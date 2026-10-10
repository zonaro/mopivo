// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper subsystem — orchestrator.
// Owns the renderer lifecycle and wires together: Launcher, WindowManager,
// ShellOverride, AutoPause, PlaybackState, RendererDBus and the panel controls.
// Ported from Hanabi (jeffshee/gnome-ext-hanabi) with Wallpaper Providers glue.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Launcher} from './launcher.js';
import {WindowManager} from './windowManager.js';
import {ShellOverride} from './shellOverride.js';
import {AutoPause} from './autoPause.js';
import {PlaybackState} from './playbackState.js';
import {RendererDBus} from './dbus.js';
import {VideoControlsBox} from './panelMenu.js';
import {StaticBlur} from './staticBlur.js';
import {YtDlpResolver} from './ytDlp.js';
import {listVideoFiles} from './videoThumbs.js';
import {LOG_PREFIX} from './constants.js';

const _log = (msg) => console.log(`${LOG_PREFIX} videoManager: ${msg}`);

const DEFAULT_VIDEO_FOLDER = GLib.build_filenamev([
    GLib.get_home_dir(), 'Videos', 'Hidamari',
]);

/**
 * Master coordinator for the video wallpaper subsystem.
 *
 * Created once per extension enable(). `enable()` wires the panel controls and
 * starts the video pipeline when `video-mode` is set; `disable()` tears
 * everything down. Setting `video-mode` toggles the pipeline at runtime.
 */
export class VideoManager {
    /**
     * @param {object} ext       — Extension instance (`.path`, `.uuid`).
     * @param {Gio.Settings} settings
     */
    constructor(ext, settings) {
        this._ext = ext;
        this._settings = settings;

        this._enabled = false;       // pipeline running (video-mode on)
        this._startupTimeoutId = 0;
        this._relaunchTimeoutId = 0;
        this._monitorsChangedId = 0;
        this._monitorsDebounceId = 0;
        this._sessionModeId = 0;
        this._destroyed = false;

        this._launcher = null;
        this._windowManager = null;
        this._shellOverride = null;
        this._autoPause = null;
        this._playbackState = null;
        this._rendererDBus = null;
        this._staticBlur = null;
        this._ytDlp = null;

        this.controls = new VideoControlsBox(ext);
        this._wireControls();

        this._settingsChangedIds = [];
        this._subscribeSettings();
    }

    /* ── Lifecycle ─────────────────────────────────────────────────────── */

    /**
     * Called once by the extension on enable(). Starts the video pipeline if
     * `video-mode` is active and keeps reacting to the setting.
     */
    enable() {
        if (this._destroyed)
            return;

        this._rendererDBus = new RendererDBus();
        this._playbackState = new PlaybackState();
        this._playbackState.setRenderer(this._rendererDBus);
        this._playbackState.connect('changed', (_s, state) =>
            this.controls.setPlaybackState(state));
        this._rendererDBus.start();

        this._autoPause = new AutoPause(this._settings, this._playbackState);
        this._autoPause.enable();

        if (this._settings.get_boolean('video-mode'))
            this.startVideo();
    }

    /** Start the video pipeline (called by enable() or video-mode change). */
    startVideo() {
        if (this._enabled || this._destroyed)
            return;
        this._enabled = true;
        _log('Starting video subsystem');

        this._shellOverride = new ShellOverride(this._ext, this._settings);
        this._shellOverride.enable();

        this._windowManager = new WindowManager();
        this._windowManager.enable();

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._onMonitorsChanged()
        );

        this._sessionModeId = Main.sessionMode.connect(
            'updated', () => this._onSessionModeChanged()
        );

        // Initial streaming resolution, if in streaming mode.
        if (this._settings.get_string('video-mode-type') === 'streaming')
            this._resolveStreamingUrl();

