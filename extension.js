// SPDX-License-Identifier: GPL-3.0-or-later
// Wallpaper Providers GNOME Shell Extension — ESM (GNOME 45+)

import Soup from 'gi://Soup';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const PROVIDERS = [
    {id: 'wallhaven', label: 'Wallhaven'},
    {id: 'pexels', label: 'Pexels', module: './lib/providers/pexels.js'},
    {id: 'unsplash', label: 'Unsplash', module: './lib/providers/unsplash.js'},
    {id: 'safebooru', label: 'Safebooru', module: './lib/providers/safebooru.js'},
    {id: 'pixabay', label: 'Pixabay', module: './lib/providers/pixabay.js'},
    {id: 'waifuim', label: 'Waifu.im', module: './lib/providers/waifuim.js'},
    {id: 'local', label: 'Local Files', module: './lib/providers/local.js'},
    {id: 'wallrus', label: 'Wallrus', module: './lib/providers/wallrus.js'},
];

// Dynamic imports with stub fallbacks
let WallhavenClient, GalleryManager, FilterBar;

try {
    ({WallhavenClient} = await import('./lib/providers/wallhaven-client.js'));
} catch (_e) {
    WallhavenClient = class {
        constructor() {}
        async search() { return {data: [], meta: {}}; }
        async downloadToFile() { return ''; }
    };
}

try {
    ({GalleryManager} = await import('./ui/gallery.js'));
} catch (_e) {
    GalleryManager = class {
        constructor() {}
        async loadRecent() {}
        async search() {}
        clear() {}
    };
}

let VideoManager;

try {
    ({VideoManager} = await import('./lib/video/videoManager.js'));
} catch (_e) {
    VideoManager = class {
        constructor() {}
        enable() {}
        disable() {}
        destroy() {}
    };
}

let VideoPicker;

try {
    ({VideoPicker} = await import('./ui/videoPicker.js'));
} catch (_e) {
    VideoPicker = class {
        constructor() {}
        refresh() {}
        destroy() {}
    };
}

try {
    ({FilterBar} = await import('./ui/filters.js'));
} catch (_e) {
    FilterBar = GObject.registerClass(
        class FilterBarStub extends St.BoxLayout {
            _init() {
                super._init({style_class: 'wp-filter-bar', vertical: false});
                this.add_child(new St.Label({text: 'No filter module loaded',
                    y_align: Clutter.ActorAlign.CENTER}));
            }
            getParams() { return {}; }
        }
    );
}

async function _loadProvider(def) {
    if (def.id === 'wallhaven') return null;
    try {
        const mod = await import(def.module);
        const keys = Object.keys(mod);
        return keys.length > 0 ? new mod[keys[0]]() : null;
    } catch (_e) {
        return null;
    }
}

const WallpaperProvidersIndicator = GObject.registerClass(
class WallpaperProvidersIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Wallpaper Providers', false);
        this._ext = ext;

        this.add_child(new St.Icon({
            icon_name: 'image-x-generic-symbolic', style_class: 'system-status-icon'}));

        this._providerBtn = new St.Button({
            label: 'Wallhaven', style_class: 'wp-cycle-btn',
            can_focus: true, x_expand: false, x_align: Clutter.ActorAlign.START});
        this.menu.box.add_child(this._providerBtn);

        this._searchEntry = new St.Entry({
            style_class: 'wp-search', hint_text: 'Search wallpapers\u2026',
            can_focus: true, x_expand: true});
        this._searchEntry.get_clutter_text().connect('activate', () => {
            const p = this._filterBar ? this._filterBar.getParams() : {};
            p.q = this._searchEntry.get_text();
            this._gallery.search(p);
        });
        this.menu.box.add_child(this._searchEntry);

        this._filterBar = new FilterBar(this._ext.getSettings());
        this._filterBar.connect('changed', (fb) => this._gallery.search(fb.getParams()));
        this.menu.box.add_child(this._filterBar);

        this._scrollView = new St.ScrollView({
            style_class: 'wp-scrollview', x_expand: true, y_expand: true});
        this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

        this._gridWidget = new St.Widget({
            style_class: 'wp-grid', x_expand: true, y_expand: true});
        this._gridLayout = new Clutter.GridLayout({orientation: Clutter.Orientation.VERTICAL});
        this._gridWidget.set_layout_manager(this._gridLayout);
        this._scrollView.add_child(this._gridWidget);
        this.menu.box.add_child(this._scrollView);
    }

    setup(client, gallery) {
        this._client = client;
        this._gallery = gallery;
    }

    destroy() {
        this._gallery = null;
        this._client = null;
        super.destroy();
    }
});

