// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-pause subsystem — four independent modules that drive PlaybackState.

import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {UPowerDBus, MprisDBus} from './dbus.js';
import {TITLE_ANCHOR, LOG_PREFIX} from './constants.js';

const _log = (msg) => console.log(`${LOG_PREFIX} autoPause: ${msg}`);

const _shellVersion = parseInt(Config.PACKAGE_VERSION.split('.')[0], 10);

// ─── Base module ─────────────────────────────────────────────────────────────

const AutoPauseModule = GObject.registerClass({
    GTypeName: 'WpAutoPauseModule',
    Signals: {
        'updated': {},
    },
}, class AutoPauseModule extends GObject.Object {
    _init(settings, name) {
        super._init();
        this._settings = settings;
        this.name = name || 'base';
    }

    enable() { /* override */ }
    disable() { /* override */ }

    /** Override in subclasses. Return true when this module wants to pause. */
    shouldAutoPause() {
        return false;
    }

    _update() {
        this.emit('updated');
    }
});

// ─── 1. MaximizeOrFullscreen ─────────────────────────────────────────────────

const _MaximizeMode = Object.freeze({never: 0, anyMonitor: 1, allMonitors: 2});

const MaximizeOrFullscreenModule = GObject.registerClass({
    GTypeName: 'WpAutoPauseMaximize',
}, class MaximizeOrFullscreenModule extends AutoPauseModule {
    _init(settings) {
        super._init(settings, 'maximizeOrFullscreen');
        this._mode = settings.get_int('pause-on-maximize-or-fullscreen');
        this._changedId = settings.connect(
            'changed::pause-on-maximize-or-fullscreen',
            () => {
                this._mode = settings.get_int('pause-on-maximize-or-fullscreen');
                this._update();
            }
        );

        this._workspaceManager = null;
        this._activeWorkspace = null;
        this._activeWorkspaceChangedId = null;
        this._windowAddedId = null;
        this._windowRemovedId = null;
        this._windows = []; // [{metaWindow, signals: [...]}]

        this._anyMaximized = false;
        this._allMaximized = false;
    }

    enable() {
        this._workspaceManager = global.workspace_manager;
        this._activeWorkspace = this._workspaceManager.get_active_workspace();
        this._activeWorkspaceChangedId = this._workspaceManager.connect(
            'active-workspace-changed',
            (_wm) => this._onActiveWorkspaceChanged()
        );

        this._activeWorkspace.list_windows().forEach(
            w => this._onWindowAdded(w, false)
        );
        this._windowAddedId = this._activeWorkspace.connect(
            'window-added', (_ws, w) => this._onWindowAdded(w)
        );
        this._windowRemovedId = this._activeWorkspace.connect(
            'window-removed', (_ws, w) => this._onWindowRemoved(w)
        );
        this._recompute();
    }

    disable() {
        if (this._activeWorkspace) {
            if (this._windowAddedId)
                this._activeWorkspace.disconnect(this._windowAddedId);
            if (this._windowRemovedId)
                this._activeWorkspace.disconnect(this._windowRemovedId);
        }
        if (this._workspaceManager && this._activeWorkspaceChangedId)
            this._workspaceManager.disconnect(this._activeWorkspaceChangedId);

        this._windows.forEach(({metaWindow, signals}) =>
            signals.forEach(id => metaWindow.disconnect(id))
        );

        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = null;
        }

        this._workspaceManager = null;
        this._activeWorkspace = null;
        this._activeWorkspaceChangedId = null;
        this._windowAddedId = null;
        this._windowRemovedId = null;
        this._windows = [];
    }

    // -- Window tracking -------------------------------------------------

    _isRendererWindow(metaWindow) {
        return metaWindow.title?.includes(TITLE_ANCHOR);
    }

    _onWindowAdded(metaWindow, doUpdate = true) {
        if (this._isRendererWindow(metaWindow) || metaWindow.skip_taskbar)
            return;

        const signals = [];
        for (const prop of [
            'notify::maximized-horizontally',
            'notify::maximized-vertically',
            'notify::fullscreen',
            'notify::minimized',
        ]) {
            signals.push(metaWindow.connect(prop, () => {
                _log(`${prop} changed on ${metaWindow.title}`);
                this._recompute();
            }));
        }
        this._windows.push({metaWindow, signals});
        _log(`Window tracked: ${metaWindow.title}`);
        if (doUpdate)
            this._recompute();
    }

    _onWindowRemoved(metaWindow) {
        if (this._isRendererWindow(metaWindow) || metaWindow.skip_taskbar)
            return;

        this._windows = this._windows.filter(entry => {
            if (entry.metaWindow !== metaWindow)
                return true;
            entry.signals.forEach(id => metaWindow.disconnect(id));
            return false;
        });
        _log(`Window untracked: ${metaWindow.title}`);
        this._recompute();
    }

    _onActiveWorkspaceChanged() {
        // Disconnect old workspace signals
        this._windows.forEach(({metaWindow, signals}) =>
            signals.forEach(id => metaWindow.disconnect(id))
        );
        this._windows = [];

        if (this._activeWorkspace) {
            if (this._windowAddedId)
                this._activeWorkspace.disconnect(this._windowAddedId);
            if (this._windowRemovedId)
                this._activeWorkspace.disconnect(this._windowRemovedId);
        }
        this._activeWorkspace = null;

        this._activeWorkspace = this._workspaceManager.get_active_workspace();
        _log(`Active workspace: ${this._activeWorkspace.workspace_index}`);

        this._activeWorkspace.list_windows().forEach(
            w => this._onWindowAdded(w, false)
        );
        this._windowAddedId = this._activeWorkspace.connect(
            'window-added', (_ws, w) => this._onWindowAdded(w)
        );
        this._windowRemovedId = this._activeWorkspace.connect(
            'window-removed', (_ws, w) => this._onWindowRemoved(w)
        );
        this._recompute();
    }

    // -- Evaluation ------------------------------------------------------

    _recompute() {
        const candidates = this._windows
            .map(e => e.metaWindow)
            .filter(w => !this._isRendererWindow(w) && !w.minimized);

        const monitors = Main.layoutManager.monitors;

        // GNOME Shell < 49 uses get_maximized() (bitmask), >= 49 uses is_maximized()
        if (_shellVersion < 49) {
            this._anyMaximized = candidates.some(
                w => w.get_maximized() === Meta.MaximizeFlags.BOTH || w.fullscreen
            );
            const byMonitor = {};
            for (const w of candidates) {
                if (w.get_maximized() === Meta.MaximizeFlags.BOTH || w.fullscreen)
                    byMonitor[w.get_monitor()] = true;
            }
            this._allMaximized = monitors.every(m => byMonitor[m.index]);
        } else {
            this._anyMaximized = candidates.some(
                w => w.is_maximized() || w.fullscreen
            );
            const byMonitor = {};
            for (const w of candidates) {
                if (w.is_maximized() || w.fullscreen)
                    byMonitor[w.get_monitor()] = true;
            }
            this._allMaximized = monitors.every(m => byMonitor[m.index]);
        }

        _log(`any=${this._anyMaximized} all=${this._allMaximized} mode=${this._mode}`);
        this._update();
    }

    shouldAutoPause() {
        if (this._mode === _MaximizeMode.anyMonitor && this._anyMaximized)
            return true;
        if (this._mode === _MaximizeMode.allMonitors && this._allMaximized)
            return true;
        return false;
    }
});

