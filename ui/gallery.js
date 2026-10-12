// SPDX-License-Identifier: GPL-3.0-or-later
// GTK4 thumbnail gallery + pagination for Mopivo.
//
// Standalone (app) rewrite of the old GNOME Shell St/Clutter gallery: renders
// search results into a Gtk.FlowBox of Gtk.Picture thumbnails, downloads the
// full-resolution image on click and applies it as desktop wallpaper via
// lib/wallpaper.js. Pure ESM — no St/Clutter/Meta/Main/resource:// imports.
//
// The app window (phase P4) hydrates a GalleryManager with the FlowBox it owns
// (or lets us create one) and calls the frozen interface below. The status
// label and the pagination bar are separate widgets the window packs wherever
// it wants; the manager only toggles their visibility.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {downloadToFile} from '../lib/download.js';
import {_} from '../lib/i18n.js';
import {setDesktopWallpaper} from '../lib/wallpaper.js';
import {resolveDownloadFolder} from '../lib/paths.js';
import {getProvider} from '../lib/providers/registry.js';

const CACHE_BASE = GLib.get_home_dir() + '/.cache/mopivo';
const GRID_COLS = 3;
const THUMB_SIZE = 200;
const THUMB_HEIGHT = 150;

// Async GTK4 picture loader for local files. set_filename is the preferred
// async API (risk R5: never block on Gdk.Texture.new_from_filename); the file
// property fallback behaves the same way. Probed once at module load — it only
// touches introspection, no widget is constructed.
const _setPictureFile = typeof Gtk.Picture.prototype.set_filename === 'function'
    ? (picture, path) => picture.set_filename(path)
    : (picture, path) => { picture.file = Gio.File.new_for_path(path); };

function _ensureDir(p) {
    const d = Gio.File.new_for_path(p);
    if (!d.query_exists(null)) d.make_directory_with_parents(null);
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

/**
 * Derive a safe image file extension from a download URL, defaulting to jpg
 * when the URL has no recognizable image extension.
 * @param {string} url
 * @returns {string}
 */
export function extensionFor(url) {
    const path = String(url).split('#')[0].split('?')[0];
    const slash = path.lastIndexOf('/');
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = name.lastIndexOf('.');
    if (dot >= 0) {
        const ext = name.slice(dot + 1).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext))
            return ext;
    }
    return 'jpg';
}

function _cacheDir(pid) {
    return GLib.build_filenamev([CACHE_BASE, pid || 'wallhaven']);
}

function _parseWidth(res) {
    if (!res || typeof res !== 'string') return 0;
    const idx = res.indexOf('x');
    if (idx <= 0) return 0;
    const w = parseInt(res.substring(0, idx), 10);
    return Number.isFinite(w) ? w : 0;
}

function _parseHeight(res) {
    if (!res || typeof res !== 'string') return 0;
    const idx = res.indexOf('x');
    if (idx < 0) return 0;
    const h = parseInt(res.substring(idx + 1), 10);
    return Number.isFinite(h) ? h : 0;
}

/**
 * Map a single raw provider item to the normalized gallery item shape.
 * Tolerant of both already-normalized items (previewUrl/fullUrl/resolution)
 * and raw provider records (thumbs.small/path/resolution/url).
 */
function _mapItem(item = {}) {
    const resolution = item.resolution || item.dimensions || item.url?.WxH || '';
    const previewUrl = item.previewUrl || item.thumbs?.small
        || item.thumbs?.medium || item.thumbs?.large
        || item.thumbnail || item.urls?.thumb || '';
    const fullUrl = item.fullUrl || item.path || item.image
        || item.urls?.full || item.imageUrl || '';

    return {
        id: item.id ?? null,
        previewUrl,
        fullUrl,
        path: fullUrl,
        resolution,
        width: Number.isInteger(item.previewWidth) && item.previewWidth > 0
            ? item.previewWidth
            : _parseWidth(resolution),
        height: Number.isInteger(item.previewHeight) && item.previewHeight > 0
            ? item.previewHeight
            : _parseHeight(resolution),
        source: item.source || '',
        sourceUrl: item.sourceUrl || item.pageUrl || item.url || '',
    };
}

