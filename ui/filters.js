// SPDX-License-Identifier: GPL-3.0-or-later
//
// GTK4 filter bar for the Mopivo app (popover content).
//
// Ported from the old GNOME Shell extension (St/Clutter) into standalone GTK4
// widgets so the app window can drop them into a Gtk.Popover attached to a
// Gtk.MenuButton. Public surface consumed by the app window (phase P4):
//
//   const bar = new FilterBar(settings);
//   bar.widget                            -> Gtk.Box to place inside the popover
//                                            (the popover itself is owned by P4)
//   bar.getParams()                       -> params object for registry.search()
//   bar.connect('changed', cb)            -> fired on every filter change
//   bar.setProvider(id)                   -> swap to the provider's filter rows
//   bar.hasFilters                        -> whether the provider has any rows
//   bar.query                             -> search query getter/setter. The
//                                            window owns the search entry, so it
//                                            either sets `bar.query` before
//                                            `getParams()` or overrides the
//                                            returned `params.q` itself.
//
// Widgets used:
//   * Categories / Purity -> three independent Gtk.ToggleButton each. They are
//     intentionally NOT grouped (multi-select); the bit-string order must match
//     the old bar: general/anime/people and sfw/sketchy/nsfw.
//   * Sorting / Order / Top range -> Gtk.DropDown over the exact option lists
//     the old cycle buttons used.
//   * atleast / resolutions / ratios -> Gtk.Entry.
//   * colors -> Gtk.DropDown over WALLHAVEN_COLORS ("Any color" = omit param).
//   * ai-art-filter -> Gtk.ToggleButton (boolean semantics).
//
// Settings are read once at construction to initialise widget state and are
// never written back by this bar, exactly like the old extension (which built
// params from widget state at getParams() time). The params mapping lives in the
// pure helper `filtersToParams(state)` so it is unit-testable without widgets.

import Gtk from 'gi://Gtk?version=4.0';
import GObject from 'gi://GObject';

import {_} from '../lib/i18n.js';
import {WALLHAVEN_COLORS} from '../lib/providers/wallhaven-client.js';

// Option lists mirror the old St cycle buttons — order matters, it is part of
// the params contract consumed by the registry search client.
const SORT_OPTIONS = ['date_added', 'relevance', 'random', 'views', 'favorites', 'toplist'];
const ORDER_OPTIONS = ['desc', 'asc'];
const TOP_RANGE_OPTIONS = ['1d', '3d', '1w', '1M', '3M', '6M', '1y'];

// Wallhaven's full filter set, in popover order. Every non-Wallhaven provider
// in this app accepts only the query plus pagination (see the search()
// signatures in lib/providers/*.js), so their row list is intentionally empty:
// switching provider clears the Wallhaven-only controls instead of showing
// dropdowns nothing consumes.
export const WALLHAVEN_FILTER_ROWS = [
    'categories', 'purity', 'sorting', 'order',
    'topRange', 'atleast', 'resolutions', 'ratios', 'colors', 'aiFilter',
];

const PROVIDER_FILTER_ROWS = {
    wallhaven: WALLHAVEN_FILTER_ROWS,
    pexels: [],
    unsplash: [],
    safebooru: [],
    pixabay: [],
    waifuim: [],
    local: [],
};

/**
 * Row keys the filter popover shows for a provider. Unknown ids get none.
 * Pure mirror of FilterBar.setProvider() so it is unit-testable headless.
 *
 * @param {string} id
 * @returns {string[]}
 */
export function filterRowsForProvider(id) {
    return (PROVIDER_FILTER_ROWS[id] || []).slice();
}

/**
 * Convert a plain filter state into the params dict consumed by
 * registry.search(). Same keys and formats as the old St filter bar.
 *
 * @param {Object}  state
 * @param {string}  [state.q='']              Search query (trimmed).
 * @param {string}  [state.provider='wallhaven'] Provider id. Only Wallhaven
 *                                            contributes the keys below; other
 *                                            providers emit `{q}` alone.
 * @param {Object}  state.categories          Bit toggles: {general, anime, people}.
 * @param {Object}  state.purity              Bit toggles: {sfw, sketchy, nsfw}.
 * @param {string}  state.sorting             One of SORT_OPTIONS.
 * @param {string}  state.order               One of ORDER_OPTIONS.
 * @param {string}  state.topRange            One of TOP_RANGE_OPTIONS. Only sent
 *                                            when sorting is 'toplist'.
 * @param {string}  [state.atleast='']        Minimum resolution (trimmed).
 * @param {string}  [state.resolutions='']    Exact resolutions (trimmed).
 * @param {string}  [state.ratios='']         Aspect ratios (trimmed).
 * @param {string}  [state.colors='']         Hex colors (trimmed).
 * @param {boolean} [state.aiArtFilter=false] Exclude AI-generated art.
 * @returns {Object} Flat params object for registry.search().
 */
