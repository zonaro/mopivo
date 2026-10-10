#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper renderer — standalone GJS+GTK4 subprocess.
// Displays video/webpage wallpapers in fullscreen windows (one per monitor).
// A GStreamer crash in this process never takes down the GNOME Shell.

// ═══════════════════════════════════════════════════════════════════════════
// GI version requirements
// ═══════════════════════════════════════════════════════════════════════════
imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Gdk = '4.0';
imports.gi.versions.GdkX11 = '4.0';

const {GObject, Gtk, Gio, GLib, Gdk, Gst} = imports.gi;

// ═══════════════════════════════════════════════════════════════════════════
// Constants — mirrored from lib/video/constants.js
// ═══════════════════════════════════════════════════════════════════════════
const APPLICATION_ID = 'org.redclaw.WallpaperProvidersRenderer';
const RENDERER_OBJECT_PATH = '/org/redclaw/WallpaperProvidersRenderer';
const EXT_SCHEMA_ID = 'br.com.redclaw.WallpaperProviders';
const LOG_PREFIX = '[wp-video]';
const TITLE_ANCHOR = `@${APPLICATION_ID}!`;

const VIDEO_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v', '.ogv',
];

// ═══════════════════════════════════════════════════════════════════════════
// Feature detection
// ═══════════════════════════════════════════════════════════════════════════
const gstVersion = Gst.version();
const gtkVersion = [
    Gtk.get_major_version(),
    Gtk.get_minor_version(),
    Gtk.get_micro_version(),
];

const isGstVersionAtLeast = (major, minor) =>
    gstVersion[0] > major ||
    (gstVersion[0] === major && gstVersion[1] >= minor);

const isGtkVersionAtLeast = (major, minor) =>
    gtkVersion[0] > major ||
    (gtkVersion[0] === major && gtkVersion[1] >= minor);

let GstPlay = null;
try {
    GstPlay = imports.gi.GstPlay;
} catch (e) {
    console.warn(`${LOG_PREFIX} GstPlay typelib not found — will fallback to GtkMediaFile`);
}
const haveGstPlay = GstPlay !== null;

let GstAudio = null;
try {
    GstAudio = imports.gi.GstAudio;
} catch (e) {
    console.warn(`${LOG_PREFIX} GstAudio typelib not found — cubic→linear fallback active`);
}
const haveGstAudio = GstAudio !== null;

let WebKit = null;
try {
    WebKit = imports.gi.WebKit6;
} catch (e) {
    console.warn(`${LOG_PREFIX} WebKit6 typelib not found — webpage mode unavailable`);
}
const haveWebKit = WebKit !== null;

// GdkX11 loads only under the X11 backend; the versions pin above must come first.
let GdkX11 = null;
try {
    GdkX11 = imports.gi.GdkX11;
} catch (e) {
    console.warn(`${LOG_PREFIX} GdkX11 typelib not found — X11 desktop layer disabled`);
}
const haveGdkX11 = GdkX11 !== null;

const haveContentFit = isGtkVersionAtLeast(4, 8);
const useGstGL = isGstVersionAtLeast(1, 24);

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
 * Map a video-fit-mode string to a Gtk.ContentFit enum value.
 * Returns 0 (CONTAIN) when ContentFit is unavailable (GTK < 4.8).
 */