function _computeTotalPage(raw, meta) {
    const last = meta.last_page ?? raw.lastPage ?? raw.pages ?? 0;
    if (Number.isFinite(last) && last >= 1)
        return Math.round(last);
    const total = meta.total ?? raw.total ?? 0;
    const per = meta.per_page ?? raw.perPage ?? 0;
    if (Number.isFinite(total) && total >= 1 && Number.isFinite(per) && per >= 1)
        return Math.max(1, Math.ceil(total / per));
    return 1;
}

/**
 * Normalize a raw provider search payload into the canonical gallery shape.
 *
 * Handles the two shapes the legacy module consumed:
 *   - wallhaven raw `{items|data: [...], meta: {current_page, last_page, total, per_page}}`
 *   - already-normalized `{items: [...], total, page, lastPage}` (modern
 *     providers via lib/providers registry).
 * Malformed/empty payloads degrade gracefully to an empty list while keeping
 * `fallbackPage` as the page number.
 *
 * @param {object|null} raw          Raw provider search result.
 * @param {number}      fallbackPage Page to report when the payload carries none.
 * @returns {{results: object[], page: number, totalPage: number}}
 */
export function normalizeResult(raw, fallbackPage = 1) {
    if (!raw || typeof raw !== 'object')
        return {results: [], page: fallbackPage, totalPage: 1};

    const rawItems = Array.isArray(raw.items) ? raw.items
        : Array.isArray(raw.data) ? raw.data
        : null;
    if (!rawItems)
        return {results: [], page: fallbackPage, totalPage: 1};

    const meta = raw.meta || {};
    const rawPage = meta.current_page ?? raw.page ?? fallbackPage;
    const page = Number.isFinite(rawPage) && rawPage >= 1
        ? Math.round(rawPage)
        : fallbackPage;

    return {
        results: rawItems
            .map(item => _mapItem(item))
            .filter(it => it.id !== null || it.previewUrl !== ''),
        page,
        totalPage: _computeTotalPage(raw, meta),
    };
}

/**
 * Thumbnail gallery + pagination on a Gtk.FlowBox.
 *
 * Frozen interface (see .omo/plans/app-conversion.md §3):
 *   new GalleryManager({flowbox?, client?, settings?, session?})
 *     .setProvider(id, instance)  .search(params)  .loadRecent()  .clear()
 *     .setVisible(on)             .connect('page-changed', cb)   .pagination
 *     .flowbox  .statusLabel  .paginationBar
 *
 * `flowbox` is normally provided by the window (the legacy module never owned
 * its grid — extension.js built it and the manager attached a layout to it).
 * If omitted, the manager creates one; append `gallery.flowbox` anywhere.
 * `client` is the legacy WallhavenClient used only when no provider instance
 * was set (the old wallhaven fallback path); modern callers rely on
 * setProvider(). `settings` provides page-size/set-background/api-key and
 * `session` is the shared Soup session for downloads. Both are optional, but
 * search fail gracefully without them.
 *
 * Emits `page-changed` (int page number) whenever the committed page moves.
 * `.pagination` returns the current {page, totalPage}.
 */
