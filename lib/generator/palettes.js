// SPDX-License-Identifier: GPL-3.0-or-later
// lib/generator/palettes.js — palette discovery + color extraction.
//
// Port of Wallrus `src/palette.rs`. Palettes are tiny vertical images (the
// bundled ones are 1x4 px): the four colors are sampled at the horizontal
// center, one per quarter band, and normalized to 0..1 floats — exactly the
// `extract_colors_from_image` logic, reimplemented on top of GdkPixbuf so we
// do not need the `image` crate or a Rust toolchain.
//
// Categories are the subfolders of `<APP_ROOT>/data/palettes` (cold/, dark/,
// …); loose images directly in the root go into an "Uncategorized" bucket, as
// in the original. Paths are absolute and everything is read lazily.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

/** File extensions treated as palettes. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const UNCATEGORIZED = 'Uncategorized';

/** Root of the installed/checkout tree (parent of lib/). */
function appRoot() {
    // lib/generator/palettes.js → generator → lib → APP_ROOT
    return Gio.File.new_for_uri(import.meta.url)
        .get_parent().get_parent().get_parent();
}

/**
 * Absolute path to the bundled palettes directory (`<APP_ROOT>/data/palettes`).
 * @returns {string}
 */
export function palettesDir() {
    return GLib.build_filenamev([appRoot().get_path(), 'data', 'palettes']);
}

function _isImage(name) {
    const lower = name.toLowerCase();
    return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function _listFiles(dir) {
    const out = [];
    let enumerator;
    try {
        enumerator = dir.enumerate_children(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return out;
    }
    let info;
    while ((info = enumerator.next_file(null)) !== null)
        out.push({name: info.get_name(), isDir: info.get_file_type() === Gio.FileType.DIRECTORY});
    return out;
}

/**
 * List palette categories with their image paths.
 *
 * Subfolders become categories (sorted by name); loose images in the root are
 * grouped under "Uncategorized". Images inside each category are sorted by
 * filename. Mirrors `palette::list_palette_categories`.
 *
 * @returns {Array<{name: string, images: string[]}>}
 */
export function listCategories() {
    const root = Gio.File.new_for_path(palettesDir());
    if (!root.query_exists(null))
        return [];

    const categories = [];
    const rootImages = [];
    const entries = _listFiles(root);

    for (const entry of entries) {
        if (entry.isDir) {
            const sub = root.get_child(entry.name);
            const images = _listFiles(sub)
                .filter(f => !f.isDir && _isImage(f.name))
                .map(f => GLib.build_filenamev([sub.get_path(), f.name]))
                .sort((a, b) => GLib.path_get_basename(a)
                    .localeCompare(GLib.path_get_basename(b)));
            if (images.length)
                categories.push({name: entry.name, images});
        } else if (_isImage(entry.name)) {
            rootImages.push(GLib.build_filenamev([root.get_path(), entry.name]));
        }
    }

    categories.sort((a, b) => a.name.localeCompare(b.name));
    if (rootImages.length) {
        rootImages.sort((a, b) => GLib.path_get_basename(a)
            .localeCompare(GLib.path_get_basename(b)));
        categories.push({name: UNCATEGORIZED, images: rootImages});
    }
    return categories;
}

/**
 * Extract the four palette colors from an image path.
 *
 * @param {string} path absolute path to a palette image
 * @returns {Array<[number, number, number]>} four RGB triples in 0..1
 * @throws {Error} if the image cannot be loaded or has zero dimensions
 */
export function extractColors(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    if (width === 0 || height === 0)
        throw new Error('Palette image has zero dimensions');

    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();
    const pixels = pixbuf.get_pixels();

    const cx = Math.floor(width / 2);
    const bandHeight = Math.floor(height / 4);

    const colors = [];
    for (let i = 0; i < 4; i++) {
        let cy = bandHeight * i + Math.floor(bandHeight / 2);
        cy = Math.min(cy, height - 1);
        const offset = cy * rowstride + cx * channels;
        colors.push([
            pixels[offset] / 255.0,
            pixels[offset + 1] / 255.0,
            pixels[offset + 2] / 255.0,
        ]);
    }
    return colors;
}

/**
 * Flatten `listCategories()` into a single array of image paths across every
 * category (used by the randomize button).
 * @returns {string[]}
 */
export function allPalettePaths() {
    const paths = [];
    for (const cat of listCategories())
        paths.push(...cat.images);
    return paths;
}

/**
 * Pick a random palette path across all categories, or null when none exist.
 * @param {() => number} [rand] injectable RNG in [0,1)
 * @returns {string|null}
 */
export function pickRandomPath(rand = Math.random) {
    const paths = allPalettePaths();
    if (!paths.length)
        return null;
    return paths[Math.floor(rand() * paths.length) % paths.length];
}
