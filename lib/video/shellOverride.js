// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper subsystem — shell override manager.
// Injects LiveWallpaper actors and hides renderer windows from the shell UI.
// Adapted from gnome-ext-hanabi (jeffshee) for Wallpaper Providers.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

const {InjectionManager} = await import(
    'resource:///org/gnome/shell/extensions/extension.js'
);
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Wallpaper from './wallpaper.js';
import {TITLE_ANCHOR, LOG_PREFIX} from './constants.js';

// Risky internal modules — guarded dynamic imports for cross-version compat.
let Background;
try {
    Background = await import('resource:///org/gnome/shell/ui/background.js');
} catch (_e) {
    console.log(`${LOG_PREFIX} shellOverride: Background module unavailable`);
}
let Workspace;
try {
    Workspace = await import('resource:///org/gnome/shell/ui/workspace.js');
} catch (_e) {
    console.log(`${LOG_PREFIX} shellOverride: Workspace module unavailable`);
}
let WorkspaceThumbnail;
try {
    WorkspaceThumbnail = await import(
        'resource:///org/gnome/shell/ui/workspaceThumbnail.js'
    );
} catch (_e) {
    console.log(`${LOG_PREFIX} shellOverride: WorkspaceThumbnail module unavailable`);
}

function _log(msg) {
    console.log(`${LOG_PREFIX} shellOverride: ${msg}`);
}

/**
 * ShellOverride — injects live wallpaper actors and hides renderer windows
 * from the shell UI (overview, alt-tab, app list, etc.).
 */
export class ShellOverride {
    constructor(ext, settings) {
        this._ext = ext;
        this._settings = settings;
        this._injectionManager = new InjectionManager();
        this._wallpaperActors = new Set();
        this._monitorsChangedId = 0;
        this._monitorsChangedTimeoutId = 0;
        this._reloadTimeoutId = 0;
    }

    _getLaters() {
        if (global.compositor?.get_laters)
            return global.compositor.get_laters();
        if (Meta.Laters?.get)
            return Meta.Laters.get();
        return null;
    }

    /** @param {Meta.Window} window */
    _isRenderer(window) {
        return window.title?.startsWith(TITLE_ANCHOR) ?? false;
    }

    /** Install an override that filters renderer windows out of a list method. */
    _filterOverride(proto, methodName) {
        this._injectionManager.overrideMethod(
            proto, methodName,
            originalMethod => {
                return function (...args) {
                    return originalMethod.call(this, ...args)
                        .filter(mw => !this._isRenderer(mw));
                };
            }
        );
    }

    /** Install an override that returns false for renderer windows. */
    _blockOverride(proto, methodName) {
        this._injectionManager.overrideMethod(
            proto, methodName,
            originalMethod => {
                return function (window) {
                    if (this._isRenderer(window))
                        return false;
                    return originalMethod.call(this, window);
                };
            }
        );
    }

    /* ----- background reload ------------------------------------------- */

