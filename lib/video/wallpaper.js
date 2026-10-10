// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper subsystem — LiveWallpaper widget.
// Clones the renderer window under the desktop background and fades it in.
// Adapted from gnome-ext-hanabi (jeffshee) for Wallpaper Providers.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TITLE_ANCHOR, LOG_PREFIX} from './constants.js';

const FADE_DURATION = 1000;

function _log(msg) {
    console.log(`${LOG_PREFIX} wallpaper: ${msg}`);
}

/**
 * Check whether a Meta.Window belongs to the renderer process.
 * @param {Meta.Window} metaWindow
 * @returns {boolean}
 */
function _isRendererWindow(metaWindow) {
    return metaWindow.title?.startsWith(TITLE_ANCHOR) ?? false;
}

/**
 * The widget that holds a Clutter.Clone of the renderer window,
 * placed on top of each BackgroundActor to act as a live wallpaper.
 */
export const LiveWallpaper = GObject.registerClass(
class LiveWallpaper extends St.Widget {
    /**
     * @param {Meta.BackgroundActor} backgroundActor
     * @param {Gio.Settings} [settings]
     */
    constructor(backgroundActor, settings = null) {
        const binLayout = new Clutter.BinLayout();
        binLayout.fill = true;

        super({
            layout_manager: binLayout,
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });

        this._backgroundActor = backgroundActor;
        this._settings = settings;
        this._monitorIndex = backgroundActor.monitor;
        this._timeoutId = 0;
        this._clone = null;
        this._cloneSourceDestroyId = 0;
        this._isDestroyed = false;

        // Guard: lock screen may have undefined monitor
        if (this._monitorIndex === undefined || this._monitorIndex < 0) {
            _log('Skipping: monitor undefined (lock screen?)');
            return;
        }

        // Place ourselves inside the background actor
        backgroundActor.layout_manager = new Clutter.BinLayout();
        backgroundActor.add_child(this);

        this.connect('destroy', () => this._onDestroy());
        this._pollForRenderer();
    }

    /* ----- lifecycle --------------------------------------------------- */

    _onDestroy() {
        if (this._isDestroyed)
            return;
        this._isDestroyed = true;

        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._clearClone();
    }

    _clearClone() {
        if (!this._clone)
            return;

        if (this._cloneSourceDestroyId && this._clone.source) {
            this._clone.source.disconnect(this._cloneSourceDestroyId);
            this._cloneSourceDestroyId = 0;
        }
        this._clone.source = null;
        this._clone.destroy();
        this._clone = null;
    }

    /* ----- renderer polling -------------------------------------------- */

    _pollForRenderer() {
        const tryAttach = () => {
            if (this._isDestroyed)
                return false; // stop

            const renderer = this._findRenderer();
            if (renderer) {
                this._attachClone(renderer);
                return false; // done
            }
            return true; // keep polling
        };

        // Immediate first attempt; poll every 1 s until found
        if (tryAttach())
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, tryAttach);
    }

    /**
     * Scan window actors for the renderer belonging to our monitor.
     * Uses `global.get_window_actors(false)` — the `false` BYPASSES the
     * shellOverride filter so we can actually see renderer windows.
     *
     * Title format: `@org.redclaw.WallpaperProvidersRenderer!{json}|<monitorIndex>`
     * Primary criterion: monitor index match (robust when monitors change).
     */
    _findRenderer() {
        const actors = global.get_window_actors(false);
        const monitor = this._monitorIndex;

        return actors.find(a => {
            const w = a.meta_window;
            return w.get_monitor() === monitor && _isRendererWindow(w);
        }) ?? null;
    }

    /* ----- clone + fade ------------------------------------------------ */

    _attachClone(rendererActor) {
        this._clone = new Clutter.Clone({
            source: rendererActor,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            x_expand: true,
            y_expand: true,
        });

        // Re-poll when the source renderer window is destroyed
        this._cloneSourceDestroyId = this._clone.source.connect('destroy', () => {
            _log(`Renderer gone on monitor ${this._monitorIndex}, re-polling`);
            this._clearClone();
            if (!this._isDestroyed)
                this._pollForRenderer();
        });

        this.add_child(this._clone);
        this._fade(true);
        _log(`Attached for monitor ${this._monitorIndex}`);
    }

    _fade(visible) {
        if (this._isDestroyed)
            return;
        this.ease({
            opacity: visible ? 255 : 0,
            duration: FADE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }
});
