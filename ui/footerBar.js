// SPDX-License-Identifier: GPL-3.0-or-later
// ui/footerBar.js — compact footer bar with video/streaming playback controls.
//
// Companion of ui/videoControls.js: same VideoController API and GSettings
// keys, but a single horizontal row meant for the bottom of the window. The
// owner (window.js) decides when it is relevant via setActive(true/false).
// Pure helpers are exported for headless tests; no widget is built at import.

import Gtk from 'gi://Gtk?version=4.0';

import {_} from '../lib/i18n.js';

/** Canonical video source types (mirrors app/videoController.js). */
export const FOOTER_SOURCE_TYPES = ['local', 'streaming', 'webpage'];

/** Canonical fit modes (mirrors the `video-fit-mode` schema choices). */
export const FOOTER_FIT_MODES = ['fill', 'contain', 'cover', 'scale-down'];

const DEFAULT_FIT_MODE = 'contain';

function _clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

/** Normalized slider value (0..1) → stored integer percent (0..100). */
export function volumeToPercent(scaleValue) {
    const n = Number(scaleValue);
    return Number.isFinite(n) ? Math.round(_clamp(n, 0, 1) * 100) : 0;
}

/** Inverse of volumeToPercent: stored percent (0..100) → slider value (0..1). */
export function percentToScale(percent) {
    const n = Number(percent);
    return Number.isFinite(n) ? _clamp(n, 0, 100) / 100 : 0;
}

/** Ordered {value, label} fit-mode choices; labels translated at call time. */
export function fitModeChoices() {
    return [
        {value: 'fill', label: _('Fill')},
        {value: 'contain', label: _('Contain')},
        {value: 'cover', label: _('Cover')},
        {value: 'scale-down', label: _('Scale down')},
    ];
}

/** Index of `mode` in FOOTER_FIT_MODES, falling back to 'contain'. */
export function fitModeIndex(mode) {
    const index = FOOTER_FIT_MODES.indexOf(mode);
    return index >= 0 ? index : FOOTER_FIT_MODES.indexOf(DEFAULT_FIT_MODE);
}

/** Human-readable label of the active source type. */
export function describeSource(type) {
    switch (type) {
    case 'streaming': return _('Streaming URL');
    case 'webpage': return _('Webpage');
    case 'local': return _('Local Files');
    default: return _('Video');
    }
}

/** Compact footer bar exposing the essential video/streaming controls. */
export class FooterBar {
    /**
     * @param {object} options
     * @param {object} options.controller — a VideoController instance
     * @param {object} options.settings   — Gio.Settings for the app schema
     */
    constructor({controller, settings} = {}) {
        this._controller = controller ?? null;
        this._settings = settings ?? null;
        this._syncingMute = this._syncingPlay =
            this._syncingVolume = this._syncingFit = false;
        this._settingsIds = [];
        this._controllerSignalId = 0;
        this._active = false;

        this._widget = this._build();
        this._widget.set_visible(false);
        this._connectController();
        this._subscribeSettings();
        this.sync();
    }

    /** Root widget for the owner to pack at the bottom (horizontal Gtk.Box). */
    get widget() {
        return this._widget;
    }

    // ── Widget tree ───────────────────────────────────────────────────

    _toggleButton(icon, tooltip) {
        const btn = new Gtk.ToggleButton({valign: Gtk.Align.CENTER});
        const image = new Gtk.Image({icon_name: icon});
        btn.set_child(image);
        btn.set_tooltip_text(tooltip);
        return [btn, image];
    }

    _iconButton(icon, tooltip, onClick) {
        const btn = new Gtk.Button({
            icon_name: icon,
            tooltip_text: tooltip,
            valign: Gtk.Align.CENTER,
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    _build() {
        const root = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            margin_top: 4,
            margin_bottom: 4,
            margin_start: 8,
            margin_end: 8,
            css_classes: ['toolbar'],
        });
        const append = (widget) => root.append(widget);
        const sep = () => new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL});

        // Active source type, e.g. "Streaming URL".
        this._sourceLabel = new Gtk.Label({
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            tooltip_text: _('Source Type'),
        });
        append(this._sourceLabel);
        append(sep());

        // Play/pause toggle, driven by the controller's is-playing-changed.
        [this._playBtn, this._playImage] =
            this._toggleButton('media-playback-start-symbolic', _('Play'));
        this._playBtn.connect('toggled', () => {
            if (!this._syncingPlay)
                this._controller?.togglePlay();
        });
        append(this._playBtn);

        // Stop tears the renderer pipeline down.
        this._stopBtn = this._iconButton('media-playback-stop-symbolic', _('Stop'), () => {
            this._controller?.stop();
            this._syncPlaying(false);
        });
        append(this._stopBtn);

