/**
 * Wallhaven API v1 — raw HTTP client.
 *
 * Provides low-level methods: search, getWallpaper, getTag,
 * getCollections, getSettings, downloadToFile.
 *
 * @module wallhaven-client
 */

import Soup from 'gi://Soup?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WALLHAVEN_DEFAULTS = {
    q: '',
    categories: '111',
    purity: '100',
    sorting: 'date_added',
    order: 'desc',
    topRange: '1M',
    atleast: '',
    resolutions: '',
    ratios: '',
    colors: '',
    page: 1,
    seed: '',
    ai_art_filter: '',
};

export const WALLHAVEN_COLORS = [
    '660000', '990e48', 'cc0000', 'ff0000', 'ff4d00',
    'ff9900', 'fccc00', 'ffff00', 'ccff00', '66ff00',
    '00ff00', '00ff99', '00ffcc', '00ffff', '0099ff',
    '004dff', '0000ff', '4d00ff', '9900ff', 'ff00ff',
    'ff0099', 'ff004d', '000000', '434343', 'b3b3b3',
    'ffffff', '1a1a2e', '16213e', '0f3460',
];

export const SORT_OPTIONS = [
    'date_added', 'relevance', 'random', 'views', 'favorites', 'toplist',
];

export const TOPRANGE_OPTIONS = [
    '1d', '3d', '1w', '1M', '3M', '6M', '1y',
];

export const RATIO_PRESETS = [
    'landscape', 'portrait', 'square', 'ultrawide',
    '16x9', '16x10', '4x3', '3x2', '21x9', '32x9',
    '9x16', '9x21', '5x4',
];

