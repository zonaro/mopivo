// SPDX-License-Identifier: GPL-3.0-or-later
// ui/webWallpaperPrefs.js — preferences for Wallpaper Engine / Lively web
// wallpapers (#11).
//
// Adds a "Web Wallpapers" group to the Video preferences page: pick a project
// folder, toggle the audio bridge, and edit the wallpaper's properties. The
// heavy lifting (manifest parsing, merge, JSON round-trip) lives in
// lib/wallpaper-web.js; this module is only the GTK surface.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {_} from '../lib/i18n.js';
import {
    parseProjectJson,
    parseLivelyProperties,
    jsonToProperties,
    propertiesToJson,
} from '../lib/wallpaper-web.js';

const LOG = '[wp] webWallpaperPrefs:';

/** Read a UTF-8 text file, returning '' (with a log) when unreadable. */
function _readText(path) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? new TextDecoder().decode(contents) : '';
    } catch (e) {
        console.warn(`${LOG} cannot read ${path}: ${e.message}`);
        return '';
    }
}

/** Merge project + Lively property specs into `{key: {type, value, text}}`. */
function _mergeSpecs(project, lively) {
    const out = {};
    for (const src of [project, lively]) {
        if (!src || typeof src !== 'object')
            continue;
        for (const key of Object.keys(src)) {
            const entry = src[key] || {};
            const prev = out[key] || {};
            const value = entry.value === null || entry.value === undefined
                ? prev.value : entry.value;
            out[key] = {
                type: entry.type || prev.type || 'textinput',
                value,
                text: entry.text || prev.text || '',
            };
        }
    }
    return out;
}

/** Load the property specs of a web wallpaper folder (empty when unreadable). */
function _loadSpecs(dir) {
    const project = parseProjectJson(_readText(GLib.build_filenamev([dir, 'project.json'])));
    const lively = parseLivelyProperties(
        _readText(GLib.build_filenamev([dir, 'LivelyProperties.json'])));
    return _mergeSpecs(project.properties, lively);
}

/** Build an editable row for one property, seeded from its merged value. */
function _propertyRow(key, spec, current) {
    const title = spec.text || key;
    const value = current === undefined ? spec.value : current;

    if (spec.type === 'bool') {
        const row = new Adw.SwitchRow({title, subtitle: key});
        row.set_active(value === true || value === 'true');
        row._readValue = () => row.get_active();
        return row;
    }

    if (spec.type === 'slider') {
        const scale = new Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 1, 0.01);
        const numeric = Number(value);
        scale.set_value(Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0);
        scale.set_hexpand(true);
        scale.set_size_request(160, -1);
        const row = new Adw.ActionRow({title, subtitle: key});
        row.add_suffix(scale);
        row._readValue = () => scale.get_value();
        return row;
    }

    const entry = new Adw.EntryRow({title: `${title} (${spec.type})`});
    entry.set_text(value === null || value === undefined ? '' : String(value));
    entry._readValue = () => entry.get_text();
    return entry;
}

/** Open the property editor for the currently selected web wallpaper. */
function _showPropertiesDialog(parentRow, settings) {
    const dir = settings.get_string('video-webpage-project');
    if (!dir) {
        _toast(parentRow, _('Select a web wallpaper folder first.'));
        return;
    }

    const specs = _loadSpecs(dir);
    const overrides = jsonToProperties(settings.get_string('video-webpage-properties'));
    const keys = Object.keys(specs);

    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    const rows = [];
    for (const key of keys) {
        const row = _propertyRow(key, specs[key], overrides[key]);
        rows.push({key, row});
        box.append(row);
    }
    if (keys.length === 0)
        box.append(new Gtk.Label({label: _('This wallpaper has no properties.'), xalign: 0}));

    const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        propagate_natural_height: true,
        max_content_height: 460,
        child: box,
    });

    const dialog = new Adw.MessageDialog({
        transient_for: parentRow?.get_root?.() ?? null,
        modal: true,
        heading: _('Web wallpaper properties'),
        extra_child: scrolled,
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('save', _('Save'));
    dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
    dialog.set_default_response('save');
    dialog.set_close_response('cancel');

    dialog.connect('response', (_dlg, response) => {
        if (response === 'save') {
            const flat = {};
            for (const {key, row} of rows) {
                try {
                    flat[key] = row._readValue();
                } catch (e) {
                    console.error(`${LOG} cannot read property '${key}': ${e.message}`);
                }
            }
            settings.set_string('video-webpage-properties', propertiesToJson(flat));
            settings.sync?.();
        }
        dialog.destroy();
    });

    dialog.present();
}

/** Transient status text on the group's subtitle when a row is unusable. */
function _toast(row, message) {
    if (row)
        row.set_subtitle(message);
}

/** Pick a web wallpaper folder and persist it on `video-webpage-project`. */
function _chooseProjectFolder(row, settings) {
    let dialog;
    try {
        dialog = new Gtk.FileDialog({title: _('Select a web wallpaper folder')});
    } catch (e) {
        console.error(`${LOG} file dialog unavailable: ${e.message}`);
        return;
    }
    dialog.select_folder(null, null, (_dlg, res) => {
        let file = null;
        try {
            file = dialog.select_folder_finish(res);
        } catch (_e) {
            return; // user cancelled
        }
        const path = file?.get_path?.();
        if (!path)
            return;
        settings.set_string('video-webpage-project', path);
        row.subtitle = path;
    });
}

/**
 * Build the "Web Wallpapers" preferences group for the Video page.
 *
 * @param {Gio.Settings} settings mopivo schema settings.
 * @returns {Adw.PreferencesGroup}
 */
export function buildWebWallpaperGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Web Wallpapers'),
        description: _('Wallpaper Engine / Lively web wallpapers with their settings and audio.'),
    });

    const projectRow = new Adw.ActionRow({
        title: _('Web Wallpaper Folder'),
        subtitle: settings.get_string('video-webpage-project') || _('No folder selected'),
    });
    const chooseBtn = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER});
    chooseBtn.connect('clicked', () => _chooseProjectFolder(projectRow, settings));
    projectRow.add_suffix(chooseBtn);
    projectRow.activatable_widget = chooseBtn;
    group.add(projectRow);

    const propsRow = new Adw.ActionRow({
        title: _('Properties'),
        subtitle: _('Override the wallpaper properties'),
    });
    const propsBtn = new Gtk.Button({label: _('Edit…'), valign: Gtk.Align.CENTER});
    propsBtn.connect('clicked', () => _showPropertiesDialog(propsRow, settings));
    propsRow.add_suffix(propsBtn);
    propsRow.activatable_widget = propsBtn;
    group.add(propsRow);

    const audioRow = new Adw.SwitchRow({
        title: _('Audio Bridge'),
        subtitle: _('Feed the system audio spectrum to the wallpaper'),
    });
    settings.bind('video-webpage-audio', audioRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(audioRow);

    return group;
}