        // Delay renderer launch to let the shell settle post-override.
        const delay = Math.max(0, this._settings.get_int('startup-delay'));
        this._startupTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._startupTimeoutId = 0;
                this._spawnRenderer();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /** Stop the video pipeline without destroying the manager. */
    stopVideo() {
        if (!this._enabled)
            return;
        this._enabled = false;
        _log('Stopping video subsystem');

        if (this._startupTimeoutId) {
            GLib.source_remove(this._startupTimeoutId);
            this._startupTimeoutId = 0;
        }
        if (this._relaunchTimeoutId) {
            GLib.source_remove(this._relaunchTimeoutId);
            this._relaunchTimeoutId = 0;
        }
        if (this._monitorsDebounceId) {
            GLib.source_remove(this._monitorsDebounceId);
            this._monitorsDebounceId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._sessionModeId) {
            Main.sessionMode.disconnect(this._sessionModeId);
            this._sessionModeId = 0;
        }

        this._killRenderer();
        this._killOrphanProcesses();

        if (this._windowManager)
            this._windowManager.disable();
        if (this._shellOverride)
            this._shellOverride.disable();
        if (this._autoPause)
            this._autoPause.disable();

        this._windowManager = null;
        this._shellOverride = null;
        this._autoPause = null;
        this._launcher = null;
    }

    /** Called once by the extension on disable(). Full teardown. */
    destroy() {
        this._destroyed = true;
        this.stopVideo();

        for (const id of this._settingsChangedIds)
            this._settings.disconnect(id);
        this._settingsChangedIds = [];

        this.controls.destroy();
        this.controls = null;

        if (this._playbackState) {
            this._playbackState.destroy();
            this._playbackState = null;
        }
        if (this._rendererDBus) {
            this._rendererDBus.stop();
            this._rendererDBus = null;
        }
        this._ext = null;
        this._settings = null;
    }

    /* ── Renderer process ──────────────────────────────────────────────── */