export default class WallpaperProvidersExtension extends Extension {
    enable() {
        this._session = new Soup.Session();
        this._settings = this.getSettings();
        this._indicator = new WallpaperProvidersIndicator(this);

        this._client = new WallhavenClient({
            apiKey: this._settings.get_string('api-key'), session: this._session});

        this._gallery = new GalleryManager({
            grid: this._indicator._gridWidget, client: this._client,
            settings: this._settings, session: this._session});

        this._indicator.setup(this._client, this._gallery);
        if (this._gallery.paginationWidget)
            this._indicator.menu.box.add_child(this._gallery.paginationWidget);

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._video = new VideoManager(this, this._settings);
        if (this._video.controls) {
            this._indicator.menu.box.add_child(this._video.controls);
            this._video.controls.connect('browse-pressed', () => this._toggleVideoPicker());
        }
        this._video.enable();

        // Video mode hides the image gallery/search/filters in the menu.
        this._videoPicker = null;
        this._videoModeChangedId = this._settings.connect(
            'changed::video-mode', () => this._syncVideoModeUi()
        );
        this._syncVideoModeUi();

        this._providerInstances = {};
        let activeId = 'wallhaven';
        try { activeId = this._settings.get_string('active-provider') || 'wallhaven'; }
        catch (_e) { activeId = 'wallhaven'; }

        this._setupProviderBtn(activeId);
        this._gallery.loadRecent().catch(e => console.error(`[wp] initial load: ${e.message}`));
    }

    _setupProviderBtn(initialId) {
        const btn = this._indicator._providerBtn;
        let idx = Math.max(0, PROVIDERS.findIndex(p => p.id === initialId));
        const update = () => btn.set_label(PROVIDERS[idx].label);
        update();

        btn.connect('clicked', () => {
            idx = (idx + 1) % PROVIDERS.length;
            update();
            this._switchProvider(PROVIDERS[idx].id);
        });

        if (initialId !== 'wallhaven') this._switchProvider(initialId);
    }

    _toggleVideoPicker() {
        if (!this._videoPicker) {
            this._videoPicker = new VideoPicker(this._settings, this);
            this._videoPicker.visible = false;
            this._indicator.menu.box.add_child(this._videoPicker);
            this._videoPicker.connect('video-selected', (_w, path) => {
                this._settings.set_string('video-path', path);
                this._videoPicker.visible = false;
            });
        }
        if (this._videoPicker.visible) {
            this._videoPicker.visible = false;
        } else {
            this._videoPicker.refresh();
            this._videoPicker.visible = true;
        }
    }

    _syncVideoModeUi() {
        const on = this._settings.get_boolean('video-mode');
        const ind = this._indicator;
        ind._searchEntry.visible = !on;
        ind._filterBar.visible = !on;
        ind._scrollView.visible = !on;
        if (this._gallery?.paginationWidget)
            this._gallery.paginationWidget.visible = !on;
        if (this._videoPicker)
            this._videoPicker.visible = false;
    }

    async _switchProvider(id) {
        try { this._settings.set_string('active-provider', id); } catch (_e) {}

        const def = PROVIDERS.find(p => p.id === id);
        if (!def) return;

        let inst = this._providerInstances[id];
        if (!inst && def.module) {
            inst = await _loadProvider(def);
            if (inst) this._providerInstances[id] = inst;
        }

        if (id === 'wallhaven') {
            this._gallery.setProvider('wallhaven', null);
        } else if (inst) {
            this._gallery.setProvider(id, inst);
        } else {
            console.warn(`[wp] Provider '${id}' unavailable, falling back to wallhaven`);
            this._gallery.setProvider('wallhaven', null);
        }

        try { if (this._indicator._filterBar?.setProvider) this._indicator._filterBar.setProvider(id); }
        catch (_e) {}

        this._gallery.search({q: ''});
    }

    disable() {
        if (this._videoModeChangedId) {
            this._settings.disconnect(this._videoModeChangedId);
            this._videoModeChangedId = 0;
        }
        if (this._videoPicker) {
            this._videoPicker.destroy();
            this._videoPicker = null;
        }
        if (this._video) { this._video.destroy(); this._video = null; }
        if (this._session) { this._session.abort(); this._session = null; }
        if (this._gallery) { this._gallery.clear(); this._gallery = null; }
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
        this._client = null;
        this._settings = null;
        this._providerInstances = null;
    }
}