        this._nextBtn = this._iconButton('media-skip-forward-symbolic', _('Next'),
            () => this._controller?.next());
        this._luckyBtn = this._iconButton('media-playlist-shuffle-symbolic', _('Lucky'),
            () => this._controller?.lucky());
        append(this._nextBtn);
        append(this._luckyBtn);
        append(sep());

        // Mute toggle.
        [this._muteBtn, this._muteImage] =
            this._toggleButton('audio-volume-high-symbolic', _('Mute'));
        this._muteBtn.connect('toggled', () => {
            if (!this._syncingMute)
                this._settings?.set_boolean?.('video-mute', this._muteBtn.get_active());
        });
        append(this._muteBtn);

        // Volume slider (compact; 0..1 mapped to the stored 0..100 percent).
        this._volumeScale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, 0, 1, 0.05);
        this._volumeScale.set_draw_value(false);
        this._volumeScale.set_size_request(120, -1);
        this._volumeScale.set_tooltip_text(_('Volume'));
        this._volumeScale.connect('value-changed', (scale) => {
            if (!this._syncingVolume)
                this._settings?.set_int?.('video-volume', volumeToPercent(scale.get_value()));
        });
        append(this._volumeScale);
        append(sep());

        // Fit mode.
        this._fitDrop = Gtk.DropDown.new_from_strings(
            fitModeChoices().map((choice) => choice.label));
        this._fitDrop.set_tooltip_text(_('Fit Mode'));
        this._fitDrop.set_valign(Gtk.Align.CENTER);
        this._fitDrop.connect('notify::selected', () => {
            if (this._syncingFit)
                return;
            const index = this._fitDrop.get_selected();
            this._settings?.set_string?.('video-fit-mode',
                FOOTER_FIT_MODES[index] ?? DEFAULT_FIT_MODE);
        });
        append(this._fitDrop);

        return root;
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Show or hide the bar. When hidden the whole row is made insensitive so
     * stale controls cannot be focused or activated.
     *
     * @param {boolean} on
     */
    setActive(on) {
        this._active = !!on;
        this._widget.set_visible(this._active);
        this._syncSensitivity();
    }

    /** Re-read the current controller/settings state into the widgets. */
    sync() {
        this._syncPlaying(this._controller?.isPlaying ?? false);
        this._syncMute();
        this._syncVolume();
        this._syncFit();
        this._syncSource();
        this._syncSensitivity();
    }

    /** Disconnect all signal subscriptions (call when the bar is removed). */
    destroy() {
        if (this._controllerSignalId) {
            try {
                this._controller?.disconnect(this._controllerSignalId);
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
        this._settingsIds.push(s.connect('changed::video-mute', () => this._syncMute()));
        this._settingsIds.push(s.connect('changed::video-volume', () => this._syncVolume()));
        this._settingsIds.push(s.connect('changed::video-fit-mode', () => this._syncFit()));
        this._settingsIds.push(s.connect('changed::video-mode-type', () => this._syncSource()));
    }

    // ── State sync ────────────────────────────────────────────────────

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

    _syncMute() {
        const muted = this._setting('video-mute', 'get_boolean', false);
        this._syncingMute = true;
        this._muteBtn.set_active(muted);
        this._syncingMute = false;
        this._muteImage.set_from_icon_name(muted
            ? 'audio-volume-muted-symbolic'
            : 'audio-volume-high-symbolic');
    }

    _syncVolume() {
        this._syncingVolume = true;
        this._volumeScale.set_value(percentToScale(
            this._setting('video-volume', 'get_int', 0)));
        this._syncingVolume = false;
    }

    _syncFit() {
        this._syncingFit = true;
        this._fitDrop.set_selected(fitModeIndex(
            this._setting('video-fit-mode', 'get_string', '')));
        this._syncingFit = false;
    }

    _syncSource() {
        this._sourceLabel.set_text(describeSource(
            this._setting('video-mode-type', 'get_string', '')));
    }

    /** Enable only the controls whose backing controller/settings exist. */
    _syncSensitivity() {
        const active = this._active;
        this._widget.set_sensitive(active);
        const hasController = !!this._controller &&
            typeof this._controller.togglePlay === 'function';
        for (const btn of [this._playBtn, this._stopBtn, this._nextBtn, this._luckyBtn])
            btn.set_sensitive(active && hasController);
        const hasSettings = !!this._settings &&
            typeof this._settings.set_int === 'function';
        for (const widget of [this._muteBtn, this._volumeScale, this._fitDrop])
            widget.set_sensitive(active && hasSettings);
    }

    // ── Settings reader (Gio.Settings or stub) ────────────────────────

    _setting(key, method, fallback) {
        const s = this._settings;
        return s && typeof s[method] === 'function' ? s[method](key) : fallback;
    }
}
