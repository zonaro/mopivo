// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper subsystem — renderer window manager.
// Ported from Hanabi (jeffshee/gnome-ext-hanabi) ManageWindow.

import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {APPLICATION_ID, TITLE_ANCHOR, LOG_PREFIX} from './constants.js';

const log = (...args) => console.log(`${LOG_PREFIX} [wm]`, ...args);

const shellVersion = parseInt(Config.PACKAGE_VERSION.split('.')[0]);

// ── ManagedWindow ─────────────────────────────────────────────────────────
// Wraps a single renderer MetaWindow and enforces keepAtBottom,
// keepMinimized, keepPosition directives parsed from the title JSON.
// Title format: @org.redclaw.WallpaperProvidersRenderer!{...}|<monitorIndex>

class ManagedWindow {
    constructor(window, isX11) {
        this._window = window;
        this._isX11 = isX11;
        this._signals = [];
        this._states = {
            position: [0, 0],
            keepAtBottom: false,
            keepMinimized: false,
            keepPosition: false,
        };
        this._isDisposed = false;
        this._isApplyingMinimize = false;
        this._notifyPositionId = null;
        this._surfaceContainer = null;

        this._connectSignals();
        this._parseTitle();
    }

    _connectSignals() {
        const w = this._window;

        this._signals.push(
            w.connect('notify::title', () => {
                if (this._isDisposed) return;
                this._parseTitle();
            })
        );

        this._signals.push(
            w.connect_after('shown', () => {
                if (this._isDisposed) return;
                if (this._states.keepMinimized)
                    this._minimizeWindow();
            })
        );

        this._signals.push(
            w.connect_after('raised', () => {
                if (this._isDisposed) return;
                if (this._states.keepAtBottom) w.lower();
            })
        );

        this._signals.push(
            w.connect('notify::above', () => {
                if (this._isDisposed) return;
                if (this._states.keepAtBottom && w.above)
                    w.unmake_above();
            })
        );

        this._signals.push(
            w.connect('notify::minimized', () => {
                if (this._isDisposed) return;
                // Skip if we are in the middle of the re-raise+minimize
                // workaround to avoid infinite recursion.
                if (this._isApplyingMinimize) return;
                if (this._states.keepMinimized && !w.minimized)
                    this._minimizeWindow();
            })
        );

        this._signals.push(
            w.connect('position-changed', () => {
                if (this._isDisposed) return;
                if (this._states.keepPosition) {
                    const [x, y] = this._states.position;
                    w.move_frame(true, x, y);
                }
            })
        );

        // ── GNOME 45 Wayland minimize workaround ──────────────────────────
        // MetaSurfaceContainerActorWayland misplaces the window when
        // minimized: it sets position to
        //   (child_actor_width - surface_width)/2,
        //   (child_actor_height - surface_height)/2
        // Ref: https://gitlab.gnome.org/GNOME/mutter/-/issues/3159
        //
        // Fix: whenever the container position changes, reset it to (0,0).
        // Combined with the re-raise+minimize sequence in _minimizeWindow(),
        // this forces the compositor to recalculate correctly.
        if (shellVersion === 45 && !this._isX11) {
            const windowActor = w.get_compositor_private();
            if (windowActor) {
                this._surfaceContainer = windowActor
                    .get_children()
                    .find(
                        child =>
                            GObject.type_name(child) ===
                            'MetaSurfaceContainerActorWayland'
                    );
                if (this._surfaceContainer) {
                    this._notifyPositionId = this._surfaceContainer.connect(
                        'notify::position',
                        () => {
                            if (!this._isDisposed)
                                this._surfaceContainer.set_position(0, 0);
                        }
                    );
                }
            }
        }
    }

