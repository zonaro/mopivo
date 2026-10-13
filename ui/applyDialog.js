// SPDX-License-Identifier: GPL-3.0-or-later
// ui/applyDialog.js — per-item "Apply" dialog.
//
// Opened from the gallery's "Apply" button (or any other list item). Lets the
// user pick which monitors receive the wallpaper and whether it is copied to
// each of them (mirror) or spread/extended across them. On Apply it writes the
// placement keys and delegates to the existing apply path in lib/wallpaper.js
// (setWallpaperMode) — the compositing/`picture-options` logic is not
// reimplemented here.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import {_} from '../lib/i18n.js';
import {setWallpaperMode} from '../lib/wallpaper.js';
import {
    PLACEMENT_COPY,
    PLACEMENT_EXTEND,
    normalizeMonitors,
    placementSummary,
    settingsForPlacement,
} from '../lib/applyPlacement.js';

/**
 * Resolve the URI the apply path should receive from a gallery glyph item.
 * Local items carry `uri`/`localUri`; remote ones fall back to `fullUrl`/`path`.
 * @param {object|null|undefined} item
 * @returns {string}
 */
function _itemUri(item) {
    if (!item || typeof item !== 'object')
        return '';
    return item.uri || item.localUri || item.fullUrl || item.path || '';
}

/** Human label for a monitor: name/connector plus resolution when known. */
function _monitorLabel(mon) {
    const base = mon.name || mon.connector || _('Monitor');
    if (mon.width > 0 && mon.height > 0)
        return `${base} — ${mon.width}×${mon.height}`;
    return base;
}

/** Persist a placement plan on the mopivo schema (best-effort, no throw). */
function _writeSettings(settings, plan) {
    if (!settings)
        return;
    settings.set_string?.('wallpaper-mode', plan.mode);
    settings.set_string?.('wallpaper-default-uri', plan.defaultUri);
    settings.set_strv?.('wallpaper-per-monitor', plan.perMonitor);
    settings.sync?.();
}

/**
 * Show the Apply placement dialog.
 *
 * @param {object}   options
 * @param {Gtk.Window|null} [options.parent]     Transient parent.
 * @param {object}   [options.item]              Gallery item being applied.
 * @param {Array}    [options.monitors]          Monitor descriptors.
 * @param {Gio.Settings|null} [options.settings] mopivo schema settings.
 * @param {Function} [options.onApplied]         Called with
 *        `{placement, connectors, uri}` after a successful apply.
 * @returns {Adw.MessageDialog} the presented dialog.
 */
export function showApplyDialog({
    parent = null, item = {}, monitors = [], settings = null, onApplied = null,
} = {}) {
    const list = normalizeMonitors(monitors);
    const uri = _itemUri(item);

    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12});

    // ── Monitor checklist ────────────────────────────────────────────────
    const monitorBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    const heading = new Gtk.Label({label: _('Apply to monitors'), xalign: 0});
    heading.add_css_class('dim-label');
    monitorBox.append(heading);

    const rows = [];
    for (const mon of list) {
        const check = new Gtk.CheckButton({label: _monitorLabel(mon), active: true});
        monitorBox.append(check);
        rows.push({mon, check});
    }
    if (list.length === 0)
        monitorBox.append(new Gtk.Label({label: _('No monitors detected.'), xalign: 0}));
    content.append(monitorBox);

    // ── Copy / Extend selector ───────────────────────────────────────────
    const placementBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    const placementLabel = new Gtk.Label({label: _('Placement'), xalign: 0});
    placementLabel.add_css_class('dim-label');
    placementBox.append(placementLabel);
    const placementDrop = Gtk.DropDown.new_from_strings([_('Copy'), _('Extend')]);
    placementBox.append(placementDrop);
    content.append(placementBox);

    const summary = new Gtk.Label({xalign: 0});
    summary.add_css_class('dim-label');
    content.append(summary);

    const selectedConnectors = () => rows
        .filter(({mon, check}) => check.get_active() && mon.connector)
        .map(({mon}) => mon.connector);

    const placementOf = () => placementDrop.get_selected() === 1
        ? PLACEMENT_EXTEND
        : PLACEMENT_COPY;

    const dialog = new Adw.MessageDialog({
        transient_for: parent,
        modal: true,
        heading: _('Apply wallpaper'),
        extra_child: content,
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('apply', _('Apply'));
    dialog.set_response_appearance('apply', Adw.ResponseAppearance.SUGGESTED);
    dialog.set_default_response('apply');
    dialog.set_close_response('cancel');

    const refresh = () => {
        const connectors = selectedConnectors();
        summary.label = placementSummary(placementOf(), connectors.length);
        dialog.set_response_sensitive('apply', connectors.length > 0 && uri.length > 0);
    };
    for (const {check} of rows)
        check.connect('toggled', refresh);
    placementDrop.connect('notify::selected', refresh);
    refresh();

    dialog.connect('response', (_dlg, response) => {
        try {
            if (response !== 'apply')
                return;
            const connectors = selectedConnectors();
            if (connectors.length === 0 || !uri)
                return;
            const placement = placementOf();
            const plan = settingsForPlacement({placement, connectors, uri});
            _writeSettings(settings, plan);
            setWallpaperMode(settings, uri);
            onApplied?.({placement, connectors, uri});
        } catch (e) {
            console.error(`[wp] apply wallpaper failed: ${e.message}`);
        } finally {
            dialog.destroy();
        }
    });

    dialog.present();
    return dialog;
}
