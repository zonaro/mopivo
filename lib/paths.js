// SPDX-License-Identifier: GPL-3.0-or-later
// lib/paths.js — canonical user-directory resolution for Mopivo.
//
// Single source of truth for the folders the app downloads into:
//   * downloaded images  → ~/Pictures/Mopivo   (or the XDG Pictures dir)
//   * downloaded videos  → ~/Videos/Mopivo     (or the XDG Videos dir)
//
// The `download-folder` / `video-folder` GSettings keys keep an empty default
// (GSettings cannot compute home paths), so an empty value means "use the
// default below". Both the app UI and the video controller resolve through
// these helpers so the behaviour stays identical everywhere.

import GLib from 'gi://GLib';

const APP_SUBFOLDER = 'Mopivo';

/**
 * Resolve the user's Pictures directory, falling back to ~/Pictures when the
 * XDG special dir is not defined.
 * @returns {string}
 */
export function getPicturesDir() {
    const special = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
    if (special && special.length > 0)
        return special;
    return GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']);
}

/**
 * Resolve the user's Videos directory, falling back to ~/Videos when the
 * XDG special dir is not defined.
 * @returns {string}
 */
export function getVideosDir() {
    const special = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
    if (special && special.length > 0)
        return special;
    return GLib.build_filenamev([GLib.get_home_dir(), 'Videos']);
}

/**
 * Default folder for downloaded images: <Pictures>/Mopivo.
 * @returns {string}
 */
export function getDefaultImageDownloadDir() {
    return GLib.build_filenamev([getPicturesDir(), APP_SUBFOLDER]);
}

/**
 * Default folder for downloaded videos: <Videos>/Mopivo.
 * @returns {string}
 */
export function getDefaultVideoDir() {
    return GLib.build_filenamev([getVideosDir(), APP_SUBFOLDER]);
}

/**
 * Resolve the effective image download folder from settings.
 * Empty (or absent) `download-folder` means the pictures default.
 *
 * @param {object} [settings] Gio.Settings or a {get_string} stub.
 * @returns {string}
 */
export function resolveDownloadFolder(settings) {
    const value = settings?.get_string?.('download-folder') ?? '';
    return typeof value === 'string' && value.length > 0
        ? value
        : getDefaultImageDownloadDir();
}

/**
 * Resolve the effective video folder from settings.
 * Empty (or absent) `video-folder` means the videos default.
 *
 * @param {object} [settings] Gio.Settings or a {get_string} stub.
 * @returns {string}
 */
export function resolveVideoFolder(settings) {
    const value = settings?.get_string?.('video-folder') ?? '';
    return typeof value === 'string' && value.length > 0
        ? value
        : getDefaultVideoDir();
}
