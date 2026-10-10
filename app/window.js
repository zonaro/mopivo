// SPDX-License-Identifier: GPL-3.0-or-later
// app/window.js — main application window for the Mopivo app.
//
// The window is the app shell that wires together the GTK4 modules built in
// earlier phases. It owns a single Soup.Session, the provider instances (via
// the registry), the GalleryManager, the FilterBar and the VideoController, and
// swaps between the image stack and the video stack on the `video-mode` key.
//
// Contract with main.js: `buildWindow(app, settings)` returns the
// Adw.ApplicationWindow (already attached to `app`). main.js imports this
// module lazily from `activate()`.
//
// Behaviour ported from the old extension.js:
//   * provider switching  -> Gtk.DropDown over PROVIDER_IDS (+ active-provider)
//   * search trigger      -> search entry query + FilterBar.getParams()
//   * pagination          -> GalleryManager pagination bar + page-changed
//   * video-mode toggle   -> swap stacks, controller.start()/stop(), setVisible
//   * preferences button  -> buildPreferencesWindow(settings)
//
// No St/Clutter/Meta/Main/resource:// and no GStreamer: video playback lives in
// the renderer subprocess owned by VideoController (plan risk R14).

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

import {_} from '../lib/i18n.js';
import {GalleryManager} from '../ui/gallery.js';
import {FilterBar} from '../ui/filters.js';
import {VideoControls} from '../ui/videoControls.js';
import {VideoController} from './videoController.js';
import {PROVIDER_IDS, PROVIDER_META, getProvider} from '../lib/providers/registry.js';

/**
 * Build the main window. This is the single entry point consumed by main.js.
 *
 * @param {Adw.Application} app      the running application (owner of the window)
 * @param {Gio.Settings}    settings GSettings for the app schema
 * @returns {Adw.ApplicationWindow}
 */
export function buildWindow(app, settings) {
    return new WallpaperWindow({application: app, settings});
}