const GalleryManager = GObject.registerClass({
    Signals: {
        'page-changed': {param_types: [GObject.TYPE_INT]},
    },
}, class GalleryManager extends GObject.Object {
    _init(opts = {}) {
        super._init();

        this._flowbox = opts.flowbox ?? new Gtk.FlowBox({
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
        this._flowbox.selection_mode = Gtk.SelectionMode.NONE;
        this._flowbox.set_row_spacing(8);
        this._flowbox.set_column_spacing(8);

        this._client = opts.client ?? null;
        this._settings = opts.settings ?? null;
        this._session = opts.session ?? null;

        this._providerId = 'wallhaven';
        this._provider = null;
        this._page = 1;
        this._lastPage = 1;
        this._items = [];
        this._thumbs = [];
        this._currentParams = null;
        this._loading = false;
        this._statusShown = false;

        this._statusLabel = new Gtk.Label({
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            visible: false,
        });
        this._buildPagination();
        _ensureDir(_cacheDir('wallhaven'));
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
        this._pageLabel = new Gtk.Label({label: _('Page 1'), margin_start: 8, margin_end: 8});
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

    get providerId() { return this._providerId; }
    get flowbox() { return this._flowbox; }
    get statusLabel() { return this._statusLabel; }
    get pagination() { return {page: this._page, totalPage: this._lastPage}; }
    get paginationBar() { return this._paginationBar; }
    // Legacy alias kept for the old extension wiring that toggled this widget.
    get paginationWidget() { return this._paginationBar; }

    setProvider(id, instance) {
        this._providerId = id || 'wallhaven';
        this._provider = instance || null;
        this._providers = instance ? [{id, instance}] : [];
        _ensureDir(_cacheDir(this._providerId));
    }

    async setProviders(providerIds, settings, session) {
        this._providerIds = Array.isArray(providerIds) ? providerIds : [providerIds].filter(Boolean);
        this._provider = null;
        this._providers = [];
        for (let i = 0; i < this._providerIds.length; i++) {
            const id = this._providerIds[i];
            try {
                const p = await getProvider(id);
                this._providers.push({id, instance: p});
                _ensureDir(_cacheDir(id));
            } catch (e) {
                console.error(`[wp] provider '${id}' unavailable: ${e.message}`);
            }
        }
        if (this._providers.length === 0 && this._providerIds.length > 0) {
            // fallback to first
            try {
                const p = await getProvider(this._providerIds[0]);
                this._providers.push({id: this._providerIds[0], instance: p});
            } catch (_e) {}
        }
        this._providerId = this._providers[0]?.id || this._providerIds[0] || 'wallhaven';
    }


    async loadRecent() {
        if (this._providerId === 'wallhaven' && !this._provider) {
            const s = this._settings;
            await this.search({
                sorting: s?.get_string?.('sorting') || 'date_added',
                order: s?.get_string?.('order') || 'desc',
                purity: s?.get_string?.('purity') || '100',
                categories: s?.get_string?.('categories') || '111',
            });
        } else {
            await this.search({q: ''});
        }
    }

    async search(params) {
        if (this._loading) return;
        this._loading = true;
        this._page = params.page || 1;
        this._currentParams = {...params};
        this.clear();
        this._showStatus(_('Searching\u2026'));

        try {
            const result = await this._runSearch(params);
            const norm = normalizeResult(result, this._page);
            if (!norm.results.length) {
                this._showStatus(_('No results found.'));
                this._updatePag();
                return;
            }
            this._items = norm.results;
            this._lastPage = norm.totalPage;
            this._updatePage(norm.page);
            this._hideStatus();
            await this._loadThumbs(this._items);
            this._updatePag();
        } catch (e) {
            const m = e.message || String(e);
            this._showStatus(
                m.includes('401') || m.includes('403')
                    ? _('Authentication failed. Check your API key.')
                    : m.includes('429') ? _('Rate limited. Please wait and try again.')
                    : `${_('Error')}: ${m}`);
            console.error(`[wp] Search failed: ${m}`);
        } finally {
            this._loading = false;
        }
    }

    async _runSearch(params) {
        const providers = this._providers || [];
        if (providers.length === 0 && this._provider) {
            providers.push({id: this._providerId, instance: this._provider});
        }
        if (providers.length === 0 && this._client) {
            const k = this._settings?.get_string?.('api-key');
            if (k) this._client.setApiKey(k);
            return this._client.search({...params, page: this._page});
        }
        if (providers.length === 0)
            throw new Error('No provider configured');

        const searchParams = {
            q: params.q || '',
            page: this._page,
            perPage: this._settings?.get_int?.('page-size') || 24,
        };
        if (providers.length === 1) {
            return providers[0].instance.search(searchParams, this._session, this._settings);
        }
        const results = await Promise.allSettled(
            providers.map(p => p.instance.search(searchParams, this._session, this._settings))
        );
        const mergedItems = [];
        let total = 0;
        let page = this._page;
        let lastPage = 1;
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled' && r.value) {
                const v = r.value;
                if (Array.isArray(v.items)) {
                    for (let j = 0; j < v.items.length; j++) {
                        const it = v.items[j];
                        it.source = it.source || providers[i].id;
                        mergedItems.push(it);
                    }
                }
                total += (v.total || mergedItems.length) || 0;
                if (v.page && v.page > page) page = v.page;
                if (v.lastPage && v.lastPage > lastPage) lastPage = v.lastPage;
            }
        }
        return {items: mergedItems, total, page, lastPage};
    }

    async _loadThumbs(items) {
        this._thumbs = [];
        const boxes = [];
        for (const item of items) {
            const box = this._newThumbBox(item);
            const child = new Gtk.FlowBoxChild({child: box});
            this._flowbox.append(child);
            this._thumbs.push(child);
            boxes.push(box);
        }
        await Promise.allSettled(items.map((item, i) => this._mkThumb(item, i, boxes[i])));
    }

    _newThumbBox(item) {
        const picture = new Gtk.Picture({
            width_request: THUMB_SIZE,
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

    async _mkThumb(item, _index, box) {
        const url = item.previewUrl || item.thumbs?.small;
        if (!url) return;
        const path = GLib.build_filenamev([_cacheDir(this._providerId), `${item.id}.jpg`]);
        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                await downloadToFile(this._session, url, path);
            _setPictureFile(box.get_first_child(), path);
        } catch (e) {
            console.error(`[wp] Thumb failed for ${item.id}: ${e.message}`);
        }
    }

    async _onSelect(item) {
        if (this._loading) return;
        try {
            const u = item.fullUrl || item.path;
            if (!u) { this._showStatus(_('No download URL available.')); return; }
            const dir = resolveDownloadFolder(this._settings);
            const dest = GLib.build_filenamev([
                dir, `${this._providerId}-${item.id}.${extensionFor(u)}`,
            ]);
            if (!GLib.file_test(dest, GLib.FileTest.EXISTS)) {
                this._showStatus(_('Downloading full resolution\u2026'));
                await downloadToFile(this._session, u, dest);
            }
            if (this._settings?.get_boolean?.('set-background') !== false) {
                setDesktopWallpaper(Gio.File.new_for_path(dest).get_uri());
                this._showStatus(_('Wallpaper set:') + ` ${item.id}`);
            } else {
                this._showStatus(_('Downloaded:') + ` ${dest}`);
            }
        } catch (e) {
            const m = e.message || String(e);
            this._showStatus(
                m.includes('401') || m.includes('403')
                    ? _('Authentication failed downloading image.')
                    : m.includes('429') ? _('Rate limited. Please wait and try again.')
                    : `${_('Download error:')}: ${m}`);
            console.error(`[wp] Failed to set wallpaper for ${item.id}: ${m}`);
        }
    }

    /**
     * Commit a page number; emits `page-changed` only on a real change.
     * @returns {number} The committed page.
     */
    _updatePage(page) {
        const next = Number.isFinite(page) && page >= 1 ? Math.round(page) : this._page;
        if (next === this._page) return next;
        this._page = next;
        this._pageLabel.text = `${_('Page')} ${next} / ${this._lastPage}`;
        this.emit('page-changed', next);
        return next;
    }

    _updatePag() {
        const on = this._lastPage > 1;
        this._paginationBar.visible = on;
        this._pageLabel.text = `${_('Page')} ${this._page} / ${this._lastPage}`;
        this._firstBtn.sensitive = on && this._page > 1;
        this._prevBtn.sensitive = on && this._page > 1;
        this._nextBtn.sensitive = on && this._page < this._lastPage;
        this._lastBtn.sensitive = on && this._page < this._lastPage;
    }

    _goTo(page) {
        if (this._loading || !this._currentParams) return;
        const target = Math.min(Math.max(page, 1), this._lastPage);
        if (target === this._page) return;
        this._updatePage(target);
        this.search({...this._currentParams, page: target});
    }

    firstPage() { this._goTo(1); }
    lastPage() { this._goTo(this._lastPage); }
    nextPage() { this._goTo(this._page + 1); }
    prevPage() { this._goTo(this._page - 1); }

    setVisible(on) {
        this._flowbox.visible = on;
        this._paginationBar.visible = on && this._lastPage > 1;
        this._statusLabel.visible = on && this._statusShown;
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

    clear() {
        if (typeof this._flowbox.remove_all === 'function')
            this._flowbox.remove_all();
        else {
            let child = this._flowbox.get_first_child();
            while (child) {
                const next = child.get_next_sibling();
                this._flowbox.remove(child);
                child = next;
            }
        }
        this._thumbs = [];
        this._items = [];
        this._hideStatus();
    }
});

export {GalleryManager};