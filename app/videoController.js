// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper subsystem — app-side orchestration controller.
//
// Owns the renderer subprocess lifecycle (RendererLauncher) and the D-Bus
// channel to it (RendererDBus). GStreamer is NEVER initialized in this process
// (risk R14): every GStreamer touchpoint lives in the spawned renderer
// subprocess. This module takes the UI actions the old GNOME Shell extension
// routed through lib/video/videoManager.js and maps them to settings + D-Bus.
//
// Frozen interface (used by P4's window and the video controls pane):
//   const controller = new VideoController({settings});
//   controller.start()                       // async; idempotent restart
//   controller.stop()                        // idempotent
//   controller.play()  controller.pause()  controller.togglePlay()
//   controller.next()  controller.lucky()   controller.setSource(type)
//   controller.connect('is-playing-changed', cb)   // cb(controller, boolean)
//
// Signal emissions use GObject.registerClass with a `Signals` definition
// (the same pattern as RendererDBus in lib/video/dbus.js): the controller
// re-emits the renderer's `is-playing-changed` D-Bus signal under the same
// name so the UI only ever listens to the controller.
//
// Source mode mapping (read/write keys, schema br.com.redclaw.WallpaperProviders):
//   'local'     → 'video-path' (or 'video-folder' newest-first fallback) → launcher `-F`
//   'streaming' → 'video-streaming-url' resolved via yt-dlp → 'video-path' → launcher `-F`
//   'webpage'   → renderer reads 'video-webpage-url' / 'video-webpage-local-html'
//                 itself (WebKit mode) — the app spawns the renderer without `-F`.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {RendererLauncher} from '../lib/video/launcher.js';
import {RendererDBus} from '../lib/video/dbus.js';
import {YtDlpResolver} from '../lib/video/ytDlp.js';
import {listVideoFiles} from '../lib/video/videoThumbs.js';
import {LOG_PREFIX} from '../lib/video/constants.js';

// This module always lives at <APP_DIR>/app/videoController.js — both in the
// repo checkout and under the installed ~/.local/share/wallpaper-providers/ —
// so the renderer root is exactly two directories up from import.meta.url.
const APP_DIR = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();

const DEFAULT_VIDEO_FOLDER = GLib.build_filenamev([
    GLib.get_home_dir(), 'Videos', 'Hidamari',
]);

const SOURCE_TYPES = ['local', 'streaming', 'webpage'];

function _log(msg) {
    console.log(`${LOG_PREFIX} videoController: ${msg}`);
}

// Read a string key from a Gio.Settings object or from a settings-like stub
// (plain object), so the pure helpers stay testable without GSettings.
function _settingsString(settings, key) {
    if (settings && typeof settings.get_string === 'function')
        return settings.get_string(key);
    return settings?.[key] ?? '';
}

/**
 * Pick a random element of `files`, deterministically when an `rng` is given.
 * Returns null for an empty/absent array.
 *
 * @param {string[]} files — candidate video paths
 * @param {() => number} rng — optional random source (defaults to Math.random)
 * @returns {string|null}
 */
export function pickRandom(files, rng = Math.random) {
    if (!Array.isArray(files) || files.length === 0)
        return null;
    const index = Math.min(files.length - 1, Math.floor(rng() * files.length));
    return files[index];
}

/**
 * Map the settings blob to the renderer source without any IO.
 * Pure — never scans folders, never spawns. `settings` may be a real
 * Gio.Settings or a {get_string} stub / plain object.
 *
 * @param {object} settings — settings-like object
 * @returns {{type: string, filePath: string|null, url: string|null, folder: string}}
 *   local     → {type:'local', filePath: 'video-path' (nullable), folder: 'video-folder'}.
 *               An empty filePath means "use the folder" (resolved in start()).
 *   streaming → {type:'streaming', url: 'video-streaming-url', filePath: null}.
 *   webpage   → {type:'webpage', url: 'video-webpage-url' || 'video-webpage-local-html',
 *               filePath: null} — the renderer reads the webpage keys itself.
 */
