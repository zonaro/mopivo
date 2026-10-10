import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {downloadToFile} from '../lib/download.js';

const CACHE_BASE = GLib.get_home_dir() + '/.cache/wallpaper-providers-gnome';
const GRID_COLS = 3;
const THUMB_SIZE = 200;
const BG_SCHEMA = 'org.gnome.desktop.background';

function _ensureDir(p) {
    const d = Gio.File.new_for_path(p);
    if (!d.query_exists(null)) d.make_directory_with_parents(null);
}
function _cacheDir(pid) {
    return GLib.build_filenamev([CACHE_BASE, pid || 'wallhaven']);
}

export class GalleryManager {
    constructor({grid, client, settings, session}) {
        this._grid = grid;
        this._client = client;
        this._settings = settings;
        this._session = session;
        this._providerId = 'wallhaven';
        this._provider = null;
        this._page = 1;
        this._lastPage = 1;
        this._items = [];
        this._thumbs = [];
        this._currentParams = null;
        this._loading = false;
        this._errorLabel = null;

        this._layout = new Clutter.GridLayout({column_spacing: 8, row_spacing: 8});
        this._grid.set_layout_manager(this._layout);

        this._paginationBox = new St.BoxLayout({
            style_class: 'wp-pagination', vertical: false,
            x_expand: true, x_align: Clutter.ActorAlign.CENTER,
        });
        this._prevBtn = new St.Button({label: '\u2190 Prev',
            style_class: 'wp-pagination-btn', can_focus: true, reactive: true});
        this._nextBtn = new St.Button({label: 'Next \u2192',
            style_class: 'wp-pagination-btn', can_focus: true, reactive: true});
        this._pageLabel = new St.Label({text: 'Page 1',
            style_class: 'wp-page-label', y_align: Clutter.ActorAlign.CENTER});
        this._prevBtn.connect('clicked', () => this.prevPage());
        this._nextBtn.connect('clicked', () => this.nextPage());
        this._paginationBox.add_child(this._prevBtn);
        this._paginationBox.add_child(this._pageLabel);
        this._paginationBox.add_child(this._nextBtn);
        this._paginationBox.hide();
        _ensureDir(_cacheDir('wallhaven'));
    }

    get paginationWidget() { return this._paginationBox; }

    setProvider(id, instance) {
        this._providerId = id || 'wallhaven';
        this._provider = instance || null;
        _ensureDir(_cacheDir(this._providerId));
    }

    get providerId() { return this._providerId; }

