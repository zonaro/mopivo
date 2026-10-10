// SPDX-License-Identifier: GPL-3.0-or-later
// Extract a video frame, optionally blur it, and set as GNOME desktop background.
// All media processing runs via CLI subprocesses — no GStreamer typelib in-process.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {LOG_PREFIX} from './constants.js';
import {setDesktopWallpaper} from '../wallpaper.js';

const CACHE_BASE = GLib.get_home_dir() + '/.cache/mopivo/static';
const EXTRACT_TIMEOUT_MS = 20_000;
const BLUR_TIMEOUT_MS = 20_000;

function _ensureDir(p) {
    const d = Gio.File.new_for_path(p);
    if (!d.query_exists(null))
        d.make_directory_with_parents(null);
}

function _tmpPath(ext = '.jpg') {
    const ts = Date.now();
    return GLib.build_filenamev([CACHE_BASE, `frame_${ts}${ext}`]);
}

/**
 * Spawn a CLI command with a timeout, returning {stdout, stderr, ok}.
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
            reject(new Error(`${LOG_PREFIX} spawn failed: ${e.message}`));
            return;
        }

        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            try { proc.force_exit(); } catch { /* already dead */ }
            reject(new Error(`${LOG_PREFIX} process timed out after ${timeoutMs}ms`));
            return GLib.SOURCE_REMOVE;
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.read_line_async(GLib.PRIORITY_LOW, null, (_s, res) => {
            try {
                const [, bytes] = proc.stdout.read_line_finish(res);
                stdout = bytes ? bytes.get_data().toString().trim() : '';
            } catch { /* ignore */ }
        });
        proc.stderr.read_line_async(GLib.PRIORITY_LOW, null, (_s, res) => {
            try {
                const [, bytes] = proc.stderr.read_line_finish(res);
                stderr = bytes ? bytes.get_data().toString().trim() : '';
            } catch { /* ignore */ }
        });

        proc.wait_async(null, (_s, res) => {
            GLib.source_remove(timeoutId);
            try { proc.wait_finish(res); } catch { /* already dead */ }

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

            resolve({stdout, stderr, ok: proc.get_successful(), exitCode: proc.get_exit_status()});
        });
    });
}

/**
 * Extract a single frame from a video file using available CLI tools.
 * Tries gst-launch-1.0 first, then ffmpeg.  Returns the output path or null.
 */
function _extractFrame(videoPath) {
    const outPath = _tmpPath('.jpg');
    _ensureDir(CACHE_BASE);

    return (async () => {
        // Try gst-launch-1.0 first.
        if (GLib.find_program_in_path('gst-launch-1.0')) {
            try {
                const argv = [
                    'gst-launch-1.0', '-q',
                    'filesrc', `location=${videoPath}`,
                    '!', 'decodebin',
                    '!', 'videoconvert',
                    '!', 'jpegenc',
                    '!', 'filesink', `location=${outPath}`,
                ];
                const r = await _run(argv, EXTRACT_TIMEOUT_MS);
                if (r.ok && GLib.file_test(outPath, GLib.FileTest.EXISTS))
                    return outPath;
            } catch (e) {
                console.log(`${LOG_PREFIX} gst frame extract failed: ${e.message}`);
            }
        }

        // Fallback to ffmpeg.
        if (GLib.find_program_in_path('ffmpeg')) {
            try {
                const argv = [
                    'ffmpeg', '-y', '-i', videoPath,
                    '-frames:v', '1', '-q:v', '2', outPath,
                ];
                const r = await _run(argv, EXTRACT_TIMEOUT_MS);
                if (r.ok && GLib.file_test(outPath, GLib.FileTest.EXISTS))
                    return outPath;
            } catch (e) {
                console.log(`${LOG_PREFIX} ffmpeg frame extract failed: ${e.message}`);
            }
        }

        return null;
    })();
}

/**
 * Blur a JPEG image in-place (or to a new path).
 * Returns the output path or null on failure.
 */
