// SPDX-License-Identifier: GPL-3.0-or-later
// Set the GNOME desktop background. Shared by the image gallery and the
// video renderer's static-wallpaper helpers (see lib/video/staticBlur.js).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';

import {
    composite,
    normalizeRects,
    parseMonitorAssignments,
    wallpaperCacheDir,
} from './wallpaper-multi.js';

export const BG_SCHEMA = 'org.gnome.desktop.background';

/**
 * Return a Gio.Settings instance for the GNOME desktop background schema.
 *
 * @returns {Gio.Settings}
 */
export function getDesktopBackgroundSettings() {
    return new Gio.Settings({schema_id: BG_SCHEMA});
}

/**
 * Set the desktop wallpaper to a file URI on both light and dark variants,
 * optionally overriding `picture-options`.
 *
 * @param {string}  uri      A file:// URI pointing to the wallpaper image.
 * @param {string=} options  Optional `picture-options` value (e.g. 'spanned').
 */
function _apply(uri, options) {
    const bg = getDesktopBackgroundSettings();
    bg.reset('picture-uri');
    bg.reset('picture-uri-dark');
    bg.set_string('picture-uri', uri);
    bg.set_string('picture-uri-dark', uri);
    if (options)
        bg.set_string('picture-options', options);
    bg.sync();
    bg.apply();
}

/**
 * Set the desktop wallpaper to a file URI on both light and dark variants.
 * This is the plain "same image on every monitor" behavior.
 *
 * @param {string} uri  A file:// URI pointing to the wallpaper image.
 */
export function setDesktopWallpaper(uri) {
    _apply(uri);
}

/**
 * Apply a single image stretched across all monitors (`picture-options`
 * = 'spanned').
 *
 * @param {string} uri  A file:// URI pointing to the wallpaper image.
 * @returns {string} the applied URI.
 */
export function setDesktopWallpaperWide(uri) {
    _apply(uri, 'spanned');
    return uri;
}

/**
 * Read the current monitor layout from Gdk. Each entry carries the geometry
 * (which can be negative on multi-monitor setups) and the connector name.
 * Returns an empty list when there is no display (headless tests).
 *
 * @returns {Array<{x:number,y:number,width:number,height:number,connector:string}>}
 */
export function getMonitorRects() {
    const rects = [];
    const display = Gdk.Display.get_default?.();
    if (!display)
        return rects;
    const monitors = display.get_monitors();
    const n = monitors?.get_n_items?.() ?? 0;
    for (let i = 0; i < n; i++) {
        const mon = monitors.get_item(i);
        if (!mon)
            continue;
        const geo = mon.get_geometry();
        rects.push({
            x: geo.x,
            y: geo.y,
            width: geo.width,
            height: geo.height,
            connector: mon.get_connector?.() ?? '',
        });
    }
    return rects;
}

/**
 * Per-monitor apply flow: pair each monitor with its assigned image (falling
 * back to `wallpaper-default-uri`), composite them into one spanning canvas
 * and apply that PNG with `picture-options='spanned'`. When compositing is not
 * possible (no monitors, no assignments, or a decode failure) fall back to a
 * single image with `picture-options='scaled'`.
 *
 * @param {object}  settings      Gio.Settings (mopivo schema).
 * @param {string=} fallbackUri   URI to use when a monitor has no assignment.
 * @returns {string} the URI actually applied, or '' when nothing was applied.
 */
export function applyPerMonitor(settings, fallbackUri = '') {
    const assignments = parseMonitorAssignments(
        settings?.get_strv?.('wallpaper-per-monitor'));
    const defaultUri = settings?.get_string?.('wallpaper-default-uri') ?? '';

    const paired = [];
    for (const mon of getMonitorRects()) {
        if (!(mon.width > 0 && mon.height > 0))
            continue;
        const match = assignments.find((a) => a.connector === mon.connector);
        const uri = match?.uri || defaultUri;
        if (uri)
            paired.push({rect: mon, uri});
    }

    const fallback = () => {
        const target = fallbackUri || defaultUri;
        if (target) {
            _apply(target, 'scaled');
            return target;
        }
        return '';
    };

    if (paired.length === 0)
        return fallback();

    try {
        const norm = normalizeRects(paired.map((p) => p.rect));
        const images = paired.map((p) => p.uri);
        const outPath = GLib.build_filenamev(
            [wallpaperCacheDir(), `monitors-${Date.now()}.png`]);
        composite(images, norm.rects, outPath);
        const fileUri = Gio.File.new_for_path(outPath).get_uri();
        _apply(fileUri, 'spanned');
        return fileUri;
    } catch (_e) {
        return fallback();
    }
}

/**
 * Dispatch the wallpaper apply according to the `wallpaper-mode` setting.
 *
 * - `same`        → current single-image behavior (repeat per monitor).
 * - `span`        → the chosen URI applied with `picture-options='spanned'`.
 * - `per-monitor` → composite per connector and apply spanned, with a
 *                   single-image 'scaled' fallback.
 *
 * @param {object}  settings  Gio.Settings (mopivo schema).
 * @param {string=} uri       The image the user just picked (optional).
 * @returns {string} the URI actually applied, or '' when nothing was applied.
 */
export function setWallpaperMode(settings, uri = '') {
    const mode = settings?.get_string?.('wallpaper-mode') ?? 'same';

    if (mode === 'span') {
        const target = uri || settings?.get_string?.('wallpaper-default-uri') || '';
        if (target)
            setDesktopWallpaperWide(target);
        return target;
    }

    if (mode === 'per-monitor')
        return applyPerMonitor(settings, uri);

    if (uri)
        setDesktopWallpaper(uri);
    return uri;
}
