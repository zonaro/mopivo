// SPDX-License-Identifier: GPL-3.0-or-later
// Streaming URL resolution via yt-dlp subprocess (isolated from the shell process).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {LOG_PREFIX} from './constants.js';

const SUBPROCESS_TIMEOUT_MS = 30_000;

/**
 * Resolve streaming URLs (YouTube, etc.) via the yt-dlp CLI.
 * All calls spawn an isolated subprocess — no GStreamer typelib in-process.
 */
export class YtDlpResolver {
    /**
     * @returns {boolean} true if yt-dlp is found in PATH.
     */
    isAvailable() {
        return GLib.find_program_in_path('yt-dlp') !== null;
    }

    /**
     * Resolve a streaming URL to a direct media URL.
     * @param {string} url  — user-provided streaming URL
     * @returns {Promise<string>} direct media URL
     */
    async resolveUrl(url) {
        return this._spawn([
            '--no-playlist',
            '--format', 'bestvideo+bestaudio/best',
            '--get-url',
            '--', url,
        ], 'resolveUrl');
    }

    /**
     * Fetch the video title for a streaming URL.
     * @param {string} url  — user-provided streaming URL
     * @returns {Promise<string|null>} video title, or null on failure
     */
    async getVideoTitle(url) {
        try {
            return await this._spawn([
                '--no-playlist',
                '--get-title',
                '--', url,
            ], 'getVideoTitle');
        } catch {
            return null;
        }
    }

    // -- private helpers -------------------------------------------------------

    /**
     * Spawn yt-dlp with the given extra arguments and return the first
     * non-empty stdout line.  Rejects with a catchable Error on failure.
     *
     * @param {string[]} extraArgs  — args appended after 'yt-dlp'
     * @param {string}   caller     — label for log messages
     * @returns {Promise<string>}
     */
    _spawn(extraArgs, caller) {
        return new Promise((resolve, reject) => {
            const argv = ['yt-dlp', ...extraArgs];
            let proc;
            try {
                const launcher = new Gio.SubprocessLauncher({
                    flags:
                        Gio.SubprocessFlags.STDOUT_PIPE |
                        Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc = launcher.spawnv(argv);
            } catch (e) {
                reject(new Error(`${LOG_PREFIX} ${caller}: failed to spawn yt-dlp: ${e.message}`));
                return;
            }

            // Timeout safety net.
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUBPROCESS_TIMEOUT_MS, () => {
                try { proc.force_exit(); } catch { /* already dead */ }
                reject(new Error(`${LOG_PREFIX} ${caller}: yt-dlp timed out after ${SUBPROCESS_TIMEOUT_MS}ms`));
                return GLib.SOURCE_REMOVE;
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.read_line_async(GLib.PRIORITY_LOW, null, (_src, result) => {
                try {
                    const [, bytes] = proc.stdout.read_line_finish(result);
                    stdout = bytes ? bytes.get_data().toString().trim() : '';
                } catch { /* ignore read errors */ }
            });

            proc.stderr.read_line_async(GLib.PRIORITY_LOW, null, (_src, result) => {
                try {
                    const [, bytes] = proc.stderr.read_line_finish(result);
                    stderr = bytes ? bytes.get_data().toString().trim() : '';
                } catch { /* ignore read errors */ }
            });

            proc.wait_async(null, (_src, result) => {
                GLib.source_remove(timeoutId);
                try {
                    proc.wait_finish(result);
                } catch { /* process may already be dead */ }

                const ok = proc.get_successful();
                // Drain any remaining buffered output synchronously as a fallback.
                if (!stdout) {
                    try {
                        const [, bytes] = proc.stdout.read_line(null);
                        stdout = bytes ? bytes.get_data().toString().trim() : '';
                    } catch { /* empty */ }
                }
                if (!stderr) {
                    try {
                        const [, bytes] = proc.stderr.read_line(null);
                        stderr = bytes ? bytes.get_data().toString().trim() : '';
                    } catch { /* empty */ }
                }

                if (ok && stdout) {
                    resolve(stdout);
                    return;
                }

                const excerpt = stderr.length > 300 ? stderr.slice(0, 300) + '…' : stderr;
                reject(new Error(
                    `${LOG_PREFIX} ${caller}: yt-dlp exited ${proc.get_exit_status()}` +
                    (excerpt ? ` — ${excerpt}` : ''),
                ));
            });
        });
    }
}
