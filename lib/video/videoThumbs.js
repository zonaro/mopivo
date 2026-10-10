// SPDX-License-Identifier: GPL-3.0-or-later
// Video thumbnail extraction and folder scanning — CLI subprocesses only.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {VIDEO_EXTENSIONS, LOG_PREFIX} from './constants.js';

const THUMB_CACHE_DIR = GLib.get_home_dir() + '/.cache/wallpaper-providers-gnome/video-thumbs';
const THUMB_TIMEOUT_MS = 20_000;

function _ensureDir(p) {
    const d = Gio.File.new_for_path(p);
    if (!d.query_exists(null))
        d.make_directory_with_parents(null);
}

/**
 * Simple SHA-1 hex digest using GJS's built-in Checksum.
 */
function _sha1(input) {
    const checksum = GLib.Checksum.new(GLib.ChecksumType.SHA1);
    checksum.update(input);
    return checksum.get_string();
}

/**
 * Spawn a CLI command with a timeout, returning {ok}.
 */
function _run(argv, timeoutMs) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags:
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc = launcher.spawnv(argv);
        } catch (e) {
            reject(new Error(`${LOG_PREFIX} thumb spawn failed: ${e.message}`));
            return;
        }

        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            try { proc.force_exit(); } catch { /* already dead */ }
            reject(new Error(`${LOG_PREFIX} thumb process timed out`));
            return GLib.SOURCE_REMOVE;
        });

        proc.wait_async(null, (_s, res) => {
            GLib.source_remove(timeoutId);
            try { proc.wait_finish(res); } catch { /* already dead */ }
            resolve({ok: proc.get_successful()});
        });
    });
}

/**
 * Extract a thumbnail frame from a video file.
 *
 * @param {string} videoPath — absolute path to the video
 * @param {object} [opts]
 * @param {number} [opts.size=320] — target width in pixels
 * @returns {Promise<string|null>} cache file path, or null on failure
 */
export async function getVideoThumb(videoPath, {size = 320} = {}) {
    if (!videoPath || !GLib.file_test(videoPath, GLib.FileTest.EXISTS))
        return null;

    _ensureDir(THUMB_CACHE_DIR);

    const cacheName = _sha1(videoPath + size) + '.jpg';
    const cachePath = GLib.build_filenamev([THUMB_CACHE_DIR, cacheName]);

    // Return cached thumbnail if it exists.
    if (GLib.file_test(cachePath, GLib.FileTest.EXISTS))
        return cachePath;

    // Try gst-launch-1.0 first.
    if (GLib.find_program_in_path('gst-launch-1.0')) {
        try {
            const argv = [
                'gst-launch-1.0', '-q',
                'filesrc', `location=${videoPath}`,
                '!', 'decodebin',
                '!', 'videoconvert',
                '!', 'videoscale',
                '!', `video/x-raw,width=${size}`,
                '!', 'jpegenc',
                '!', 'filesink', `location=${cachePath}`,
            ];
            const r = await _run(argv, THUMB_TIMEOUT_MS);
            if (r.ok && GLib.file_test(cachePath, GLib.FileTest.EXISTS))
                return cachePath;
        } catch (e) {
            console.log(`${LOG_PREFIX} gst thumbnail failed: ${e.message}`);
        }
    }

    // Fallback to ffmpeg.
    if (GLib.find_program_in_path('ffmpeg')) {
        try {
            const argv = [
                'ffmpeg', '-y', '-ss', '1', '-i', videoPath,
                '-frames:v', '1',
                '-vf', `scale=${size}:-2`,
                '-q:v', '2', cachePath,
            ];
            const r = await _run(argv, THUMB_TIMEOUT_MS);
            if (r.ok && GLib.file_test(cachePath, GLib.FileTest.EXISTS))
                return cachePath;
        } catch (e) {
            console.log(`${LOG_PREFIX} ffmpeg thumbnail failed: ${e.message}`);
        }
    }

    console.log(`${LOG_PREFIX} thumbnail extraction failed for ${videoPath}`);
    return null;
}

/**
 * Scan a folder for video files, returning absolute paths sorted newest first.
 *
 * @param {string} folderPath — absolute path to the folder to scan
 * @returns {string[]} sorted list of video file paths
 */
export function listVideoFiles(folderPath) {
    if (!folderPath || !GLib.file_test(folderPath, GLib.FileTest.IS_DIR)) {
        console.log(`${LOG_PREFIX} listVideoFiles: folder not found: ${folderPath}`);
        return [];
    }

    const results = [];
    const folder = Gio.File.new_for_path(folderPath);

    try {
        const enumerator = folder.enumerate_children(
            'standard::name,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const type = info.get_file_type();
            if (type !== Gio.FileType.REGULAR)
                continue;

            const name = info.get_name();
            const dotIdx = name.lastIndexOf('.');
            if (dotIdx < 0)
                continue;

            const ext = name.slice(dotIdx).toLowerCase();
            if (!VIDEO_EXTENSIONS.includes(ext))
                continue;

            const mtime = info.get_attribute_uint64('time::modified');
            const child = enumerator.get_child(info);
            results.push({path: child.get_path(), mtime});
        }
    } catch (e) {
        console.log(`${LOG_PREFIX} listVideoFiles: error scanning ${folderPath}: ${e.message}`);
        return [];
    }

    // Sort newest first.
    results.sort((a, b) => b.mtime - a.mtime);
    return results.map(r => r.path);
}