    _spawnRenderer() {
        if (!this._enabled || this._destroyed)
            return;

        this._launcher = new Launcher(this._ext);

        // Give the WindowManager ownership info for Wayland window tracking.
        if (this._windowManager)
            this._windowManager.setWaylandClient(this._launcher);

        // Watch renderer death for auto-relaunch (100 ms clean / 1000 ms crash).
        const subprocess = this._launcher.spawn();
        if (!subprocess)
            return;

        subprocess.wait_async(null, (proc, res) => {
            let status = -1;
            try {
                proc.wait_finish(res);
                status = proc.get_exit_status();
            } catch (_e) { /* killed by us */ }
            if (!this._enabled || this._destroyed)
                return;
            const delay = status === 0 ? 100 : 1000;
            this._relaunchTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, delay, () => {
                    this._relaunchTimeoutId = 0;
                    _log(`Renderer relaunch after exit (status ${status})`);
                    this._spawnRenderer();
                    return GLib.SOURCE_REMOVE;
                }
            );
        });
    }

    _killRenderer() {
        if (this._launcher) {
            this._launcher.kill();
            this._launcher = null;
        }
    }

    /**
     * Sweep /proc for orphaned renderer processes (e.g. after a Wayland
     * client crash that leaked the subprocess handle).
     */
    _killOrphanProcesses() {
        try {
            const procDir = Gio.File.new_for_path('/proc');
            const enumerator = procDir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null))) {
                const name = info.get_name();
                if (!/^\d+$/.test(name))
                    continue;

                let cmdline = '';
                try {
                    const [, contents] = Gio.File
                        .new_for_path(`/proc/${name}/cmdline`)
                        .load_contents(null);
                    cmdline = contents.toString();
                } catch (_e) { /* process gone */ }

                if (!cmdline.includes('renderer.js'))
                    continue;
                if (!cmdline.includes(this._ext.path))
                    continue;

                _log(`Killing orphaned renderer (pid ${name})`);
                GLib.spawn_command_line_async(`kill -15 ${name}`);
            }
        } catch (e) {
            _log(`Orphan sweep failed: ${e.message}`);
        }
    }

    /* ── Runtime event handlers ────────────────────────────────────────── */

    _onMonitorsChanged() {
        if (this._monitorsDebounceId) {
            GLib.source_remove(this._monitorsDebounceId);
            this._monitorsDebounceId = 0;
        }
        this._monitorsDebounceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 500, () => {
                this._monitorsDebounceId = 0;
                if (!this._enabled)
                    return GLib.SOURCE_REMOVE;
                _log('Monitors changed — restarting renderer');
                this._killRenderer();
                this._spawnRenderer();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _onSessionModeChanged() {
        if (!this._enabled || !this._rendererDBus)
            return;
        const locked = Main.sessionMode.currentMode === 'unlock-dialog';
        _log(`Session mode: ${Main.sessionMode.currentMode}`);
        if (locked)
            this._rendererDBus.pause();
        else if (this._playbackState?.getCurrentState() === 'playing')
            this._rendererDBus.play();
    }

    /* ── Settings wiring ───────────────────────────────────────────────── */

    _subscribeSettings() {
        const s = this._settings;

        this._settingsChangedIds.push(s.connect('changed::video-mode', () => {
            if (this._destroyed)
                return;
            if (s.get_boolean('video-mode'))
                this.startVideo();
            else
                this.stopVideo();
        }));

        // Streaming URL: resolve to a direct media URL and feed video-path.
        this._settingsChangedIds.push(s.connect('changed::video-streaming-url', () => {
            if (s.get_string('video-mode-type') === 'streaming')
                this._resolveStreamingUrl();
        }));

        // Static wallpaper from video follows the current video-path.
        this._settingsChangedIds.push(s.connect('changed::video-path', () => {
            const path = s.get_string('video-path');
            if (path && !path.includes('://'))
                this._staticBlur?.onVideoChanged(path);
        }));

        // Keep the slider in sync with external volume changes.
        this._settingsChangedIds.push(s.connect('changed::video-volume', () => {
            if (this.controls)
                this.controls.setVolume(s.get_int('video-volume') / 100.0);
        }));

        this._settingsChangedIds.push(s.connect('changed::show-panel-menu', () => {
            if (this.controls)
                this.controls.setEnabled(s.get_boolean('show-panel-menu'));
        }));

        this._staticBlur = new StaticBlur(s);
    }

    /* ── Panel controls wiring ─────────────────────────────────────────── */

    _wireControls() {
        const c = this.controls;

        c.connect('play-pressed', () => this._playbackState?.userPlay());
        c.connect('pause-pressed', () => this._playbackState?.userPause());
        c.connect('next-pressed', () => this._nextVideo());
        c.connect('lucky-pressed', () => this._luckyVideo());
        c.connect('mute-toggled', (_w, muted) =>
            this._settings.set_boolean('video-mute', muted));
        c.connect('volume-changed', (_w, v) =>
            this._settings.set_int('video-volume', Math.round(v * 100)));

        c.setEnabled(this._settings.get_boolean('show-panel-menu'));
    }

    /* ── Folder helpers (Next / Lucky) ─────────────────────────────────── */

    _videoFolder() {
        return this._settings.get_string('video-folder') || DEFAULT_VIDEO_FOLDER;
    }

    _nextVideo() {
        const files = listVideoFiles(this._videoFolder());
        if (files.length === 0) {
            _log('No videos found in folder');
            return;
        }
        const current = this._settings.get_string('video-path');
        const idx = files.indexOf(current);
        const next = files[(idx + 1) % files.length] ?? files[0];
        this._settings.set_string('video-path', next);
    }

    _luckyVideo() {
        const files = listVideoFiles(this._videoFolder());
        if (files.length === 0) {
            _log('No videos found in folder');
            return;
        }
        const next = files[Math.floor(Math.random() * files.length)];
        this._settings.set_string('video-path', next);
    }

    /* ── Streaming URL (yt-dlp) ────────────────────────────────────────── */

    async _resolveStreamingUrl() {
        const url = this._settings.get_string('video-streaming-url');
        if (!url)
            return;

        if (!this._ytDlp)
            this._ytDlp = new YtDlpResolver();
        if (!this._ytDlp.isAvailable()) {
            console.warn(
                `${LOG_PREFIX} streaming mode requires yt-dlp (install to enable)`
            );
            return;
        }

        try {
            const direct = await this._ytDlp.resolveUrl(url);
            if (direct) {
                _log(`Resolved streaming URL → ${direct}`);
                this._settings.set_string('video-path', direct);
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} streaming resolve failed: ${e.message}`);
        }
    }
}