export function filtersToParams(state = {}) {
    const provider = state.provider || 'wallhaven';
    const q = (state.q ?? '').trim();

    if (provider !== 'wallhaven')
        return {q};

    const cat = state.categories || {};
    const pur = state.purity || {};

    const params = {
        q,
        categories: [
            cat.general ? '1' : '0',
            cat.anime ? '1' : '0',
            cat.people ? '1' : '0',
        ].join(''),
        purity: [
            pur.sfw ? '1' : '0',
            pur.sketchy ? '1' : '0',
            pur.nsfw ? '1' : '0',
        ].join(''),
        sorting: state.sorting,
        order: state.order,
    };

    // Top range is only sent for toplist sorting (old behaviour).
    if (state.sorting === 'toplist')
        params.topRange = state.topRange;

    // Text filters are trimmed and omitted entirely when empty (old behaviour).
    for (const key of ['atleast', 'resolutions', 'ratios', 'colors']) {
        const value = (state[key] ?? '').trim();
        if (value)
            params[key] = value;
    }

    // Old bar sent ai_art_filter=1 when active and omitted the key otherwise.
    if (state.aiArtFilter)
        params.ai_art_filter = 1;

    return params;
}

// ---------------------------------------------------------------------------
// Widget builders
// ---------------------------------------------------------------------------

function makeLabel(text) {
    return new Gtk.Label({label: _(text), xalign: 0, hexpand: true, valign: Gtk.Align.CENTER});
}

function makeRow(labelText, controls) {
    const row = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
    row.append(makeLabel(labelText));
    for (const control of controls)
        row.append(control);
    return row;
}

function makeToggle(label, active) {
    return new Gtk.ToggleButton({
        label: _(label),
        active,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.START,
    });
}

function makeDropDown(options, value) {
    const index = Math.max(0, options.indexOf(value));
    return new Gtk.DropDown({
        model: Gtk.StringList.new(options),
        selected: index,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.START,
    });
}

function makeEntry(hint, text) {
    return new Gtk.Entry({
        placeholder_text: _(hint),
        text,
        hexpand: true,
        valign: Gtk.Align.CENTER,
    });
}

// "Any color" (index 0) means no `colors` param; the remaining entries are the
// bare hex values the Wallhaven API accepts.
function makeColorDropDown(value) {
    const options = [_('Any color'), ...WALLHAVEN_COLORS];
    const index = value ? Math.max(0, WALLHAVEN_COLORS.indexOf(value) + 1) : 0;
    return new Gtk.DropDown({
        model: Gtk.StringList.new(options),
        selected: index,
        valign: Gtk.Align.CENTER,
        halign: Gtk.Align.START,
    });
}

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