const WallpaperWindow = GObject.registerClass({
    GTypeName: 'WpWindow',
}, class WallpaperWindow extends Adw.ApplicationWindow {
    _init({application, settings}) {
        super._init({application, title: _('Mopivo')});

        this._settings = settings;
        // One shared HTTP session for thumbnails and full-resolution downloads.
        this._session = new Soup.Session();

        this._syncingVideo = false;
        this._syncingProvider = false;
        this._settingsVideoModeId = 0;

        // The video controller owns the renderer subprocess; the controls pane
        // drives it. Constructing either does not spawn anything.
        this._controller = new VideoController({settings});
        // The manager creates its own FlowBox; we read it back via the public
        // `flowbox` getter and wrap it in a scrolled window.
        this._manager = new GalleryManager({settings, session: this._session});
        this._filterBar = new FilterBar(settings);

        this._buildLayout();
        this._wireSignals();

        this.set_default_size(980, 720);
        this._applyVideoMode(settings.get_boolean('video-mode'));
        this._bootstrap().catch(e =>
            this._showStatus(`${_('Error')}: ${e.message}`));
    }

    // ── Layout ─────────────────────────────────────────────────────────

    _buildLayout() {
        const header = new Adw.HeaderBar();
        this._title = new Adw.WindowTitle({title: _('Mopivo')});
        header.set_title_widget(this._title);

        // Preferences button.
        this._prefsBtn = new Gtk.Button({
            icon_name: 'emblem-system-symbolic',
            tooltip_text: _('Preferences'),
            valign: Gtk.Align.CENTER,
        });
        header.pack_end(this._prefsBtn);

        // Filters: the popover is created exactly once (plan risk R6) and holds
        // the FilterBar's widget. The button keeps it alive, so locals suffice.
        const filterButton = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            tooltip_text: _('Filters'),
            valign: Gtk.Align.CENTER,
        });
        const filterPopover = new Gtk.Popover();
        const filterScroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            propagate_natural_height: true,
            max_content_height: 480,
        });
        filterScroll.set_child(this._filterBar.widget);
        filterPopover.set_child(filterScroll);
        filterButton.set_popover(filterPopover);
        header.pack_end(filterButton);

        // Video-mode switch.
        this._videoSwitch = new Gtk.Switch({
            active: this._settings.get_boolean('video-mode'),
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Video mode'),
        });
        const videoBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        videoBox.append(new Gtk.Image({icon_name: 'video-display-symbolic'}));
        videoBox.append(this._videoSwitch);
        header.pack_end(videoBox);

        this._stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            hexpand: true,
            vexpand: true,
        });
        this._stack.add_named(this._buildImagePage(), 'images');
        this._stack.add_named(this._buildVideoPage(), 'video');

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.set_content(this._stack);
        this.set_content(toolbar);
    }

    _buildImagePage() {
        const page = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        const searchRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });
        this._searchEntry = new Gtk.SearchEntry({
            hexpand: true,
            placeholder_text: _('Search wallpapers\u2026'),
        });
        this._searchEntry.set_text(this._settings.get_string('search-query'));
        this._providerDrop = new Gtk.DropDown({
            model: Gtk.StringList.new(
                PROVIDER_IDS.map(id => PROVIDER_META[id].displayName)),
            tooltip_text: _('Provider'),
            valign: Gtk.Align.CENTER,
        });
        this._selectProvider(this._settings.get_string('active-provider'));
        searchRow.append(this._searchEntry);
        searchRow.append(this._providerDrop);
        page.append(searchRow);

        const scrolled = new Gtk.ScrolledWindow({hexpand: true, vexpand: true});
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        scrolled.set_child(this._manager.flowbox);
        page.append(scrolled);

        // The manager toggles these via setVisible(); we just pack them.
        page.append(this._manager.statusLabel);
        page.append(this._manager.paginationBar);
        return page;
    }

    _buildVideoPage() {
        this._videoControls = new VideoControls({
            controller: this._controller,
            settings: this._settings,
        });
        return this._videoControls.widget;
    }

    // ── Signal wiring ───────────────────────────────────────────────────

    _wireSignals() {
        this._prefsBtn.connect('clicked', () => this._openPreferences());

        this._searchEntry.connect('activate', () => {
            this._submitSearch().catch(e =>
                console.error(`[wp] search failed: ${e.message}`));
        });

        this._providerDrop.connect('notify::selected', () => {
            if (this._syncingProvider)
                return;
            const id = PROVIDER_IDS[this._providerDrop.get_selected()];
            if (id)
                this._switchProvider(id).catch(e =>
                    console.error(`[wp] provider switch: ${e.message}`));
        });

        this._filterBar.connect('changed', () => {
            this._rerunSearch().catch(e =>
                console.error(`[wp] filter search failed: ${e.message}`));
        });

        this._videoSwitch.connect('notify::active', () => {
            if (this._syncingVideo)
                return;
            const on = this._videoSwitch.get_active();
            this._settings.set_boolean('video-mode', on);
            this._applyVideoMode(on);
        });
        this._settingsVideoModeId = this._settings.connect('changed::video-mode', () => {
            const on = this._settings.get_boolean('video-mode');
            if (this._videoSwitch.get_active() === on)
                return;
            this._syncingVideo = true;
            this._videoSwitch.set_active(on);
            this._syncingVideo = false;
            this._applyVideoMode(on);
        });

        this._manager.connect('page-changed', (_mgr, page) => {
            const total = this._manager.pagination.totalPage;
            this._title.set_subtitle(`${_('Page')} ${page} / ${total}`);
        });

        this.connect('close-request', () => {
            if (this._settingsVideoModeId) {
                this._settings.disconnect(this._settingsVideoModeId);
                this._settingsVideoModeId = 0;
            }
            try { this._controller.stop(); } catch (_e) { /* not started */ }
            try { this._session.abort(); } catch (_e) { /* already aborted */ }
            this._videoControls.destroy?.();
            return false;
        });
    }

    // ── Provider / search / pagination ──────────────────────────────────

    async _bootstrap() {
        let activeId = 'wallhaven';
        try {
            activeId = this._settings.get_string('active-provider') || 'wallhaven';
        } catch (_e) {
            activeId = 'wallhaven';
        }
        if (!PROVIDER_IDS.includes(activeId))
            activeId = 'wallhaven';

        this._selectProvider(activeId);
        await this._switchProvider(activeId, {initial: true});
    }

    /**
     * Resolve and activate a provider, persisting `active-provider`. On failure
     * the current provider is kept and the error is shown on the manager's
     * status label instead of a parallel error surface.
     *
     * @param {string}  id
     * @param {object}  [opts]
     * @param {boolean} [opts.initial] load the recent feed instead of an empty query
     */
    async _switchProvider(id, {initial = false} = {}) {
        let instance = null;
        try {
            instance = await getProvider(id);
        } catch (e) {
            console.error(`[wp] provider '${id}' unavailable: ${e.message}`);
            const label = PROVIDER_META[id]?.displayName || id;
            this._showStatus(`${_('Provider unavailable:')} ${label}`);
            this._selectProvider(this._manager.providerId);
            return;
        }

        this._settings.set_string('active-provider', id);
        this._manager.setProvider(id, instance);
        if (initial)
            await this._manager.loadRecent();
        else
            await this._manager.search({q: ''});
    }

    _selectProvider(id) {
        const index = PROVIDER_IDS.indexOf(id);
        if (index < 0)
            return;
        this._syncingProvider = true;
        this._providerDrop.set_selected(index);
        this._syncingProvider = false;
    }

    /** Search entry activated: search by query, or reload the feed when empty. */
    async _submitSearch() {
        const q = this._searchEntry.get_text();
        this._settings.set_string('search-query', q);
        this._filterBar.query = q;
        if (q.trim())
            await this._manager.search({...this._filterBar.getParams(), q});
        else
            await this._manager.loadRecent();
    }

    /** A filter changed: re-run with the current query and filter params. */
    async _rerunSearch() {
        const q = this._searchEntry.get_text();
        this._filterBar.query = q;
        await this._manager.search({...this._filterBar.getParams(), q});
    }

    // ── Video mode ──────────────────────────────────────────────────────

    _applyVideoMode(on) {
        this._stack.set_visible_child_name(on ? 'video' : 'images');
        this._manager.setVisible(!on);
        if (on)
            this._controller.start().catch(e =>
                console.error(`[wp] video start failed: ${e.message}`));
        else
            this._controller.stop();
    }

    // ── Preferences ─────────────────────────────────────────────────────

    async _openPreferences() {
        try {
            const {buildPreferencesWindow} = await import('../prefs.js');
            const win = buildPreferencesWindow(this._settings);
            win.set_transient_for(this);
            win.present();
        } catch (e) {
            console.error(`[wp] preferences failed: ${e.message}`);
        }
    }

    _showStatus(text) {
        const label = this._manager.statusLabel;
        label.set_text(text);
        label.set_visible(true);
    }
});
