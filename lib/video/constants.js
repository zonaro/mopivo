// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper subsystem — shared constants (contract for all video modules).

// D-Bus bus name / window-title application id of the renderer subprocess.
// Must be a valid D-Bus name (dot-separated, no hyphens).
export const APPLICATION_ID = 'org.redclaw.WallpaperProvidersRenderer';

// D-Bus object path exposed by the renderer.
export const RENDERER_OBJECT_PATH = '/org/redclaw/WallpaperProvidersRenderer';

// GSettings schema id of the extension (read by the renderer subprocess too).
export const EXT_SCHEMA_ID = 'org.gnome.shell.extensions.wallpaper-providers-gnome';
export const EXT_SCHEMA_PATH = '/org/gnome/shell/extensions/wallpaper-providers-gnome/';

// Common local video file extensions (lowercase, with leading dot).
export const VIDEO_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v', '.ogv',
];

// MIME types accepted when picking video files.
export const VIDEO_MIME_TYPES = [
    'video/*',
];

// Log prefix — extension modules log as '[wp]', video modules as '[wp-video]'.
export const LOG_PREFIX = '[wp-video]';

// Renderer window title protocol: `@${APPLICATION_ID}!${JSON.stringify(state)}|${monitorIndex}`.
// Anchor string used to identify renderer windows.
export const TITLE_ANCHOR = `@${APPLICATION_ID}!`;

// Startup flags read by the renderer subprocess.
export const ARG_EXT_PATH = '-P';
export const ARG_FILE_PATH = '-F';