    async loadRecent() {
        if (this._providerId === 'wallhaven' && !this._provider) {
            await this.search({
                sorting: this._settings.get_string('sorting') || 'date_added',
                order: this._settings.get_string('order') || 'desc',
                purity: this._settings.get_string('purity') || '100',
                categories: this._settings.get_string('categories') || '111',
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
        this._showError('Loading...');

        try {
            let result;
            if (this._provider) {
                const perPage = this._settings.get_int('page-size') || 24;
                result = await this._provider.search(
                    {q: params.q || '', page: this._page, perPage},
                    this._session, this._settings);
            } else {
                const k = this._settings.get_string('api-key');
                if (k) this._client.setApiKey(k);
                result = await this._client.search({...params, page: this._page});
            }
            const norm = this._norm(result);
            if (!norm.items.length) { this._showError('No results found.'); this._loading = false; return; }
            this._items = norm.items;
            this._lastPage = norm.lastPage;
            this._page = norm.page;
            this._hideError();
            await this._loadThumbs(this._items);
            this._updatePag();
        } catch (e) {
            const m = e.message || String(e);
            this._showError(m.includes('401') || m.includes('403')
                ? 'Authentication failed. Check your API key.'
                : m.includes('429') ? 'Rate limited. Please wait and try again.'
                : `Error: ${m}`);
        } finally {
            this._loading = false;
        }
    }

    _norm(r) {
        if (!r) return {items: [], total: 0, page: 1, lastPage: 1};
        if (Array.isArray(r.items))
            return {items: r.items, total: r.total || 0, page: r.page || this._page, lastPage: r.lastPage || 1};
        if (Array.isArray(r.data))
            return {items: r.data, total: r.meta?.total || 0,
                page: r.meta?.current_page || this._page, lastPage: r.meta?.last_page || 1};
        return {items: [], total: 0, page: 1, lastPage: 1};
    }

    clear() {
        for (const c of [...this._grid.get_children()]) { this._grid.remove_child(c); c.destroy(); }
        this._errorLabel = null;
        this._thumbs = [];
        this._items = [];
    }

    _showError(text) {
        if (!this._errorLabel) {
            this._errorLabel = new St.Label({style_class: 'wp-error-label',
                x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER, x_margin_top: 40});
            this._grid.add_child(this._errorLabel);
            this._layout.set_column_span(this._errorLabel, GRID_COLS);
        }
        this._errorLabel.set_text(text);
        this._errorLabel.show();
    }

    _hideError() {
        if (!this._errorLabel) return;
        this._errorLabel.hide();
        this._grid.remove_child(this._errorLabel);
        this._errorLabel.destroy();
        this._errorLabel = null;
    }

    async _loadThumbs(items) {
        await Promise.allSettled(items.map((item, i) => this._mkThumb(item, i)));
    }

    async _mkThumb(item, index) {
        const url = item.previewUrl || item.thumbs?.small;
        if (!url) return;
        const path = GLib.build_filenamev([_cacheDir(this._providerId), `${item.id}.jpg`]);
        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                await downloadToFile(this._session, url, path);
            const gicon = Gio.FileIcon.new(Gio.File.new_for_path(path));
            const icon = new St.Icon({gicon, icon_size: THUMB_SIZE, style_class: 'wp-thumb-icon'});
            const btn = new St.Button({style_class: 'wp-thumb-button', child: icon,
                can_focus: true, reactive: true, x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER});
            if (item.resolution) {
                const lbl = new St.Label({text: item.resolution, style_class: 'wp-thumb-label',
                    x_align: Clutter.ActorAlign.CENTER});
                const box = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER});
                box.add_child(icon);
                box.add_child(lbl);
                btn.set_child(box);
            }
            btn.connect('clicked', () => this._onSelect(item));
            this._grid.add_child(btn);
            this._layout.attach(btn, index % GRID_COLS, Math.floor(index / GRID_COLS), 1, 1);
            this._thumbs.push(btn);
        } catch (e) {
            console.error(`[wp] Thumb failed for ${item.id}: ${e.message}`);
        }
    }

    async _onSelect(item) {
        if (this._loading) return;
        const full = GLib.build_filenamev([_cacheDir(this._providerId), `${item.id}.jpg`]);
        try {
            if (!GLib.file_test(full, GLib.FileTest.EXISTS)) {
                const u = item.fullUrl || item.path;
                if (!u) { this._showError('No download URL available.'); return; }
                this._showError('Downloading full resolution...');
                await downloadToFile(this._session, u, full);
                this._hideError();
            }
            const bg = new Gio.Settings({schema_id: BG_SCHEMA});
            const uri = Gio.File.new_for_path(full).get_uri();
            bg.reset('picture-uri'); bg.reset('picture-uri-dark');
            bg.set_string('picture-uri', uri); bg.set_string('picture-uri-dark', uri);
            bg.sync(); bg.apply();
            Main.notify('Wallpaper Providers', `Wallpaper set: ${item.id}`);
        } catch (e) {
            const m = e.message || String(e);
            this._showError(m.includes('401') || m.includes('403')
                ? 'Authentication failed downloading image.'
                : m.includes('429') ? 'Rate limited. Please wait and try again.'
                : `Download error: ${m}`);
            console.error(`[wp] Failed to set wallpaper for ${item.id}: ${m}`);
        }
    }

    _updatePag() {
        if (this._lastPage <= 1) { this._paginationBox.hide(); return; }
        this._paginationBox.show();
        this._prevBtn.reactive = this._page > 1;
        this._prevBtn.set_style(this._page > 1 ? 'wp-pagination-btn' : 'wp-pagination-btn-disabled');
        this._nextBtn.reactive = this._page < this._lastPage;
        this._nextBtn.set_style(this._page < this._lastPage ? 'wp-pagination-btn' : 'wp-pagination-btn-disabled');
        this._pageLabel.set_text(`Page ${this._page} / ${this._lastPage}`);
    }

    async nextPage() {
        if (this._page >= this._lastPage || this._loading) return;
        this._page++;
        await this.search({...this._currentParams, page: this._page});
    }

    async prevPage() {
        if (this._page <= 1 || this._loading) return;
        this._page--;
        await this.search({...this._currentParams, page: this._page});
    }
}
