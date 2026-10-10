// SPDX-License-Identifier: GPL-3.0-or-later
// Set the GNOME desktop background. Shared by the image gallery and the
// video renderer's static-wallpaper helpers (see lib/video/staticBlur.js).

import Gio from 'gi://Gio';

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
 * Set the desktop wallpaper to a file URI on both light and dark variants.
 *
 * @param {string} uri  A file:// URI pointing to the wallpaper image.
 */
export function setDesktopWallpaper(uri) {
    const bg = getDesktopBackgroundSettings();
    bg.reset('picture-uri');
    bg.reset('picture-uri-dark');
    bg.set_string('picture-uri', uri);
    bg.set_string('picture-uri-dark', uri);
    bg.sync();
    bg.apply();
}
