// SPDX-License-Identifier: GPL-3.0-or-later
// In-panel video browser — local mode only, vertical list with thumbnails.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {_} from '../lib/i18n.js';
import {LOG_PREFIX} from '../lib/video/constants.js';
import {listVideoFiles, getVideoThumb} from '../lib/video/videoThumbs.js';

const DEFAULT_VIDEO_FOLDER = GLib.get_home_dir() + '/Videos/Hidamari';
const THUMB_ICON_SIZE = 32;

export class VideoPicker extends St.BoxLayout {
    GType() {
        return VideoPicker;
    }

    static {
        GObject.registerClass({
            Signals: {
                'video-selected': {param_types: [GObject.TYPE_STRING]},
            },
        }, this);
    }

    _init(settings, _ext) {
        super._init({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style_class: 'wp-video-picker',
        });

        this._settings = settings;
        this._filterText = '';

        // Search entry.
        this._searchEntry = new St.Entry({
            hint_text: _('Search videos…'),
            style_class: 'wp-video-search',
            x_expand: true,
            reactive: true,
            can_focus: true,
        });
        this._searchEntry.connect('text-changed', () => {
            this._filterText = this._searchEntry.get_text().toLowerCase();
            this._populate();
        });
        this.add_child(this._searchEntry);

        // Scrollable list.
        this._scrollView = new St.ScrollView({
            style_class: 'wp-video-scrollview',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
        });
        this._listBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'wp-video-list',
        });
        this._scrollView.set_child(this._listBox);
        this.add_child(this._scrollView);

        this._rows = [];
        this._files = [];
    }

    get folder() {
        const f = this._settings.get_string('video-folder');
        return f || DEFAULT_VIDEO_FOLDER;
    }

    refresh() {
        this._files = listVideoFiles(this.folder);
        this._populate();
    }

    _populate() {
        // Clear existing rows.
        for (const row of this._rows) {
            this._listBox.remove_child(row);
            row.destroy();
        }
        this._rows = [];

        const filter = this._filterText;
        const filtered = filter
            ? this._files.filter(p => {
                const name = GLib.path_get_basename(p).toLowerCase();
                return name.includes(filter);
            })
            : this._files;

        if (filtered.length === 0) {
            const empty = new St.Label({
                text: filter ? _('No matching videos.') : _('No videos found.'),
                style_class: 'wp-video-empty',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._listBox.add_child(empty);
            this._rows.push(empty);
            return;
        }

        for (const filePath of filtered) {
            const row = this._mkRow(filePath);
            this._listBox.add_child(row);
            this._rows.push(row);
        }
    }

    _mkRow(filePath) {
        const name = GLib.path_get_basename(filePath);

        const icon = new St.Icon({
            icon_name: 'video-x-generic-symbolic',
            icon_size: THUMB_ICON_SIZE,
            style_class: 'wp-video-row-icon',
        });

        const label = new St.Label({
            text: name,
            style_class: 'wp-video-row-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const btn = new St.Button({
            style_class: 'wp-video-row-button',
            child: null,
            can_focus: true,
            reactive: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });

        const rowBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'wp-video-row-box',
        });
        rowBox.add_child(icon);
        rowBox.add_child(label);
        btn.set_child(rowBox);

        btn.connect('clicked', () => {
            this.emit('video-selected', filePath);
        });

        // Async thumbnail load — swap icon when ready, non-blocking.
        this._loadThumbAsync(filePath, icon);

        return btn;
    }

    async _loadThumbAsync(filePath, icon) {
        try {
            const thumbPath = await getVideoThumb(filePath);
            if (!thumbPath)
                return;
            const gicon = Gio.FileIcon.new(Gio.File.new_for_path(thumbPath));
            icon.set_gicon(gicon);
        } catch (e) {
            console.log(`${LOG_PREFIX} videoPicker thumb failed: ${e.message}`);
        }
    }
}