function _blurFrame(srcPath, radius) {
    const outPath = _tmpPath('_blur.jpg');
    const sigma = radius / 10.0;

    return (async () => {
        // Try gst-launch-1.0 first.
        if (GLib.find_program_in_path('gst-launch-1.0')) {
            try {
                const argv = [
                    'gst-launch-1.0', '-q',
                    'filesrc', `location=${srcPath}`,
                    '!', 'jpegdec',
                    '!', 'videoconvert',
                    '!', 'gaussblur', `sigma=${sigma}`,
                    '!', 'jpegenc',
                    '!', 'filesink', `location=${outPath}`,
                ];
                const r = await _run(argv, BLUR_TIMEOUT_MS);
                if (r.ok && GLib.file_test(outPath, GLib.FileTest.EXISTS))
                    return outPath;
            } catch (e) {
                console.log(`${LOG_PREFIX} gst blur failed: ${e.message}`);
            }
        }

        // Fallback to ffmpeg.
        if (GLib.find_program_in_path('ffmpeg')) {
            try {
                const argv = [
                    'ffmpeg', '-y', '-i', srcPath,
                    '-vf', `gblur=sigma=${sigma}`,
                    '-q:v', '2', outPath,
                ];
                const r = await _run(argv, BLUR_TIMEOUT_MS);
                if (r.ok && GLib.file_test(outPath, GLib.FileTest.EXISTS))
                    return outPath;
            } catch (e) {
                console.log(`${LOG_PREFIX} ffmpeg blur failed: ${e.message}`);
            }
        }

        return null;
    })();
}

/**
 * Manages extracting a frame from a video and optionally applying a blur,
 * then setting it as the GNOME desktop background.
 */
export class StaticBlur {
    /**
     * @param {Gio.Settings} settings — extension settings
     * @param {object}       _session  —Soup session (unused, kept for symmetry)
     */
    constructor(settings, _session = null) {
        this._settings = settings;
    }

    /**
     * Extract a frame from the given video, optionally blur it, and apply
     * it as the GNOME desktop background.
     *
     * @param {string} videoPath — absolute path to the video file
     * @returns {Promise<string|null>} written wallpaper path, or null on failure
     */
    async applyFromVideo(videoPath) {
        if (!this._settings.get_boolean('static-wallpaper-from-video')) {
            console.log(`${LOG_PREFIX} static wallpaper from video is disabled`);
            return null;
        }

        if (!videoPath || !GLib.file_test(videoPath, GLib.FileTest.EXISTS)) {
            console.log(`${LOG_PREFIX} video not found: ${videoPath}`);
            return null;
        }

        // 1. Extract a single frame.
        const framePath = await _extractFrame(videoPath);
        if (!framePath) {
            console.log(`${LOG_PREFIX} failed to extract frame from ${videoPath}`);
            return null;
        }
        console.log(`${LOG_PREFIX} extracted frame: ${framePath}`);

        let outPath = framePath;

        // 2. Optionally blur.
        if (this._settings.get_boolean('static-wallpaper-blur-enabled')) {
            const radius = this._settings.get_int('static-wallpaper-blur-radius');
            const blurred = await _blurFrame(framePath, radius);
            if (blurred) {
                outPath = blurred;
                console.log(`${LOG_PREFIX} blur applied (radius=${radius}): ${outPath}`);
            } else {
                console.log(`${LOG_PREFIX} blur failed, using unblurred frame`);
            }
        }

        // 3. Set as GNOME background.
        try {
            setDesktopWallpaper(Gio.File.new_for_path(outPath).get_uri());
            console.log(`${LOG_PREFIX} background set: ${outPath}`);
        } catch (e) {
            console.log(`${LOG_PREFIX} failed to set background: ${e.message}`);
            return null;
        }

        return outPath;
    }

    /**
     * Convenience method called when the video wallpaper changes.
     * Triggers applyFromVideo if the setting is enabled.
     *
     * @param {string} videoPath — new video path
     */
    async onVideoChanged(videoPath) {
        if (this._settings.get_boolean('static-wallpaper-from-video')) {
            await this.applyFromVideo(videoPath);
        }
    }
}
