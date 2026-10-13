// SPDX-License-Identifier: GPL-3.0-or-later
// Wallpaper Engine / Lively web-wallpaper support — pure helpers (no GTK, no
// WebKit). The renderer subprocess imports this module dynamically.
//
//   * Wallpaper Engine ships `project.json`: HTML entry in `file`, typed
//     defaults under `general.properties` (`{type,value,text,order}`).
//   * Lively ships `LivelyProperties.json` shaped `{key: {type,value,...}}`.
//
// A page reads properties via `window.wallpaperPropertyListener` (WE) and/or a
// global `livelyPropertyListener(name, value)` (Lively); audio comes from
// `window.wallpaperRegisterAudioListener(cb)` (WE) / `window.livelyAudioListener`.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const LOG = '[wp-web]';

// Lively type aliases → canonical types shared by both manifests.
const LIVELY_TYPE_MAP = {
    checkbox: 'bool', textbox: 'textinput', folderdropdown: 'file',
    filedropdown: 'file', colorpicker: 'color',
};

/** Canonicalize a manifest property type (lowercased, aliases resolved). */
function canonicalType(type) {
    const raw = typeof type === 'string' ? type.trim().toLowerCase() : '';
    return LIVELY_TYPE_MAP[raw] || raw;
}

/** Tolerant JSON-object parser: never throws, returns {value, error}. */
function safeParseObject(text) {
    if (text === null || text === undefined)
        return {value: {}, error: 'empty input'};
    if (typeof text !== 'string')
        return {value: {}, error: 'input is not a string'};
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return {value: {}, error: 'empty input'};
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch (e) {
        return {value: {}, error: `invalid JSON: ${e.message}`};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return {value: {}, error: 'JSON is not an object'};
    return {value: parsed, error: null};
}

/** Parse a WE `project.json`; `properties` normalized to `{key:{type,value,text,order}}`. */
export function parseProjectJson(text) {
    const {value, error} = safeParseObject(text);
    const result = {title: '', type: '', file: '', properties: {}, error};
    if (error)
        return result;
    result.title = typeof value.title === 'string' ? value.title : '';
    result.type = typeof value.type === 'string' ? value.type : '';
    result.file = typeof value.file === 'string' ? value.file : '';
    const general = value.general;
    const raw = general && typeof general.properties === 'object'
        ? general.properties
        : (typeof value.properties === 'object' ? value.properties : null);
    if (!raw || Array.isArray(raw))
        return result;
    for (const key of Object.keys(raw)) {
        const entry = raw[key];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            continue;
        result.properties[key] = {
            type: canonicalType(entry.type),
            value: 'value' in entry ? entry.value : null,
            text: typeof entry.text === 'string' ? entry.text : '',
            order: Number.isFinite(entry.order) ? entry.order
                : (Number.isFinite(entry.index) ? entry.index : null),
        };
    }
    return result;
}

/** Parse a Lively manifest into normalized `{key:{type,value,text}}`; `onError(reason)` on bad JSON. */
export function parseLivelyProperties(text, onError = null) {
    const {value, error} = safeParseObject(text);
    if (error) {
        if (onError)
            onError(error);
        return {};
    }
    const out = {};
    for (const key of Object.keys(value)) {
        const entry = value[key];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            continue;
        out[key] = {
            type: canonicalType(entry.type),
            value: 'value' in entry ? entry.value : null,
            text: typeof entry.text === 'string' ? entry.text : '',
        };
    }
    return out;
}

/** Merge both manifests + overrides into a flat map; project < lively < overrides. */
export function mergeProperties(projectProperties = {}, livelyProperties = {},
    overrides = {}) {
    const out = {};
    for (const map of [projectProperties, livelyProperties]) {
        if (!map || typeof map !== 'object')
            continue;
        for (const key of Object.keys(map)) {
            const entry = map[key];
            if (entry && typeof entry === 'object' && 'value' in entry)
                out[key] = entry.value;
        }
    }
    if (overrides && typeof overrides === 'object') {
        for (const key of Object.keys(overrides))
            out[key] = overrides[key];
    }
    return out;
}

/** True when `dir` is an existing directory holding a WE or Lively manifest. */
export function isWebProjectFolder(dir) {
    if (!dir || typeof dir !== 'string')
        return false;
    const folder = Gio.File.new_for_path(dir);
    try {
        if (!folder.query_exists(null) ||
            folder.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !==
                Gio.FileType.DIRECTORY)
            return false;
    } catch (e) {
        console.warn(`${LOG} Cannot inspect folder ${dir}: ${e.message}`);
        return false;
    }
    return ['project.json', 'LivelyProperties.json'].some(name =>
        folder.get_child(name).query_exists(null));
}

/** Resolve the absolute entry HTML (project.file, else index.html/index.htm/main.html). */
export function resolveEntryFile(dir, project = {}) {
    if (!dir || typeof dir !== 'string')
        return null;
    const folder = Gio.File.new_for_path(dir);
    const requested = project && typeof project.file === 'string'
        ? project.file.trim() : '';
    if (requested) {
        const candidate = requested.startsWith('/')
            ? requested : GLib.build_filenamev([dir, requested]);
        if (Gio.File.new_for_path(candidate).query_exists(null))
            return candidate;
    }
    for (const name of ['index.html', 'index.htm', 'main.html']) {
        const child = folder.get_child(name);
        if (child.query_exists(null))
            return child.get_path();
    }
    return null;
}

/** Parse override JSON into a flat map; bad input → {} + reason, never throws. */
export function jsonToProperties(text, onError = null) {
    const {value, error} = safeParseObject(text);
    if (error) {
        if (onError)
            onError(error);
        return {};
    }
    return value;
}

/** Serialize a flat property map to JSON (`'{}'` for anything unusable). */
export function propertiesToJson(flat) {
    if (!flat || typeof flat !== 'object' || Array.isArray(flat))
        return '{}';
    try {
        return JSON.stringify(flat);
    } catch (e) {
        console.warn(`${LOG} Cannot serialize properties: ${e.message}`);
        return '{}';
    }
}

/**
 * Build the shim injected at document-start that lets an unmodified WE/Lively
 * page run under Mopivo: it defines the listener surfaces, env flags and audio
 * sink, then applies the current values once the page is ready.
 * @param {object} opts `{properties, livelyProperties, audioEnabled, env}`.
 * @returns {string} JavaScript source.
 */
export function buildBridgeScript({
    properties = {}, livelyProperties = {}, audioEnabled = false, env = 'both',
} = {}) {
    const flat = properties && typeof properties === 'object' ? properties : {};
    const lively = livelyProperties && typeof livelyProperties === 'object'
        ? livelyProperties : {};
    const weEnv = 'ENV === "both" || ENV === "wallpaper-engine"';
    const livelyEnv = 'ENV === "both" || ENV === "lively"';
    const code = `
(function () {
  "use strict";
  var ENV = ${JSON.stringify(env)};
  var AUDIO = ${audioEnabled ? 'true' : 'false'};
  var PROPS = ${JSON.stringify(flat)};
  window.mopivo = window.mopivo || {};
  window.mopivo.env = ENV;
  window.mopivo.properties = PROPS;
  window.mopivo.livelyProperties = ${JSON.stringify(lively)};
  if (${weEnv}) window.isWallpaperEngine = true;
  if (${livelyEnv}) window.isLivelyWallpaper = true;
  if (typeof window.wallpaperRegisterAudioListener !== "function") {
    window.wallpaperRegisterAudioListener = function (cb) {
      window.__mopivoWeAudioListener = cb;
    };
  }
  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }
  window.mopivoApplyProperties = function (next) {
    if (!next || typeof next !== "object") return;
    window.mopivo.properties = next;
    var we = window.wallpaperPropertyListener;
    if (we && typeof we.applyUserProperties === "function") {
      var payload = {};
      for (var k in next) {
        if (hasOwn(next, k)) payload[k] = { value: next[k] };
      }
      try { we.applyUserProperties(payload); }
      catch (err) { console.error("[mopivo] applyUserProperties failed: " + err); }
    }
    if (typeof window.livelyPropertyListener === "function") {
      for (var j in next) {
        if (!hasOwn(next, j)) continue;
        try { window.livelyPropertyListener(j, next[j]); }
        catch (err2) { console.error("[mopivo] livelyPropertyListener " + j + ": " + err2); }
      }
    }
  };
  window.mopivoPushAudio = function (samples) {
    if (!AUDIO || !samples) return;
    var weCb = window.__mopivoWeAudioListener;
    if (typeof weCb === "function") {
      try { weCb(samples); } catch (e1) { console.error("[mopivo] WE audio failed: " + e1); }
    }
    if (typeof window.livelyAudioListener === "function") {
      try { window.livelyAudioListener(samples); }
      catch (e2) { console.error("[mopivo] Lively audio failed: " + e2); }
    }
  };
  function applyNow() { window.mopivoApplyProperties(PROPS); }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", applyNow);
  else
    applyNow();
  window.addEventListener("load", applyNow);
})();`;
    return code.trim();
}
