/**
 * Local Files Provider - search wallpapers in user-local folders.
 *
 * Default folder is the user's Pictures directory
 * (GLib.UserDirectory.DIRECTORY_PICTURES); extra folders come from the
 * 'local-folders' GSettings key (string array) and are editable in the
 * Providers preferences page. 'local-recursive' toggles subfolder search.
 *
 * No API key, no network. Results are sorted by modification time
 * (newest first) and paginated in memory. The query filters by filename
 * (case-insensitive substring); empty query returns everything.
 *
 * Items expose file:// URIs; the shared download helper copies them into
 * the thumbnail cache, so the gallery works unchanged.
 *
 * Usage:
 *   const provider = new LocalProvider();
 *   const result = await provider.search({q: 'sunset', page: 1, perPage: 24}, null, settings);
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp',
    'tif', 'tiff', 'svg', 'avif', 'jxl', 'heic', 'heif',
];
const MAX_DEPTH = 8;
const MAX_FILES = 10000;
const DEFAULT_PER_PAGE = 24;

/**
 * Default Pictures folder, or empty string when unavailable.
 *
 * @returns {string}
 */
export function getDefaultPicturesDir() {
    const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
    return dir || '';
}

// ---------------------------------------------------------------------------
// LocalProvider
// ---------------------------------------------------------------------------

export class LocalProvider {
    static displayName = 'Local Files';
    static requiresApiKey = false;
    static websiteUrl = '';
    static keyHelpUrl = '';

    constructor() {}

    /**
     * Configured when at least one search folder exists.
     *
     * @param {Gio.Settings} [settings]  Extension GSettings instance.
     * @returns {boolean}
     */
    isConfigured(settings = null) {
        return this._resolveFolders(settings).some(f => f.query_exists(null));
    }

    /**
     * Search local images by filename.
     *
     * @param {{q?: string, page?: number, perPage?: number}} params
     * @param {Soup.Session} [session]   Unused (no network).
     * @param {Gio.Settings} [settings]  Reads local-folders / local-recursive.
     * @returns {Promise<{items: Array, total: number, page: number, lastPage: number}>}
     */
    async search({q = '', page = 1, perPage = DEFAULT_PER_PAGE} = {}, session = null, settings = null) {
        const folders = this._resolveFolders(settings).filter(f => {
            try {
                return f.query_exists(null);
            } catch (_skip) {
                return false;
            }
        });

        if (!folders.length)
            throw new Error('Local Files: no folders found. Check the Providers settings.');

        let recursive = true;
        try {
            recursive = settings ? settings.get_boolean('local-recursive') : true;
        } catch (_skip) {
            recursive = true;
        }

        const collected = [];
        for (const folder of folders)
            this._walk(folder, recursive, 0, collected);

        const needle = q.trim().toLowerCase();
        const matched = needle
            ? collected.filter(f => f.name.toLowerCase().includes(needle))
            : collected;

        matched.sort((a, b) => b.mtime - a.mtime);

        const total = matched.length;
        const safePerPage = Math.max(1, perPage);
        const lastPage = Math.max(1, Math.ceil(total / safePerPage));
        const safePage = Math.min(Math.max(1, page), lastPage);
        const slice = matched.slice((safePage - 1) * safePerPage, safePage * safePerPage);

        return {items: slice.map(_normalize), total, page: safePage, lastPage};
    }

    // -----------------------------------------------------------------------
    // Folder resolution
    // -----------------------------------------------------------------------

    /**
     * Default Pictures folder plus configured extras, deduplicated.
     *
     * @param {Gio.Settings} [settings]
     * @returns {Gio.File[]}
     * @private
     */
    _resolveFolders(settings) {
        const paths = [];
        const pictures = getDefaultPicturesDir();
        if (pictures)
            paths.push(pictures);

        try {
            const extras = settings ? settings.get_strv('local-folders') : [];
            for (const p of extras) {
                const trimmed = (p || '').trim();
                if (trimmed)
                    paths.push(trimmed);
            }
        } catch (_skip) {
            // Missing key (older schema) — Pictures folder only.
        }

        const seen = new Set();
        const folders = [];
        for (const p of paths) {
            if (seen.has(p))
                continue;
            seen.add(p);
            folders.push(Gio.File.new_for_path(p));
        }
        return folders;
    }

    // -----------------------------------------------------------------------
    // Recursive walk
    // -----------------------------------------------------------------------

    /**
     * Walk a folder collecting image files (sync; header-only IO per dir).
     *
     * @param {Gio.File} dir        Folder to scan.
     * @param {boolean} recursive   Descend into subfolders.
     * @param {number} depth        Current depth (capped).
     * @param {Array} out           Collector.
     * @private
     */
    _walk(dir, recursive, depth, out) {
        if (depth > MAX_DEPTH || out.length >= MAX_FILES)
            return;

        let enumerator = null;
        try {
            enumerator = dir.enumerate_children(
                'standard::name,standard::type,time::modified',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch (_skip) {
            return;
        }

        try {
            let info = null;
            while (out.length < MAX_FILES && (info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith('.'))
                    continue;
                const child = enumerator.get_child(info);
                const ftype = info.get_file_type();
                if (ftype === Gio.FileType.DIRECTORY) {
                    if (recursive)
                        this._walk(child, recursive, depth + 1, out);
                } else if (ftype === Gio.FileType.REGULAR && _isImage(name)) {
                    out.push({
                        uri: child.get_uri(),
                        name,
                        mtime: info.get_attribute_uint64('time::modified'),
                        folder: dir.get_basename(),
                    });
                }
            }
        } catch (_skip) {
            // Unreadable entries are skipped; keep what was collected.
        } finally {
            try {
                enumerator.close(null);
            } catch (_skip) {
                // Nothing to release.
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function _isImage(name) {
    const dot = name.lastIndexOf('.');
    if (dot < 0)
        return false;
    return IMAGE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

function _normalize(file) {
    return {
        id: GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, file.uri, -1),
        previewUrl: file.uri,
        fullUrl: file.uri,
        resolution: '',
        source: 'Local Files',
        sourceUrl: file.uri,
        tags: file.folder || '',
    };
}
