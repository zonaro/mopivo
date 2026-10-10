// SPDX-License-Identifier: GPL-3.0-or-later
// Video controls pane (GTK4) for the standalone Mopivo app.
//
// P4 packs `new VideoControls({controller, settings}).widget` into the video
// stack. The pane is pure GTK4 (no St/Clutter/Meta and no GStreamer):
//
//   * play/pause drives the controller, which talks D-Bus to the renderer and
//     emits `is-playing-changed` — the toggle is updated programmatically from
//     that signal, with `_syncingPlay` guarding against feedback loops;
//   * mute, volume and fit-mode are written straight to GSettings for the
//     renderer subprocess to apply (matching the old panelMenu wiring);
//   * the source drop-down calls `controller.setSource()`, which owns the
//     renderer (re)start + streaming URL resolution;
//   * the Browse button opens a Gtk.FileDialog, stores `video-path` and then
//     asks the controller to switch to the 'local' source.
//
// The widget getter contract for P4:
//   const controls = new VideoControls({controller, settings});
//   videoStack.append(controls.widget);     // root is a Gtk.Box (vertical)

import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {_} from '../lib/i18n.js';
import {LOG_PREFIX, VIDEO_MIME_TYPES} from '../lib/video/constants.js';

const SOURCE_TYPES = ['local', 'streaming', 'webpage'];
const FIT_MODES = ['fill', 'contain', 'cover', 'scale-down'];

const _log = (msg) => console.log(`${LOG_PREFIX} videoControls: ${msg}`);

export class VideoControls {
    /**
     * @param {object} options
     * @param {object} options.controller — a VideoController instance
     * @param {object} options.settings   — Gio.Settings for the app schema
     */
    constructor({controller, settings} = {}) {
        this._controller = controller ?? null;
        this._settings = settings ?? null;

        this._syncingSource = false;
        this._syncingPlay = false;
        this._syncingMute = false;
        this._syncingVolume = false;
        this._syncingFit = false;

        this._settingsIds = [];
        this._controllerSignalId = 0;

        this._widget = this._build();
        this._connectController();
        this._subscribeSettings();
        this._syncFromSettings();
        this._syncPlaying(controller?.isPlaying ?? false);
    }

    /** Root widget for P4 to place in the video stack (a vertical Gtk.Box). */
    get widget() {
        return this._widget;
    }

    // ── Widget tree ───────────────────────────────────────────────────

