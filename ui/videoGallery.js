// SPDX-License-Identifier: GPL-3.0-or-later
// ui/videoGallery.js — online video gallery for Mopivo.
//
// Video-capable counterpart of ui/gallery.js: browses the providers listed in
// VIDEO_PROVIDER_IDS (Pexels, Pixabay), renders poster thumbnails into a
// Gtk.FlowBox, paginates, and on click downloads the mp4 into the configured
// video folder and hands it to the app's VideoController for playback.
// Pure ESM — no St/Clutter/Meta/Main/resource:// imports, no GStreamer/D-Bus.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {downloadToFile} from '../lib/download.js';
import {_} from '../lib/i18n.js';
import {resolveVideoFolder} from '../lib/paths.js';
import {
    VIDEO_PROVIDER_IDS,
    PROVIDER_META,
    getProvider,
} from '../lib/providers/registry.js';

const CACHE_BASE = GLib.get_home_dir() + '/.cache/mopivo';
const GRID_COLS = 3;
const THUMB_WIDTH = 200;
const THUMB_HEIGHT = 150;

/** Number of video results requested per page. */
export const VIDEO_PAGE_SIZE = 10;

// Async GTK4 picture loader for local files (same probe as ui/gallery.js).
// Probed once at module load — it only touches introspection, no widget is
// constructed, so importing the module stays headless-safe.
const _setPictureFile = typeof Gtk.Picture.prototype.set_filename === 'function'
    ? (picture, path) => picture.set_filename(path)
    : (picture, path) => { picture.file = Gio.File.new_for_path(path); };

function _ensureDir(p) {
    const d = Gio.File.new_for_path(p);
    if (!d.query_exists(null)) d.make_directory_with_parents(null);
}

function _cacheDir(pid) {
    return GLib.build_filenamev([CACHE_BASE, pid || 'pexels', 'videos']);
}

// ---------------------------------------------------------------------------
// Pure helpers (module-level, no GObject — import-safe headless)
// ---------------------------------------------------------------------------

/**
 * Sanitize an id so it is safe inside a file name.
 * @param {*} id
 * @returns {string}
 */
