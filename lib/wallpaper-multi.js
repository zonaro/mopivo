// SPDX-License-Identifier: GPL-3.0-or-later
// lib/wallpaper-multi.js — pure helpers for multi-monitor wallpaper placement.
//
// Headless-safe: no Gtk.Window and no Gdk.Display access here. Only GdkPixbuf
// (image decoding + compositing) is used, so every helper can be unit-tested
// without a session. Monitor geometry is read from Gdk by the caller
// (lib/wallpaper.js) at apply time and passed in as plain rects.

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

/** Cache subfolder holding the composited per-monitor canvases. */
const CACHE_SUBDIR = 'mopivo';
const CACHE_FOLDER = 'placement';

/**
 * Parse the `wallpaper-per-monitor` schema value (an array of "connector=uri"
 * strings) into a list of `{connector, uri}` pairs. Malformed entries are
 * silently skipped; anything that is not an array yields an empty list.
 *
 * @param {string[]|null|undefined} value  GSettings `as` value (or garbage).
 * @returns {Array<{connector: string, uri: string}>}
 */
export function parseMonitorAssignments(value) {
    if (!Array.isArray(value))
        return [];

    const out = [];
    for (const entry of value) {
        if (typeof entry !== 'string')
            continue;
        const sep = entry.indexOf('=');
        // No '=' (sep === -1) or an empty connector (sep === 0) is malformed.
        if (sep <= 0)
            continue;
        const connector = entry.slice(0, sep).trim();
        const uri = entry.slice(sep + 1).trim();
        if (connector.length === 0 || uri.length === 0)
            continue;
        out.push({connector, uri});
    }
    return out;
}

/**
 * Shift monitor rects (which can carry negative x/y on multi-monitor layouts)
 * into a pixel space whose origin is the top-left of their bounding box.
 *
 * @param {Array<{x:number,y:number,width:number,height:number,connector?:string}>} monitors
 * @returns {{rects: Array<object>, width: number, height: number}}
 *          Shifted rects (input order preserved, extra fields kept) plus the
 *          bounding-box size (canvas dimensions). Empty when nothing is valid.
 */
export function normalizeRects(monitors) {
    const list = Array.isArray(monitors) ? monitors : [];
    const valid = [];
    for (const m of list) {
        const width = Math.max(0, Math.floor(Number(m?.width) || 0));
        const height = Math.max(0, Math.floor(Number(m?.height) || 0));
        if (width === 0 || height === 0)
            continue;
        const rect = {
            x: Math.floor(Number(m?.x) || 0),
            y: Math.floor(Number(m?.y) || 0),
            width,
            height,
        };
        if (m && m.connector !== undefined)
            rect.connector = m.connector;
        valid.push(rect);
    }

    if (valid.length === 0)
        return {rects: [], width: 0, height: 0};

    const minX = Math.min(...valid.map((r) => r.x));
    const minY = Math.min(...valid.map((r) => r.y));
    const maxX = Math.max(...valid.map((r) => r.x + r.width));
    const maxY = Math.max(...valid.map((r) => r.y + r.height));

    const rects = valid.map((r) => ({...r, x: r.x - minX, y: r.y - minY}));
    return {rects, width: maxX - minX, height: maxY - minY};
}

/**
 * Absolute cache folder for composited canvases (`<user cache>/mopivo/placement`).
 *
 * @returns {string}
 */
export function wallpaperCacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), CACHE_SUBDIR, CACHE_FOLDER]);
}

/**
 * Load an image from a file:// URI or a plain path. Returns null on failure.
 *
 * @param {string} uri
 * @returns {GdkPixbuf.Pixbuf|null}
 */
function _loadPixbuf(uri) {
    if (typeof uri !== 'string' || uri.length === 0)
        return null;
    let path = uri;
    if (uri.includes('://')) {
        try {
            [path] = GLib.filename_from_uri(uri);
        } catch (_e) {
            return null;
        }
    }
    try {
        return GdkPixbuf.Pixbuf.new_from_file(path);
    } catch (_e) {
        return null;
    }
}

/**
 * Scale-to-cover + center-crop a source pixbuf into width×height (no aspect
 * distortion: the scaled image always covers the rect, overflow is cropped).
 *
 * @param {GdkPixbuf.Pixbuf} src
 * @param {number} width
 * @param {number} height
 * @returns {GdkPixbuf.Pixbuf}
 */
function _coverCrop(src, width, height) {
    const sw = src.get_width();
    const sh = src.get_height();
    if (sw <= 0 || sh <= 0 || width <= 0 || height <= 0)
        return src;

    const scale = Math.max(width / sw, height / sh);
    const scaledW = Math.max(width, Math.round(sw * scale));
    const scaledH = Math.max(height, Math.round(sh * scale));

    let scaled = src;
    if (scaledW !== sw || scaledH !== sh)
        scaled = src.scale_simple(scaledW, scaledH, GdkPixbuf.InterpType.BILINEAR);

    if (scaledW === width && scaledH === height)
        return scaled;

    const offX = Math.floor((scaledW - width) / 2);
    const offY = Math.floor((scaledH - height) / 2);
    return scaled.new_subpixbuf(offX, offY, width, height);
}

/**
 * Composite one image per monitor rect onto a single canvas matching the
 * bounding box of the rects, then save it as PNG.
 *
 * `images[i]` is painted into `rects[i]` (cover semantics). Rects must already
 * be shifted to origin (see `normalizeRects`). Images that fail to load are
 * left as the opaque black canvas background.
 *
 * @param {string[]} images      image URIs (or paths), parallel to `rects`.
 * @param {Array<{x:number,y:number,width:number,height:number}>} rects
 * @param {string} outputPath    PNG destination path.
 * @returns {string} outputPath
 * @throws {Error} when there is nothing to composite or the path is missing.
 */
export function composite(images, rects, outputPath) {
    const imgs = Array.isArray(images) ? images : [];
    const rs = Array.isArray(rects) ? rects : [];
    if (!outputPath || imgs.length === 0 || rs.length === 0)
        throw new Error('composite: images and rects must be non-empty');

    let maxX = 0;
    let maxY = 0;
    for (const r of rs) {
        maxX = Math.max(maxX, (r.x || 0) + r.width);
        maxY = Math.max(maxY, (r.y || 0) + r.height);
    }

    const canvas = GdkPixbuf.Pixbuf.new(
        GdkPixbuf.Colorspace.RGB, true, 8, Math.max(1, maxX), Math.max(1, maxY));
    canvas.fill(0x000000ff);

    const count = Math.min(imgs.length, rs.length);
    for (let i = 0; i < count; i++) {
        const rect = rs[i];
        const src = _loadPixbuf(imgs[i]);
        if (!src)
            continue;
        const tile = _coverCrop(src, rect.width, rect.height);
        tile.composite(
            canvas, rect.x, rect.y, rect.width, rect.height,
            0, 0, 1, 1, GdkPixbuf.InterpType.BILINEAR, 255);
    }

    const dir = GLib.path_get_dirname(outputPath);
    if (dir && dir.length > 0)
        GLib.mkdir_with_parents(dir, 0o755);
    canvas.savev(outputPath, 'png', [], []);
    return outputPath;
}
