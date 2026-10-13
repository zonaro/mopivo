#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper renderer — standalone GJS + GTK3 subprocess, one window per
// monitor. A GStreamer crash in this process never takes down GNOME Shell.
//
// Window mechanism mirrors Hidamari: every monitor gets a Gtk.ApplicationWindow
// moved/sized to its GdkMonitor geometry and marked as a desktop-layer window
// through the toolkit before it is shown; no external window-type utility.

// ═══════════════════════════════════════════════════════════════════════════
// GI version requirements
// ═══════════════════════════════════════════════════════════════════════════
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Gdk = '3.0';
imports.gi.versions.GdkX11 = '3.0';

const {GObject, Gtk, Gio, GLib, Gdk, Gst, GdkX11} = imports.gi;

// ═══════════════════════════════════════════════════════════════════════════
// Constants — mirrored from lib/video/constants.js
// ═══════════════════════════════════════════════════════════════════════════
const APPLICATION_ID = 'org.redclaw.MopivoRenderer';
const RENDERER_OBJECT_PATH = '/org/redclaw/MopivoRenderer';
const EXT_SCHEMA_ID = 'br.com.redclaw.Mopivo';
const LOG_PREFIX = '[wp-video]';
const IMPL_NAME = 'playbin + xvimagesink';

const VIDEO_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v', '.ogv',
];

// ═══════════════════════════════════════════════════════════════════════════
// WebKit — optional, webpage mode only. GTK3 builds ship the WebKit2 4.1
// namespace (WebKitGTK 2.x); newer GTK4 builds use WebKit 6.0. Probe both so a
// missing typelib never breaks local/streaming video playback.
// ═══════════════════════════════════════════════════════════════════════════
let WebKit = null;
try {
    imports.gi.versions.WebKit2 = '4.1';
    WebKit = imports.gi.WebKit2;
} catch (e) {
    console.warn(`${LOG_PREFIX} WebKit2 4.1 unavailable: ${e.message}`);
}
if (!WebKit) {
    try {
        imports.gi.versions.WebKit = '6.0';
        WebKit = imports.gi.WebKit;
    } catch (e) {
        console.warn(`${LOG_PREFIX} WebKit 6.0 unavailable: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Module-level state (populated after arg parsing + settings load)
// ═══════════════════════════════════════════════════════════════════════════
let extPath = '';
let extSettings = null;
let nohide = false;

// Settings values — read from GSettings after schema load
let videoModeType = 'local';
let videoPath = '';
let videoFolder = '';
let videoWebpageUrl = '';
let videoWebpageLocalHtml = '';
let videoWebpageProject = '';
let videoWebpageProperties = '{}';
let videoWebpageAudio = false;
let videoVolume = 50;
let videoMute = false;
let videoFadeDurationSec = 0.5;
let videoFitMode = 'contain';
let videoRandomStart = false;
let videoMonitorPaths = [];
let preferClappersink = false;
let forceMediaFile = false;
let enableVA = false;
let enableNvSl = false;
let changeWallpaper = false;
let changeWallpaperDir = '';
let changeWallpaperInterval = 15;
let changeWallpaperMode = 0;

// Runtime state
let changeWallpaperTimerId = null;
let fadeTimerId = null;
let autoWallpaperIndex = 0;
let autoWallpaperPaths = [];

// ═══════════════════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a file path or URI string to a proper URI.
 * If the path already contains '://', it is returned as-is.
 */
function toUri(path) {
    if (!path || path.length === 0)
        return '';
    if (path.includes('://'))
        return path;
    return Gio.File.new_for_path(path).get_uri();
}

/**
 * Resolve a GdkWindow to its X11 window id. GTK3 only exposes the XID through
 * the X11 backend (GDK_BACKEND=x11), which the launcher guarantees.
 */
function getXid(gdkWindow) {
    return GdkX11.X11Window.prototype.get_xid.call(gdkWindow);
}

/**
 * Parse per-monitor path entries ["CONNECTOR=path", ...] into a map.
 */
function parseMonitorPaths(entries) {
    const map = {};
    if (!entries)
        return map;
    for (const entry of entries) {
        const idx = entry.indexOf('=');
        if (idx > 0) {
            const connector = entry.substring(0, idx);
            const path = entry.substring(idx + 1);
            map[connector] = path;
        }
    }
    return map;
}

/**
 * Scan a directory for video files matching VIDEO_EXTENSIONS.
 */
function scanVideoDir(dirPath) {
    const dir = Gio.File.new_for_path(dirPath);
    try {
        if (dir.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !==
            Gio.FileType.DIRECTORY)
            return [];
    } catch (e) {
        return [];
    }

    const paths = [];
    try {
        const enumerator = dir.enumerate_children(
            'standard::name,standard::content-type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let info;
        while ((info = enumerator.next_file(null))) {
            const name = info.get_name();
            const dotIdx = name.lastIndexOf('.');
            if (dotIdx >= 0) {
                const ext = name.substring(dotIdx).toLowerCase();
                if (VIDEO_EXTENSIONS.includes(ext))
                    paths.push(GLib.build_filenamev([dirPath, name]));
            }
        }
    } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to enumerate ${dirPath}: ${e.message}`);
    }

    return paths.sort();
}

/**
 * Read a whole text file (UTF-8), tolerating a missing/unreadable file.
 * @returns {string} file contents, or '' with a logged reason.
 */
