/**
 * Shared download helper — fetch a URL to a local file.
 *
 * http(s) URLs are fetched via the Soup session; file:// URIs are copied
 * directly with Gio (used by the Local Files provider).
 *
 * Usage:
 *   import {downloadToFile} from './lib/download.js';
 *   await downloadToFile(session, url, '/tmp/image.jpg');
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

export function downloadToFile(session, url, destPath) {
    if (url.startsWith('file://'))
        return _copyLocalFile(url, destPath);

    const message = Soup.Message.new('GET', url);

    return new Promise((resolve, reject) => {
        session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, null,
            (sess, result) => {
                try {
                    const status = message.get_status();
                    if (status < 200 || status >= 300) {
                        reject(new Error(
                            `HTTP ${status}: ${message.get_reason_phrase() || 'Download failed'}`
                        ));
                        return;
                    }
                    const bytes = sess.send_and_read_finish(result);
                    _writeFile(bytes.get_data(), destPath).then(resolve, reject);
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

/**
 * Copy a file:// URI to a destination path (Local Files provider).
 *
 * @param {string} url       Source file URI.
 * @param {string} destPath  Local filesystem destination path.
 * @returns {Promise<void>}
 */
function _copyLocalFile(url, destPath) {
    return new Promise((resolve, reject) => {
        try {
            const src = Gio.File.new_for_uri(url);
            const dest = Gio.File.new_for_path(destPath);
            const parent = dest.get_parent();
            if (parent && !parent.query_exists(null))
                parent.make_directory_with_parents(null);
            src.copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
            resolve();
        } catch (e) {
            reject(e);
        }
    });
}

function _writeFile(data, destPath) {
    const file = Gio.File.new_for_path(destPath);
    const parent = file.get_parent();
    if (parent && !parent.query_exists(null))
        parent.make_directory_with_parents(null);

    return new Promise((resolve, reject) => {
        file.replace_contents_async(
            data, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
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
