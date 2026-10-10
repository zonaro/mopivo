import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

const SORT_OPTIONS = ['date_added', 'relevance', 'random', 'views', 'favorites', 'toplist'];
const ORDER_OPTIONS = ['desc', 'asc'];
const TOP_RANGE_OPTIONS = ['1d', '3d', '1w', '1M', '3M', '6M', '1y'];

function _randomSeed() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let seed = '';
    for (let i = 0; i < 6; i++)
        seed += chars[Math.floor(Math.random() * chars.length)];
    return seed;
}

function _makeToggle(label, active) {
    const btn = new St.ToggleButton({
        label,
        style_class: 'wp-toggle',
        toggle_mode: true,
        can_focus: true,
        x_expand: false,
        x_align: Clutter.ActorAlign.START,
    });
    btn._active = active;
    if (active) {
        btn.add_style_pseudo_class('active');
    }
    btn.connect('clicked', () => {
        btn._active = !btn._active;
        if (btn._active)
            btn.add_style_pseudo_class('active');
        else
            btn.remove_style_pseudo_class('active');
    });
    return btn;
}

function _makeCycleButton(options, initial) {
    const idx = Math.max(0, options.indexOf(initial));
    let current = idx >= 0 ? idx : 0;

    const btn = new St.Button({
        label: options[current],
        style_class: 'wp-cycle-btn',
        can_focus: true,
        x_expand: false,
        x_align: Clutter.ActorAlign.START,
    });
    btn._currentValue = () => options[current];
    btn.connect('clicked', () => {
        current = (current + 1) % options.length;
        btn.set_label(options[current]);
    });
    btn._setValue = (val) => {
        const i = options.indexOf(val);
        if (i >= 0) {
            current = i;
            btn.set_label(options[current]);
        }
    };
    return btn;
}

function _makeEntry(hint, text) {
    const entry = new St.Entry({
        hint_text: hint,
        style_class: 'wp-entry',
        can_focus: true,
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
    });
    if (text)
        entry.set_text(text);
    return entry;
}