// ─── 2. Focus ────────────────────────────────────────────────────────────────

const FocusModule = GObject.registerClass({
    GTypeName: 'WpAutoPauseFocus',
}, class FocusModule extends AutoPauseModule {
    _init(settings) {
        super._init(settings, 'focus');
        this._enabled = settings.get_boolean('pause-on-focus');
        this._changedId = settings.connect('changed::pause-on-focus', () => {
            this._enabled = settings.get_boolean('pause-on-focus');
            this._update();
        });

        this._display = null;
        this._focusChangedId = null;
        this._trackedWindow = null;
        this._appearsFocusedId = null;
        this._windowFocused = false;
    }

    enable() {
        this._display = global.display;
        this._focusChangedId = this._display.connect(
            'notify::focus-window', () => {
                _log('focus-window changed');
                this._trackFocusWindow();
                this._recompute();
            }
        );
        this._trackFocusWindow();
        this._recompute();
    }

    disable() {
        if (this._focusChangedId && this._display) {
            this._display.disconnect(this._focusChangedId);
            this._focusChangedId = null;
        }
        this._disconnectAppearsFocused();
        this._trackedWindow = null;
        this._display = null;
    }

    _disconnectAppearsFocused() {
        if (this._appearsFocusedId && this._trackedWindow) {
            this._trackedWindow.disconnect(this._appearsFocusedId);
            this._appearsFocusedId = null;
        }
        this._trackedWindow = null;
    }

    _trackFocusWindow() {
        this._disconnectAppearsFocused();
        const focusWindow = this._display?.focus_window;
        if (focusWindow) {
            this._trackedWindow = focusWindow;
            this._appearsFocusedId = focusWindow.connect(
                'notify::appears-focused', () => {
                    _log(`appears-focused: ${focusWindow.appears_focused} (${focusWindow.title})`);
                    this._recompute();
                }
            );
        }
    }

    _recompute() {
        const focusWindow = this._display?.focus_window;
        this._windowFocused = focusWindow !== null &&
            focusWindow.appears_focused &&
            !focusWindow.minimized &&
            !focusWindow.title?.includes(TITLE_ANCHOR) &&
            !focusWindow.skip_taskbar;
        _log(`focused=${this._windowFocused} title=${focusWindow?.title}`);
        this._update();
    }

    shouldAutoPause() {
        return this._enabled && this._windowFocused;
    }
});

// ─── 3. Battery ──────────────────────────────────────────────────────────────

