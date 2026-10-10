// SPDX-License-Identifier: GPL-3.0-or-later
// D-Bus wrappers for the video renderer, UPower, and MPRIS players.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    APPLICATION_ID,
    RENDERER_OBJECT_PATH,
    LOG_PREFIX,
} from './constants.js';

const _log = (msg) => console.log(`${LOG_PREFIX} dbus: ${msg}`);

// ─── Renderer D-Bus ─────────────────────────────────────────────────────────

const _RENDERER_IFACE = `
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

/**
 * Wrapper over the renderer D-Bus service (org.redclaw.WallpaperProvidersRenderer).
 *
 * Provides play/pause fire-and-forget methods, an async isPlaying query,
 * auto-reconnect on NameOwnerChanged, and a GObject `is-playing-changed` signal
 * forwarded from the renderer's D-Bus signal.
 */
export const RendererDBus = GObject.registerClass({
    GTypeName: 'WpRendererDBus',
    Signals: {
        'is-playing-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class RendererDBus extends GObject.Object {
    _init() {
        super._init();
        this._proxy = null;
        this._signalId = null;
        this._ownerSubId = null;
        this._currentOwner = null;
    }

    /** Start watching the renderer and create the initial proxy. */
    start() {
        this._subscribeOwnerChanged();
        this._createProxy();
    }

    /** Disconnect all D-Bus subscriptions and drop the proxy. */
    stop() {
        if (this._ownerSubId) {
            Gio.DBus.session.signal_unsubscribe(this._ownerSubId);
            this._ownerSubId = null;
        }
        this._disconnectSignal();
        this._proxy = null;
        this._currentOwner = null;
    }

    // ── Proxy lifecycle ─────────────────────────────────────────────────

    _subscribeOwnerChanged() {
        if (this._ownerSubId)
            return;
        try {
            this._ownerSubId = Gio.DBus.session.signal_subscribe(
                'org.freedesktop.DBus',
                'org.freedesktop.DBus',
                'NameOwnerChanged',
                '/org/freedesktop/DBus',
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    const [name, oldOwner, newOwner] = params.deep_unpack();
                    if (name !== APPLICATION_ID)
                        return;
                    if (oldOwner === this._currentOwner)
                        return;
                    _log(`Owner changed: ${oldOwner || '(none)'} → ${newOwner || '(none)'}`);
                    this._currentOwner = newOwner || null;
                    if (newOwner)
                        this._createProxy();
                }
            );
        } catch (e) {
            _log(`Owner watch failed: ${e.message}`);
        }
    }

    _createProxy() {
        this._disconnectSignal();
        try {
            const DBusProxy = Gio.DBusProxy.makeProxyWrapper(_RENDERER_IFACE);
            this._proxy = DBusProxy(Gio.DBus.session, APPLICATION_ID, RENDERER_OBJECT_PATH);
            const owner = this._proxy.get_name_owner();
            if (owner)
                this._currentOwner = owner;
            this._signalId = this._proxy.connectSignal(
                'isPlayingChanged',
                (_p, _s, [isPlaying]) => this.emit('is-playing-changed', isPlaying)
            );
            _log('Proxy created');
        } catch (e) {
            _log(`Proxy creation failed: ${e.message}`);
            this._proxy = null;
        }
    }

    _disconnectSignal() {
        if (this._signalId && this._proxy) {
            try {
                this._proxy.disconnectSignal(this._signalId);
            } catch (_e) { /* already disconnected */ }
            this._signalId = null;
        }
    }

    _tryReconnect() {
        if (this._currentOwner)
            this._createProxy();
    }

    // ── Public API ──────────────────────────────────────────────────────

    /** Tell the renderer to play (fire-and-forget). */
    play() {
        if (!this._proxy)
            return;
        try {
            this._proxy.setPlaySync();
        } catch (e) {
            _log(`play() failed: ${e.message}`);
            this._tryReconnect();
        }
    }

    /** Tell the renderer to pause (fire-and-forget). */
    pause() {
        if (!this._proxy)
            return;
        try {
            this._proxy.setPauseSync();
        } catch (e) {
            _log(`pause() failed: ${e.message}`);
            this._tryReconnect();
        }
    }

    /** Query whether the renderer is currently playing. Returns boolean|null. */
    async getIsPlaying() {
        if (!this._proxy)
            return null;
        try {
            return this._proxy.isPlaying;
        } catch (e) {
            _log(`getIsPlaying() failed: ${e.message}`);
            this._tryReconnect();
            return null;
        }
    }
});

// ─── UPower D-Bus ───────────────────────────────────────────────────────────

const _UPOWER_BUS = 'org.freedesktop.UPower';
const _UPOWER_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const _UPOWER_IFACE = 'org.freedesktop.UPower.Device';

const _UPowerState = Object.freeze({
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
});

const _UPOWER_DEVICE_XML = `
<node>
    <interface name="${_UPOWER_IFACE}">
        <property name="Percentage" type="d" access="read"/>
        <property name="State" type="u" access="read"/>
    </interface>