    reloadBackgrounds() {
        _log('Reloading backgrounds');
        this._wallpaperActors.forEach(actor => actor.destroy());
        this._wallpaperActors.clear();

        const laters = this._getLaters();
        if (laters) {
            laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                Main.layoutManager._updateBackgrounds();
                if (Main.screenShield?._dialog?._updateBackgrounds)
                    Main.screenShield._dialog._updateBackgrounds();
                try {
                    Main.overview._overview._controls
                        ._workspacesDisplay._updateWorkspacesViews();
                } catch (_e) { /* extension conflicts */ }
                return GLib.SOURCE_REMOVE;
            });
        }

        // Delayed refresh for other extensions (Blur My Shell, etc.)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            global.display.emit('workareas-changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ----- enable / disable -------------------------------------------- */

    enable() {
        _log('Installing overrides');
        const thisRef = this;

        // Override #0: BackgroundManager._createBackgroundActor — inject LiveWallpaper
        if (Background?.BackgroundManager) {
            this._injectionManager.overrideMethod(
                Background.BackgroundManager.prototype,
                '_createBackgroundActor',
                originalMethod => {
                    return function () {
                        const bg = originalMethod.call(this);
                        const isLockScreen =
                            Main.sessionMode.currentMode === 'unlock-dialog';
                        if (isLockScreen &&
                            !thisRef._settings?.get_boolean('show-on-lock-screen')) {
                            _log('Skipping live wallpaper on lock screen');
                            return bg;
                        }
                        _log(`Injecting live wallpaper (monitor ${bg.monitor})`);
                        const wp = new Wallpaper.LiveWallpaper(bg, thisRef._settings);
                        thisRef._wallpaperActors.add(wp);
                        wp.connect('destroy', actor => thisRef._wallpaperActors.delete(actor));
                        return bg;
                    };
                }
            );
        }

        // Override #1: Global.get_window_actors — filter renderer from default call.
        // Call with `false` to bypass (used internally by LiveWallpaper._findRenderer).
        this._injectionManager.overrideMethod(
            Shell.Global.prototype, 'get_window_actors',
            originalMethod => {
                return function (hideRenderer = true) {
                    const actors = originalMethod.call(this);
                    return hideRenderer
                        ? actors.filter(a => !thisRef._isRenderer(a.meta_window))
                        : actors;
                };
            }
        );

        // Override #2 & #3: Workspace / WorkspaceThumbnail._isOverviewWindow
        if (Workspace?.Workspace?.prototype)
            this._blockOverride(Workspace.Workspace.prototype, '_isOverviewWindow');
        if (WorkspaceThumbnail?.WorkspaceThumbnail?.prototype)
            this._blockOverride(
                WorkspaceThumbnail.WorkspaceThumbnail.prototype, '_isOverviewWindow');

        // Override #4: Meta.Display.get_tab_list — filter renderer from Alt-Tab
        this._filterOverride(Meta.Display.prototype, 'get_tab_list');

        // Override #5: Shell.WindowTracker.get_window_app — return null for renderer
        // to avoid Wayland PID-clash (renderer shares gnome-shell PID).
        // Ref: gnome-ext-hanabi gnomeShellOverride.js
        this._injectionManager.overrideMethod(
            Shell.WindowTracker.prototype, 'get_window_app',
            originalMethod => {
                return function (window) {
                    return thisRef._isRenderer(window)
                        ? null : originalMethod.call(this, window);
                };
            }
        );

        // Override #6: Shell.App.get_windows / get_n_windows — filter renderer
        this._filterOverride(Shell.App.prototype, 'get_windows');
        this._injectionManager.overrideMethod(
            Shell.App.prototype, 'get_n_windows',
            () => function () { return this.get_windows().length; }
        );

        // Override #7: Shell.AppSystem.get_running — drop apps with 0 windows
        this._injectionManager.overrideMethod(
            Shell.AppSystem.prototype, 'get_running',
            originalMethod => {
                return function () {
                    return originalMethod.call(this).filter(app => app.get_n_windows() > 0);
                };
            }
        );

        // monitors-changed with debounce → reload backgrounds
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => {
                if (this._monitorsChangedTimeoutId)
                    GLib.source_remove(this._monitorsChangedTimeoutId);
                this._monitorsChangedTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, 500, () => {
                        this._monitorsChangedTimeoutId = 0;
                        this.reloadBackgrounds();
                        return GLib.SOURCE_REMOVE;
                    });
            });

        // Initial reload after 1 s delay so the shell settles post-override.
        this._reloadTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 1000, () => {
                this._reloadTimeoutId = 0;
                this.reloadBackgrounds();
                return GLib.SOURCE_REMOVE;
            });
    }

    disable() {
        _log('Removing overrides');
        if (this._monitorsChangedTimeoutId) {
            GLib.source_remove(this._monitorsChangedTimeoutId);
            this._monitorsChangedTimeoutId = 0;
        }
        if (this._reloadTimeoutId) {
            GLib.source_remove(this._reloadTimeoutId);
            this._reloadTimeoutId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        this._wallpaperActors.forEach(actor => actor.destroy());
        this._wallpaperActors.clear();
        this._injectionManager.clear();
        this.reloadBackgrounds();
        this._ext = null;
        this._settings = null;
    }
}
