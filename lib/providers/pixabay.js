/**
 * Pixabay Provider - GJS/ESM client for the Pixabay API
 *
 * Endpoint used (images):
 *   GET https://pixabay.com/api/?key=...&q=...&image_type=photo&per_page=...&page=...&safesearch=true
 *   (empty query falls back to q=wallpaper&editors_choice=true&order=popular)
 *
 * Endpoint used (videos):
 *   GET https://pixabay.com/api/videos/?key=...&q=...&per_page=...&page=...&safesearch=true
 *
 * Requires an API key (https://pixabay.com/api/docs/).
 * Disabled until configured in extension preferences.
 *
 * Usage:
 *   const provider = new PixabayProvider({session});
 *   const result = await provider.search({q: 'sunset', page: 1, perPage: 24}, session, settings);
 *   const videos = await provider.searchVideos({q: 'sunset', page: 1, perPage: 10}, session, settings);
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'https://pixabay.com/api/';
const VIDEO_API_URL = 'https://pixabay.com/api/videos/';
const MAX_PER_PAGE = 200;
const DEFAULT_PER_PAGE = 24;
const SETTINGS_KEY = 'pixabay-api-key';

// Fallback for empty image queries: Pixabay returns no hits for an empty `q`,
// so we search a broad, safe, popular term and pin the curated feed params.
const FALLBACK_QUERY = 'wallpaper';

// ---------------------------------------------------------------------------
// PixabayProvider
// ---------------------------------------------------------------------------

export class PixabayProvider {
    static displayName = 'Pixabay';
    static requiresApiKey = true;
    static supportsVideo = true;
    static websiteUrl = 'https://pixabay.com';
    static keyHelpUrl = 'https://pixabay.com/api/docs/';

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
            throw new Error('Pixabay API key required. Configure it in extension preferences.');

        const apiKey = settings.get_string(SETTINGS_KEY);
        if (!apiKey)
            throw new Error('Pixabay API key required. Get one at https://pixabay.com/api/docs/');

        const sess = session || this._session;
        const clampedPerPage = Math.min(Math.max(1, perPage), MAX_PER_PAGE);
        const url = this._buildUrl(apiKey, q, page, clampedPerPage);
        const message = Soup.Message.new('GET', url);

        const text = await this._sendAndRead(sess, message);
        const json = JSON.parse(text);
        return this._normalize(json, page);
    }

    /**
     * Search for videos (Pixabay Videos API). Pixabay requires a search term.
     *
     * @param {{q?: string, page?: number, perPage?: number}} params
     * @param {Soup.Session} [session]   Optional override session.
     * @param {Gio.Settings} [settings]  Required to read API key.
     * @returns {Promise<{items: Array, total: number, page: number, lastPage: number}>}
     */
    async searchVideos({q = '', page = 1, perPage = DEFAULT_PER_PAGE} = {}, session = null, settings = null) {
        if (!settings)
            throw new Error('Pixabay API key required. Configure it in extension preferences.');

        const apiKey = settings.get_string(SETTINGS_KEY);
        if (!apiKey)
            throw new Error('Pixabay API key required. Get one at https://pixabay.com/api/docs/');

        if (!q || !q.trim())
            throw new Error('Pixabay video search requires a search term.');

        const sess = session || this._session;
        const clampedPerPage = Math.min(Math.max(1, perPage), MAX_PER_PAGE);
        const url = this._buildVideoUrl(apiKey, q, page, clampedPerPage);
        const message = Soup.Message.new('GET', url);

        const text = await this._sendAndRead(sess, message);
        const json = JSON.parse(text);
        return this._normalizeVideo(json, page);
    }

    // -----------------------------------------------------------------------
    // URL builder
    // -----------------------------------------------------------------------

    /**
     * Build the request URL. An empty/loose query falls back to a broad,
     * curated popular search (`q=wallpaper` + `editors_choice=true` +
     * `order=popular`) so a full page of safe hits is always returned.
     *
     * @param {string} apiKey
     * @param {string} q
     * @param {number} page
     * @param {number} perPage
     * @returns {string}
     * @private
     */
    _buildUrl(apiKey, q, page, perPage) {
        const isFallback = !q || !q.trim();
        const query = isFallback ? FALLBACK_QUERY : q.trim();
        const parts = [
            `key=${encodeURIComponent(apiKey)}`,
            `q=${encodeURIComponent(query)}`,
            'image_type=photo',
            'safesearch=true',
            `per_page=${perPage}`,
            `page=${page}`,
        ];

        if (isFallback) {
            parts.push('editors_choice=true');
            parts.push('order=popular');
        }

        return `${API_URL}?${parts.join('&')}`;
    }

    // -----------------------------------------------------------------------
    // Response normalization
    // -----------------------------------------------------------------------

    /**
     * Normalize Pixabay response to the shared provider shape.
     *
     * @param {object} json  Raw Pixabay API response.
     * @param {number} page  Current page number.
     * @returns {{items: Array, total: number, page: number, lastPage: number}}
     * @private
     */
    _normalize(json, page) {
        const hits = json.hits || [];
        const perPage = hits.length || 1;
        const total = json.totalHits || 0;
        const lastPage = Math.max(1, Math.ceil(total / perPage));

        const items = hits.map(hit => ({
            id: String(hit.id),
            previewUrl: hit.previewURL || '',
            fullUrl: hit.largeImageURL || hit.fullHDURL || '',
            resolution: hit.imageWidth && hit.imageHeight
                ? `${hit.imageWidth}x${hit.imageHeight}`
                : '',
            source: hit.user || 'Pixabay',
            sourceUrl: hit.pageURL || '',
            tags: hit.tags || '',
        }));

        return {items, total, page, lastPage};
    }

    /**
     * Build the video request URL.
     *
     * @param {string} apiKey
     * @param {string} q
     * @param {number} page
     * @param {number} perPage
     * @returns {string}
     * @private
     */
    _buildVideoUrl(apiKey, q, page, perPage) {
        const parts = [
            `key=${encodeURIComponent(apiKey)}`,
            `q=${encodeURIComponent(q)}`,
            'safesearch=true',
            `per_page=${perPage}`,
            `page=${page}`,
        ];
        return `${VIDEO_API_URL}?${parts.join('&')}`;
    }

    /**
     * Normalize a Pixabay Videos response to the shared video item shape.
     *
     * @param {object} json  Raw Pixabay Videos API response.
     * @param {number} page  Current page number.
     * @returns {{items: Array, total: number, page: number, lastPage: number}}
     * @private
     */
    _normalizeVideo(json, page) {
        const hits = json.hits || [];
        const perPage = hits.length || 1;
        const total = json.totalHits || 0;
        const lastPage = Math.max(1, Math.ceil(total / perPage));

        const items = [];
        for (const hit of hits) {
            if (!hit.picture_id)
                continue;
            const file = _pickVideo(hit.videos);
            if (!file)
                continue;
            items.push({
                id: String(hit.id),
                previewUrl: `https://i.vimeocdn.com/video/${hit.picture_id}_640x360.jpg`,
                videoUrl: file.url || '',
                resolution: file.width && file.height
                    ? `${file.width}x${file.height}`
                    : '',
                duration: Number.isFinite(hit.duration) ? hit.duration : 0,
                source: hit.user || 'Pixabay',
                sourceUrl: hit.pageURL || '',
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

                        if (status === 401 || status === 403) {
                            reject(new Error(
                                'Pixabay API 401/403: Invalid or missing API key'
                            ));
                            return;
                        }
                        if (status === 429) {
                            reject(new Error(
                                'Pixabay API 429: Rate limit exceeded'
                            ));
                            return;
                        }
                        if (status < 200 || status >= 300) {
                            reject(new Error(
                                `Pixabay API ${status}: Unexpected HTTP status`
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
 * Pick a Pixabay video rendition to download, preferring medium (a good
 * size/quality balance) then small, large and tiny. Returns null when the
 * hit exposes no playable rendition.
 *
 * @param {object} videos  Raw Pixabay `videos` object.
 * @returns {object|null}
 */
function _pickVideo(videos) {
    if (!videos)
        return null;

    for (const key of ['medium', 'small', 'large', 'tiny']) {
        const rendition = videos[key];
        if (rendition && rendition.url)
            return rendition;
    }
    return null;
}