function _safeId(id) {
    return String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Extract the final path segment of a URL-ish string, ignoring any query
 * string or fragment. GJS ships no WHATWG `URL` global, so this parses the
 * string directly (mirrors ui/gallery.js `extensionFor`).
 *
 * @param {*} url
 * @returns {string}
 */
function _pathName(url) {
    const path = String(url ?? '').split('#')[0].split('?')[0];
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Derive the download file name for a video item: `<provider>-<id>.<ext>`,
 * where the extension comes from the video URL path (mp4/webm) and defaults
 * to mp4 for anything else.
 *
 * @param {string} providerId
 * @param {{id: *, videoUrl?: string}} item
 * @returns {string}
 */
export function videoFileName(providerId, item) {
    let ext = 'mp4';
    try {
        const name = _pathName(item.videoUrl);
        const dot = name.lastIndexOf('.');
        if (dot >= 0) {
            const candidate = name.slice(dot + 1).toLowerCase();
            if (candidate === 'mp4' || candidate === 'webm')
                ext = candidate;
        }
    } catch (_e) { /* defensive — keep the mp4 default */ }
    return `${providerId}-${_safeId(item.id)}.${ext}`;
}

/**
 * Resolve the absolute destination path for a video download.
 *
 * @param {object} settings   Gio.Settings or a {get_string} stub.
 * @param {string} providerId
 * @param {{id: *, videoUrl?: string}} item
 * @returns {string}
 */
export function resolveVideoDownloadPath(settings, providerId, item) {
    return GLib.build_filenamev([resolveVideoFolder(settings), videoFileName(providerId, item)]);
}

/**
 * Filter/sanitize a provider video payload down to playable items. Keeps only
 * entries with a truthy `id` AND `videoUrl`, and returns a fresh canonical copy.
 *
 * @param {Array} items
 * @returns {Array<{id: *, previewUrl: string, videoUrl: string, resolution: string,
 *                  duration: number, source: string, sourceUrl: string}>}
 */
export function normalizeVideoItems(items) {
    if (!Array.isArray(items))
        return [];
    return items
        .filter(it => it && it.id && it.videoUrl)
        .map(it => ({
            id: it.id,
            previewUrl: it.previewUrl || '',
            videoUrl: it.videoUrl || '',
            resolution: it.resolution || '',
            duration: Number.isFinite(it.duration) ? it.duration : 0,
            source: it.source || '',
            sourceUrl: it.sourceUrl || '',
        }));
}

// ---------------------------------------------------------------------------
// VideoGallery
// ---------------------------------------------------------------------------

/**
 * Online video gallery backed by the video-capable providers.
 *
 * Contract:
 *   new VideoGallery({controller?, settings?, session?})
 *     .widget  .search({q, page})  .loadRecent()  .setVisible(on)  .clear()
 *     .providerId  .pagination  .destroy()
 *
 * All three constructor options are optional. Nothing at import time touches
 * the network, D-Bus, GStreamer or constructs a widget; widgets live inside
 * _init/_buildWidget. The window packs `.widget` into its video stack.
 */
const VideoGallery = GObject.registerClass({
    GTypeName: 'WpVideoGallery',
}, class VideoGallery extends GObject.Object {
    _init({controller = null, settings = null, session = null} = {}) {
        super._init();

        this._controller = controller;
        this._settings = settings;
        this._session = session;

        this._providerId = 'pexels';
        this._page = 1;
        this._lastPage = 1;
        this._items = [];
        this._thumbs = [];
        this._currentParams = null;
        this._loading = false;
        this._statusShown = false;

        this._buildWidget();

        const saved = this._settings?.get_string?.('video-search-query') || '';
        if (saved)
            this._searchEntry.set_text(saved);
        if (this._providerId)
            this.search({q: saved || ''}).catch(e =>
                console.error('[wp-video] Video search failed: ' + (e.message || e)));
    }

    get widget() { return this._widget; }
    get providerId() { return this._providerId; }
    get pagination() { return {page: this._page, totalPage: this._lastPage}; }

    // ── Widget construction ─────────────────────────────────────────────

    _buildWidget() {
        this._widget = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
        });

        // Search row: entry + provider dropdown.
        const searchRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });

        this._searchEntry = new Gtk.SearchEntry({
            hexpand: true,
            placeholder_text: _('Search videos…'),
        });

        this._providerDrop = new Gtk.DropDown({
            model: Gtk.StringList.new(
                VIDEO_PROVIDER_IDS.map(id => PROVIDER_META[id].displayName)),
            tooltip_text: _('Video provider'),
            valign: Gtk.Align.CENTER,
        });

        // Initial selection: the saved 'video-provider' (fallback: first id).
        const savedId = this._settings?.get_string?.('video-provider') || '';
        this._providerId = VIDEO_PROVIDER_IDS.includes(savedId)
            ? savedId
            : (VIDEO_PROVIDER_IDS[0] ?? 'pexels');
        if (VIDEO_PROVIDER_IDS.length)
            this._providerDrop.set_selected(VIDEO_PROVIDER_IDS.indexOf(this._providerId));
        else
            this._providerDrop.set_sensitive(false);

        searchRow.append(this._searchEntry);
        searchRow.append(this._providerDrop);
        this._widget.append(searchRow);

        // Scrolled grid of poster thumbnails.
        this._flowbox = new Gtk.FlowBox({
            row_spacing: 8,
            column_spacing: 8,
            homogeneous: true,
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: GRID_COLS,
            min_children_per_line: 1,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.START,
            hexpand: true,
            vexpand: true,
        });

        const scrolled = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
        });
        scrolled.set_child(this._flowbox);
        this._widget.append(scrolled);

        // Status label.
        this._statusLabel = new Gtk.Label({
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            visible: false,
        });
        this._widget.append(this._statusLabel);

        // Pagination bar.
        this._buildPagination();
        this._widget.append(this._paginationBar);

        // Signal wiring.
        this._searchEntry.connect('activate', () => {
            this.search({q: this._searchEntry.get_text(), page: 1}).catch(e =>
                console.error('[wp-video] Video search failed: ' + (e.message || e)));
        });

        this._providerDrop.connect('notify::selected', () => {
            const index = this._providerDrop.get_selected();
            if (index < 0 || index >= VIDEO_PROVIDER_IDS.length) return;
            const id = VIDEO_PROVIDER_IDS[index];
            if (!id || id === this._providerId) return;
            this._providerId = id;
            if (typeof this._settings?.set_string === 'function')
                this._settings.set_string('video-provider', id);
            _ensureDir(_cacheDir(this._providerId));
            const q = this._currentParams?.q ?? this._searchEntry.get_text();
            this.search({q, page: 1}).catch(e =>
                console.error('[wp-video] Video search failed: ' + (e.message || e)));
        });

        _ensureDir(_cacheDir(this._providerId));
    }

    _buildPagination() {
        this._paginationBar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
            margin_top: 8,
            visible: false,
        });

        this._firstBtn = new Gtk.Button({label: '\u23EE', tooltip_text: _('First page')});
        this._prevBtn = new Gtk.Button({label: '\u2039', tooltip_text: _('Previous page')});
        this._pageLabel = new Gtk.Label({label: 'Page 1', margin_start: 8, margin_end: 8});
        this._nextBtn = new Gtk.Button({label: '\u203A', tooltip_text: _('Next page')});
        this._lastBtn = new Gtk.Button({label: '\u23ED', tooltip_text: _('Last page')});

        this._firstBtn.connect('clicked', () => this._goTo(1));
        this._prevBtn.connect('clicked', () => this._goTo(this._page - 1));
        this._nextBtn.connect('clicked', () => this._goTo(this._page + 1));
        this._lastBtn.connect('clicked', () => this._goTo(this._lastPage));

        this._paginationBar.append(this._firstBtn);
        this._paginationBar.append(this._prevBtn);
        this._paginationBar.append(this._pageLabel);
        this._paginationBar.append(this._nextBtn);
        this._paginationBar.append(this._lastBtn);
    }

    // ── Search ──────────────────────────────────────────────────────────

    /**
     * Run a video search. `q` defaults to the SearchEntry text; `page` to 1.
     *
     * @param {{q?: string, page?: number}} [params]
     */
    async search({q, page} = {}) {
        if (this._loading) return;
        this._loading = true;

        try {
            this._page = page || 1;

            if (q === undefined || q === null)
                q = this._searchEntry?.get_text?.() ?? '';
            if (typeof q !== 'string')
                q = String(q);
            this._currentParams = {q, page: this._page};

            if (typeof this._settings?.set_string === 'function')
                this._settings.set_string('video-search-query', q);

            this._clearGrid();
            this._showStatus(_('Searching…'));

            const provider = await getProvider(this._providerId);

            // Pixabay rejects an empty query — guide the user instead of throwing.
            if (this._providerId === 'pixabay' && !q.trim()) {
                this._lastPage = 1;
                this._updatePag();
                this._showStatus(_('Type a search term to browse videos.'));
                return;
            }

            const result = await provider.searchVideos(
                {q, page: this._page, perPage: VIDEO_PAGE_SIZE},
                this._session,
                this._settings,
            );

            const items = normalizeVideoItems(result?.items);
            if (!items.length) {
                this._lastPage = 1;
                this._updatePag();
                this._showStatus(_('No results found.'));
                return;
            }

            this._items = items;
            this._lastPage = result.lastPage || 1;
            this._hideStatus();
            await this._loadThumbs(items);
            this._updatePag();
        } catch (e) {
            const m = e.message || String(e);
            this._showStatus(
                m.includes('401') || m.includes('403')
                    ? _('Authentication failed. Check your API key.')
                    : m.includes('429') ? _('Rate limited. Please wait and try again.')
                    : `${_('Error')}: ${m}`);
            console.error('[wp-video] Video search failed: ' + m);
        } finally {
            this._loading = false;
        }
    }

    async loadRecent() {
        await this.search({q: this._searchEntry?.get_text?.() || ''});
    }

    // ── Thumbnails / selection ──────────────────────────────────────────

    async _loadThumbs(items) {
        this._thumbs = [];
        const dir = _cacheDir(this._providerId);
        _ensureDir(dir);

        const boxes = [];
        for (const item of items) {
            const box = this._newThumbBox(item);
            const child = new Gtk.FlowBoxChild({child: box});
            this._flowbox.append(child);
            this._thumbs.push(child);
            boxes.push(box);
        }
        await Promise.allSettled(items.map((item, i) => this._mkThumb(item, boxes[i], dir)));
    }

    _newThumbBox(item) {
        const picture = new Gtk.Picture({
            width_request: THUMB_WIDTH,
            height_request: THUMB_HEIGHT,
            can_shrink: true,
            content_fit: Gtk.ContentFit.COVER,
            halign: Gtk.Align.CENTER,
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            halign: Gtk.Align.CENTER,
        });
        box.append(picture);
        if (item.resolution)
            box.append(new Gtk.Label({label: item.resolution, halign: Gtk.Align.CENTER}));

        const gesture = new Gtk.GestureClick();
        gesture.connect('released', (_g, _n, _x, _y) => this._onSelect(item));
        box.add_controller(gesture);
        return box;
    }

    async _mkThumb(item, box, dir) {
        const url = item.previewUrl;
        if (!url) return;
        const path = GLib.build_filenamev([dir, item.id + '.jpg']);
        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                await downloadToFile(this._session, url, path);
            _setPictureFile(box.get_first_child(), path);
        } catch (e) {
            console.error('[wp-video] Thumb failed for ' + item.id + ': ' + e.message);
        }
    }

    async _onSelect(item) {
        if (this._loading) return;
        this._showStatus(_('Downloading video…'));
        try {
            const dest = resolveVideoDownloadPath(this._settings, this._providerId, item);
            _ensureDir(GLib.path_get_dirname(dest));
            if (!GLib.file_test(dest, GLib.FileTest.EXISTS))
                await downloadToFile(this._session, item.videoUrl, dest);
            await this._controller?.playFile?.(dest);
            this._showStatus(_('Playing video…'));
        } catch (e) {
            const m = e.message || String(e);
            this._showStatus(_('Download error:') + ' ' + m);
            console.error('[wp-video] Failed to play video ' + item.id + ': ' + m);
        }
    }

    // ── Pagination ──────────────────────────────────────────────────────

    _updatePag() {
        const on = this._lastPage > 1;
        this._paginationBar.visible = on;
        this._pageLabel.text = `Page ${this._page} / ${this._lastPage}`;
        this._firstBtn.sensitive = on && this._page > 1;
        this._prevBtn.sensitive = on && this._page > 1;
        this._nextBtn.sensitive = on && this._page < this._lastPage;
        this._lastBtn.sensitive = on && this._page < this._lastPage;
    }

    _goTo(page) {
        if (this._loading || !this._currentParams) return;
        const target = Math.min(Math.max(page, 1), this._lastPage);
        if (target === this._page) return;
        this._page = target;
        this.search({...this._currentParams, page: target}).catch(e =>
            console.error('[wp-video] Video search failed: ' + (e.message || e)));
    }

    // ── Visibility / lifecycle ──────────────────────────────────────────

    setVisible(on) {
        this._widget.visible = on;
    }

    _showStatus(text) {
        this._statusShown = true;
        this._statusLabel.text = text;
        this._statusLabel.visible = true;
    }

    _hideStatus() {
        this._statusShown = false;
        this._statusLabel.visible = false;
    }

    _clearGrid() {
        if (typeof this._flowbox.remove_all === 'function') {
            this._flowbox.remove_all();
        } else {
            let child = this._flowbox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                this._flowbox.remove(child);
                child = next;
            }
        }
        this._thumbs = [];
    }

    clear() {
        this._clearGrid();
        this._items = [];
        this._hideStatus();
    }

    destroy() {
        try { this._clearGrid(); } catch (_e) { /* keep the no-op guarantee */ }
        this._controller = null;
    }
});

export {VideoGallery};
