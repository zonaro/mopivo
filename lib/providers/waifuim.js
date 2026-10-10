/**
 * Waifu.im Provider - GJS/ESM client for the Waifu.im API (v5)
 *
 * Endpoint used:
 *   GET https://api.waifu.im/search
 *       ?included_tags=<slugs>&many=true&is_nsfw=false&order_by=RANDOM
 *
 * Docs: https://docs.waifu.im/ — OpenAPI spec, no API key required for search.
 * many=true returns up to 30 images; the API has no page parameter, so each
 * search is a single page of fresh random results (lastPage is always 1).
 * Empty query falls back to the API default tag ("waifu").
 *
 * Tag slugs use hyphens (e.g. "raiden-shogun"); user spaces are converted.
 * is_nsfw is always false — this provider only serves SFW content.
 * Rate limit: 1 request / 200ms (429 when the server queue is full).
 *
 * Usage:
 *   const provider = new WaifuimProvider({session});
 *   const result = await provider.search({q: 'maid', page: 1}, session, settings);
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'https://api.waifu.im/search';
const DEFAULT_TAG = 'waifu';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

// ---------------------------------------------------------------------------
// WaifuimProvider
// ---------------------------------------------------------------------------

export class WaifuimProvider {
    static displayName = 'Waifu.im';
    static requiresApiKey = false;
    static websiteUrl = 'https://www.waifu.im';
    static keyHelpUrl = '';

    /**
     * @param {{session?: Soup.Session}} opts
     */
    constructor({session = null} = {}) {
        this._session = session || new Soup.Session();
    }

    /**
     * Waifu.im search never requires an API key.
     * @returns {boolean}
     */
    isConfigured() {
        return true;
    }

    /**
     * Search for images.
     *
     * @param {{q?: string, page?: number, perPage?: number}} params
     * @param {Soup.Session} [session]   Optional override session.
     * @param {Gio.Settings} [settings]  Unused (no key needed).
     * @returns {Promise<{items: Array, total: number, page: number, lastPage: number}>}
     */
    async search({q = '', page = 1, perPage = 24} = {}, session = null, settings = null) {
        const sess = session || this._session;
        const url = this._buildUrl(q);
        const message = Soup.Message.new('GET', url);
        message.get_headers().append('User-Agent', USER_AGENT);

        let text;
        try {
            text = await this._sendAndRead(sess, message);
        } catch (e) {
            // API returns 404 when no image matches the tags — surface as
            // an empty result so the gallery shows "No results found."
            if (e.message && e.message.includes('404'))
                return {items: [], total: 0, page, lastPage: 1};
            throw e;
        }

        const json = JSON.parse(text);
        return this._normalize(json, page);
    }

    // -----------------------------------------------------------------------
    // URL builder
    // -----------------------------------------------------------------------

    /**
     * Build the request URL. Tag slugs use hyphens, so user spaces become
     * hyphens and everything is lowercased. Empty queries use the default tag.
     *
     * @param {string} q  Raw user query (space-separated tags).
     * @returns {string}
     * @private
     */
    _buildUrl(q) {
        const tags = this._buildTags(q);
        const parts = [
            `included_tags=${encodeURIComponent(tags)}`,
            'many=true',
            'is_nsfw=false',
            'order_by=RANDOM',
        ];
        return `${API_URL}?${parts.join('&')}`;
    }

    /**
     * Convert user query to Waifu.im tag slug format.
     *
     * @param {string} q  Raw user query.
     * @returns {string}  Comma-separated tag slugs.
     * @private
     */
    _buildTags(q) {
        if (!q || !q.trim())
            return DEFAULT_TAG;
        return q.trim().toLowerCase().split(/\s+/).map(t => t.replace(/_/g, '-')).join(',');
    }

    // -----------------------------------------------------------------------
    // Response normalization
    // -----------------------------------------------------------------------

    /**
     * Normalize Waifu.im response to the shared provider shape.
     *
     * The API returns {images: [...]} with no pagination metadata;
     * many=true yields up to 30 fresh random images per request.
     *
     * @param {object} json  Raw API response.
     * @param {number} page  Current page number.
     * @returns {{items: Array, total: number, page: number, lastPage: number}}
     * @private
     */
    _normalize(json, page) {
        const images = Array.isArray(json.images) ? json.images : [];
        const items = images.map(img => ({
            id: String(img.image_id || img.signature || ''),
            previewUrl: img.preview_url || img.url || '',
            fullUrl: img.url || '',
            resolution: img.width && img.height
                ? `${img.width}x${img.height}`
                : '',
            source: 'Waifu.im',
            sourceUrl: this._resolveSourceUrl(img.source),
            purity: img.is_nsfw ? 'nsfw' : 'sfw',
            tags: Array.isArray(img.tags)
                ? img.tags.map(t => t.name).filter(Boolean).join(', ')
                : '',
        }));

        return {items, total: items.length, page, lastPage: 1};
    }

    /**
     * Resolve the artist source URL, falling back to the site homepage.
     *
     * @param {string} source  Raw source field from the API.
     * @returns {string}
     * @private
     */
    _resolveSourceUrl(source) {
        if (source && (source.startsWith('http://') || source.startsWith('https://')))
            return source;
        return 'https://www.waifu.im/';
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

                        if (status === 403) {
                            reject(new Error(
                                'Waifu.im API 403: Request blocked. Please try again in a moment.'
                            ));
                            return;
                        }
                        if (status === 404) {
                            reject(new Error('Waifu.im API 404: No images found for these tags'));
                            return;
                        }
                        if (status === 429) {
                            reject(new Error(
                                'Waifu.im API 429: Rate limit exceeded (1 request/200ms)'
                            ));
                            return;
                        }
                        if (status < 200 || status >= 300) {
                            reject(new Error(
                                `Waifu.im API ${status}: Unexpected HTTP status`
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
