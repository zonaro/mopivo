// SPDX-License-Identifier: GPL-3.0-or-later
// lib/applyPlacement.js — pure helpers behind the per-item "Apply" dialog.
//
// Turns the user's monitor selection plus a copy/extend choice into the three
// GSettings keys the existing apply path already understands
// (`wallpaper-mode`, `wallpaper-per-monitor`, `wallpaper-default-uri`, see
// lib/wallpaper.js + lib/wallpaper-multi.js). No GTK and no Gio here, so the
// logic stays unit-testable without a display; the dialog (ui/applyDialog.js)
// and the apply path itself are kept free of it.

import {_} from './i18n.js';

/** Replicate the chosen wallpaper on each selected monitor. */
export const PLACEMENT_COPY = 'copy';
/** Spread a single wallpaper across the selected monitors. */
export const PLACEMENT_EXTEND = 'extend';

/** `wallpaper-mode` written for a copy placement. */
const MODE_PER_MONITOR = 'per-monitor';
/** `wallpaper-mode` written for an extend placement. */
const MODE_SPAN = 'span';

/** Coerce a monitor geometry field to a finite integer (0 when invalid). */
function _int(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize a monitor list: drop non-objects, coerce geometry to finite
 * integers, dedupe by connector (first wins) and sort left-to-right /
 * top-to-bottom so the dialog shows monitors in their physical order.
 *
 * @param {Array<object>|null|undefined} list
 * @returns {Array<{connector:string,name:string,x:number,y:number,width:number,height:number}>}
 */
export function normalizeMonitors(list) {
    const input = Array.isArray(list) ? list : [];
    const seen = new Set();
    const out = [];

    for (const entry of input) {
        if (!entry || typeof entry !== 'object')
            continue;
        const connector = String(entry.connector ?? '').trim();
        const name = String(entry.name ?? '').trim();
        const key = connector || name;
        if (key && seen.has(key))
            continue;
        if (key)
            seen.add(key);
        out.push({
            connector,
            name: name || connector,
            x: _int(entry.x),
            y: _int(entry.y),
            width: Math.max(0, _int(entry.width)),
            height: Math.max(0, _int(entry.height)),
        });
    }

    out.sort((a, b) => a.x - b.x || a.y - b.y || a.connector.localeCompare(b.connector));
    return out;
}

/**
 * Connector strings of a monitor list, in normalized order, without blanks.
 *
 * @param {Array<object>|null|undefined} monitors
 * @returns {string[]}
 */
export function allConnectors(monitors) {
    const out = [];
    for (const mon of normalizeMonitors(monitors)) {
        if (mon.connector && !out.includes(mon.connector))
            out.push(mon.connector);
    }
    return out;
}

/**
 * Build `wallpaper-per-monitor` entries (`"connector=uri"`) for a set of
 * connectors. Blank connectors/duplicates and a blank URI yield no entry,
 * matching the schema/format consumed by `parseMonitorAssignments`.
 *
 * @param {string[]|null|undefined} connectors
 * @param {string} uri
 * @returns {string[]}
 */
export function buildPerMonitorEntries(connectors, uri) {
    const target = String(uri ?? '').trim();
    if (!target)
        return [];

    const list = Array.isArray(connectors) ? connectors : [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const connector = String(raw ?? '').trim();
        if (!connector || seen.has(connector))
            continue;
        seen.add(connector);
        out.push(`${connector}=${target}`);
    }
    return out;
}

/**
 * Map a copy/extend placement to the GSettings values the existing apply path
 * (`setWallpaperMode` → `applyPerMonitor`) already understands.
 *
 * - copy   → `per-monitor`: the URI is assigned to every selected connector and
 *            also used as the fallback default so the image covers the rest.
 * - extend → `span`: a single URI stretched across all monitors.
 *
 * @param {object}  options
 * @param {string}  options.placement  PLACEMENT_COPY or PLACEMENT_EXTEND.
 * @param {string[]} options.connectors
 * @param {string}  options.uri
 * @returns {{mode:string, defaultUri:string, perMonitor:string[]}}
 */
export function settingsForPlacement({placement, connectors, uri} = {}) {
    const target = typeof uri === 'string' ? uri : '';

    if (placement === PLACEMENT_EXTEND)
        return {mode: MODE_SPAN, defaultUri: target, perMonitor: []};

    return {
        mode: MODE_PER_MONITOR,
        defaultUri: target,
        perMonitor: buildPerMonitorEntries(connectors, target),
    };
}

/**
 * Localized one-line summary of a placement choice (e.g. "Copy to 2 monitors").
 *
 * @param {string} placement
 * @param {number} count  Number of selected monitors.
 * @returns {string}
 */
export function placementSummary(placement, count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const unit = n === 1 ? _('monitor') : _('monitors');
    const verb = placement === PLACEMENT_EXTEND ? _('Spread across') : _('Copy to');
    return `${verb} ${n} ${unit}`;
}