</node>`;

/**
 * Thin wrapper over the UPower DisplayDevice.
 *
 * Emits `changed` when battery state or percentage changes, and a one-shot
 * `unavailable` signal if UPower cannot be reached (e.g. desktop without
 * battery).
 */
export const UPowerDBus = GObject.registerClass({
    GTypeName: 'WpUPowerDBus',
    Signals: {
        'changed': {},
        'unavailable': {},
    },
}, class UPowerDBus extends GObject.Object {
    _init() {
        super._init();
        this._proxy = null;
        this._unavailableEmitted = false;
    }

    /** Create the proxy — safe to call even if UPower is absent. */
    start() {
        try {
            const DBusProxy = Gio.DBusProxy.makeProxyWrapper(_UPOWER_DEVICE_XML);
            this._proxy = DBusProxy(Gio.DBus.system, _UPOWER_BUS, _UPOWER_PATH);
            this._proxy.connect('g-properties-changed', () => {
                this.emit('changed');
            });
        } catch (e) {
            _log(`UPower proxy creation failed: ${e.message}`);
            this._emitUnavailable();
        }
    }

    stop() {
        this._proxy = null;
    }

    _emitUnavailable() {
        if (!this._unavailableEmitted) {
            this._unavailableEmitted = true;
            this.emit('unavailable');
        }
    }

    _getState() {
        try {
            return this._proxy.State ?? _UPowerState.UNKNOWN;
        } catch (_e) {
            return _UPowerState.UNKNOWN;
        }
    }

    _getPercentage() {
        try {
            return this._proxy.Percentage ?? 100;
        } catch (_e) {
            return 100;
        }
    }

    /** True when the device is on battery AND percentage ≤ threshold. */
    async isLowBattery(threshold = 25) {
        if (!this._proxy) {
            this._emitUnavailable();
            return false;
        }
        const state = this._getState();
        const onBattery = state === _UPowerState.PENDING_DISCHARGE ||
            state === _UPowerState.DISCHARGING;
        return onBattery && this._getPercentage() <= threshold;
    }

    /** True when the device is discharging (on battery power). */
    async isOnBattery() {
        if (!this._proxy) {
            this._emitUnavailable();
            return false;
        }
        const state = this._getState();
        return state === _UPowerState.PENDING_DISCHARGE ||
            state === _UPowerState.DISCHARGING;
    }
});

// ─── MPRIS D-Bus ────────────────────────────────────────────────────────────

const _DBUS_BUS = 'org.freedesktop.DBus';
const _DBUS_PATH = '/org/freedesktop/DBus';
const _MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const _MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const _MPRIS_PLAYER_XML = `
<node>
    <interface name="${_MPRIS_PLAYER_IFACE}">
        <property name="PlaybackStatus" type="s" access="read"/>
    </interface>
</node>`;

/**
 * Watches all MPRIS media players on the session bus.
 *
 * Emits `playing-changed(boolean)` when ANY player's PlaybackStatus changes.
 * `true` = at least one player is Playing, `false` = none are.
 */
export const MprisDBus = GObject.registerClass({
    GTypeName: 'WpMprisDBus',
    Signals: {
        'playing-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class MprisDBus extends GObject.Object {
    _init() {
        super._init();
        this._ownerSubId = null;
        this._players = new Map();
    }

    /** Discover existing players and start watching. */
    start() {
        this._discoverPlayers();
        this._subscribeOwnerChanged();
    }

    /** Drop all tracked players and stop watching. */
    stop() {
        if (this._ownerSubId) {
            Gio.DBus.session.signal_unsubscribe(this._ownerSubId);
            this._ownerSubId = null;
        }
        this._dropAllPlayers();
    }

    // ── Owner watch ─────────────────────────────────────────────────────

    _subscribeOwnerChanged() {
        if (this._ownerSubId)
            return;
        try {
            this._ownerSubId = Gio.DBus.session.signal_subscribe(
                _DBUS_BUS,
                'org.freedesktop.DBus',
                'NameOwnerChanged',
                _DBUS_PATH,
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    const [name, oldOwner, newOwner] = params.deep_unpack();
                    if (!name.startsWith(_MPRIS_PREFIX))
                        return;
                    if (oldOwner === '' && newOwner !== '')
                        this._addPlayer(name);
                    else if (newOwner === '' && oldOwner !== '')
                        this._removePlayer(name);
                    this._evaluatePlaying();
                }
            );
        } catch (e) {
            _log(`MPRIS owner watch failed: ${e.message}`);
        }
    }

    // ── Player tracking ─────────────────────────────────────────────────

    _discoverPlayers() {
        try {
            const result = Gio.DBus.session.call_sync(
                _DBUS_BUS, _DBUS_PATH,
                'org.freedesktop.DBus', 'ListNames',
                null,
                new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE, -1, null
            );
            const [names] = result.deep_unpack();
            for (const name of names) {
                if (name.startsWith(_MPRIS_PREFIX))
                    this._addPlayer(name);
            }
        } catch (e) {
            _log(`MPRIS ListNames failed: ${e.message}`);
        }
    }

    _addPlayer(name) {
        if (this._players.has(name))
            return;
        try {
            const DBusProxy = Gio.DBusProxy.makeProxyWrapper(_MPRIS_PLAYER_XML);
            const proxy = DBusProxy(Gio.DBus.session, name, '/org/mpris/MediaPlayer2');
            const propId = proxy.connect('g-properties-changed', () => {
                this._evaluatePlaying();
            });
            this._players.set(name, {proxy, propId});
            _log(`MPRIS player added: ${name}`);
        } catch (e) {
            _log(`Failed to add MPRIS player ${name}: ${e.message}`);
        }
    }

    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        try {
            player.proxy.disconnect(player.propId);
        } catch (_e) { /* already disconnected */ }
        this._players.delete(name);
        _log(`MPRIS player removed: ${name}`);
    }

    _dropAllPlayers() {
        for (const name of this._players.keys())
            this._removePlayer(name);
    }

    _evaluatePlaying() {
        let anyPlaying = false;
        for (const [name, player] of this._players) {
            try {
                if (player.proxy.PlaybackStatus === 'Playing') {
                    anyPlaying = true;
                    break;
                }
            } catch (_e) {
                this._removePlayer(name);
            }
        }
        this.emit('playing-changed', anyPlaying);
    }
});