function mapContentFit(mode) {
    if (!haveContentFit)
        return 0;
    switch (mode) {
    case 'fill':
        return Gtk.ContentFit.FILL;
    case 'contain':
        return Gtk.ContentFit.CONTAIN;
    case 'cover':
        return Gtk.ContentFit.COVER;
    case 'scale-down':
        return Gtk.ContentFit.SCALE_DOWN;
    default:
        return Gtk.ContentFit.CONTAIN;
    }
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
 * True when the renderer should run in X11 desktop-layer mode: the
 * launcher spawns it with GDK_BACKEND=x11 (XWayland), the GdkX11 typelib
 * loaded, and no-hide debug mode inactive.
 */
function isX11DesktopMode() {
    return haveGdkX11 && !nohide &&
        GLib.getenv('GDK_BACKEND') === 'x11';
}

// Find xprop once; a cached null silences the warning after first attempt.
let xpropPath;
function findXprop() {
    if (xpropPath === undefined) {
        xpropPath = GLib.find_program_in_path('xprop') || null;
        if (!xpropPath)
            console.warn(`${LOG_PREFIX} xprop not found — desktop layer skipped`);
    }
    return xpropPath;
}

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
                flags: Gio.ApplicationFlags.NON_UNIQUE,
            });

            // Window / widget bookkeeping
            this._windows = [];
            this._pictures = [];
            this._webViews = [];
            this._sharedPaintable = null;
            this._gstImplName = '';

            // Playback state
            this._play = null;    // GstPlay.Play instance
            this._media = null;   // Gtk.MediaFile instance
            this._isPlaying = false;
            this._randomStartPending = false;

            // D-Bus exported object
            this._dbus = null;

            // ── Application signals ──────────────────────────────────
            this.connect('activate', app => {
                if (app.activeWindow)
                    return;

                this._display = Gdk.Display.get_default();
                this._monitors = this._display
                    ? [...this._display.get_monitors()]
                    : [];

                this._buildUI();
                this._windows.forEach(w => w.present());
            });

            this.connect('command-line', (app, commandLine) => {
                const argv = commandLine.get_arguments();
                if (this._parseAndInit(argv)) {
                    this.activate();
                    commandLine.set_exit_status(0);
                } else {
                    commandLine.set_exit_status(2);
                }
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
            // ── Parse arguments ──
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

            // ── Load GSettings schema from extension path ──
            if (!this._loadSettings())
                return false;

            // ── Read initial values from settings ──
            this._readSettings();

            // ── Export D-Bus interface ──
            this._exportDbus();

            // ── Connect settings change handlers ──
            this._connectSettings();

            // ── Setup auto-change wallpaper timer ──
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

            videoModeType = extSettings.get_string('video-mode-type');
            videoPath = extSettings.get_string('video-path');
            videoFolder = extSettings.get_string('video-folder');
            videoWebpageUrl = extSettings.get_string('video-webpage-url');
            videoWebpageLocalHtml = extSettings.get_string('video-webpage-local-html');
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

            // If no file given on CLI, use the setting
            if (!videoPath || videoPath.length === 0)
                videoPath = extSettings.get_string('video-path');
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
                    this._updateContentFit();
                    break;

                case 'video-random-start':
                    videoRandomStart = settings.get_boolean(key);
                    break;

                case 'video-fade-duration-sec':
                    videoFadeDurationSec = settings.get_double(key);
                    break;

                case 'video-webpage-url':
                    videoWebpageUrl = settings.get_string(key);
                    if (videoModeType === 'webpage')
                        this._reloadWebViews();
                    break;

                case 'video-webpage-local-html':
                    videoWebpageLocalHtml = settings.get_string(key);
                    if (videoModeType === 'webpage')
                        this._reloadWebViews();
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
            // Setup GStreamer HW decode ranks
            this._setupGst();

            // Load CSS
            this._loadCss();

            // Resolve per-monitor path assignments.
            // Since we use a single shared pipeline, if paths differ
            // we warn and play the FIRST entry for all monitors.
            let effectiveVideoPath = videoPath;
            if (videoMonitorPaths.length > 0) {
                const monitorPathMap = parseMonitorPaths(videoMonitorPaths);
                const paths = Object.values(monitorPathMap);
                const unique = [...new Set(paths)];

                if (unique.length > 1) {
                    console.warn(
                        `${LOG_PREFIX} Per-monitor paths differ; using first entry for all monitors`
                    );
                    effectiveVideoPath = unique[0];
                } else if (unique.length === 1) {
                    effectiveVideoPath = unique[0];
                }
            }

            this._monitors.forEach((gdkMonitor, index) => {
                let widget = null;

                if (videoModeType === 'webpage') {
                    widget = this._createWebpageWidget();
                } else {
                    widget = this._createVideoWidget(
                        effectiveVideoPath, index === 0
                    );
                }

                if (!widget)
                    widget = this._createBlackWidget();

                const geometry = gdkMonitor.get_geometry();
                const state = {
                    position: [geometry.x, geometry.y],
                    keepAtBottom: true,
                    keepMinimized: true,
                    keepPosition: true,
                };
                const title = nohide
                    ? `WP Renderer #${index} (using ${this._gstImplName})`
                    : `${TITLE_ANCHOR}${JSON.stringify(state)}|${index}`;

                const window = new RendererWindow(
                    this, title, widget, gdkMonitor
                );
                this._windows.push(window);
            });

            console.log(`${LOG_PREFIX} Using ${this._gstImplName} for video output`);
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
        // Video widget creation (GstPlay or MediaFile fallback)
        // ─────────────────────────────────────────────────────────────

        _createVideoWidget(filePath, isPrimary) {
            if (!filePath || filePath.length === 0) {
                console.warn(`${LOG_PREFIX} No video path — showing black`);
                return this._createBlackWidget();
            }

            // Force MediaFile backend?
            if (forceMediaFile) {
                return this._setupMediaFile(filePath);
            }

            // Try GstPlay path
            if (haveGstPlay) {
                try {
                    return this._setupGstPlay(filePath, isPrimary);
                } catch (e) {
                    console.warn(
                        `${LOG_PREFIX} GstPlay setup failed: ${e.message} — falling back`
                    );
                }
            }

            // Fallback: Gtk.MediaFile
            try {
                return this._setupMediaFile(filePath);
            } catch (e) {
                console.error(
                    `${LOG_PREFIX} MediaFile setup failed: ${e.message}`
                );
                return this._createBlackWidget();
            }
        }

        /**
         * Setup a GstPlay pipeline with the best available sink.
         * Returns a GTK widget for embedding in the window.
         */
        _setupGstPlay(filePath, isPrimary) {
            // Sink selection
            let sink = null;

            if (preferClappersink) {
                try {
                    sink = Gst.ElementFactory.make('clappersink', 'clappersink');
                } catch (e) {
                    console.warn(`${LOG_PREFIX} clappersink not available`);
                }
            }

            if (!sink) {
                try {
                    sink = Gst.ElementFactory.make(
                        'gtk4paintablesink', 'gtk4paintablesink'
                    );
                } catch (e) {
                    console.warn(`${LOG_PREFIX} gtk4paintablesink not available`);
                }
            }

            if (!sink)
                throw new Error('No GStreamer sink available');

            this._gstImplName = sink.name;

            // Wrap in glsinkbin for GPU-accelerated rendering (Gst >= 1.24)
            if (useGstGL) {
                try {
                    const glsink = Gst.ElementFactory.make('glsinkbin', 'glsinkbin');
                    if (glsink) {
                        this._gstImplName = `glsinkbin + ${this._gstImplName}`;
                        glsink.set_property('sink', sink);
                        sink = glsink;
                    }
                } catch (e) {
                    console.warn(`${LOG_PREFIX} glsinkbin not available`);
                }
            }

            // Create GstPlay instance
            this._play = GstPlay.Play.new(
                GstPlay.PlayVideoOverlayVideoRenderer.new_with_sink(null, sink)
            );
            this._adapter = GstPlay.PlaySignalAdapter.new(this._play);

            // Loop: seek to start on end-of-stream
            this._adapter.connect('end-of-stream', adapter =>
                adapter.play.seek(0)
            );

            // Error handling
            this._adapter.connect('warning', (_adapter, err) =>
                console.warn(`${LOG_PREFIX} GstPlay warning: ${err.message}`)
            );
            this._adapter.connect('error', (_adapter, err) =>
                console.error(`${LOG_PREFIX} GstPlay error: ${err.message}`)
            );

            // Apply volume/mute after reaching PAUSED or later
            let volumeApplied = false;
            this._adapter.connect('state-changed', (_adapter, state) => {
                if (!volumeApplied && state >= GstPlay.PlayState.PAUSED) {
                    this._applyVolume(
                        videoMute ? 0 : videoVolume / 100.0
                    );
                    volumeApplied = true;
                }
            });

            // Monitor playing state for D-Bus property + auto-change
            this._adapter.connect('state-changed', (_adapter, state) => {
                const playing = state === GstPlay.PlayState.PLAYING;
                if (playing !== this._isPlaying) {
                    this._isPlaying = playing;
                    this._emitIsPlayingChanged();
                }
            });

            // Random start after first PAUSED
            this._adapter.connect('state-changed', (_adapter, state) => {
                if (state >= GstPlay.PlayState.PAUSED)
                    this._maybeSeekRandomGst();
            });

            // Wire shared paintable from the sink
            let widget = this._getWidgetFromSink(sink);

            // Set URI and start
            this._play.set_uri(toUri(filePath));
            this._markRandomStartPending();
            this.setPlay();
            this._setupAutoWallpaper();

            return widget;
        }

        /**
         * Fallback: use Gtk.MediaFile for video playback.
         */
        _setupMediaFile(filePath) {
            this._gstImplName = 'GtkMediaFile';

            // Gtk.MediaFile.new_for_filename / new_for_uri
            if (filePath.includes('://'))
                this._media = Gtk.MediaFile.new_for_uri(filePath);
            else
                this._media = Gtk.MediaFile.new_for_filename(filePath);

            this._media.set({loop: true});

            // Apply volume/mute after prepared
            this._media.connect('notify::prepared', () => {
                this._applyVolume(videoMute ? 0 : videoVolume / 100.0);
                this._maybeSeekRandomMedia();
            });

            // Monitor playing state
            this._media.connect('notify::playing', media => {
                const playing = media.get_playing();
                if (playing !== this._isPlaying) {
                    this._isPlaying = playing;
                    this._emitIsPlayingChanged();
                }
            });

            this._sharedPaintable = this._media;
            const widget = this._getWidgetFromSharedPaintable();

            this._markRandomStartPending();
            this.setPlay();
            this._setupAutoWallpaper();

            return widget;
        }

        /**
         * Build a GTK widget from a GStreamer sink's paintable.
         */
        _getWidgetFromSink(sink) {
            let widget = null;

            if (sink.widget) {
                if (sink.widget instanceof Gtk.Picture) {
                    // Workaround for clappersink: use a Box to host the
                    // sink's internal Gtk.Picture alongside our own.
                    this._sharedPaintable = sink.widget.paintable;
                    const box = new Gtk.Box();
                    box.append(sink.widget);
                    box.append(this._getWidgetFromSharedPaintable());
                    sink.widget.hide();
                    widget = box;
                } else {
                    widget = sink.widget;
                }
            } else if (sink.paintable) {
                this._sharedPaintable = sink.paintable;
                widget = this._getWidgetFromSharedPaintable();
            }

            return widget;
        }

        /**
         * Create a Gtk.Picture from the shared paintable.
         */
        _getWidgetFromSharedPaintable() {
            if (!this._sharedPaintable)
                return null;

            const picture = new Gtk.Picture({
                paintable: this._sharedPaintable,
                hexpand: true,
                vexpand: true,
            });

            if (haveContentFit)
                picture.set_content_fit(mapContentFit(videoFitMode));

            this._pictures.push(picture);
            return picture;
        }

        // ─────────────────────────────────────────────────────────────
        // Webpage widget (WebKit6)
        // ─────────────────────────────────────────────────────────────

        _createWebpageWidget() {
            if (!haveWebKit) {
                console.error(
                    `${LOG_PREFIX} WebKit6 not available — rendering black`
                );
                return this._createBlackWidget();
            }

            const url = this._getWebpageUrl();
            if (!url) {
                return this._createNoWebpageLabel();
            }

            try {
                const webView = new WebKit.WebView();
                webView.set_background_color(
                    new Gdk.RGBA({red: 0, green: 0, blue: 0, alpha: 1})
                );
                webView.load_uri(url);

                // Auto-reload on crash
                webView.connect('web-process-terminated', () => {
                    console.warn(
                        `${LOG_PREFIX} Web process terminated — reloading in 1s`
                    );
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                        webView.load_uri(this._getWebpageUrl() || '');
                        return GLib.SOURCE_REMOVE;
                    });
                });

                this._webViews.push(webView);
                return webView;
            } catch (e) {
                console.error(
                    `${LOG_PREFIX} WebView creation failed: ${e.message}`
                );
                return this._createBlackWidget();
            }
        }

        _getWebpageUrl() {
            if (videoWebpageUrl && videoWebpageUrl.length > 0)
                return videoWebpageUrl;
            if (videoWebpageLocalHtml && videoWebpageLocalHtml.length > 0) {
                if (videoWebpageLocalHtml.includes('://'))
                    return videoWebpageLocalHtml;
                return `file://${videoWebpageLocalHtml}`;
            }
            return '';
        }

        _createNoWebpageLabel() {
            const label = new Gtk.Label({
                label:
                    '<span foreground="white">No webpage configured</span>',
                use_markup: true,
                hexpand: true,
                vexpand: true,
            });
            return label;
        }

        _reloadWebViews() {
            const url = this._getWebpageUrl();
            for (const webView of this._webViews) {
                try {
                    if (url)
                        webView.load_uri(url);
                    else
                        webView.load_html(
                            '<html><body style="background:black;' +
                            'color:white;display:flex;align-items:center;' +
                            'justify-content:center;height:100vh;margin:0">' +
                            '<h2>No webpage configured</h2></body></html>',
                            ''
                        );
                } catch (e) {
                    console.warn(
                        `${LOG_PREFIX} WebView reload failed: ${e.message}`
                    );
                }
            }
        }

        // ─────────────────────────────────────────────────────────────
        // Black fallback widget
        // ─────────────────────────────────────────────────────────────

        _createBlackWidget() {
            // A simple Gtk.DrawingArea that paints black
            const area = new Gtk.DrawingArea({
                hexpand: true,
                vexpand: true,
            });
            area.set_draw_func((_cr, width, height) => {
                // The window CSS already makes the background black,
                // so a no-op draw is sufficient.
            });
            return area;
        }

        // ─────────────────────────────────────────────────────────────
        // Content fit
        // ─────────────────────────────────────────────────────────────

        _updateContentFit() {
            if (!haveContentFit)
                return;
            const fit = mapContentFit(videoFitMode);
            for (const picture of this._pictures)
                picture.set_content_fit(fit);
        }

        // ─────────────────────────────────────────────────────────────
        // Playback control
        // ─────────────────────────────────────────────────────────────

        setPlay() {
            if (this._play)
                this._play.play();
            else if (this._media)
                this._media.play();
        }

        setPause() {
            if (this._play)
                this._play.pause();
            else if (this._media)
                this._media.pause();
        }

        setFilePath(path) {
            if (this._play) {
                this._play.set_uri(toUri(path));
            } else if (this._media) {
                this._media.stream_unprepared();
                if (path.includes('://'))
                    this._media.file = Gio.File.new_for_uri(path);
                else
                    this._media.file = Gio.File.new_for_path(path);
            }
            this._markRandomStartPending();
            this.setPlay();
        }

        // ─────────────────────────────────────────────────────────────
        // Volume / mute with fade
        // ─────────────────────────────────────────────────────────────

        /**
         * Apply volume immediately to the active player backend.
         */
        _applyVolume(linearVolume) {
            const player = this._play || this._media;
            if (!player)
                return;

            if (this._play) {
                // GstPlay uses linear volume — convert from perceptual (cubic)
                let v = linearVolume;
                if (haveGstAudio) {
                    v = GstAudio.StreamVolume.convert_volume(
                        GstAudio.StreamVolumeFormat.CUBIC,
                        GstAudio.StreamVolumeFormat.LINEAR,
                        v
                    );
                } else {
                    v = Math.pow(v, 3);
                }
                // Force change by resetting to null first
                if (player.volume === v)
                    player.volume = null;
                player.volume = v;
            } else if (this._media) {
                // GtkMediaFile uses linear volume directly
                if (player.volume === linearVolume)
                    player.volume = null;
                player.volume = linearVolume;
            }
        }

        /**
         * Apply mute state to the active player backend.
         */
        _applyMute(muted) {
            if (this._play) {
                if (this._play.mute === muted)
                    this._play.mute = !muted;
                this._play.mute = muted;
            } else if (this._media) {
                if (this._media.muted === muted)
                    this._media.muted = !muted;
                this._media.muted = muted;
            }
        }

        /**
         * Get current linear volume from the active player.
         */
        _getCurrentVolume() {
            if (this._play) {
                if (haveGstAudio) {
                    return GstAudio.StreamVolume.convert_volume(
                        GstAudio.StreamVolumeFormat.LINEAR,
                        GstAudio.StreamVolumeFormat.CUBIC,
                        this._play.volume
                    );
                }
                return Math.pow(this._play.volume, 1 / 3);
            }
            if (this._media)
                return this._media.volume;
            return 0;
        }

        /**
         * Ramp volume linearly from current to target over
         * video-fade-duration-sec seconds.
         */
        _setVolumeWithFade(targetVolume) {
            // Cancel any running fade
            if (fadeTimerId) {
                GLib.source_remove(fadeTimerId);
                fadeTimerId = null;
            }

            const duration = videoFadeDurationSec;
            if (duration <= 0 || !this._play) {
                // No fade or GstPlay not active — apply immediately
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
        // Random start
        // ─────────────────────────────────────────────────────────────

        _markRandomStartPending() {
            this._randomStartPending = true;
        }

        _maybeSeekRandomGst() {
            if (!this._play || !videoRandomStart || !this._randomStartPending)
                return;

            const duration = this._play.get_duration();
            if (!duration || duration <= 0) {
                this._randomStartPending = false;
                return;
            }

            const second = Gst.SECOND || 1000000000;
            const maxPos = Math.max(duration - second, 0);
            const position = Math.floor(Math.random() * (maxPos + 1));
            this._play.seek(position);
            this._randomStartPending = false;
        }

        _maybeSeekRandomMedia() {
            if (!this._media || !videoRandomStart || !this._randomStartPending)
                return;

            const duration = this._media.get_duration();
            if (!duration || duration <= 0) {
                this._randomStartPending = false;
                return;
            }

            const maxPos = Math.max(duration - GLib.USEC_PER_SEC, 0);
            const position = Math.floor(Math.random() * (maxPos + 1));
            this._media.seek(position);
            this._randomStartPending = false;
        }

        // ─────────────────────────────────────────────────────────────
        // Auto-change wallpaper
        // ─────────────────────────────────────────────────────────────

        _setupAutoWallpaper() {
            // Remove existing timer
            if (changeWallpaperTimerId) {
                GLib.source_remove(changeWallpaperTimerId);
                changeWallpaperTimerId = null;
            }

            if (!changeWallpaper)
                return;

            // Resolve directory: configured → video-folder → ~/Videos/Hidamari
            const dir = changeWallpaperDir || videoFolder ||
                GLib.build_filenamev([
                    GLib.get_home_dir(), 'Videos', 'Hidamari',
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
                // Only change if playing to avoid unexpected resume
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

            // Apply first wallpaper immediately
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
// RendererWindow — one per monitor, fullscreen
// ═══════════════════════════════════════════════════════════════════════════
const RendererWindow = GObject.registerClass(
    {
        GTypeName: 'WpRendererWindow',
    },
    class RendererWindow extends Gtk.ApplicationWindow {
        constructor(application, title, widget, gdkMonitor) {
            super({
                application,
                decorated: !!nohide,
                title,
            });

            this.set_child(widget);

            if (isX11DesktopMode()) {
                // Desktop-layer windows cover the monitor geometry instead
                // of going fullscreen (EWMH has no fullscreen + desktop).
                const geometry = gdkMonitor.get_geometry();
                this.set_default_size(geometry.width, geometry.height);
                this.move(geometry.x, geometry.y);
                this.set_resizable(false);
                this.connect('map', () => {
                    if (this._desktopLayerMapped)
                        return;
                    this._desktopLayerMapped = true;
                    // XID is only valid after map — schedule in idle.
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this._placeOnDesktopLayer();
                        return GLib.SOURCE_REMOVE;
                    });
                });
            } else {
                this.fullscreen_on_monitor(gdkMonitor);
            }
        }

        _placeOnDesktopLayer() {
            const surface = this.get_surface();
            if (!surface)
                return;

            let xid = 0;
            try {
                // Runtime GType is X11Surface under X11; get_xid throws
                // (or returns 0) for non-X11 surfaces.
                xid = surface.get_xid();
            } catch (e) {
                xid = 0;
            }
            if (!xid) {
                console.debug(
                    `${LOG_PREFIX} Surface has no X11 XID — desktop layer skipped`
                );
                return;
            }

            const xprop = findXprop();
            if (!xprop)
                return;

            const launcher = new Gio.SubprocessLauncher();
            launcher.set_flags(Gio.SubprocessFlags.STDERR_PIPE);
            let proc;
            try {
                proc = launcher.spawnv([
                    xprop,
                    '-id', String(xid),
                    '-f', '_NET_WM_WINDOW_TYPE', '32a',
                    '-set', '_NET_WM_WINDOW_TYPE',
                    '_NET_WM_WINDOW_TYPE_DESKTOP',
                ]);
            } catch (e) {
                console.warn(
                    `${LOG_PREFIX} Failed to spawn xprop (window ${xid}): ${e.message}`
                );
                return;
            }

            proc.wait_check_async(null, (subprocess, res) => {
                try {
                    subprocess.wait_check_finish(res);
                    console.log(
                        `${LOG_PREFIX} Window ${xid} set to desktop layer`
                    );
                } catch (e) {
                    console.warn(
                        `${LOG_PREFIX} xprop failed (window ${xid}): ${e.message}`
                    );
                }
            });
        }
    }
);

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════
Gst.init(null);

const app = new Renderer();

// Clean exit on SIGTERM (signal 15)
GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    app.quit();
    return GLib.SOURCE_REMOVE;
});

app.run(ARGV);