export function sourcePathsFromSettings(settings) {
    const type = _settingsString(settings, 'video-mode-type') || 'local';
    switch (type) {
    case 'streaming':
        return {
            type: 'streaming',
            filePath: null,
            url: _settingsString(settings, 'video-streaming-url') || null,
        };
    case 'webpage':
        return {
            type: 'webpage',
            filePath: null,
            url: _settingsString(settings, 'video-webpage-url') ||
                _settingsString(settings, 'video-webpage-local-html') || null,
        };
    case 'local':
    default:
        return {
            type: 'local',
            filePath: _settingsString(settings, 'video-path') || null,
            url: null,
            folder: _settingsString(settings, 'video-folder') || DEFAULT_VIDEO_FOLDER,
        };
    }
}

/**
 * VideoController — owns RendererLauncher + RendererDBus for the app.
 *
 * Nothing that touches the bus, the subprocess or GSettings is constructed at
 * import time or at construction: RendererLauncher/RendererDBus are created
 * lazily inside start(), so headless imports and pure-helper tests never
 * contact D-Bus or spawn anything.
 */
export const VideoController = GObject.registerClass({
    GTypeName: 'WpVideoController',
    Signals: {
        'is-playing-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class VideoController extends GObject.Object {
    _init({settings, log = _log} = {}) {
        super._init();
        this._settings = settings ?? null;
        this._logSink = log;
        this._appDir = APP_DIR;

        this._launcher = null;
        this._dbus = null;
        this._dbusSignalId = 0;
        this._ytDlp = null;
        this._isPlaying = null;
        this._started = false;
    }

    /** True while the renderer pipeline is meant to be running. */
    get started() {
        return this._started;
    }

    /** Last known playback state (false until the renderer says otherwise). */
    get isPlaying() {
        return this._isPlaying ?? false;
    }

    /**
     * Start (or restart, if already started) the renderer from the current
     * settings. Asynchronous because streaming sources resolve through yt-dlp.
     */
    async start() {
        if (!this._settings)
            return;
        if (this._started)
            await this.stop();

        this._started = true;
        const filePath = await this._resolveSourcePath();

        this._launcher = new RendererLauncher({
            appDir: this._appDir,
            log: this._logSink,
            onExit: () => this._onRendererExit(),
        });
        this._launcher.start({filePath});

        this._connectDbus();
        this._syncPlaying();
    }

    /** Stop the renderer pipeline. Idempotent (safe to call when not started). */
    stop() {
        this._started = false;
        this._disconnectDbus();
        if (this._launcher) {
            this._launcher.stop();
            this._launcher = null;
        }
        this._setPlaying(false);
    }

    /** Ask the renderer to play (fire-and-forget D-Bus call). */
    play() {
        this._dbus?.play();
    }

    /** Ask the renderer to pause (fire-and-forget D-Bus call). */
    pause() {
        this._dbus?.pause();
    }

    /** Toggle play/pause based on the last reported D-Bus playback state. */
    togglePlay() {
        if (this._isPlaying)
            this.pause();
        else
            this.play();
    }

    /** Cycle to the next video in the folder (newest-first order). */
    next() {
        const files = listVideoFiles(this._videoFolder());
        if (files.length === 0) {
            this._logSink(`next: no videos found in ${this._videoFolder()}`);
            return;
        }
        const current = this._readString('video-path');
        const index = files.indexOf(current);
        const nextFile = files[(index + 1) % files.length] ?? files[0];
        this._setVideoPath(nextFile);
        this._restartRenderer(nextFile);
    }

    /** "I'm Feeling Lucky" — play a random video from the folder. */
    lucky() {
        const files = listVideoFiles(this._videoFolder());
        const nextFile = pickRandom(files);
        if (!nextFile) {
            this._logSink(`lucky: no videos found in ${this._videoFolder()}`);
            return;
        }
        this._setVideoPath(nextFile);
        this._restartRenderer(nextFile);
    }

    /**
     * Switch the video source. Writes `video-mode-type`; when the pipeline is
     * running it is restarted with the new source (async for streaming).
     *
     * @param {'local'|'streaming'|'webpage'} type
     */
    async setSource(type) {
        if (!SOURCE_TYPES.includes(type)) {
            this._logSink(`setSource: unknown type "${type}"`);
            return;
        }
        if (this._settings && typeof this._settings.set_string === 'function')
            this._settings.set_string('video-mode-type', type);
        if (this._started)
            await this.start();
    }

    // ── Renderer source resolution ────────────────────────────────────

    /**
     * Decide which file path the renderer should play, or null when the renderer
     * reads the settings itself (webpage mode) or when nothing is available.
     *
     * @returns {Promise<string|null>}
     */
    async _resolveSourcePath() {
        const src = sourcePathsFromSettings(this._settings);
        if (src.type === 'streaming')
            return (await this._resolveStreaming(src.url));
        if (src.type === 'webpage')
            return null;
        if (src.filePath)
            return src.filePath;
        const files = listVideoFiles(src.folder);
        if (files.length === 0) {
            this._logSink(`local: no video-path and no videos in ${src.folder}`);
            return null;
        }
        return files[0];
    }

    /**
     * Resolve a streaming URL to a direct media URL via yt-dlp, mirroring the
     * old videoManager._resolveStreamingUrl (which also wrote the direct URL
     * into `video-path`).
     *
     * @param {string} url
     * @returns {Promise<string|null>}
     */
    async _resolveStreaming(url) {
        if (!url) {
            this._logSink(`streaming: no video-streaming-url configured`);
            return null;
        }
        if (!this._ytDlp)
            this._ytDlp = new YtDlpResolver();
        if (!this._ytDlp.isAvailable()) {
            this._logSink(`streaming: yt-dlp not found (install it to enable streaming)`);
            return null;
        }
        try {
            const direct = await this._ytDlp.resolveUrl(url);
            if (!direct)
                return null;
            this._settings?.set_string?.('video-path', direct);
            return direct;
        } catch (e) {
            this._logSink(`streaming: resolve failed: ${e.message}`);
            return null;
        }
    }

    /** Point the renderer at a folder pick without resetting the pipeline. */
    _restartRenderer(filePath) {
        if (!this._started || !this._launcher)
            return;
        // RendererLauncher.start() stops the previous process before spawning,
        // and -F guarantees the new file takes effect even if the renderer
        // would otherwise re-read `video-path` from settings.
        this._launcher.start({filePath});
    }

    // ── D-Bus wiring ──────────────────────────────────────────────────

    _connectDbus() {
        this._disconnectDbus();
        const dbus = new RendererDBus();
        this._dbusSignalId = dbus.connect('is-playing-changed', (_src, isPlaying) => {
            this._setPlaying(isPlaying);
        });
        this._dbus = dbus;
        this._dbus.start();
    }

    _disconnectDbus() {
        if (this._dbusSignalId && this._dbus) {
            try {
                this._dbus.disconnect(this._dbusSignalId);
            } catch (_e) { /* already disconnected */ }
            this._dbusSignalId = 0;
        }
        if (this._dbus) {
            try {
                this._dbus.stop();
            } catch (_e) { /* already stopped */ }
            this._dbus = null;
        }
    }

    /** Poll the renderer's current D-Bus playback state after startup. */
    async _syncPlaying() {
        const dbus = this._dbus;
        if (!dbus)
            return;
        const value = await dbus.getIsPlaying();
        if (value !== null)
            this._setPlaying(value);
    }

    _setPlaying(value) {
        const playing = !!value;
        if (playing === this._isPlaying)
            return;
        this._isPlaying = playing;
        this.emit('is-playing-changed', playing);
    }

    _onRendererExit() {
        this._logSink(`renderer exited`);
        this._setPlaying(false);
    }

    // ── Settings helpers ──────────────────────────────────────────────

    _videoFolder() {
        return this._readString('video-folder') || DEFAULT_VIDEO_FOLDER;
    }

    _setVideoPath(path) {
        if (this._settings && typeof this._settings.set_string === 'function')
            this._settings.set_string('video-path', path);
    }

    _readString(key) {
        return _settingsString(this._settings, key);
    }
});