export const RESOLUTION_PRESETS = [
    '1920x1080', '2560x1440', '3840x2160', '7680x4320',
    '2560x1080', '3440x1440', '5120x2160',
    '1080x1920', '1440x2560', '2160x3840',
    '1024x768', '1280x1024', '1600x900',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert category booleans to 3-char bitmask (e.g. '111'). */
export function categoriesToMask({general = true, anime = true, people = true} = {}) {
    return `${general ? 1 : 0}${anime ? 1 : 0}${people ? 1 : 0}`;
}

/** Convert purity booleans to 3-char bitmask (e.g. '100'). */
export function purityToMask({sfw = true, sketchy = false, nsfw = false} = {}) {
    return `${sfw ? 1 : 0}${sketchy ? 1 : 0}${nsfw ? 1 : 0}`;
}

/** Join array or comma-separated string into a single comma-delimited string. */
export function joinList(list) {
    if (Array.isArray(list)) return list.join(',');
    if (typeof list === 'string') return list;
    return '';
}

// ---------------------------------------------------------------------------
// WallhavenClient
// ---------------------------------------------------------------------------

export class WallhavenClient {
    /**
     * @param {{apiKey?: string, session?: Soup.Session}} opts
     */
    constructor({apiKey = '', session = null} = {}) {
        this._apiKey = apiKey;
        this._session = session || new Soup.Session();
    }

    setApiKey(key) {
        this._apiKey = key;
    }

    // -----------------------------------------------------------------------
    // URL builder
    // -----------------------------------------------------------------------

    buildSearchUrl(params = {}) {
        const p = {...WALLHAVEN_DEFAULTS, ...params};
        const parts = [];
        const add = (k, v) => {
            if (v !== undefined && v !== null && v !== '')
                parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        };

        if (p.q) add('q', p.q);
        add('categories', p.categories);
        add('purity', p.purity);
        add('sorting', p.sorting);
        add('order', p.order);
        if (p.sorting === 'toplist' && p.topRange) add('topRange', p.topRange);
        if (p.atleast) add('atleast', p.atleast);

        const resolutions = joinList(p.resolutions);
        if (resolutions) add('resolutions', resolutions);

        const ratios = joinList(p.ratios);
        if (ratios) add('ratios', ratios);

        const colors = joinList(p.colors);
        if (colors) add('colors', colors);

        if (p.page && p.page > 1) add('page', p.page);
        if (p.sorting === 'random' && p.seed) add('seed', p.seed);

        if (p.ai_art_filter !== '' && p.ai_art_filter !== undefined && p.ai_art_filter !== null)
            add('ai_art_filter', p.ai_art_filter);

        return `https://wallhaven.cc/api/v1/search${parts.length ? '?' + parts.join('&') : ''}`;
    }

    // -----------------------------------------------------------------------
    // API methods
    // -----------------------------------------------------------------------

    async search(params = {}) {
        const url = this.buildSearchUrl(params);
        const message = Soup.Message.new('GET', url);
        if (this._apiKey)
            message.get_headers().append('X-API-Key', this._apiKey);
        const text = await this._sendAndRead(message);
        return JSON.parse(text);
    }

    async getWallpaper(id) {
        const url = `https://wallhaven.cc/api/v1/w/${encodeURIComponent(id)}`;
        const message = Soup.Message.new('GET', url);
        if (this._apiKey)
            message.get_headers().append('X-API-Key', this._apiKey);
        const text = await this._sendAndRead(message);
        return JSON.parse(text);
    }

    async getTag(id) {
        const url = `https://wallhaven.cc/api/v1/tag/${encodeURIComponent(String(id))}`;
        const message = Soup.Message.new('GET', url);
        if (this._apiKey)
            message.get_headers().append('X-API-Key', this._apiKey);
        const text = await this._sendAndRead(message);
        return JSON.parse(text);
    }

    async getCollections(username, apikey) {
        const key = apikey || this._apiKey;
        if (!key)
            throw new Error('Wallhaven API: API key required for collections endpoint');
        const url = `https://wallhaven.cc/api/v1/collections/${encodeURIComponent(username)}?apikey=${encodeURIComponent(key)}`;
        const message = Soup.Message.new('GET', url);
        const text = await this._sendAndRead(message);
        return JSON.parse(text);
    }

    async getSettings() {
        if (!this._apiKey)
            throw new Error('Wallhaven API: API key required for settings endpoint');
        const url = `https://wallhaven.cc/api/v1/settings?apikey=${encodeURIComponent(this._apiKey)}`;
        const message = Soup.Message.new('GET', url);
        const text = await this._sendAndRead(message);
        return JSON.parse(text);
    }

    async downloadToFile(url, destPath) {
        const message = Soup.Message.new('GET', url);
        if (this._apiKey)
            message.get_headers().append('X-API-Key', this._apiKey);
        const bytes = await this._sendAndReadRaw(message);
        const file = Gio.File.new_for_path(destPath);
        const parent = file.get_parent();
        if (parent && !parent.query_exists(null))
            parent.make_directory_with_parents(null);

        return new Promise((resolve, reject) => {
            file.replace_contents_async(
                bytes.get_data(),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                GLib.PRIORITY_DEFAULT, null,
                (source, result) => {
                    try {
                        source.replace_contents_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    _sendAndRead(message) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null,
                (sess, result) => {
                    try {
                        const status = message.get_status();
                        if (status === 401) {
                            reject(new Error('Wallhaven API 401: Invalid API key or NSFW content requested without API key'));
                            return;
                        }
                        if (status === 404) {
                            reject(new Error('Wallhaven API 404: Resource not found'));
                            return;
                        }
                        if (status === 429) {
                            reject(new Error('Wallhaven API 429: Rate limit exceeded (max 45 requests/minute)'));
                            return;
                        }
                        if (status < 200 || status >= 300) {
                            reject(new Error(`Wallhaven API ${status}: Unexpected HTTP status`));
                            return;
                        }
                        const bytes = sess.send_and_read_finish(result);
                        const text = new TextDecoder().decode(bytes.get_data());
                        resolve(text);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    _sendAndReadRaw(message) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message, GLib.PRIORITY_DEFAULT, null,
                (sess, result) => {
                    try {
                        const status = message.get_status();
                        if (status === 401) {
                            reject(new Error('Wallhaven API 401: Invalid API key'));
                            return;
                        }
                        if (status === 404) {
                            reject(new Error('Wallhaven API 404: Resource not found'));
                            return;
                        }
                        if (status === 429) {
                            reject(new Error('Wallhaven API 429: Rate limit exceeded (max 45 requests/minute)'));
                            return;
                        }
                        if (status < 200 || status >= 300) {
                            reject(new Error(`Wallhaven API ${status}: Unexpected HTTP status`));
                            return;
                        }
                        const bytes = sess.send_and_read_finish(result);
                        resolve(bytes);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }
}
