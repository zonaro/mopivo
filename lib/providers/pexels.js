/**
 * Pexels Provider - GJS/ESM client for the Pexels API
 *
 * Endpoints used (images):
 *   GET https://api.pexels.com/v1/search?query=...&per_page=...&page=...
 *   GET https://api.pexels.com/v1/curated?per_page=...&page=...  (fallback when query is empty)
 *
 * Endpoints used (videos):
 *   GET https://api.pexels.com/videos/search?query=...&per_page=...&page=...
 *   GET https://api.pexels.com/videos/popular?per_page=...&page=...  (fallback when query is empty)
 *
 * Requires an API key (https://www.pexels.com/api/).
 * Disabled until configured in extension preferences.
 *
 * Usage:
 *   const provider = new PexelsProvider({session});
 *   const result = await provider.search({q: 'mountains', page: 1, perPage: 24}, session, settings);
 *   const videos = await provider.searchVideos({q: 'ocean', page: 1, perPage: 10}, session, settings);
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.pexels.com/v1';
const SEARCH_ENDPOINT = `${API_BASE}/search`;
const CURATED_ENDPOINT = `${API_BASE}/curated`;
const VIDEO_API_BASE = 'https://api.pexels.com/videos';
const VIDEO_SEARCH_ENDPOINT = `${VIDEO_API_BASE}/search`;
const VIDEO_POPULAR_ENDPOINT = `${VIDEO_API_BASE}/popular`;
const MAX_PER_PAGE = 80;
const DEFAULT_PER_PAGE = 24;
const SETTINGS_KEY = 'pexels-api-key';
const MAX_VIDEO_WIDTH = 1920;

// ---------------------------------------------------------------------------
// PexelsProvider
// ---------------------------------------------------------------------------

export class PexelsProvider {
    static displayName = 'Pexels';
    static requiresApiKey = true;
    static supportsVideo = true;
    static websiteUrl = 'https://www.pexels.com';
    static keyHelpUrl = 'https://www.pexels.com/api/';

    /**
     * @param {{session?: Soup.Session}} opts
     */
    constructor({session = null} = {}) {
        this._session = session || new Soup.Session();
    }

    /**
     * Check if this provider is configured (API key is non-empty).
     * @param {Gio.Settings} settings
     * @returns {boolean}
     */
    isConfigured(settings) {
        const key = settings.get_string(SETTINGS_KEY);
        return typeof key === 'string' && key.length > 0;
    }

    /**
     * Search for photos.
     *
     * @param {{q?: string, page?: number, perPage?: number}} params
     * @param {Soup.Session} [session]   Optional override session.
     * @param {Gio.Settings} [settings]  Required to read API key.
     * @returns {Promise<{items: Array, total: number, page: number, lastPage: number}>}
     */
    async search({q = '', page = 1, perPage = DEFAULT_PER_PAGE} = {}, session = null, settings = null) {
        if (!settings)
            throw new Error('Pexels API key required. Configure it in extension preferences.');

        const apiKey = settings.get_string(SETTINGS_KEY);
        if (!apiKey)
            throw new Error('Pexels API key required. Get one at https://www.pexels.com/api/');

        const sess = session || this._session;
        const clampedPerPage = Math.min(Math.max(1, perPage), MAX_PER_PAGE);
        const url = this._buildUrl(q, page, clampedPerPage);
        const message = Soup.Message.new('GET', url);
        message.get_headers().append('Authorization', apiKey);

        const text = await this._sendAndRead(sess, message);
        const json = JSON.parse(text);
        return this._normalize(json, page);
    }

    /**
     * Search for videos (Pexels Videos API).
     *
     * @param {{q?: string, page?: number, perPage?: number}} params
     * @param {Soup.Session} [session]   Optional override session.
     * @param {Gio.Settings} [settings]  Required to read API key.
     * @returns {Promise<{items: Array, total: number, page: number, lastPage: number}>}
     */
    async searchVideos({q = '', page = 1, perPage = DEFAULT_PER_PAGE} = {}, session = null, settings = null) {
        if (!settings)
            throw new Error('Pexels API key required. Configure it in extension preferences.');

        const apiKey = settings.get_string(SETTINGS_KEY);
        if (!apiKey)
            throw new Error('Pexels API key required. Get one at https://www.pexels.com/api/');

        const sess = session || this._session;
        const clampedPerPage = Math.min(Math.max(1, perPage), MAX_PER_PAGE);
        const url = this._buildVideoUrl(q, page, clampedPerPage);
        const message = Soup.Message.new('GET', url);
        message.get_headers().append('Authorization', apiKey);

        const text = await this._sendAndRead(sess, message);
        const json = JSON.parse(text);
        return this._normalizeVideo(json, page);
    }

    // -----------------------------------------------------------------------
    // URL builder
    // -----------------------------------------------------------------------

    /**
     * Build the request URL. Falls back to curated endpoint when query is empty.
     *
     * @param {string} q
     * @param {number} page
     * @param {number} perPage
     * @returns {string}
     * @private
     */
    _buildUrl(q, page, perPage) {
        const hasQuery = q && q.trim();
        const base = hasQuery ? SEARCH_ENDPOINT : CURATED_ENDPOINT;
        const parts = [];

        if (hasQuery)
            parts.push(`query=${encodeURIComponent(hasQuery)}`);

        parts.push(`per_page=${perPage}`);
        parts.push(`page=${page}`);

        return `${base}?${parts.join('&')}`;
    }

    // -----------------------------------------------------------------------
    // Response normalization
    // -----------------------------------------------------------------------

    /**
     * Normalize Pexels response to the shared provider shape.
     *
     * @param {object} json  Raw Pexels API response.
     * @param {number} page  Current page number.
     * @returns {{items: Array, total: number, page: number, lastPage: number}}
     * @private
     */
    _normalize(json, page) {
        const photos = json.photos || [];
        const perPage = photos.length || 1;
        const total = json.total_results || 0;
        const lastPage = Math.max(1, Math.ceil(total / perPage));

        const items = photos.map(photo => ({
            id: String(photo.id),
            previewUrl: photo.src?.medium || photo.src?.small || '',
            fullUrl: photo.src?.original || photo.src?.large2x || photo.src?.large || '',
            resolution: photo.width && photo.height
                ? `${photo.width}x${photo.height}`
                : '',
            source: photo.photographer || 'Pexels',
            sourceUrl: photo.url || '',
            tags: photo.alt || '',
        }));

        return {items, total, page, lastPage};
    }

    /**
     * Build the video request URL. Falls back to the popular endpoint when the
     * query is empty (Pexels has no empty-query video search).
     *
     * @param {string} q
     * @param {number} page
     * @param {number} perPage
     * @returns {string}
     * @private
     */
    _buildVideoUrl(q, page, perPage) {
        const base = q ? VIDEO_SEARCH_ENDPOINT : VIDEO_POPULAR_ENDPOINT;
        const parts = [];

        if (q)
            parts.push(`query=${encodeURIComponent(q)}`);

        parts.push(`per_page=${perPage}`);
        parts.push(`page=${page}`);

        return `${base}?${parts.join('&')}`;
    }

    /**
     * Normalize a Pexels Videos response to the shared video item shape.
     *
     * @param {object} json  Raw Pexels Videos API response.
     * @param {number} page  Current page number.
     * @returns {{items: Array, total: number, page: number, lastPage: number}}
     * @private
     */
    _normalizeVideo(json, page) {
        const videos = json.videos || [];
        const perPage = videos.length || 1;
        const total = json.total_results || 0;
        const lastPage = Math.max(1, Math.ceil(total / perPage));

        const items = [];
        for (const video of videos) {
            const file = _pickMp4(video.video_files);
            if (!file)
                continue;
            items.push({
                id: String(video.id),
                previewUrl: video.image || '',
                videoUrl: file.link || '',
                resolution: file.width && file.height
                    ? `${file.width}x${file.height}`
                    : '',
                duration: Number.isFinite(video.duration) ? video.duration : 0,
                source: video.user?.name || 'Pexels',
                sourceUrl: video.url || '',
            });
        }

        return {items, total, page, lastPage};
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /**
     * Send a Soup.Message, read the full response body, check HTTP status,
     * and return the decoded UTF-8 text. Follows the wallhaven.js pattern.
     *
     * @param {Soup.Session} sess
     * @param {Soup.Message} message
     * @returns {Promise<string>}
     * @private
     */
    _sendAndRead(sess, message) {
        return new Promise((resolve, reject) => {
            sess.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (sender, result) => {
                    try {
                        const status = message.get_status();

                        if (status === 401) {
                            reject(new Error(
                                'Pexels API 401: Invalid API key'
                            ));
                            return;
                        }
                        if (status === 429) {
                            reject(new Error(
                                'Pexels API 429: Rate limit exceeded'
                            ));
                            return;
                        }
                        if (status < 200 || status >= 300) {
                            reject(new Error(
                                `Pexels API ${status}: Unexpected HTTP status`
                            ));
                            return;
                        }

                        const bytes = sender.send_and_read_finish(result);
                        const text = new TextDecoder().decode(bytes.get_data());
                        resolve(text);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }
}

/**
 * Pick the best downloadable MP4 from a Pexels `video_files` array:
 * the largest width up to MAX_VIDEO_WIDTH, else the largest width, else the
 * first MP4. Returns null when the item has no MP4 rendition.
 *
 * @param {Array} files  Raw Pexels `video_files`.
 * @returns {object|null}
 */
function _pickMp4(files) {
    if (!Array.isArray(files))
        return null;

    const mp4 = files.filter(f => f && f.file_type === 'video/mp4' && f.link);
    if (mp4.length === 0)
        return null;

    const capped = mp4
        .filter(f => f.width > 0 && f.width <= MAX_VIDEO_WIDTH)
        .sort((a, b) => b.width - a.width);
    if (capped.length > 0)
        return capped[0];

    return mp4.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
}