function readFileText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || !bytes) {
            console.warn(`${LOG_PREFIX} Cannot read ${path}`);
            return '';
        }
        return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to read ${path}: ${e.message}`);
        return '';
    }
}

// lib/wallpaper-web.js is an ESM module; the renderer is a legacy script, so
// load it through a dynamic import and cache the promise (null on failure).
let webLibPromise = null;
function loadWallpaperWeb() {
    if (!webLibPromise) {
        const path = GLib.build_filenamev([extPath, 'lib', 'wallpaper-web.js']);
        webLibPromise = import(Gio.File.new_for_path(path).get_uri()).catch(e => {
            console.error(`${LOG_PREFIX} lib/wallpaper-web.js failed to load: ${e.message}`);
            return null;
        });
    }
    return webLibPromise;
}

// GSettings keys added for webpage mode may be absent from an older schema;
// read them defensively so a missing key never aborts the renderer.
function settingsHasKey(settings, key) {
    const schema = settings.settings_schema;
    return !!(schema && schema.has_key(key));
}
function safeGetString(settings, key, fallback = '') {
    return settingsHasKey(settings, key) ? settings.get_string(key) : fallback;
}
function safeGetBoolean(settings, key, fallback = false) {
    return settingsHasKey(settings, key) ? settings.get_boolean(key) : fallback;
}

/**
 * Apply the desktop-layer window chrome shared by video and webpage windows.
 * DESKTOP must be set before the window is shown.
 */
function configureWallpaperWindow(win, gdkMonitor, index) {
    const geometry = gdkMonitor.get_geometry();
    win.set_title(`Wallpaper ${index}`);
    if (nohide) {
        win.set_decorated(true);
        win.set_skip_taskbar_hint(false);
        win.set_default_size(geometry.width, geometry.height);
    } else {
        win.set_type_hint(Gdk.WindowTypeHint.DESKTOP);
        win.set_decorated(false);
        win.set_skip_taskbar_hint(true);
        win.set_skip_pager_hint(true);
        win.set_keep_below(true);
        win.stick();
        win.set_size_request(geometry.width, geometry.height);
        win.move(geometry.x, geometry.y);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// RendererWindow — one GStreamer pipeline per monitor, embedded by XID
// ═══════════════════════════════════════════════════════════════════════════
const RendererWindow = GObject.registerClass(
    {
        GTypeName: 'WpRendererWindow',
    },
    class RendererWindow extends Gtk.ApplicationWindow {
        constructor(app, gdkMonitor, index, isPrimary, path) {
            super({application: app});

            this._app = app;
            this._index = index;
            this._isPrimary = isPrimary;
            this._path = path;
            this._uri = '';
            this._playbin = null;
            this._sink = null;
            this._randomStartPending = false;

            this._area = new Gtk.DrawingArea();
            this._area.set_hexpand(true);
            this._area.set_vexpand(true);
            this.add(this._area);
            this._area.show();

            configureWallpaperWindow(this, gdkMonitor, index);

            this._buildPipeline();
        }

        _buildPipeline() {
            const sink = Gst.ElementFactory.make(
                'xvimagesink', `wp-xv-${this._index}`
            );
            if (!sink)
                throw new Error('xvimagesink plugin missing');

            // "contain" only: xvimagesink has no cover/fill modes, so
            // video-fit-mode values other than contain are not honored.
            sink.set_property('force-aspect-ratio', true);
            sink.set_property('handle-events', false);

            const playbin = Gst.ElementFactory.make(
                'playbin', `wp-playbin-${this._index}`
            );
            if (!playbin)
                throw new Error('playbin element missing');
            playbin.set_property('video-sink', sink);

            this._sink = sink;
            this._playbin = playbin;

            // Audio only on the primary monitor.
            playbin.set_property('mute', !this._isPrimary);
            playbin.set_property(
                'volume', this._isPrimary ? this._volumeLinear() : 0
            );

            this._area.connect('realize', () => this._embedSink());

            const bus = playbin.get_bus();
            bus.add_signal_watch();

            // xvimagesink requests a window handle before the first frame;
            // embed the DrawingArea XID here (runs on the streaming thread).
            bus.connect('sync-message::element', (_bus, msg) => {
                const structure = msg.get_structure();
                if (structure && structure.get_name() === 'prepare-window-handle') {
                    this._embedSink();
                    return true;
                }
                return false;
            });

            bus.connect('message::error', (_bus, msg) => {
                const [err] = msg.parse_error();
                console.error(
                    `${LOG_PREFIX} playback error [monitor ${this._index}]: ${err.message}`
                );
            });
            bus.connect('message::warning', (_bus, msg) => {
                const [err] = msg.parse_warning();
                console.warn(
                    `${LOG_PREFIX} playback warning [monitor ${this._index}]: ${err.message}`
                );
            });
            bus.connect('message::state-changed', (_bus, msg) => {
                const [_old, current] = msg.parse_state_changed();
                if (current >= Gst.State.PAUSED)
                    this._maybeRandomStart();
                if (this._isPrimary)
                    this._app._onPrimaryStateChanged(current);
            });

            // Loop the media by re-setting the URI when it is about to finish.
            playbin.connect('about-to-finish', () => {
                if (this._uri)
                    playbin.set_property('uri', this._uri);
            });
            bus.connect('message::eos', () => {
                playbin.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH, 0);
            });
        }

        _embedSink() {
            if (!this._sink)
                return;
            const gdkWindow = this._area.get_window();
            if (!gdkWindow)
                return;
            try {
                this._sink.set_window_handle(getXid(gdkWindow));
            } catch (e) {
                console.warn(
                    `${LOG_PREFIX} XID embed failed [monitor ${this._index}]: ${e.message}`
                );
            }
        }

        _volumeLinear() {
            const v = videoMute ? 0 : videoVolume / 100;
            return Math.max(0, Math.min(1, v));
        }

        _maybeRandomStart() {
            if (!videoRandomStart || !this._randomStartPending)
                return;
            const [ok, duration] = this._playbin.query_duration(Gst.Format.TIME);
            if (!ok || duration <= 0)
                return;
            const second = Gst.SECOND || 1000000000;
            const maxPos = Math.max(duration - second, 0);
            const position = Math.floor(Math.random() * (maxPos + 1));
            this._playbin.seek_simple(
                Gst.Format.TIME, Gst.SeekFlags.FLUSH, position
            );
            this._randomStartPending = false;
        }

        start() {
            this.setUri(this._path);
            this._playbin.set_state(Gst.State.PLAYING);
        }

        setUri(path) {
            const uri = toUri(path);
            if (!uri || uri === this._uri)
                return;
            this._uri = uri;
            this._playbin.set_property('uri', uri);
            this._randomStartPending = true;
        }

        play() {
            this._playbin.set_state(Gst.State.PLAYING);
        }

        pause() {
            this._playbin.set_state(Gst.State.PAUSED);
        }

        setVolume(linear) {
            this._playbin.set_property('volume', linear);
        }

        getVolume() {
            return this._playbin.get_property('volume');
        }
    }
);

// ═══════════════════════════════════════════════════════════════════════════
// WebpageWindow — one WebKit view per monitor (WE/Lively web wallpapers).
// Mirrors the RendererWindow control surface so D-Bus play/pause/volume keep
// working unchanged.
// ═══════════════════════════════════════════════════════════════════════════
const WebpageWindow = GObject.registerClass(
    {
        GTypeName: 'WpWebpageWindow',
    },
    class WebpageWindow extends Gtk.ApplicationWindow {
        constructor(app, gdkMonitor, index, isPrimary, config) {
            super({application: app});

            this._app = app;
            this._index = index;
            this._isPrimary = isPrimary;
            this.isWebpage = true;
            this._uri = '';
            this._started = false;
            this._paused = false;

            this._webview = new WebKit.WebView();
            this._applyWebSettings();
            this.add(this._webview);
            this._webview.show();

            configureWallpaperWindow(this, gdkMonitor, index);

            this._webview.connect('load-changed', (_view, event) => {
                if (event === WebKit.LoadEvent.FINISHED) {
                    if (this._isPrimary && !this._paused)
                        this._app._onPrimaryStateChanged(Gst.State.PLAYING);
                    console.log(
                        `${LOG_PREFIX} webpage loaded [monitor ${this._index}]`
                    );
                } else if (event === WebKit.LoadEvent.FAILED) {
                    console.warn(
                        `${LOG_PREFIX} webpage load failed [monitor ${this._index}]`
                    );
                }
            });

            this.applyConfig(config);
        }

        _applyWebSettings() {
            try {
                const settings = this._webview.get_settings();
                settings.set_property('enable-javascript', true);
                settings.set_property('enable-webaudio', true);
            } catch (e) {
                console.warn(`${LOG_PREFIX} webpage settings failed: ${e.message}`);
            }
        }

        /** Install the WE/Lively shim so it runs before the page's own scripts. */
        _installBridge(bridgeScript) {
            if (!bridgeScript)
                return;
            const ucm = this._webview.get_user_content_manager();
            ucm.remove_all_scripts();
            ucm.add_script(new WebKit.UserScript(
                bridgeScript,
                WebKit.UserContentInjectedFrames.TOP_FRAME,
                WebKit.UserScriptInjectionTime.START,
                null, null
            ));
        }

        /** Update the page or its live properties without rebuilding the window. */
        applyConfig(config) {
            if (!config)
                return;
            this._installBridge(config.bridgeScript);
            if (config.uri && config.uri !== this._uri) {
                this._uri = config.uri;
                if (this._started)
                    this._webview.load_uri(this._uri);
            } else {
                this.refreshProperties(config.properties);
            }
        }

        refreshProperties(flat) {
            this.evaluate(
                `window.mopivoApplyProperties(${JSON.stringify(flat || {})})`
            );
        }

        evaluate(js) {
            if (!js)
                return;
            try {
                // WebKitGTK 2.40+ exposes evaluate_javascript; older builds use
                // the deprecated run_javascript. Prefer the current one.
                if (typeof this._webview.evaluate_javascript === 'function')
                    this._webview.evaluate_javascript(js, -1, null, null, null, null);
                else if (typeof this._webview.run_javascript === 'function')
                    this._webview.run_javascript(js, null, null);
                else
                    console.warn(`${LOG_PREFIX} webpage JS evaluation unavailable`);
            } catch (e) {
                console.warn(`${LOG_PREFIX} webpage JS evaluation failed: ${e.message}`);
            }
        }

        start() {
            this._started = true;
            if (this._uri)
                this._webview.load_uri(this._uri);
        }

        play() {
            this._paused = false;
            if (this._isPrimary)
                this._app._onPrimaryStateChanged(Gst.State.PLAYING);
        }

        pause() {
            this._paused = true;
            if (this._isPrimary)
                this._app._onPrimaryStateChanged(Gst.State.PAUSED);
        }

        setVolume(linear) {
            try {
                if (typeof this._webview.set_is_muted === 'function')
                    this._webview.set_is_muted(!(linear > 0));
            } catch (e) {
                console.warn(`${LOG_PREFIX} webpage mute failed: ${e.message}`);
            }
        }

        getVolume() {
            return 1;
        }

        setUri() {
            // Webpage mode has no per-monitor video path; ignored on purpose.
        }
    }
);

// ═══════════════════════════════════════════════════════════════════════════
// Renderer — Gtk.Application subclass
// ═══════════════════════════════════════════════════════════════════════════
const Renderer = GObject.registerClass(
    {
        GTypeName: 'WpRenderer',
    },
    class Renderer extends Gtk.Application {
        constructor() {
            super({
                application_id: APPLICATION_ID,
                flags: Gio.ApplicationFlags.NON_UNIQUE |
                    Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
            });

            this._windows = [];
            this._monitors = [];
            this._dbus = null;
            this._isPlaying = false;
            this._audioPipeline = null;

            this.connect('activate', () => {
                if (this._windows.length > 0)
                    return;

                const display = Gdk.Display.get_default();
                if (!display) {
                    console.error(`${LOG_PREFIX} No display available`);
                    return;
                }

                const count = display.get_n_monitors();
                for (let i = 0; i < count; i++)
                    this._monitors.push(display.get_monitor(i));
                if (this._monitors.length === 0) {
                    const primary = display.get_primary_monitor();
                    if (primary)
                        this._monitors.push(primary);
                }

                this._buildUI();
                this._windows.forEach(w => {
                    w.show_all();
                    w.present();
                });
                this._windows.forEach(w => w.start());
            });

            this.connect('command-line', (app, commandLine) => {
                const argv = commandLine.get_arguments().slice(1);
                if (this._parseAndInit(argv)) {
                    this.activate();
                    return 0;
                }
                commandLine.set_exit_status(2);
                return 2;
            });
        }

        // ─────────────────────────────────────────────────────────────
        // Argument parsing + settings initialisation
        // ─────────────────────────────────────────────────────────────

        _printUsage() {
            console.log(
                `Usage: gjs renderer.js -P <ext-path> [-F <video-file>] [-N]\n` +
                `  -P <ext-path>    Path to the extension install directory (required)\n` +
                `  -F <video-file>  Initial video file path (optional)\n` +
                `  -N               No-hide debug mode (show window decorations)`
            );
        }

        _parseAndInit(argv) {
            let lastArg = null;
            for (const arg of argv) {
                if (lastArg === '-P') {
                    extPath = arg;
                    lastArg = null;
                } else if (lastArg === '-F') {
                    videoPath = arg;
                    lastArg = null;
                } else if (arg === '-P' || arg === '-F') {
                    lastArg = arg;
                } else if (arg === '-N' || arg === '--nohide') {
                    nohide = true;
                } else if (arg === '-h' || arg === '--help') {
                    this._printUsage();
                    return false;
                } else {
                    console.error(`${LOG_PREFIX} Unknown argument: ${arg}`);
                    this._printUsage();
                    return false;
                }
            }

            if (!extPath) {
                console.error(`${LOG_PREFIX} -P <ext-path> is required`);
                this._printUsage();
                return false;
            }

            if (!this._loadSettings())
                return false;

            this._readSettings();
            this._exportDbus();
            this._connectSettings();
            this._setupAutoWallpaper();

            return true;
        }

        _loadSettings() {
            const schemaDirPath = GLib.build_filenamev([extPath, 'schemas']);
            if (!GLib.file_test(schemaDirPath, GLib.FileTest.IS_DIR)) {
                console.error(
                    `${LOG_PREFIX} Schema directory not found: ${schemaDirPath}`
                );
                return false;
            }

            try {
                const defaultSource = Gio.SettingsSchemaSource.get_default();
                const schemaSource =
                    Gio.SettingsSchemaSource.new_from_directory(
                        schemaDirPath, defaultSource, false
                    );
                const schema = schemaSource.lookup(EXT_SCHEMA_ID, true);
                if (!schema) {
                    console.error(
                        `${LOG_PREFIX} Schema ${EXT_SCHEMA_ID} not found in ${schemaDirPath}`
                    );
                    return false;
                }
                extSettings = new Gio.Settings({settings_schema: schema});
            } catch (e) {
                console.error(
                    `${LOG_PREFIX} Failed to load settings schema: ${e.message}`
                );
                return false;
            }

            return true;
        }

        _readSettings() {
            if (!extSettings)
                return;

            // CLI -F wins; fall back to the settings key.
            if (!videoPath || videoPath.length === 0)
                videoPath = extSettings.get_string('video-path');

            videoModeType = extSettings.get_string('video-mode-type');
            videoFolder = extSettings.get_string('video-folder');
            videoWebpageUrl = safeGetString(extSettings, 'video-webpage-url');
            videoWebpageLocalHtml = safeGetString(extSettings, 'video-webpage-local-html');
            videoWebpageProject = safeGetString(extSettings, 'video-webpage-project');
            videoWebpageProperties = safeGetString(extSettings, 'video-webpage-properties', '{}');
            videoWebpageAudio = safeGetBoolean(extSettings, 'video-webpage-audio');
            videoVolume = extSettings.get_int('video-volume');
            videoMute = extSettings.get_boolean('video-mute');
            videoFadeDurationSec = extSettings.get_double('video-fade-duration-sec');
            videoFitMode = extSettings.get_string('video-fit-mode');
            videoRandomStart = extSettings.get_boolean('video-random-start');
            videoMonitorPaths = extSettings.get_strv('video-monitor-paths');
            preferClappersink = extSettings.get_boolean('prefer-clappersink');
            forceMediaFile = extSettings.get_boolean('force-mediafile');
            enableVA = extSettings.get_boolean('enable-va');
            enableNvSl = extSettings.get_boolean('enable-nvsl');
            changeWallpaper = extSettings.get_boolean('change-wallpaper');
            changeWallpaperDir = extSettings.get_string('change-wallpaper-directory-path');
            changeWallpaperInterval = extSettings.get_int('change-wallpaper-interval');
            changeWallpaperMode = extSettings.get_int('change-wallpaper-mode');
        }

        // ─────────────────────────────────────────────────────────────
        // Settings change handlers
        // ─────────────────────────────────────────────────────────────

        _connectSettings() {
            if (!extSettings)
                return;

            extSettings.connect('changed', (settings, key) => {
                switch (key) {
                case 'video-path':
                    videoPath = settings.get_string(key);
                    this.setFilePath(videoPath);
                    break;

                case 'video-volume':
                    videoVolume = settings.get_int(key);
                    this._setVolumeWithFade(videoMute ? 0 : videoVolume / 100.0);
                    break;

                case 'video-mute':
                    videoMute = settings.get_boolean(key);
                    this._setVolumeWithFade(videoMute ? 0 : videoVolume / 100.0);
                    break;

                case 'video-fit-mode':
                    videoFitMode = settings.get_string(key);
                    if (videoFitMode !== 'contain') {
                        console.warn(
                            `${LOG_PREFIX} fit-mode "${videoFitMode}" unsupported by xvimagesink; using contain`
                        );
                    }
                    break;

                case 'video-random-start':
                    videoRandomStart = settings.get_boolean(key);
                    break;

                case 'video-fade-duration-sec':
                    videoFadeDurationSec = settings.get_double(key);
                    break;

                case 'video-webpage-url':
                    videoWebpageUrl = settings.get_string(key);
                    this._reloadWebpage('video-webpage-url');
                    break;

                case 'video-webpage-local-html':
                    videoWebpageLocalHtml = settings.get_string(key);
                    this._reloadWebpage('video-webpage-local-html');
                    break;

                case 'video-webpage-project':
                    videoWebpageProject = safeGetString(settings, key);
                    this._reloadWebpage('video-webpage-project');
                    break;

                case 'video-webpage-properties':
                    videoWebpageProperties = safeGetString(settings, key, '{}');
                    this._pushWebpageProperties();
                    break;

                case 'video-webpage-audio':
                    videoWebpageAudio = safeGetBoolean(settings, key);
                    this._restartAudioBridge();
                    break;

                case 'video-mode-type':
                    videoModeType = settings.get_string(key);
                    console.warn(
                        `${LOG_PREFIX} Mode changed to ${videoModeType} — restart recommended`
                    );
                    break;

                case 'video-monitor-paths':
                    videoMonitorPaths = settings.get_strv(key);
                    console.warn(
                        `${LOG_PREFIX} Per-monitor paths changed — restart recommended`
                    );
                    break;

                case 'change-wallpaper':
                    changeWallpaper = settings.get_boolean(key);
                    this._setupAutoWallpaper();
                    break;

                case 'change-wallpaper-directory-path':
                    changeWallpaperDir = settings.get_string(key);
                    this._setupAutoWallpaper();
                    break;

                case 'change-wallpaper-interval':
                    changeWallpaperInterval = settings.get_int(key);
                    this._setupAutoWallpaper();
                    break;

                case 'change-wallpaper-mode':
                    changeWallpaperMode = settings.get_int(key);
                    break;

                case 'prefer-clappersink':
                case 'force-mediafile':
                case 'enable-va':
                case 'enable-nvsl':
                    console.warn(
                        `${LOG_PREFIX} ${key} changed — restart recommended`
                    );
                    break;
                }
            });
        }

        // ─────────────────────────────────────────────────────────────
        // D-Bus export
        // ─────────────────────────────────────────────────────────────

        _exportDbus() {
            const dbusXml = `
            <node>
                <interface name="${APPLICATION_ID}">
                    <method name="setPlay"/>
                    <method name="setPause"/>
                    <property name="isPlaying" type="b" access="read"/>
                    <signal name="isPlayingChanged">
                        <arg name="isPlaying" type="b"/>
                    </signal>
                </interface>
            </node>`;

            this._dbus = Gio.DBusExportedObject.wrapJSObject(dbusXml, this);
            this._dbus.export(Gio.DBus.session, RENDERER_OBJECT_PATH);
            // Own the well-known name so the app's RendererDBus proxy
            // resolves. (Gtk.Application with NON_UNIQUE does not own its
            // application_id itself.) REPLACE: a fresh renderer always takes
            // over from a dying one during restarts.
            Gio.bus_own_name(
                Gio.BusType.SESSION,
                APPLICATION_ID,
                Gio.BusNameOwnerFlags.REPLACE,
                null, null, null
            );
        }

        // ─────────────────────────────────────────────────────────────
        // GStreamer hardware-decode rank bumping
        // ─────────────────────────────────────────────────────────────

        _setupGst() {
            try {
                if (enableVA)
                    this._setPluginDecodersRank('va', Gst.Rank.PRIMARY + 3, false);
                if (enableNvSl)
                    this._setPluginDecodersRank('nvcodec', Gst.Rank.PRIMARY + 1, true);
            } catch (e) {
                console.warn(`${LOG_PREFIX} HW decode setup failed: ${e.message}`);
            }
        }

        _setPluginDecodersRank(pluginName, rank, useStateless) {
            try {
                const gstRegistry = Gst.Registry.get();
                const features = gstRegistry.get_feature_list_by_plugin(pluginName);

                for (const feature of features) {
                    const featureName = feature.get_name();

                    if (!featureName.endsWith('dec') &&
                        !featureName.endsWith('postproc'))
                        continue;

                    const isStateless = featureName.includes('sl');
                    if (isStateless !== useStateless)
                        continue;

                    const oldRank = feature.get_rank();
                    if (rank === oldRank)
                        continue;

                    feature.set_rank(rank);
                    console.debug(
                        `${LOG_PREFIX} changed rank: ${oldRank} -> ${rank} for ${featureName}`
                    );
                }
            } catch (e) {
                console.warn(
                    `${LOG_PREFIX} Failed to set ranks for ${pluginName}: ${e.message}`
                );
            }
        }

        // ─────────────────────────────────────────────────────────────
        // UI building — one window per monitor
        // ─────────────────────────────────────────────────────────────

        _buildUI() {
            this._setupGst();
            this._loadCss();

            if (videoModeType === 'webpage') {
                this._buildWebpageWindows().catch(e =>
                    console.error(`${LOG_PREFIX} webpage mode setup failed: ${e.message}`));
                return;
            }

            const monitorMap = parseMonitorPaths(videoMonitorPaths);
            let primaryIndex = this._monitors.findIndex(m => m.is_primary());
            if (primaryIndex < 0)
                primaryIndex = 0;

            this._monitors.forEach((gdkMonitor, index) => {
                const path = this._resolveMonitorPath(gdkMonitor, monitorMap);
                try {
                    this._windows.push(new RendererWindow(
                        this, gdkMonitor, index, index === primaryIndex, path
                    ));
                } catch (e) {
                    console.error(
                        `${LOG_PREFIX} Window setup failed [monitor ${index}]: ${e.message}`
                    );
                }
            });

            console.log(`${LOG_PREFIX} Using ${IMPL_NAME} for video output`);
        }

        _resolveMonitorPath(gdkMonitor, monitorMap) {
            const model = gdkMonitor.get_model ? gdkMonitor.get_model() : '';
            if (model && monitorMap[model])
                return monitorMap[model];
            return videoPath;
        }

        // ─────────────────────────────────────────────────────────────
        // Webpage mode — WebKit views + WE/Lively property/audio bridge
        // ─────────────────────────────────────────────────────────────

        _webpageWindows() {
            return this._windows.filter(w => w && w.isWebpage);
        }

        async _buildWebpageWindows() {
            if (!WebKit) {
                console.error(
                    `${LOG_PREFIX} webpage mode requested but no WebKit namespace ` +
                    '(WebKit2 4.1 / WebKit 6.0) is installed; showing blank wallpaper'
                );
                return;
            }

            const web = await loadWallpaperWeb();
            if (!web) {
                console.error(
                    `${LOG_PREFIX} webpage mode unavailable: helper module missing`
                );
                return;
            }

            const config = this._resolveWebpageConfig(web);
            if (!config) {
                console.error(
                    `${LOG_PREFIX} webpage mode: no project folder, local HTML or URL configured`
                );
                return;
            }

            let primaryIndex = this._monitors.findIndex(m => m.is_primary());
            if (primaryIndex < 0)
                primaryIndex = 0;

            this._monitors.forEach((gdkMonitor, index) => {
                try {
                    this._windows.push(new WebpageWindow(
                        this, gdkMonitor, index, index === primaryIndex, config
                    ));
                } catch (e) {
                    console.error(
                        `${LOG_PREFIX} Webpage window setup failed [monitor ${index}]: ${e.message}`
                    );
                }
            });

            this._windows.forEach(w => {
                w.show_all();
                w.present();
            });
            this._windows.forEach(w => w.start());

            console.log(
                `${LOG_PREFIX} Using WebKit for webpage output ` +
                `(${this._windows.length} monitor(s))`
            );
            if (videoWebpageAudio)
                this._startAudioBridge();
        }

        /**
         * Resolve the effective webpage source and properties. Prefers a WE/
         * Lively project folder, then a local HTML file, then a URL.
         * @returns {{uri: string, bridgeScript: string, properties: object}|null}
         */
        _resolveWebpageConfig(web) {
            const overrides = web.jsonToProperties(videoWebpageProperties, reason =>
                console.warn(`${LOG_PREFIX} invalid video-webpage-properties: ${reason}`));

            let uri = '';
            let properties = {};
            let lively = {};

            // Accept either the project folder or a direct path to project.json.
            let projectDir = videoWebpageProject;
            if (projectDir && !web.isWebProjectFolder(projectDir) &&
                projectDir.endsWith('.json')) {
                const parent = Gio.File.new_for_path(projectDir).get_parent();
                if (parent)
                    projectDir = parent.get_path();
            }

            if (projectDir && web.isWebProjectFolder(projectDir)) {
                const projectPath = GLib.build_filenamev([projectDir, 'project.json']);
                const livelyPath =
                    GLib.build_filenamev([projectDir, 'LivelyProperties.json']);
                let project = {title: '', file: '', properties: {}};
                if (GLib.file_test(projectPath, GLib.FileTest.EXISTS)) {
                    project = web.parseProjectJson(readFileText(projectPath));
                    if (project.error)
                        console.warn(`${LOG_PREFIX} invalid project.json: ${project.error}`);
                }
                if (GLib.file_test(livelyPath, GLib.FileTest.EXISTS)) {
                    lively = web.parseLivelyProperties(readFileText(livelyPath), reason =>
                        console.warn(`${LOG_PREFIX} invalid LivelyProperties.json: ${reason}`));
                }
                const entryPath = web.resolveEntryFile(projectDir, project);
                if (!entryPath) {
                    console.error(`${LOG_PREFIX} no entry HTML found in ${projectDir}`);
                    return null;
                }
                uri = Gio.File.new_for_path(entryPath).get_uri();
                properties = web.mergeProperties(project.properties, lively, overrides);
                console.log(
                    `${LOG_PREFIX} web project "${project.title || projectDir}" -> ` +
                    `${entryPath} (${Object.keys(properties).length} properties)`
                );
            } else if (videoWebpageLocalHtml) {
                const file = Gio.File.new_for_path(videoWebpageLocalHtml);
                if (!file.query_exists(null)) {
                    console.error(
                        `${LOG_PREFIX} local HTML not found: ${videoWebpageLocalHtml}`
                    );
                    return null;
                }
                uri = file.get_uri();
                properties = overrides;
            } else if (videoWebpageUrl) {
                uri = videoWebpageUrl;
                properties = overrides;
            } else {
                return null;
            }

            const bridgeScript = web.buildBridgeScript({
                properties,
                livelyProperties: lively,
                audioEnabled: videoWebpageAudio,
                env: 'both',
            });
            return {uri, bridgeScript, properties};
        }

        _reloadWebpage(reason) {
            const windows = this._webpageWindows();
            if (windows.length === 0)
                return;
            console.log(`${LOG_PREFIX} ${reason} changed — reloading webpage`);
            loadWallpaperWeb().then(web => {
                if (!web)
                    return;
                const config = this._resolveWebpageConfig(web);
                if (config)
                    windows.forEach(w => w.applyConfig(config));
            });
        }

        _pushWebpageProperties() {
            const windows = this._webpageWindows();
            if (windows.length === 0)
                return;
            loadWallpaperWeb().then(web => {
                if (!web)
                    return;
                const config = this._resolveWebpageConfig(web);
                if (config)
                    windows.forEach(w => w.refreshProperties(config.properties));
            });
        }

        // ── Audio bridge: GStreamer spectrum → window.mopivoPushAudio ──

        _restartAudioBridge() {
            this._stopAudioBridge();
            if (videoWebpageAudio && this._webpageWindows().length > 0)
                this._startAudioBridge();
        }

        /**
         * Best-effort system-audio capture: pulsesrc/autoaudiosrc → spectrum,
         * whose 64 bands are pushed to every webpage view. Set
         * MOPIVO_AUDIO_DEVICE to a sink *monitor* to react to output instead
         * of the default capture device.
         */
        _startAudioBridge() {
            if (this._audioPipeline)
                return;
            try {
                const pipeline = Gst.Pipeline.new('wp-webpage-audio');
                const source = Gst.ElementFactory.make('pulsesrc', null) ||
                    Gst.ElementFactory.make('autoaudiosrc', null);
                const convert = Gst.ElementFactory.make('audioconvert', null);
                const resample = Gst.ElementFactory.make('audioresample', null);
                const capsFilter = Gst.ElementFactory.make('capsfilter', null);
                const spectrum = Gst.ElementFactory.make('spectrum', null);
                const sink = Gst.ElementFactory.make('fakesink', null);
                if (!source || !convert || !resample || !capsFilter ||
                    !spectrum || !sink) {
                    console.warn(
                        `${LOG_PREFIX} webpage audio: required GStreamer elements ` +
                        'missing; bridge disabled'
                    );
                    return;
                }

                const device = GLib.getenv('MOPIVO_AUDIO_DEVICE');
                if (device && source.find_property('device'))
                    source.set_property('device', device);

                capsFilter.set_property(
                    'caps', Gst.Caps.from_string('audio/x-raw,rate=44100,channels=2')
                );
                spectrum.set_property('bands', 64);
                spectrum.set_property('threshold', -80);
                spectrum.set_property('interval', 33000000); // ~30 fps in ns

                [source, convert, resample, capsFilter, spectrum, sink]
                    .forEach(el => pipeline.add(el));
                if (!source.link(convert) || !convert.link(resample) ||
                    !resample.link(capsFilter) || !capsFilter.link(spectrum) ||
                    !spectrum.link(sink)) {
                    console.warn(
                        `${LOG_PREFIX} webpage audio: pipeline link failed; bridge disabled`
                    );
                    return;
                }

                const bus = pipeline.get_bus();
                bus.add_signal_watch();
                bus.connect('message::element', (_bus, msg) => {
                    try {
                        const structure = msg.get_structure();
                        if (!structure || structure.get_name() !== 'spectrum')
                            return;
                        const magnitudes = structure.get_list('magnitude');
                        if (!magnitudes || magnitudes.length === 0)
                            return;
                        const samples = [];
                        for (let i = 0; i < magnitudes.length; i++) {
                            // spectrum magnitudes are dBFS (-80..0); pages expect 0..1.
                            samples.push(Math.max(0, Math.min(
                                1, Math.pow(10, magnitudes[i] / 20)
                            )));
                        }
                        this._pushWebpageAudio(samples);
                    } catch (e) {
                        console.warn(
                            `${LOG_PREFIX} webpage audio spectrum failed: ${e.message}`
                        );
                    }
                });
                bus.connect('message::error', (_bus, msg) => {
                    const [err] = msg.parse_error();
                    console.warn(`${LOG_PREFIX} webpage audio error: ${err.message}`);
                });

                pipeline.set_state(Gst.State.PLAYING);
                this._audioPipeline = pipeline;
                console.log(
                    `${LOG_PREFIX} webpage audio bridge started` +
                    (device ? ` (device ${device})` : '')
                );
            } catch (e) {
                console.warn(
                    `${LOG_PREFIX} webpage audio bridge unavailable: ${e.message}`
                );
            }
        }

        _stopAudioBridge() {
            if (!this._audioPipeline)
                return;
            try {
                this._audioPipeline.set_state(Gst.State.NULL);
            } catch (e) {
                console.warn(`${LOG_PREFIX} webpage audio stop failed: ${e.message}`);
            }
            this._audioPipeline = null;
        }

        _pushWebpageAudio(samples) {
            const js = `window.mopivoPushAudio(${JSON.stringify(samples)})`;
            this._webpageWindows().forEach(w => w.evaluate(js));
        }

        _loadCss() {
            try {
                const cssPath = GLib.build_filenamev([
                    extPath, 'renderer', 'stylesheet.css',
                ]);
                const cssProvider = new Gtk.CssProvider();
                cssProvider.load_from_file(Gio.File.new_for_path(cssPath));
                Gtk.StyleContext.add_provider_for_display(
                    Gdk.Display.get_default(),
                    cssProvider,
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
                );
            } catch (e) {
                console.warn(`${LOG_PREFIX} Failed to load CSS: ${e.message}`);
            }
        }

        // ─────────────────────────────────────────────────────────────
        // Playback control
        // ─────────────────────────────────────────────────────────────

        _primaryWindow() {
            return this._windows.find(w => w._isPrimary) ||
                this._windows[0] || null;
        }

        _onPrimaryStateChanged(state) {
            const playing = state === Gst.State.PLAYING;
            if (playing !== this._isPlaying) {
                this._isPlaying = playing;
                this._emitIsPlayingChanged();
            }
        }

        setPlay() {
            this._windows.forEach(w => w.play());
        }

        setPause() {
            this._windows.forEach(w => w.pause());
        }

        setFilePath(path) {
            this._windows.forEach(w => w.setUri(path));
            this._windows.forEach(w => w.play());
        }

        // ─────────────────────────────────────────────────────────────
        // Volume / mute with fade
        // ─────────────────────────────────────────────────────────────

        _applyVolume(linearVolume) {
            const win = this._primaryWindow();
            if (win)
                win.setVolume(Math.max(0, Math.min(1, linearVolume)));
        }

        _getCurrentVolume() {
            const win = this._primaryWindow();
            return win ? win.getVolume() : 0;
        }

        /**
         * Ramp the primary monitor volume from its current value to the
         * target over video-fade-duration-sec seconds.
         */
        _setVolumeWithFade(targetVolume) {
            if (fadeTimerId) {
                GLib.source_remove(fadeTimerId);
                fadeTimerId = null;
            }

            const duration = videoFadeDurationSec;
            if (duration <= 0) {
                this._applyVolume(targetVolume);
                return;
            }

            const currentVolume = this._getCurrentVolume();
            const steps = Math.max(1, Math.round(duration / 0.03));
            const delta = (targetVolume - currentVolume) / steps;
            let step = 0;

            fadeTimerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 30, () => {
                    step++;
                    if (step >= steps) {
                        this._applyVolume(targetVolume);
                        fadeTimerId = null;
                        return GLib.SOURCE_REMOVE;
                    }
                    this._applyVolume(currentVolume + delta * step);
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        // ─────────────────────────────────────────────────────────────
        // Auto-change wallpaper
        // ─────────────────────────────────────────────────────────────

        _setupAutoWallpaper() {
            if (changeWallpaperTimerId) {
                GLib.source_remove(changeWallpaperTimerId);
                changeWallpaperTimerId = null;
            }

            if (!changeWallpaper)
                return;

            const dir = changeWallpaperDir || videoFolder ||
                GLib.build_filenamev([
                    GLib.get_home_dir(), 'Videos', 'Mopivo',
                ]);

            autoWallpaperPaths = scanVideoDir(dir);
            if (autoWallpaperPaths.length === 0) {
                console.warn(
                    `${LOG_PREFIX} Auto-change: no videos in ${dir}, retrying in 60s`
                );
                changeWallpaperTimerId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT, 60, () => {
                        this._setupAutoWallpaper();
                        return GLib.SOURCE_REMOVE;
                    }
                );
                return;
            }

            autoWallpaperIndex = 0;
            console.log(
                `${LOG_PREFIX} Auto-change: ${autoWallpaperPaths.length} videos, ` +
                `interval ${changeWallpaperInterval}m, mode ${changeWallpaperMode}`
            );

            const change = () => {
                if (!this._isPlaying)
                    return GLib.SOURCE_CONTINUE;

                extSettings.set_string(
                    'video-path', autoWallpaperPaths[autoWallpaperIndex]
                );

                switch (changeWallpaperMode) {
                case 0: // sequential
                    autoWallpaperIndex =
                        (autoWallpaperIndex + 1) % autoWallpaperPaths.length;
                    break;
                case 1: // reverse
                    autoWallpaperIndex =
                        (autoWallpaperIndex - 1 + autoWallpaperPaths.length) %
                        autoWallpaperPaths.length;
                    break;
                case 2: { // random
                    let newIndex;
                    do {
                        newIndex = Math.floor(
                            Math.random() * autoWallpaperPaths.length
                        );
                    } while (
                        newIndex === autoWallpaperIndex &&
                        autoWallpaperPaths.length > 1
                    );
                    autoWallpaperIndex = newIndex;
                    break;
                }
                }

                return GLib.SOURCE_CONTINUE;
            };

            change();

            changeWallpaperTimerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                changeWallpaperInterval * 60,
                change
            );
        }

        // ─────────────────────────────────────────────────────────────
        // D-Bus property + signal helpers
        // ─────────────────────────────────────────────────────────────

        get isPlaying() {
            return this._isPlaying;
        }

        _emitIsPlayingChanged() {
            if (this._dbus) {
                this._dbus.emit_signal(
                    'isPlayingChanged',
                    new GLib.Variant('(b)', [this._isPlaying])
                );
            }
        }
    }
);

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════
Gst.init(null);

const app = new Renderer();

// Clean exit on SIGTERM (signal 15)
imports.gi.GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    app.quit();
    return GLib.SOURCE_REMOVE;
});

imports.system.exit(app.run([GLib.get_prgname() || 'renderer.js', ...ARGV]));