function _makeLabel(text) {
    return new St.Label({
        text,
        style_class: 'wp-filter-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function _makeRow(labelText, widget) {
    const row = new St.BoxLayout({
        style_class: 'wp-filter-row',
        vertical: false,
        x_expand: true,
    });
    row.add_child(_makeLabel(labelText));
    row.add_child(widget);
    return row;
}

function _makeToggleRow(labelText, toggles) {
    const row = new St.BoxLayout({
        style_class: 'wp-filter-row',
        vertical: false,
        x_expand: true,
    });
    row.add_child(_makeLabel(labelText));
    for (const t of toggles)
        row.add_child(t);
    return row;
}

export const FilterBar = GObject.registerClass({
    Signals: {'changed': {}},
}, class FilterBar extends St.BoxLayout {
    _init(settings) {
        super._init({
            vertical: true,
            style_class: 'wp-filter-bar',
            x_expand: true,
            y_expand: false,
        });

        this._settings = settings;

        // --- Search entry ---
        this._searchEntry = _makeEntry('Search wallpapers...', settings.get_string('search-query'));
        this._searchEntry.get_clutter_text().connect('activate', () => this._emitChanged());
        this.add_child(_makeRow('Query', this._searchEntry));

        // --- Categories: General / Anime / People (bits 111 default) ---
        const catDefault = settings.get_string('categories') || '111';
        this._catGeneral = _makeToggle('General', catDefault[0] === '1');
        this._catAnime = _makeToggle('Anime', catDefault[1] === '1');
        this._catPeople = _makeToggle('People', catDefault[2] === '1');
        this.add_child(_makeToggleRow('Categories', [
            this._catGeneral, this._catAnime, this._catPeople,
        ]));

        // --- Purity: SFW / Sketchy / NSFW (bits 100 default) ---
        const purDefault = settings.get_string('purity') || '100';
        this._purSFW = _makeToggle('SFW', purDefault[0] === '1');
        this._purSketchy = _makeToggle('Sketchy', purDefault[1] === '1');
        this._purNSFW = _makeToggle('NSFW', purDefault[2] === '1');

        // NSFW disabled if no API key
        this._apiKey = settings.get_string('api-key');
        this._updateNSFW();
        this._settings.connectObject('changed::api-key', () => {
            this._apiKey = this._settings.get_string('api-key');
            this._updateNSFW();
        }, this);

        this.add_child(_makeToggleRow('Purity', [
            this._purSFW, this._purSketchy, this._purNSFW,
        ]));

        // --- Sorting ---
        this._sortBtn = _makeCycleButton(SORT_OPTIONS, settings.get_string('sorting') || 'date_added');
        this.add_child(_makeRow('Sorting', this._sortBtn));

        // --- Order ---
        this._orderBtn = _makeCycleButton(ORDER_OPTIONS, settings.get_string('order') || 'desc');
        this.add_child(_makeRow('Order', this._orderBtn));

        // --- Top Range (only useful when sorting=toplist) ---
        this._topRangeBtn = _makeCycleButton(TOP_RANGE_OPTIONS, settings.get_string('top-range') || '1M');
        this._topRangeLabel = _makeLabel('Top Range');
        this._topRangeRow = _makeRow('Top Range', this._topRangeBtn);
        this.add_child(this._topRangeRow);
        this._updateTopRangeSensitive();

        // Connect sorting change to toggle topRange sensitivity
        this._sortBtn.connect('clicked', () => {
            this._updateTopRangeSensitive();
        });

        // --- Resolution filters ---
        this._atleastEntry = _makeEntry('Min resolution (e.g. 1920x1080)', settings.get_string('atleast'));
        this.add_child(_makeRow('At Least', this._atleastEntry));

        this._resolutionsEntry = _makeEntry('Exact resolutions (e.g. 1920x1080)', settings.get_string('resolutions'));
        this.add_child(_makeRow('Resolutions', this._resolutionsEntry));

        this._ratiosEntry = _makeEntry('Aspect ratios (e.g. 16x9)', settings.get_string('ratios'));
        this.add_child(_makeRow('Ratios', this._ratiosEntry));

        this._colorsEntry = _makeEntry('Colors (hex, e.g. ff0000)', settings.get_string('colors'));
        this.add_child(_makeRow('Colors', this._colorsEntry));

        // --- AI art filter ---
        this._aiArtFilter = _makeToggle('Exclude AI Art', settings.get_boolean('ai-art-filter'));
        this.add_child(_makeRow('AI Filter', this._aiArtFilter));

        // --- Action buttons ---
        const btnRow = new St.BoxLayout({
            style_class: 'wp-filter-row',
            vertical: false,
            x_expand: true,
        });

        const searchBtn = new St.Button({
            label: 'Search',
            style_class: 'wp-action-btn',
            can_focus: true,
        });
        searchBtn.connect('clicked', () => this._emitChanged());

        const randomBtn = new St.Button({
            label: 'Random',
            style_class: 'wp-action-btn',
            can_focus: true,
        });
        randomBtn.connect('clicked', () => {
            this._searchEntry.set_text(_randomSeed());
            this._sortBtn._setValue('random');
            this._emitChanged();
        });

        btnRow.add_child(searchBtn);
        btnRow.add_child(randomBtn);
        this.add_child(btnRow);
    }

    _updateNSFW() {
        if (!this._apiKey) {
            this._purNSFW.set_sensitive(false);
            this._purNSFW.set_tooltip_text('API key required for NSFW content');
        } else {
            this._purNSFW.set_sensitive(true);
            this._purNSFW.set_tooltip_text('');
        }
    }

    _updateTopRangeSensitive() {
        const isToplist = this._sortBtn._currentValue() === 'toplist';
        this._topRangeBtn.set_sensitive(isToplist);
        if (!isToplist)
            this._topRangeBtn.set_tooltip_text('Only available with toplist sorting');
        else
            this._topRangeBtn.set_tooltip_text('');
    }

    _emitChanged() {
        this.emit('changed');
    }

    getParams() {
        const cats = [
            this._catGeneral._active ? '1' : '0',
            this._catAnime._active ? '1' : '0',
            this._catPeople._active ? '1' : '0',
        ].join('');

        const pury = [
            this._purSFW._active ? '1' : '0',
            this._purSketchy._active ? '1' : '0',
            this._purNSFW._active ? '1' : '0',
        ].join('');

        const params = {
            q: this._searchEntry.get_text().trim(),
            categories: cats,
            purity: pury,
            sorting: this._sortBtn._currentValue(),
            order: this._orderBtn._currentValue(),
        };

        if (this._sortBtn._currentValue() === 'toplist')
            params.topRange = this._topRangeBtn._currentValue();

        const atleast = this._atleastEntry.get_text().trim();
        if (atleast)
            params.atleast = atleast;

        const resolutions = this._resolutionsEntry.get_text().trim();
        if (resolutions)
            params.resolutions = resolutions;

        const ratios = this._ratiosEntry.get_text().trim();
        if (ratios)
            params.ratios = ratios;

        const colors = this._colorsEntry.get_text().trim();
        if (colors)
            params.colors = colors;

        if (this._aiArtFilter._active)
            params.ai_art_filter = 1;

        return params;
    }
});
