// SPDX-License-Identifier: GPL-3.0-or-later
// Video controls widget — added inside the existing panel menu by the extension.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {_} from '../i18n.js';
import {LOG_PREFIX} from './constants.js';

const _log = (msg) => console.log(`${LOG_PREFIX} panelMenu: ${msg}`);

// ─── VideoControlsBox ────────────────────────────────────────────────────────

/**
 * Video controls box placed inside the existing panel menu.
 *
 * NOT a PanelMenu.Button — the extension wires this into its own menu.
 *
 * Provides: mode toggle, play/pause, mute, volume slider, next, lucky.
 * Each button emits a GObject signal the extension connects to.
 */
export const VideoControlsBox = GObject.registerClass({
    GTypeName: 'WpVideoControlsBox',
    Signals: {
        'play-pressed': {},
        'pause-pressed': {},
        'next-pressed': {},
        'lucky-pressed': {},
        'browse-pressed': {},
        'mute-toggled': {param_types: [GObject.TYPE_BOOLEAN]},
        'volume-changed': {param_types: [GObject.TYPE_DOUBLE]},
    },
}, class VideoControlsBox extends St.BoxLayout {
    _init(ext) {
        super._init({
            style_class: 'wp-video-controls',
            vertical: true,
            x_align: Clutter.ActorAlign.START,
        });

        this._ext = ext;
        this._settings = ext.getSettings();
        this._isPlaying = false;
        this._isMuted = false;
        this._volume = 50;

        // ── Mode toggle ─────────────────────────────────────────────
        this._modeBtn = new St.Button({
            label: _('Video mode: OFF'),
            style_class: 'wp-cycle-btn',
            x_align: Clutter.ActorAlign.START,
        });
        this._modeBtn.connect('clicked', () => {
            const current = this._settings.get_boolean('video-mode');
            this._settings.set_boolean('video-mode', !current);
        });
        this.add_child(this._modeBtn);

        this._modeChangedId = this._settings.connect(
            'changed::video-mode', () => this._syncMode()
        );
        this._syncMode();

        // ── Play / Pause ────────────────────────────────────────────
        this._playPauseBtn = new St.Button({
            style_class: 'wp-cycle-btn',
            x_align: Clutter.ActorAlign.START,
        });
        this._playPauseIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            style_class: 'system-status-icon',
        });
        this._playPauseBtn.set_child(this._playPauseIcon);
        this._playPauseBtn.connect('clicked', () => {
            if (this._isPlaying)
                this.emit('pause-pressed');
            else
                this.emit('play-pressed');
        });
        this.add_child(this._playPauseBtn);

        // ── Mute ────────────────────────────────────────────────────
        this._muteBtn = new St.Button({
            style_class: 'wp-cycle-btn',
            x_align: Clutter.ActorAlign.START,
        });
        this._muteIcon = new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            style_class: 'system-status-icon',
        });
        this._muteBtn.set_child(this._muteIcon);
        this._muteBtn.connect('clicked', () => {
            this._isMuted = !this._isMuted;
            this.emit('mute-toggled', this._isMuted);
        });
        this.add_child(this._muteBtn);

        this._muteChangedId = this._settings.connect(
            'changed::video-mute', () => this._syncMute()
        );
        this._syncMute();

        // ── Volume slider ───────────────────────────────────────────
        this._volumeSlider = new St.Slider({
            style_class: 'wp-cycle-btn',
            width: 150,
            x_align: Clutter.ActorAlign.START,
        });
        this._volume = this._settings.get_int('video-volume');
        this._volumeSlider.value = this._volume / 100;
        this._volumeSlider.connect('notify::value', slider => {
            const val = Math.round(slider.value * 100);
            this._volume = val;
            this.emit('volume-changed', val / 100.0);
        });
        this.add_child(this._volumeSlider);

        // ── Next ────────────────────────────────────────────────────
        this._nextBtn = new St.Button({
            label: _('Next'),
            style_class: 'wp-cycle-btn',
            x_align: Clutter.ActorAlign.START,
        });
        this._nextBtn.connect('clicked', () => this.emit('next-pressed'));
        this.add_child(this._nextBtn);

        // ── I'm Feeling Lucky ───────────────────────────────────────
        this._luckyBtn = new St.Button({
            label: _('Lucky'),
            style_class: 'wp-cycle-btn',
            x_align: Clutter.ActorAlign.START,
        });
        this._luckyBtn.connect('clicked', () => this.emit('lucky-pressed'));
        this.add_child(this._luckyBtn);

        // ── Browse (in-panel file picker) ─────────────────────────────
        this._browseBtn = new St.Button({
            label: _('Browse…'),
            style_class: 'wp-cycle-btn',
            x_align: Clutter.ActorAlign.START,
        });
        this._browseBtn.connect('clicked', () => this.emit('browse-pressed'));
        this.add_child(this._browseBtn);
    }

    // ── Sync helpers ─────────────────────────────────────────────────

    _syncMode() {
        const on = this._settings.get_boolean('video-mode');
        this._modeBtn.label.set_text(on ? _('Video mode: ON') : _('Video mode: OFF'));
    }

    _syncMute() {
        this._isMuted = this._settings.get_boolean('video-mute');
        this._muteIcon.icon_name = this._isMuted
            ? 'audio-volume-muted-symbolic'
            : 'audio-volume-high-symbolic';
    }

    // ── Public API ───────────────────────────────────────────────────

    /** Bind to the show-panel-menu setting visibility. */
    setEnabled(visible) {
        this.visible = visible;
    }

    /** Update the play/pause icon based on playback state name. */
    setPlaybackState(stateName) {
        this._isPlaying = stateName === 'playing';
        this._playPauseIcon.icon_name = this._isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
    }

    /** Update the volume slider position (0.0 – 1.0). */
    setVolume(v) {
        this._volume = Math.round(v * 100);
        this._volumeSlider.value = v;
    }

    /** Update the mute icon. */
    setMuted(m) {
        this._isMuted = m;
        this._muteIcon.icon_name = m
            ? 'audio-volume-muted-symbolic'
            : 'audio-volume-high-symbolic';
    }
});
