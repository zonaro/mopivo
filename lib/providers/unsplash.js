/**
 * Unsplash Provider - GJS/ESM client for the Unsplash API
 *
 * Endpoints used:
 *   GET https://api.unsplash.com/search/photos?query=...&per_page=...&page=...
 *   GET https://api.unsplash.com/photos?per_page=...&page=...  (fallback when query is empty)
 *
 * Requires an API key (https://unsplash.com/developers).
 * Authorization header: Client-ID <key>
 *
 * Usage:
 *   const provider = new UnsplashProvider({session});
 *   const result = await provider.search({q: 'mountains', page: 1, perPage: 24}, session, settings);
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.unsplash.com';
const SEARCH_ENDPOINT = `${API_BASE}/search/photos`;
const PHOTOS_ENDPOINT = `${API_BASE}/photos`;
const MAX_PER_PAGE = 30;
const DEFAULT_PER_PAGE = 24;
const SETTINGS_KEY = 'unsplash-api-key';

// ---------------------------------------------------------------------------
// UnsplashProvider
// ---------------------------------------------------------------------------

export class UnsplashProvider {
    static displayName = 'Unsplash';
    static requiresApiKey = true;
    static websiteUrl = 'https://unsplash.com';
    static keyHelpUrl = 'https://unsplash.com/developers';

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
            throw new Error('Unsplash API key required. Configure it in extension preferences.');

        const apiKey = settings.get_string(SETTINGS_KEY);
        if (!apiKey)
            throw new Error('Unsplash API key required. Get one at https://unsplash.com/developers');

        const sess = session || this._session;
        const clampedPerPage = Math.min(Math.max(1, perPage), MAX_PER_PAGE);
        const url = this._buildUrl(q, page, clampedPerPage);
        const message = Soup.Message.new('GET', url);
        message.get_headers().append('Authorization', `Client-ID ${apiKey}`);

        const text = await this._sendAndRead(sess, message);
        const json = JSON.parse(text);
        return this._normalize(json, page);
    }

    // -----------------------------------------------------------------------
    // URL builder
    // -----------------------------------------------------------------------

    /**
     * Build the request URL. Falls back to /photos endpoint when query is empty.
     *
     * @param {string} q
     * @param {number} page
     * @param {number} perPage
     * @returns {string}
     * @private
     */
    _buildUrl(q, page, perPage) {
        const base = q ? SEARCH_ENDPOINT : PHOTOS_ENDPOINT;
        const parts = [];

        if (q)
            parts.push(`query=${encodeURIComponent(q)}`);

        parts.push(`per_page=${perPage}`);
        parts.push(`page=${page}`);

        return `${base}?${parts.join('&')}`;
    }

    // -----------------------------------------------------------------------
    // Response normalization
    // -----------------------------------------------------------------------

    /**
     * Normalize Unsplash response to the shared provider shape.
     *
     * @param {object} json  Raw Unsplash API response.
     * @param {number} page  Current page number.
     * @returns {{items: Array, total: number, page: number, lastPage: number}}
     * @private
     */
    _normalize(json, page) {
        // Search endpoint returns {results, total, total_pages}
        // /photos endpoint returns [] directly
        const photos = Array.isArray(json) ? json : (json.results || []);
        const total = Array.isArray(json) ? photos.length : (json.total || 0);
        const totalPages = Array.isArray(json) ? 1 : (json.total_pages || 1);
        const lastPage = Math.max(1, totalPages);

        const items = photos.map(photo => ({
            id: String(photo.id),
            previewUrl: photo.urls?.small || photo.urls?.regular || '',
            fullUrl: photo.urls?.full || photo.urls?.raw || '',
            resolution: photo.width && photo.height
                ? `${photo.width}x${photo.height}`
                : '',
            source: photo.user?.name || 'Unsplash',
            sourceUrl: photo.links?.html || '',
            tags: photo.description || photo.alt_description || '',
        }));

        return {items, total, page, lastPage};
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /**
     * Send a Soup.Message, read the full response body, check HTTP status,
     * and return the decoded UTF-8 text.
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
                                'Unsplash API 401/403: Invalid or missing API key'
                            ));
                            return;
                        }
                        if (status === 429) {
                            reject(new Error(
                                'Unsplash API 429: Rate limit exceeded'
                            ));
                            return;
                        }
                        if (status < 200 || status >= 300) {
                            reject(new Error(
                                `Unsplash API ${status}: Unexpected HTTP status`
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