    _build() {
        const root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });

        const heading = new Gtk.Label({
            label: _('Video'),
            xalign: 0,
            css_classes: ['heading'],
        });
        root.append(heading);

        // ── Source ────────────────────────────────────────────────
        this._sourceDrop = Gtk.DropDown.new_from_strings([
            _('Local Files'), _('Streaming URL'), _('Webpage'),
        ]);
        this._sourceDrop.set_hexpand(true);
        this._sourceDrop.set_tooltip_text(_('Video wallpaper source'));
        this._sourceDrop.connect('notify::selected', () => {
            if (this._syncingSource)
                return;
            const type = SOURCE_TYPES[this._sourceDrop.get_selected()] ?? 'local';
            this._controller?.setSource(type);
        });
        root.append(this._row(_('Source'), this._sourceDrop));

        // ── Source-specific rows ──────────────────────────────────
        this._browseBtn = Gtk.Button.new_with_label(_('Browse…'));
        this._browseBtn.connect('clicked', () => this._pickVideo());
        this._localRow = this._row(_('Video Path'), this._browseBtn);

        this._urlEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _('https://…'),
        });
        this._urlEntry.connect('activate', () => {
            this._settings?.set_string?.('video-streaming-url', this._urlEntry.get_text());
            this._controller?.setSource('streaming');
        });
        this._streamingRow = this._row(_('Streaming URL'), this._urlEntry);

        const webpageHint = new Gtk.Label({
            label: _('Configure the webpage in Preferences → Video.'),
            xalign: 0,
            wrap: true,
        });
        this._webpageRow = this._row(_('Webpage'), webpageHint);

        root.append(new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL}));
        root.append(this._localRow);
        root.append(this._streamingRow);
        root.append(this._webpageRow);
        root.append(new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL}));

        // ── Playback row ──────────────────────────────────────────
        const playbackRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
        });

        this._playBtn = new Gtk.ToggleButton();
        this._playImage = new Gtk.Image({icon_name: 'media-playback-start-symbolic'});
        this._playBtn.set_child(this._playImage);
        this._playBtn.set_tooltip_text(_('Play'));
        this._playBtn.connect('toggled', () => {
            if (this._syncingPlay)
                return;
            this._controller?.togglePlay();
        });

        const nextBtn = Gtk.Button.new_with_label(_('Next'));
        nextBtn.connect('clicked', () => this._controller?.next());

        const luckyBtn = Gtk.Button.new_with_label(_('Lucky'));
        luckyBtn.connect('clicked', () => this._controller?.lucky());

        playbackRow.append(this._playBtn);
        playbackRow.append(nextBtn);
        playbackRow.append(luckyBtn);
        root.append(playbackRow);

        // ── Sound row (mute + volume) ─────────────────────────────
        const soundRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });

        this._muteBtn = new Gtk.ToggleButton();
        this._muteImage = new Gtk.Image({icon_name: 'audio-volume-high-symbolic'});
        this._muteBtn.set_child(this._muteImage);
        this._muteBtn.set_tooltip_text(_('Mute'));
        this._muteBtn.connect('toggled', () => {
            if (this._syncingMute)
                return;
            this._settings?.set_boolean?.('video-mute', this._muteBtn.get_active());
        });

        this._volumeScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 1, 0.05);
        this._volumeScale.set_draw_value(false);
        this._volumeScale.set_hexpand(true);
        this._volumeScale.connect('value-changed', (scale) => {
            if (this._syncingVolume)
                return;
            this._settings?.set_int?.('video-volume', Math.round(scale.get_value() * 100));
        });

        soundRow.append(this._muteBtn);
        soundRow.append(this._volumeScale);
        root.append(soundRow);

        // ── Fit mode ──────────────────────────────────────────────
        root.append(new Gtk.Separator({orientation: Gtk.Orientation.HORIZONTAL}));
        this._fitDrop = Gtk.DropDown.new_from_strings([
            _('Fill'), _('Contain'), _('Cover'), _('Scale down'),
        ]);
        this._fitDrop.set_hexpand(true);
        this._fitDrop.connect('notify::selected', () => {
            if (this._syncingFit)
                return;
            const mode = FIT_MODES[this._fitDrop.get_selected()] ?? 'contain';
            this._settings?.set_string?.('video-fit-mode', mode);
        });
        root.append(this._row(_('Fit Mode'), this._fitDrop));

        return root;
    }

    /** Consistent label+widget row: label on the left, expanding widget right. */
    _row(labelText, widget) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
        const label = new Gtk.Label({label: labelText, xalign: 0});
        label.set_hexpand(true);
        label.set_halign(Gtk.Align.START);
        box.append(label);
        box.append(widget);
        return box;
    }

    // ── External wiring ───────────────────────────────────────────────

    _connectController() {
        const controller = this._controller;
        if (!controller || typeof controller.connect !== 'function')
            return;
        this._controllerSignalId = controller.connect('is-playing-changed',
            (_src, playing) => this._syncPlaying(playing));
    }

    _subscribeSettings() {
        const s = this._settings;
        if (!s || typeof s.connect !== 'function')
            return;
        this._settingsIds.push(s.connect('changed::video-mode-type', () => {
            this._syncingSource = true;
            this._sourceDrop.set_selected(this._sourceIndex());
            this._syncingSource = false;
            this._syncSourceRows();
        }));
        this._settingsIds.push(s.connect('changed::video-path', () => {
            this._updateBrowseLabel();
        }));
        this._settingsIds.push(s.connect('changed::video-streaming-url', () => {
            this._urlEntry.set_text(this._getString('video-streaming-url'));
        }));
        this._settingsIds.push(s.connect('changed::video-mute', () => {
            this._syncingMute = true;
            this._muteBtn.set_active(this._getBoolean('video-mute'));
            this._syncingMute = false;
            this._updateMuteIcon();
        }));
        this._settingsIds.push(s.connect('changed::video-volume', () => {
            this._syncingVolume = true;
            this._volumeScale.set_value(this._getInt('video-volume') / 100);
            this._syncingVolume = false;
        }));
        this._settingsIds.push(s.connect('changed::video-fit-mode', () => {
            this._syncingFit = true;
            this._fitDrop.set_selected(this._fitIndex());
            this._syncingFit = false;
        }));
    }

    // ── Initial state ─────────────────────────────────────────────────

    _syncFromSettings() {
        this._syncingSource = true;
        this._sourceDrop.set_selected(this._sourceIndex());
        this._syncingSource = false;
        this._urlEntry.set_text(this._getString('video-streaming-url'));

        this._syncingMute = true;
        this._muteBtn.set_active(this._getBoolean('video-mute'));
        this._syncingMute = false;
        this._updateMuteIcon();

        this._syncingVolume = true;
        this._volumeScale.set_value(this._getInt('video-volume') / 100);
        this._syncingVolume = false;

        this._syncingFit = true;
        this._fitDrop.set_selected(this._fitIndex());
        this._syncingFit = false;

        this._updateBrowseLabel();
        this._syncSourceRows();
    }

    /** Reflect the controller's playback state on the play/pause toggle. */
    _syncPlaying(playing) {
        const p = !!playing;
        this._syncingPlay = true;
        this._playBtn.set_active(p);
        this._syncingPlay = false;
        this._playImage.set_from_icon_name(p
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic');
        this._playBtn.set_tooltip_text(p ? _('Pause') : _('Play'));
    }

    _sourceIndex() {
        const type = this._getString('video-mode-type') || 'local';
        const index = SOURCE_TYPES.indexOf(type);
        return index >= 0 ? index : 0;
    }

    _fitIndex() {
        const mode = this._getString('video-fit-mode') || 'contain';
        const index = FIT_MODES.indexOf(mode);
        return index >= 0 ? index : Math.max(0, FIT_MODES.indexOf('contain'));
    }

    /** Show only the row that matches the currently selected source. */
    _syncSourceRows() {
        const type = SOURCE_TYPES[this._sourceDrop.get_selected()] ?? 'local';
        this._localRow.set_visible(type === 'local');
        this._streamingRow.set_visible(type === 'streaming');
        this._webpageRow.set_visible(type === 'webpage');
    }

    _updateBrowseLabel() {
        const path = this._getString('video-path');
        if (!path) {
            this._browseBtn.set_label(_('Browse…'));
            return;
        }
        try {
            this._browseBtn.set_label(GLib.path_get_basename(path));
        } catch (_e) {
            this._browseBtn.set_label(path);
        }
    }

    _updateMuteIcon() {
        this._muteImage.set_from_icon_name(this._getBoolean('video-mute')
            ? 'audio-volume-muted-symbolic'
            : 'audio-volume-high-symbolic');
    }

    // ── Actions ────────────────────────────────────────────────────────

    _pickVideo() {
        const dialog = new Gtk.FileDialog();
        const filter = Gtk.FileFilter.new();
        filter.set_name(_('Videos'));
        filter.add_mime_types(VIDEO_MIME_TYPES);
        const filters = Gio.ListStore.new(Gtk.FileFilter);
        filters.append(filter);
        dialog.set_filters(filters);

        dialog.open(null, (dlg, res) => {
            if (!this._settings)
                return;
            let file = null;
            try {
                file = dlg.open_finish(res);
            } catch (e) {
                _log(`file picker cancelled: ${e.message}`);
                return;
            }
            if (!file)
                return;
            const uri = file.get_uri();
            this._settings.set_string('video-path', uri);
            this._controller?.setSource('local');
        });
    }

    // ── Settings readers (Gio.Settings or stub) ────────────────────────

    _getString(key) {
        const s = this._settings;
        if (s && typeof s.get_string === 'function')
            return s.get_string(key) || '';
        return '';
    }

    _getBoolean(key) {
        const s = this._settings;
        if (s && typeof s.get_boolean === 'function')
            return s.get_boolean(key);
        return false;
    }

    _getInt(key) {
        const s = this._settings;
        if (s && typeof s.get_int === 'function')
            return s.get_int(key);
        return 0;
    }

    /** Disconnect all signal subscriptions (call when the pane is removed). */
    destroy() {
        if (this._controllerSignalId && this._controller) {
            try {
                this._controller.disconnect(this._controllerSignalId);
            } catch (_e) { /* already disconnected */ }
            this._controllerSignalId = 0;
        }
        for (const id of this._settingsIds) {
            try {
                this._settings?.disconnect(id);
            } catch (_e) { /* already disconnected */ }
        }
        this._settingsIds = [];
    }
}