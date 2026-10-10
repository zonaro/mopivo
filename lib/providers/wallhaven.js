/**
 * WallhavenProvider — provider abstraction for Wallhaven.
 *
 * Wraps WallhavenClient (wallhaven-client.js) and normalizes its output
 * to the common NormalizedResult shape defined in base.js.
 *
 * Re-exports all WallhavenClient symbols for backward compatibility,
 * so existing code can import everything from this module.
 *
 * @module wallhaven-provider
 */

import {BaseProvider} from './base.js';
import {
    WallhavenClient,
    WALLHAVEN_DEFAULTS,
    WALLHAVEN_COLORS,
    SORT_OPTIONS,
    TOPRANGE_OPTIONS,
    RATIO_PRESETS,
    RESOLUTION_PRESETS,
    categoriesToMask,
    purityToMask,
    joinList,
} from './wallhaven-client.js';

// Re-export all WallhavenClient symbols for backward compat
export {
    WallhavenClient,
    WALLHAVEN_DEFAULTS,
    WALLHAVEN_COLORS,
    SORT_OPTIONS,
    TOPRANGE_OPTIONS,
    RATIO_PRESETS,
    RESOLUTION_PRESETS,
    categoriesToMask,
    purityToMask,
    joinList,
};

// ---------------------------------------------------------------------------
// WallhavenProvider
// ---------------------------------------------------------------------------

export class WallhavenProvider extends BaseProvider {
    /**
     * @param {{apiKey?: string, session?: Soup.Session}} opts
     */
    constructor({apiKey = '', session = null} = {}) {
        super();
        this._client = new WallhavenClient({apiKey, session});
    }

    /** @returns {'wallhaven'} */
    get id() {
        return 'wallhaven';
    }

    /** @returns {'Wallhaven'} */
    get displayName() {
        return 'Wallhaven';
    }

    /** @returns {boolean} */
    get requiresApiKey() {
        return false; // Basic search works without key; NSFW requires one
    }

    /** @returns {'https://wallhaven.cc'} */
    get websiteUrl() {
        return 'https://wallhaven.cc';
    }

    /** @returns {'https://wallhaven.cc/settings#api-key'} */
    get keyHelpUrl() {
        return 'https://wallhaven.cc/settings#api-key';
    }

    /**
     * Update the API key at runtime.
     * @param {string} key
     */
    setApiKey(key) {
        this._client.setApiKey(key);
    }

    /**
     * Expose the underlying WallhavenClient for direct API access.
     * @returns {WallhavenClient}
     */
    get client() {
        return this._client;
    }

    // -----------------------------------------------------------------------
    // Provider interface
    // -----------------------------------------------------------------------

    /**
     * Search wallpapers and return normalized results.
     *
     * @param {object}       params   Wallhaven search parameters (q, categories, purity, etc.)
     * @param {Soup.Session} session  Shared Soup session (unused; client has its own)
     * @param {Gio.Settings} settings Extension GSettings (used for API key)
     * @returns {Promise<import('./base.js').NormalizedResult>}
     */
    async search(params, session, settings) {
        // Sync API key from settings
        const apiKey = settings.get_string('api-key');
        if (apiKey)
            this._client.setApiKey(apiKey);

        const raw = await this._client.search(params);

        return _normalizeResult(raw, this.id);
    }

    // -----------------------------------------------------------------------
    // Overridden helpers
    // -----------------------------------------------------------------------

    /**
     * Download a file using the WallhavenClient (includes API key header).
     *
     * @param {string}       url
     * @param {string}       destPath
     * @param {Soup.Session} session  Unused; client uses its own session
     * @returns {Promise<void>}
     */
    async downloadToFile(url, destPath, session) {
        return this._client.downloadToFile(url, destPath);
    }

    /**
     * Check if provider is configured. Wallhaven works without API key
     * for SFW content, so always returns true.
     *
     * @param {Gio.Settings} settings
     * @returns {boolean}
     */
    isConfigured(_settings) {
        return true;
    }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Convert raw Wallhaven API response to NormalizedResult.
 *
 * Field mapping (raw -> normalized):
 *   data[].id          -> id           (string)
 *   data[].thumbs.small -> previewUrl  (string)
 *   data[].path        -> fullUrl      (string)
 *   data[].resolution  -> resolution   (string, e.g. "1920x1080")
 *   data[].thumbs.small -> (parsed)    -> previewWidth/Height (number)
 *   'wallhaven'        -> source       (string)
 *   data[].url         -> sourceUrl    (string)
 *   data[].purity      -> purity       (string, e.g. "sfw")
 *   data[].tags[].name -> tags         (string[])
 *
 * @param {object} raw        Raw Wallhaven API response {data, meta}
 * @param {string} sourceId   Provider identifier
 * @returns {import('./base.js').NormalizedResult}
 */
function _normalizeResult(raw, sourceId) {
    const items = (raw.data || []).map(wall => ({
        id: wall.id,
        previewUrl: wall.thumbs?.small || wall.thumbs?.medium || wall.thumbs?.large || '',
        fullUrl: wall.path || '',
        resolution: wall.resolution || '',
        previewWidth: _parseWidth(wall.resolution),
        previewHeight: _parseHeight(wall.resolution),
        source: sourceId,
        sourceUrl: wall.url || '',
        purity: wall.purity || undefined,
        tags: Array.isArray(wall.tags)
            ? wall.tags.map(t => t.name || t)
            : undefined,
    }));

    const meta = raw.meta || {};

    return {
        items,
        total: meta.total || items.length,
        page: meta.current_page || 1,
        lastPage: meta.last_page || 1,
    };
}

/**
 * Parse width from "WxH" resolution string.
 * @param {string} res e.g. "1920x1080"
 * @returns {number}
 */
function _parseWidth(res) {
    if (!res || typeof res !== 'string') return 0;
    const idx = res.indexOf('x');
    if (idx <= 0) return 0;
    const w = parseInt(res.substring(0, idx), 10);
    return Number.isFinite(w) ? w : 0;
}

/**
 * Parse height from "WxH" resolution string.
 * @param {string} res e.g. "1920x1080"
 * @returns {number}
 */
function _parseHeight(res) {
    if (!res || typeof res !== 'string') return 0;
    const idx = res.indexOf('x');
    if (idx < 0) return 0;
    const h = parseInt(res.substring(idx + 1), 10);
    return Number.isFinite(h) ? h : 0;
}
