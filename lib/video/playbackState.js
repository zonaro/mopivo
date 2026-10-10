// SPDX-License-Identifier: GPL-3.0-or-later
// Playback state machine — tracks user/auto pause intents and drives the renderer.

import GObject from 'gi://GObject';

import {LOG_PREFIX} from './constants.js';

const _log = (msg) => console.log(`${LOG_PREFIX} playbackState: ${msg}`);

// Public state constants
export const STATE_PLAYING = 'playing';
export const STATE_PAUSED_BY_USER = 'pausedByUser';
export const STATE_PAUSED_BY_AUTO = 'pausedByAuto';
export const STATE_PAUSED = 'paused';

// ─── State-machine helper ────────────────────────────────────────────────────

function _createMachine(def) {
    const machine = {
        value: def.initialState,
        transition(currentState, event) {
            const cur = def[currentState];
            const t = cur?.transitions?.[event];
            if (!t)
                return null;

            const dest = t.target;
            const destDef = def[dest];

            t.action();
            cur.actions.onExit();
            destDef.actions.onEnter();

            machine.value = dest;
            return dest;
        },
    };
    return machine;
}

// ─── PlaybackState GObject ───────────────────────────────────────────────────

/**
 * Playback state machine.
 *
 * Four states: playing, pausedByUser, pausedByAuto, paused.
 * The user and auto-pause subsystems are independent flags; the `paused`
 * state represents "both user and auto want pause".  Only real state
 * transitions (entering `playing` or entering a paused state FROM `playing`)
 * push play/pause to the renderer.
 *
 * Signals:
 *   changed(stateName: string)
 */
export const PlaybackState = GObject.registerClass({
    GTypeName: 'WpPlaybackState',
    Signals: {
        'changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class PlaybackState extends GObject.Object {
    _init() {
        super._init();
        this._renderer = null;
        this._rendererPlayingChangedId = null;
        this._machine = null;
        this._buildMachine();
    }

    /** Inject the RendererDBus instance (called by the extension). */
    setRenderer(renderer) {
        // Disconnect previous renderer signal
        if (this._renderer && this._rendererPlayingChangedId) {
            this._renderer.disconnect(this._rendererPlayingChangedId);
            this._rendererPlayingChangedId = null;
        }

        this._renderer = renderer;

        if (renderer) {
            // If the renderer reports playing while we are paused, re-pause it.
            // This handles shell reloads / renderer restarts.
            this._rendererPlayingChangedId = renderer.connect(
                'is-playing-changed',
                (_src, isPlaying) => {
                    if (isPlaying && this._machine.value !== STATE_PLAYING) {
                        _log('Renderer playing while state is not playing — re-pausing');
                        renderer.pause();
                    }
                }
            );
        }
    }

    destroy() {
        if (this._renderer && this._rendererPlayingChangedId) {
            this._renderer.disconnect(this._rendererPlayingChangedId);
            this._rendererPlayingChangedId = null;
        }
        this._renderer = null;
    }

    getCurrentState() {
        return this._machine.value;
    }

    // ── Public actions ──────────────────────────────────────────────────

    userPlay() {
        const prev = this._machine.value;
        const next = this._machine.transition(prev, 'userPlay');
        if (next)
            _log(`userPlay: ${prev} → ${next}`);
    }

    userPause() {
        const prev = this._machine.value;
        const next = this._machine.transition(prev, 'userPause');
        if (next)
            _log(`userPause: ${prev} → ${next}`);
    }

    autoPlay() {
        const prev = this._machine.value;
        const next = this._machine.transition(prev, 'autoPlay');
        if (next)
            _log(`autoPlay: ${prev} → ${next}`);
    }

    autoPause() {
        const prev = this._machine.value;
        const next = this._machine.transition(prev, 'autoPause');
        if (next)
            _log(`autoPause: ${prev} → ${next}`);
    }

    // ── Machine definition ──────────────────────────────────────────────

    _buildMachine() {
        this._machine = _createMachine({
            initialState: STATE_PLAYING,

            [STATE_PLAYING]: {
                actions: {
                    onEnter: () => {
                        _log('→ renderer.play()');
                        this._renderer?.play();
                        this.emit('changed', STATE_PLAYING);
                    },
                    onExit() {},
                },
                transitions: {
                    userPause: {
                        target: STATE_PAUSED_BY_USER,
                        action: () => _log('transition: playing → pausedByUser'),
                    },
                    autoPause: {
                        target: STATE_PAUSED_BY_AUTO,
                        action: () => _log('transition: playing → pausedByAuto'),
                    },
                },
            },

            [STATE_PAUSED_BY_USER]: {
                actions: {
                    onEnter: () => {
                        _log('→ renderer.pause()');
                        this._renderer?.pause();
                        this.emit('changed', STATE_PAUSED_BY_USER);
                    },
                    onExit() {},
                },
                transitions: {
                    userPlay: {
                        target: STATE_PLAYING,
                        action: () => _log('transition: pausedByUser → playing'),
                    },
                    autoPause: {
                        target: STATE_PAUSED,
                        action: () => _log('transition: pausedByUser → paused'),
                    },
                },
            },

            [STATE_PAUSED_BY_AUTO]: {
                actions: {
                    onEnter: () => {
                        _log('→ renderer.pause()');
                        this._renderer?.pause();
                        this.emit('changed', STATE_PAUSED_BY_AUTO);
                    },
                    onExit() {},
                },
                transitions: {
                    autoPlay: {
                        target: STATE_PLAYING,
                        action: () => _log('transition: pausedByAuto → playing'),
                    },
                    userPause: {
                        target: STATE_PAUSED,
                        action: () => _log('transition: pausedByAuto → paused'),
                    },
                },
            },

            [STATE_PAUSED]: {
                actions: {
                    onEnter: () => {
                        _log('→ (renderer already paused, no-op)');
                        this.emit('changed', STATE_PAUSED);
                    },
                    onExit() {},
                },
                transitions: {
                    userPlay: {
                        target: STATE_PAUSED_BY_AUTO,
                        action: () => _log('transition: paused → pausedByAuto'),
                    },
                    autoPlay: {
                        target: STATE_PAUSED_BY_USER,
                        action: () => _log('transition: paused → pausedByUser'),
                    },
                },
            },
        });
    }
});