const _BatteryMode = Object.freeze({never: 0, lowBattery: 1, always: 2});
const _DEBOUNCE_MS = 5000;

const BatteryModule = GObject.registerClass({
    GTypeName: 'WpAutoPauseBattery',
}, class BatteryModule extends AutoPauseModule {
    _init(settings) {
        super._init(settings, 'battery');
        this._mode = settings.get_int('pause-on-battery');
        this._threshold = settings.get_int('low-battery-threshold');
        this._onBatteryChangedId = settings.connect(
            'changed::pause-on-battery', () => {
                this._mode = settings.get_int('pause-on-battery');
                this._update();
            }
        );
        this._thresholdChangedId = settings.connect(
            'changed::low-battery-threshold', () => {
                this._threshold = settings.get_int('low-battery-threshold');
                this._update();
            }
        );

        this._upower = new UPowerDBus();
        this._upowerChangedId = null;
        this._debounceId = 0;
        this._onBattery = false;
        this._lowBattery = false;
    }

    enable() {
        this._upower.start();
        this._upowerChangedId = this._upower.connect('changed', () => {
            this._debouncedUpdate();
        });
        this._recompute();
    }

    disable() {
        if (this._upowerChangedId) {
            this._upower.disconnect(this._upowerChangedId);
            this._upowerChangedId = null;
        }
        this._upower.stop();
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._onBatteryChangedId) {
            this._settings.disconnect(this._onBatteryChangedId);
            this._onBatteryChangedId = null;
        }
        if (this._thresholdChangedId) {
            this._settings.disconnect(this._thresholdChangedId);
            this._thresholdChangedId = null;
        }
    }

    _debouncedUpdate() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, _DEBOUNCE_MS, () => {
                this._debounceId = 0;
                this._recompute();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    async _recompute() {
        this._onBattery = await this._upower.isOnBattery();
        this._lowBattery = await this._upower.isLowBattery(this._threshold);
        _log(`onBattery=${this._onBattery} lowBattery=${this._lowBattery} mode=${this._mode}`);
        this._update();
    }

    shouldAutoPause() {
        if (this._mode === _BatteryMode.lowBattery && this._lowBattery)
            return true;
        if (this._mode === _BatteryMode.always && this._onBattery)
            return true;
        return false;
    }
});

// ─── 4. MPRIS ────────────────────────────────────────────────────────────────

const MprisModule = GObject.registerClass({
    GTypeName: 'WpAutoPauseMpris',
}, class MprisModule extends AutoPauseModule {
    _init(settings) {
        super._init(settings, 'mpris');
        this._enabled = settings.get_boolean('pause-on-mpris-playing');
        this._changedId = settings.connect(
            'changed::pause-on-mpris-playing', () => {
                this._enabled = settings.get_boolean('pause-on-mpris-playing');
                this._update();
            }
        );

        this._mpris = new MprisDBus();
        this._mprisPlayingChangedId = null;
        this._mprisPlaying = false;
    }

    enable() {
        this._mpris.start();
        this._mprisPlayingChangedId = this._mpris.connect(
            'playing-changed', (_src, playing) => {
                this._mprisPlaying = playing;
                _log(`MPRIS playing: ${playing}`);
                this._update();
            }
        );
    }

    disable() {
        if (this._mprisPlayingChangedId) {
            this._mpris.disconnect(this._mprisPlayingChangedId);
            this._mprisPlayingChangedId = null;
        }
        this._mpris.stop();
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = null;
        }
    }

    shouldAutoPause() {
        return this._enabled && this._mprisPlaying;
    }
});

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Auto-pause orchestrator.
 *
 * Holds four independent modules, each determining whether the video should
 * pause.  On any module update, eval() runs all modules; if ANY wants pause,
 * playbackState.autoPause() is called, otherwise autoPlay().
 *
 * Emits NOTHING to the renderer directly.
 */
export const AutoPause = GObject.registerClass({
    GTypeName: 'WpAutoPause',
}, class AutoPause extends GObject.Object {
    _init(settings, playbackState) {
        super._init();
        this._settings = settings;
        this._playbackState = playbackState;
        this._modules = [
            new MaximizeOrFullscreenModule(settings),
            new FocusModule(settings),
            new BatteryModule(settings),
            new MprisModule(settings),
        ];
        this._moduleUpdatedIds = [];
    }

    enable() {
        this._modules.forEach((module, i) => {
            const id = module.connect('updated', () => this._eval());
            this._moduleUpdatedIds.push(id);
            module.enable();
        });
    }

    disable() {
        this._modules.forEach((module, i) => {
            module.disable();
            if (this._moduleUpdatedIds[i] !== undefined) {
                module.disconnect(this._moduleUpdatedIds[i]);
            }
        });
        this._moduleUpdatedIds = [];
    }

    _eval() {
        const shouldPause = this._modules.some(m => m.shouldAutoPause());
        _log(`eval: shouldPause=${shouldPause}`);
        if (shouldPause)
            this._playbackState.autoPause();
        else
            this._playbackState.autoPlay();
    }
});
