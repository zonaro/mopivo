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

            const geometry = gdkMonitor.get_geometry();

            this._area = new Gtk.DrawingArea();
            this._area.set_hexpand(true);
            this._area.set_vexpand(true);
            this.add(this._area);
            this._area.show();

            this.set_title(`Wallpaper ${index}`);

            if (nohide) {
                this.set_decorated(true);
                this.set_skip_taskbar_hint(false);
                this.set_default_size(geometry.width, geometry.height);
            } else {
                // DESKTOP must be set before the window is shown.
                this.set_type_hint(Gdk.WindowTypeHint.DESKTOP);
                this.set_decorated(false);
                this.set_skip_taskbar_hint(true);
                this.set_skip_pager_hint(true);
                this.set_keep_below(true);
                this.stick();
                this.set_size_request(geometry.width, geometry.height);
                this.move(geometry.x, geometry.y);
            }

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
                    console.warn(
                        `${LOG_PREFIX} Webpage output is not supported by this renderer`
                    );
                    break;

                case 'video-webpage-local-html':
                    videoWebpageLocalHtml = settings.get_string(key);
                    console.warn(
                        `${LOG_PREFIX} Webpage output is not supported by this renderer`
                    );
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
                console.warn(
                    `${LOG_PREFIX} Webpage output is not supported by this renderer; showing blank wallpaper`
                );
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