    // ── GNOME 45 re-raise + minimize ──────────────────────────────────────
    // On GNOME 45 Wayland, calling minimize() directly can leave the
    // surface container at a wrong position.  Workaround: temporarily
    // raise the window (forcing the compositor to compute its position),
    // then minimize.  The _isApplyingMinimize flag prevents the
    // notify::minimized handler from recursing back here.
    _minimizeWindow() {
        if (shellVersion === 45 && !this._isX11) {
            this._isApplyingMinimize = true;
            this._window.raise();
            this._window.minimize();
            this._isApplyingMinimize = false;
        } else {
            this._window.minimize();
        }
    }

    _parseTitle() {
        const title = this._window.get_title();
        if (!title || !title.startsWith(TITLE_ANCHOR)) return;

        const json = title.substring(TITLE_ANCHOR.length).split('|')[0];
        try {
            const newState = JSON.parse(json);
            this._states = {...this._states, ...newState};
        } catch (e) {
            log(`Failed to parse title JSON: ${e.message}`);
        }
        this._refresh();
    }

    _refresh() {
        if (this._states.keepAtBottom && this._window.above)
            this._window.unmake_above();
        if (this._states.keepMinimized && !this._window.minimized)
            this._minimizeWindow();
        if (this._states.keepPosition) {
            const [x, y] = this._states.position;
            this._window.move_frame(true, x, y);
        }
    }

    disconnect() {
        this._isDisposed = true;

        if (this._notifyPositionId !== null && this._surfaceContainer) {
            this._surfaceContainer.disconnect(this._notifyPositionId);
            this._notifyPositionId = null;
        }

        for (const sig of this._signals)
            this._window.disconnect(sig);
        this._signals = [];
        this._window = null;
        this._surfaceContainer = null;
    }
}

// ── WindowManager ─────────────────────────────────────────────────────────
// Tracks renderer windows across monitors, enforcing the directives
// embedded in their title JSON.  Call setWaylandClient() with the
// Launcher instance before enable() on Wayland sessions.

export class WindowManager extends GObject.Object {
    constructor() {
        super();

        this._isX11 =
            shellVersion < 50 ? !Meta.is_wayland_compositor() : false;
        this._waylandClient = null;
        this._windows = new Set();
        this._mapId = 0;
    }

    /**
     * Set the Launcher that owns the renderer subprocess.
     * Must be called before enable() on Wayland sessions.
     *
     * @param {import('./launcher.js').Launcher|null} client
     */
    setWaylandClient(client) {
        this._waylandClient = client;
    }

    enable() {
        this._mapId = global.window_manager.connect_after(
            'map',
            (_wm, windowActor) => {
                const window = windowActor.get_meta_window();
                const title = window.get_title();

                // ── Guard: only process renderer windows ──────────────────
                if (!title || !title.startsWith(TITLE_ANCHOR)) return;

                if (!this._isX11) {
                    // Wayland: delegate ownership check to the Launcher.
                    if (
                        this._waylandClient &&
                        this._waylandClient.queryWindowBelongs(window)
                    )
                        this._addWindow(window);
                } else {
                    // X11: match by gtk_application_id.
                    if (window.get_gtk_application_id() === APPLICATION_ID)
                        this._addWindow(window);
                }
            }
        );
        log('Window manager enabled');
    }

    disable() {
        for (const window of this._windows)
            this._clearWindow(window);
        this._windows.clear();

        if (this._mapId) {
            global.window_manager.disconnect(this._mapId);
            this._mapId = 0;
        }

        log('Window manager disabled');
    }

    _addWindow(window) {
        if (this._windows.has(window)) return;

        window.managed = new ManagedWindow(window, this._isX11);
        this._windows.add(window);

        window.managed._unmanagedId = window.connect(
            'unmanaged',
            _window => {
                this._clearWindow(_window);
                this._windows.delete(_window);
            }
        );
        log('Renderer window tracked');
    }

    _clearWindow(window) {
        if (!window.managed) return;

        window.disconnect(window.managed._unmanagedId);
        window.managed.disconnect();
        window.managed = null;
    }
}
