/**
 * BaseProvider — abstract interface for all wallpaper providers.
 *
 * Every provider must extend this class and implement:
 *   - get id()             unique string identifier
 *   - get displayName()    human-readable name
 *   - get requiresApiKey() whether an API key is mandatory
 *   - get websiteUrl()     provider homepage
 *   - get keyHelpUrl()     URL where users can obtain an API key
 *   - search(params, session, settings) -> NormalizedResult
 *
 * Shared utilities:
 *   - downloadToFile()     fetch binary content and write to disk
 *   - isConfigured()       check whether the provider has a valid API key
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Normalized result shape
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NormalizedItem
 * @property {string}  id            Unique identifier within the provider
 * @property {string}  previewUrl    URL to a small preview / thumbnail image
 * @property {string}  fullUrl       URL to the full-resolution image
 * @property {string}  resolution    Human-readable resolution (e.g. "1920x1080")
 * @property {number}  previewWidth  Preview image width in pixels (0 if unknown)
 * @property {number}  previewHeight Preview image height in pixels (0 if unknown)
 * @property {string}  source        Provider identifier string
 * @property {string}  sourceUrl     URL to the item on the provider website
 * @property {string} [purity]       Optional purity label (e.g. "sfw")
 * @property {string[]} [tags]       Optional tag names
 */

/**
 * @typedef {Object} NormalizedResult
 * @property {NormalizedItem[]} items  Array of normalized wallpaper items
 * @property {number}          total   Total number of results available
 * @property {number}          page    Current page number (1-based)
 * @property {number}          lastPage  Total number of pages
 */

// ---------------------------------------------------------------------------
// BaseProvider
// ---------------------------------------------------------------------------

export class BaseProvider {
    /** @returns {string} Unique provider identifier (e.g. 'wallhaven') */
    get id() {
        throw new Error('BaseProvider.id must be implemented by subclass');
    }

    /** @returns {string} Human-readable display name (e.g. 'Wallhaven') */
    get displayName() {
        throw new Error('BaseProvider.displayName must be implemented by subclass');
    }

    /** @returns {boolean} Whether this provider requires an API key */
    get requiresApiKey() {
        throw new Error('BaseProvider.requiresApiKey must be implemented by subclass');
    }

    /** @returns {string} Provider homepage URL */
    get websiteUrl() {
        throw new Error('BaseProvider.websiteUrl must be implemented by subclass');
    }

    /** @returns {string} URL where users can obtain an API key */
    get keyHelpUrl() {
        throw new Error('BaseProvider.keyHelpUrl must be implemented by subclass');
    }

    /**
     * Search for wallpapers.
     *
     * @param {object}      params   Provider-specific search parameters
     * @param {Soup.Session} session  Shared Soup session
     * @param {Gio.Settings} settings Extension GSettings instance
     * @returns {Promise<NormalizedResult>}
     */
    async search(params, session, settings) {
        throw new Error('BaseProvider.search must be implemented by subclass');
    }

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    /**
     * Download a binary file (typically an image) to a local path.
     * Creates parent directories if they do not exist.
     *
     * @param {string}       url       Direct download URL
     * @param {string}       destPath  Local filesystem destination path
     * @param {Soup.Session} session   Shared Soup session
     * @returns {Promise<void>}
     */
    async downloadToFile(url, destPath, session) {
        const Soup = (await import('gi://Soup?version=3.0')).default;
        const message = Soup.Message.new('GET', url);

        const bytes = await this._sendAndReadRaw(message, session);

        const file = Gio.File.new_for_path(destPath);
        const parent = file.get_parent();
        if (parent && !parent.query_exists(null))
            parent.make_directory_with_parents(null);

        return new Promise((resolve, reject) => {
            file.replace_contents_async(
                bytes.get_data(),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                GLib.PRIORITY_DEFAULT,
                null,
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

    /**
     * Check whether this provider is configured (API key present if required).
     *
     * @param {Gio.Settings} settings  Extension GSettings instance
     * @returns {boolean}
     */
    isConfigured(settings) {
        if (!this.requiresApiKey)
            return true;

        // Wallhaven uses 'api-key'; other providers use '<id>-api-key'
        const legacyKey = settings.get_string('api-key');
        if (this.id === 'wallhaven' && legacyKey)
            return true;

        const providerKey = settings.get_string(`${this.id}-api-key`);
        return !!providerKey;
    }

    // -----------------------------------------------------------------------
    // Internal HTTP helpers
    // -----------------------------------------------------------------------

    /**
     * Send a Soup.Message, read the full response body as UTF-8 text,
     * check HTTP status, and return the decoded string.
     *
     * @param {Soup.Message} message
     * @param {Soup.Session} session
     * @returns {Promise<string>}
     * @protected
     */
    _sendAndRead(message, session) {
        return new Promise((resolve, reject) => {
            session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (sess, result) => {
                    try {
                        const status = message.get_status();
                        if (status < 200 || status >= 300) {
                            reject(new Error(
                                `HTTP ${status}: ${message.get_reason_phrase() || 'Unexpected status'}`
                            ));
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

    /**
     * Send a Soup.Message and return raw GLib.Bytes (for binary downloads).
     *
     * @param {Soup.Message} message
     * @param {Soup.Session} session
     * @returns {Promise<GLib.Bytes>}
     * @protected
     */
    _sendAndReadRaw(message, session) {
        return new Promise((resolve, reject) => {
            session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (sess, result) => {
                    try {
                        const status = message.get_status();
                        if (status < 200 || status >= 300) {
                            reject(new Error(
                                `HTTP ${status}: ${message.get_reason_phrase() || 'Unexpected status'}`
                            ));
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
