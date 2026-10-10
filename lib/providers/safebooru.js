/**
 * Safebooru Provider - GJS/ESM client for the Safebooru JSON API
 *
 * Endpoint used:
 *   GET https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1
 *       &tags=<tags>&pid=<page-1>&limit=<perPage>
 *
 * No API key required. Tags are space-separated in query, converted to underscores.
 * Appends safe:order+safe:rating defaults for content safety.
 *
 * Usage:
 *   const provider = new SafebooruProvider({session});
 *   const result = await provider.search({q: 'scenery', page: 1, perPage: 24}, session, settings);
 */

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = 'https://safebooru.org/index.php';
const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 24;
const SAFE_DEFAULTS = 'safe:order+safe:rating';

// ---------------------------------------------------------------------------
// SafebooruProvider
// ---------------------------------------------------------------------------

export class SafebooruProvider {
    static displayName = 'Safebooru';
    static requiresApiKey = false;
    static websiteUrl = 'https://safebooru.org';
    static keyHelpUrl = '';

    /**
     * @param {{session?: Soup.Session}} opts
     */
    constructor({session = null} = {}) {
        this._session = session || new Soup.Session();
    }

    /**
     * Safebooru never requires an API key.
     * @returns {boolean}
     */
    isConfigured() {
        return true;
    }

    /**
     * Search for posts.
     *
     * @param {{q?: string, page?: number, perPage?: number}} params
     * @param {Soup.Session} [session]   Optional override session.
     * @param {Gio.Settings} [settings]  Unused (no key needed).
     * @returns {Promise<{items: Array, total: number, page: number, lastPage: number}>}
     */
    async search({q = '', page = 1, perPage = DEFAULT_PER_PAGE} = {}, session = null, settings = null) {
        const sess = session || this._session;
        const clampedPerPage = Math.min(Math.max(1, perPage), MAX_PER_PAGE);
        const url = this._buildUrl(q, page, clampedPerPage);
        const message = Soup.Message.new('GET', url);

        const text = await this._sendAndRead(sess, message);
        const json = JSON.parse(text);
        return this._normalize(json, page);
    }

    // -----------------------------------------------------------------------
    // URL builder
    // -----------------------------------------------------------------------

    /**
     * Build the request URL. Converts spaces to underscores and appends safe defaults.
     *
     * @param {string} q       Search tags (space-separated).
     * @param {number} page    1-based page number.
     * @param {number} perPage Results per page.
     * @returns {string}
     * @private
     */
    _buildUrl(q, page, perPage) {
        const tags = this._buildTags(q);
        const parts = [
            'page=dapi',
            's=post',
            'q=index',
            'json=1',
            `limit=${perPage}`,
            `pid=${Math.max(0, page - 1)}`,
        ];

        if (tags)
            parts.push(`tags=${encodeURIComponent(tags)}`);

        return `${API_URL}?${parts.join('&')}`;
    }

    /**
     * Convert user query to Safebooru tag format.
     * Spaces become underscores. Appends safe defaults.
     *
     * @param {string} q  Raw user query.
     * @returns {string}  Safebooru tag string.
     * @private
     */
    _buildTags(q) {
        const userTags = q ? q.trim().replace(/\s+/g, '_') : '';
        const allTags = userTags
            ? `${SAFE_DEFAULTS}+${userTags}`
            : SAFE_DEFAULTS;
        return allTags;
    }

    // -----------------------------------------------------------------------
    // Response normalization
    // -----------------------------------------------------------------------

    /**
     * Normalize Safebooru response to the shared provider shape.
     *
     * Safebooru returns a flat array [] (no total/total_pages metadata).
     * We estimate lastPage from result count.
     *
     * @param {Array} json   Raw Safebooru API response (array of posts).
     * @param {number} page  Current page number.
     * @returns {{items: Array, total: number, page: number, lastPage: number}}
     * @private
     */
    _normalize(json, page) {
        const posts = Array.isArray(json) ? json : [];
        const count = posts.length;

        // Safebooru doesn't provide total count; estimate from page results
        const lastPage = count < MAX_PER_PAGE ? page : page + 1;
        const total = count > 0 ? (page * count) : 0;

        const items = posts.map(post => ({
            id: String(post.id),
            previewUrl: this._resolveUrl(post.preview_url),
            fullUrl: this._resolveUrl(post.sample_url || post.file_url),
            resolution: post.width && post.height
                ? `${post.width}x${post.height}`
                : '',
            source: 'Safebooru',
            sourceUrl: `https://safebooru.org/index.php?page=post&s=view&id=${post.id}`,
            tags: post.tags || '',
        }));

        return {items, total, page, lastPage};
    }

    // -----------------------------------------------------------------------
    // URL helpers
    // -----------------------------------------------------------------------

    /**
     * Prefix relative URLs with the Safebooru base domain.
     *
     * @param {string} url  Possibly relative URL from the API.
     * @returns {string}    Absolute URL.
     * @private
     */
    _resolveUrl(url) {
        if (!url) return '';
        if (url.startsWith('http://') || url.startsWith('https://'))
            return url;
        return `https://safebooru.org${url.startsWith('/') ? '' : '/'}${url}`;
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

                        if (status === 429) {
                            reject(new Error(
                                'Safebooru API 429: Rate limit exceeded'
                            ));
                            return;
                        }
                        if (status < 200 || status >= 300) {
                            reject(new Error(
                                `Safebooru API ${status}: Unexpected HTTP status`
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