export const FilterBar = GObject.registerClass({
    GTypeName: 'MopivoFilterBar',
    Signals: {'changed': {}},
}, class FilterBar extends GObject.Object {
    constructor(settings) {
        super();
        this._settings = settings;

        // The app window owns the search entry; this bar only mirrors the value.
        this._query = settings.get_string('search-query');

        // --- Categories: General / Anime / People (bit order = old bar) ---
        const catBits = settings.get_string('categories') || '111';
        this._catGeneral = makeToggle('General', catBits[0] === '1');
        this._catAnime = makeToggle('Anime', catBits[1] === '1');
        this._catPeople = makeToggle('People', catBits[2] === '1');

        // --- Purity: SFW / Sketchy / NSFW. NSFW needs an API key. ---
        const purBits = settings.get_string('purity') || '100';
        this._purSFW = makeToggle('SFW', purBits[0] === '1');
        this._purSketchy = makeToggle('Sketchy', purBits[1] === '1');
        this._purNSFW = makeToggle('NSFW', purBits[2] === '1');

        // --- Sorting / Order / Top range ---
        this._sortDrop = makeDropDown(SORT_OPTIONS, settings.get_string('sorting') || 'date_added');
        this._orderDrop = makeDropDown(ORDER_OPTIONS, settings.get_string('order') || 'desc');
        this._topRangeDrop = makeDropDown(
            TOP_RANGE_OPTIONS, settings.get_string('top-range') || '1M');

        // --- Resolution / ratio entries + color palette ---
        this._atleastEntry = makeEntry('Min resolution (e.g. 1920x1080)',
            settings.get_string('atleast'));
        this._resolutionsEntry = makeEntry('Exact resolutions (e.g. 1920x1080)',
            settings.get_string('resolutions'));
        this._ratiosEntry = makeEntry('Aspect ratios (e.g. 16x9)',
            settings.get_string('ratios'));
        this._colorsDrop = makeColorDropDown(settings.get_string('colors'));

        // --- AI art filter ---
        this._aiToggle = makeToggle('Exclude AI Art', settings.get_boolean('ai-art-filter'));

        // --- Layout: rows are keyed so setProvider() can show only the ones the
        // active provider supports. The app window wraps `.widget` in a
        // Gtk.ScrolledWindow, so the popover can grow. ---
        this._rowWidgets = {
            categories: makeRow('Categories', [this._catGeneral, this._catAnime, this._catPeople]),
            purity: makeRow('Purity', [this._purSFW, this._purSketchy, this._purNSFW]),
            sorting: makeRow('Sorting', [this._sortDrop]),
            order: makeRow('Order', [this._orderDrop]),
            topRange: makeRow('Top Range', [this._topRangeDrop]),
            atleast: makeRow('At Least', [this._atleastEntry]),
            resolutions: makeRow('Resolutions', [this._resolutionsEntry]),
            ratios: makeRow('Ratios', [this._ratiosEntry]),
            colors: makeRow('Colors', [this._colorsDrop]),
            aiFilter: makeRow('AI Filter', [this._aiToggle]),
        };
        this._emptyLabel = makeLabel('No filters for this provider');

        this._root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        this._provider = 'wallhaven';
        this._applyProvider(this._provider);

        // --- Signal wiring. Connected after initial state is set so building
        // the bar does not fire 'changed'. ---
        const onChange = () => this.emit('changed');
        for (const toggle of [this._catGeneral, this._catAnime, this._catPeople,
            this._purSFW, this._purSketchy, this._purNSFW, this._aiToggle]) {
            toggle.connect('toggled', onChange);
        }
        this._sortDrop.connect('notify::selected', () => {
            this._updateTopRange();
            onChange();
        });
        this._orderDrop.connect('notify::selected', onChange);
        this._topRangeDrop.connect('notify::selected', onChange);
        for (const entry of [this._atleastEntry, this._resolutionsEntry,
            this._ratiosEntry]) {
            entry.connect('changed', onChange);
        }
        this._colorsDrop.connect('notify::selected', onChange);

        // NSFW stays locked until a Wallhaven API key is configured. The
        // settings object is app-owned and outlives this bar, so a plain
        // connection is enough (GJS 1.88 has no GObject.connectObject).
        this._settings.connect('changed::api-key', () => this._updateNSFW());
        this._updateNSFW();
        this._updateTopRange();
    }

    /**
     * Root widget for the app window to place into a Gtk.Popover.
     *
     * @returns {Gtk.Box}
     */
    get widget() {
        return this._root;
    }

    /**
     * Search query used by getParams(). The window owns the search entry and
     * may set this before calling getParams(), or override params.q itself.
     *
     * @param {string} value
     */
    get query() {
        return this._query;
    }

    set query(value) {
        this._query = String(value ?? '');
    }

    /**
     * Whether the active provider exposes any filter rows.
     *
     * @returns {boolean}
     */
    get hasFilters() {
        return filterRowsForProvider(this._provider).length > 0;
    }

    /**
     * Switch the filter set to a provider and rebuild the popover content with
     * the rows it supports. Never emits 'changed': the app window drives the
     * follow-up search for a provider switch itself.
     *
     * @param {string} id  Provider id (e.g. 'wallhaven', 'safebooru').
     */
    setProvider(id) {
        this._provider = id || 'wallhaven';
        this._applyProvider(this._provider);
    }

    _applyProvider(id) {
        let child = this._root.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._root.remove(child);
            child = next;
        }

        const rows = filterRowsForProvider(id);
        if (!rows.length) {
            this._root.append(this._emptyLabel);
            return;
        }
        for (const key of rows) {
            const row = this._rowWidgets[key];
            if (row)
                this._root.append(row);
        }
    }

    _colorValue() {
        const index = this._colorsDrop.selected;
        return index > 0 ? (WALLHAVEN_COLORS[index - 1] || '') : '';
    }

    _updateNSFW() {
        const hasKey = Boolean(this._settings.get_string('api-key'));
        this._purNSFW.sensitive = hasKey;
        this._purNSFW.tooltip_text = hasKey ? '' : _('API key required for NSFW content');
    }

    _updateTopRange() {
        const enabled = this._sortDrop.selected === SORT_OPTIONS.indexOf('toplist');
        this._topRangeDrop.sensitive = enabled;
        this._topRangeDrop.tooltip_text = enabled ? '' : _('Only available with toplist sorting');
    }

    /**
     * Build the params dict for registry.search() from current widget state.
     *
     * @returns {Object}
     */
    getParams() {
        return filtersToParams({
            q: this._query,
            provider: this._provider,
            categories: {
                general: this._catGeneral.active,
                anime: this._catAnime.active,
                people: this._catPeople.active,
            },
            purity: {
                sfw: this._purSFW.active,
                sketchy: this._purSketchy.active,
                nsfw: this._purNSFW.active,
            },
            sorting: SORT_OPTIONS[this._sortDrop.selected],
            order: ORDER_OPTIONS[this._orderDrop.selected],
            topRange: TOP_RANGE_OPTIONS[this._topRangeDrop.selected],
            atleast: this._atleastEntry.text,
            resolutions: this._resolutionsEntry.text,
            ratios: this._ratiosEntry.text,
            colors: this._colorValue(),
            aiArtFilter: this._aiToggle.active,
        });
    }
});