// SPDX-License-Identifier: GPL-3.0-or-later
// app/generatorPage.js — wallpapers Generator page (GTK4) for the Mopivo app.
//
// The third stack page (alongside 'images' and 'video'). It is a thin GTK
// front-end over lib/generator/{presets,palettes,engine}.js: every control
// mutates an in-memory UI state and schedules a debounced preview render, and
// all rendering is delegated to the numpy/PIL subprocess (`renderer/generator.py`)
// — no shader math lives here.
//
// Contract with app/window.js:
//   const page = new GeneratorPage({settings});
//   stack.add_named(page.widget, 'generator');   // root is a Gtk.ScrolledWindow
//   page.destroy();                              // on window close
//
// All user-visible strings go through _() (lib/i18n.js).

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {_} from '../lib/i18n.js';
import {setDesktopWallpaper} from '../lib/wallpaper.js';
import {
    PRESET_NAMES,
    controlsFor,
    DISTORTION_TYPES,
    EFFECT_TYPES,
    LIGHTING_TYPES,
    BLUR_TYPES,
    distortStrengthRange,
    blurHasAngle,
    blurHasStrength,
} from '../lib/generator/presets.js';
import {
    EXPORT_RESOLUTIONS,
    defaultUiState,
    applyPreset,
    randomizeUiState,
    renderState,
    checkAvailable,
    normalizeFormat,
} from '../lib/generator/engine.js';
import {
    listCategories,
    extractColors,
    pickRandomPath,
} from '../lib/generator/palettes.js';

const CACHE_DIR = GLib.get_home_dir() + '/.cache/mopivo/generator';
const PREVIEW_W = 480;
const PREVIEW_H = 270;
const DEBOUNCE_MS = 250;

// Async GTK4 picture loader for local files, probed once (same trick as
// ui/gallery.js): set_filename is the preferred API; the `file` property is a
// behavioural fallback.
const _setPictureFile = typeof Gtk.Picture.prototype.set_filename === 'function'
    ? (picture, path) => picture.set_filename(path)
    : (picture, path) => { picture.file = Gio.File.new_for_path(path); };

function _ensureDir(path) {
    const dir = Gio.File.new_for_path(path);
    if (!dir.query_exists(null))
        dir.make_directory_with_parents(null);
}

/** Current primary-monitor size, falling back to 1920x1080. */
function _monitorSize() {
    try {
        const display = Gdk.Display.get_default();
        const monitors = display?.get_monitors?.();
        if (monitors && monitors.get_n_items() > 0) {
            const geo = monitors.get_item(0).get_geometry();
            if (geo.width > 0 && geo.height > 0)
                return {width: geo.width, height: geo.height};
        }
    } catch (_e) { /* headless / no monitor: fall through */ }
    return {width: 1920, height: 1080};
}

export class GeneratorPage {
    /**
     * @param {object} [options]
     * @param {Gio.Settings} [options.settings] app schema settings
     */
    constructor({settings = null} = {}) {
        this._settings = settings;
        this._state = defaultUiState(this._getString('generator-preset') || 'Bars');
        this._categories = [];
        this._initialized = false;
        this._available = true;
        this._syncing = false;
        this._settingsIds = [];
        this._renderTimeout = 0;
        this._rendering = false;
        this._dirty = false;
        this._lastPreviewPath = null;

        this._widget = this._build();
        this._restorePalette();
        this._populateCategories();
        this._updateControlVisibility();
        this._syncWidgetsFromState();
        this._subscribeSettings();

        // Defer the first (python-spawning) work until the page is shown, so
        // merely opening the window never runs the renderer.
        this._widget.connect('map', () => this._onFirstMap());
    }

    /** Root widget for the stack (a Gtk.ScrolledWindow wrapping a vertical Box). */
    get widget() {
        return this._widget;
    }

    // ── Widget tree ─────────────────────────────────────────────────────

    _build() {
        const scrolled = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            hexpand: true,
            vexpand: true,
        });

        const root = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        scrolled.set_child(root);

        root.append(new Gtk.Label({
            label: _('Generator'),
            xalign: 0,
            css_classes: ['heading'],
        }));

        this._banner = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false,
            css_classes: ['error'],
        });
        root.append(this._banner);

        // Preview + spinner overlay.
        const overlay = new Gtk.Overlay();
        this._preview = new Gtk.Picture({
            height_request: 300,
            can_shrink: true,
            content_fit: Gtk.ContentFit.COVER,
            hexpand: true,
        });
        overlay.set_child(this._preview);
        this._spinner = new Gtk.Spinner({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        overlay.add_overlay(this._spinner);
        root.append(overlay);

        this._status = new Gtk.Label({xalign: 0, wrap: true, visible: false});
        root.append(this._status);

        // Everything interactive lives in this box so we can disable it at once
        // when the renderer is unavailable.
        this._controlsBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
        });
        root.append(this._controlsBox);

        this._buildPresetSection();
        this._buildPaletteSection();
        this._buildShaderSection();
        this._buildDistortionSection();
        this._buildGrainSection();
        this._buildLightingSection();
        this._buildBlurSection();
        this._buildBloomSection();
        this._buildChromaticSection();
        this._buildExportSection();
        this._buildActions();

        return scrolled;
    }

    _buildPresetSection() {
        this._presetDrop = this._makeDrop([...PRESET_NAMES],
            Math.max(0, PRESET_NAMES.indexOf(this._state.preset)),
            index => this._applyPreset(PRESET_NAMES[index]));
        this._controlsBox.append(this._row(_('Preset'), this._presetDrop));
    }

    _buildPaletteSection() {
        this._controlsBox.append(new Gtk.Separator({
            orientation: Gtk.Orientation.HORIZONTAL,
        }));

        this._categoryDrop = Gtk.DropDown.new_from_strings([_('Loading…')]);
        this._categoryDrop.set_hexpand(true);
        this._categoryDrop.connect('notify::selected', () => {
            if (this._syncing)
                return;
            this._populatePalettes(this._categoryDrop.get_selected());
        });
        this._controlsBox.append(this._row(_('Palette Category'), this._categoryDrop));

        const sw = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            height_request: 96,
        });
        this._paletteFlow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 40,
            row_spacing: 4,
            column_spacing: 4,
            halign: Gtk.Align.START,
        });
        sw.set_child(this._paletteFlow);
        this._controlsBox.append(sw);

        const swatchRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });
        this._swatches = [];
        for (let i = 0; i < 4; i++) {
            const area = new Gtk.DrawingArea({
                width_request: 32,
                height_request: 32,
                css_classes: ['card'],
            });
            area._rgb = [0.25, 0.25, 0.25];
            area.set_draw_func((a, cr, w, h) => {
                const [r, g, b] = a._rgb;
                cr.setSourceRGB(r, g, b);
                cr.rectangle(0, 0, w, h);
                cr.fill();
            });
            this._swatches.push(area);
            swatchRow.append(area);
        }
        this._controlsBox.append(this._row(_('Colors'), swatchRow));
    }

    _buildShaderSection() {
        this._controlsBox.append(new Gtk.Separator({
            orientation: Gtk.Orientation.HORIZONTAL,
        }));

        const c = controlsFor(this._state.preset);

        this._angleScale = this._makeScale(this._state.angle, 0, 360, 1,
            v => { this._state.angle = v; });
        this._angleRow = this._row(_('Angle'), this._angleScale);

        this._scaleScale = this._makeScale(this._state.scale,
            c.scaleRange[0], c.scaleRange[1], c.scaleRange[2],
            v => { this._state.scale = v; });
        this._scaleRow = this._row(_('Scale'), this._scaleScale);

        this._speedScale = this._makeScale(this._state.speed,
            c.speedRange[0], c.speedRange[1], c.speedRange[2],
            v => { this._state.speed = v; });
        this._speedLabel = new Gtk.Label({label: c.speedLabel, xalign: 0});
        this._speedRow = this._rowWidget(this._speedLabel, this._speedScale);

        this._centerScale = this._makeScale(this._state.center, -1, 1, 0.01,
            v => { this._state.center = v; });
        this._centerRow = this._row(_('Center'), this._centerScale);

        this._variationScale = this._makeScale(this._state.variation,
            c.variationRange[0], c.variationRange[1], c.variationRange[2],
            v => { this._state.variation = v; });
        this._variationRow = this._row(_('Variation'), this._variationScale);

        this._blendScale = this._makeScale(this._state.blend, 0, 1, 0.01,
            v => { this._state.blend = v; });
        this._blendRow = this._row(_('Blend'), this._blendScale);

        this._controlsBox.append(this._angleRow);
        this._controlsBox.append(this._scaleRow);
        this._controlsBox.append(this._speedRow);
        this._controlsBox.append(this._centerRow);
        this._controlsBox.append(this._variationRow);
        this._controlsBox.append(this._blendRow);
    }

    _buildDistortionSection() {
        this._controlsBox.append(this._sectionLabel(_('Distortion')));
        this._distortDrop = this._makeDrop(DISTORTION_TYPES.map(t => _(t)),
            this._state.distortType,
            index => { this._state.distortType = index; this._updateDistort(); });
        this._controlsBox.append(this._row(_('Distortion'), this._distortDrop));

        this._distortScale = this._makeScale(this._state.distortStrength, -10, 10, 0.1,
            v => { this._state.distortStrength = v; });
        this._distortRow = this._row(_('Strength'), this._distortScale);
        this._controlsBox.append(this._distortRow);
    }

    _buildGrainSection() {
        this._controlsBox.append(this._sectionLabel(_('Grain & Texture')));
        this._effectDrop = this._makeDrop(EFFECT_TYPES.map(t => _(t)),
            this._state.effectType,
            index => { this._state.effectType = index; this._updateEffect(); });
        this._controlsBox.append(this._row(_('Effect'), this._effectDrop));

        this._noiseScale = this._makeScale(this._state.noise, -0.2, 0.2, 0.01,
            v => { this._state.noise = v; });
        this._noiseRow = this._row(_('Noise'), this._noiseScale);

        this._ditherStrengthScale = this._makeScale(this._state.ditherStrength, 0.5, 1.0, 0.01,
            v => { this._state.ditherStrength = v; });
        this._ditherStrengthRow = this._row(_('Dither Strength'), this._ditherStrengthScale);

        this._ditherLevelsScale = this._makeScale(this._state.ditherLevels, 2, 8, 1,
            v => { this._state.ditherLevels = v; });
        this._ditherLevelsRow = this._row(_('Dither Levels'), this._ditherLevelsScale);

        this._grainScale = this._makeScale(this._state.grainIntensity, 0.05, 0.3, 0.01,
            v => { this._state.grainIntensity = v; });
        this._grainRow = this._row(_('Grain Intensity'), this._grainScale);

        this._controlsBox.append(this._noiseRow);
        this._controlsBox.append(this._ditherStrengthRow);
        this._controlsBox.append(this._ditherLevelsRow);
        this._controlsBox.append(this._grainRow);
    }

    _buildLightingSection() {
        this._controlsBox.append(this._sectionLabel(_('Lighting')));

        this._lightingSwitch = new Gtk.Switch({
            active: this._state.lightingEnabled,
            valign: Gtk.Align.CENTER,
        });
        this._lightingSwitch.connect('notify::active', () => {
            if (this._syncing)
                return;
            this._state.lightingEnabled = this._lightingSwitch.get_active();
            this._updateLighting();
            this._scheduleRender();
        });
        this._controlsBox.append(this._row(_('Enable Lighting'), this._lightingSwitch));

        this._lightingDrop = this._makeDrop(LIGHTING_TYPES.map(t => _(t)),
            this._state.lightingType,
            index => { this._state.lightingType = index; this._updateLighting(); });
        this._lightingRow = this._row(_('Type'), this._lightingDrop);

        this._lightStrengthScale = this._makeScale(this._state.lightStrength, 0, 1, 0.01,
            v => { this._state.lightStrength = v; });
        this._lightStrengthRow = this._row(_('Strength'), this._lightStrengthScale);

        this._bevelWidthScale = this._makeScale(this._state.bevelWidth, 0.01, 0.15, 0.001,
            v => { this._state.bevelWidth = v; });
        this._bevelWidthRow = this._row(_('Bevel Width'), this._bevelWidthScale);

        this._lightAngleScale = this._makeScale(this._state.lightAngle, 0, 360, 1,
            v => { this._state.lightAngle = v; });
        this._lightAngleRow = this._row(_('Light Angle'), this._lightAngleScale);

        this._controlsBox.append(this._lightingRow);
        this._controlsBox.append(this._lightStrengthRow);
        this._controlsBox.append(this._bevelWidthRow);
        this._controlsBox.append(this._lightAngleRow);
    }

    _buildBlurSection() {
        this._controlsBox.append(this._sectionLabel(_('Blur')));
        this._blurDrop = this._makeDrop(BLUR_TYPES.map(t => _(t)),
            this._state.blurType,
            index => { this._state.blurType = index; this._updateBlur(); });
        this._controlsBox.append(this._row(_('Blur'), this._blurDrop));

        this._blurStrengthScale = this._makeScale(this._state.blurStrength, 0, 1, 0.01,
            v => { this._state.blurStrength = v; });
        this._blurStrengthRow = this._row(_('Strength'), this._blurStrengthScale);

        this._blurAngleScale = this._makeScale(this._state.blurAngle, 0, 360, 1,
            v => { this._state.blurAngle = v; });
        this._blurAngleRow = this._row(_('Angle'), this._blurAngleScale);

        this._controlsBox.append(this._blurStrengthRow);
        this._controlsBox.append(this._blurAngleRow);
    }

    _buildBloomSection() {
        this._controlsBox.append(this._sectionLabel(_('Bloom')));
        this._bloomSwitch = new Gtk.Switch({
            active: this._state.bloomEnabled,
            valign: Gtk.Align.CENTER,
        });
        this._bloomSwitch.connect('notify::active', () => {
            if (this._syncing)
                return;
            this._state.bloomEnabled = this._bloomSwitch.get_active();
            this._updateBloom();
            this._scheduleRender();
        });
        this._controlsBox.append(this._row(_('Enable Bloom'), this._bloomSwitch));

        this._bloomThresholdScale = this._makeScale(this._state.bloomThreshold, 0, 1, 0.01,
            v => { this._state.bloomThreshold = v; });
        this._bloomThresholdRow = this._row(_('Threshold'), this._bloomThresholdScale);

        this._bloomIntensityScale = this._makeScale(this._state.bloomIntensity, 0, 3, 0.05,
            v => { this._state.bloomIntensity = v; });
        this._bloomIntensityRow = this._row(_('Intensity'), this._bloomIntensityScale);

        this._controlsBox.append(this._bloomThresholdRow);
        this._controlsBox.append(this._bloomIntensityRow);
    }

    _buildChromaticSection() {
        this._controlsBox.append(this._sectionLabel(_('Chromatic Aberration')));
        this._chromSwitch = new Gtk.Switch({
            active: this._state.chromaticEnabled,
            valign: Gtk.Align.CENTER,
        });
        this._chromSwitch.connect('notify::active', () => {
            if (this._syncing)
                return;
            this._state.chromaticEnabled = this._chromSwitch.get_active();
            this._updateChromatic();
            this._scheduleRender();
        });
        this._controlsBox.append(this._row(_('Enable Chromatic'), this._chromSwitch));

        this._chromStrengthScale = this._makeScale(this._state.chromaticStrength, 0, 1, 0.01,
            v => { this._state.chromaticStrength = v; });
        this._chromStrengthRow = this._row(_('Strength'), this._chromStrengthScale);

        this._chromAngleScale = this._makeScale(this._state.chromaticAngle, 0, 360, 1,
            v => { this._state.chromaticAngle = v; });
        this._chromAngleRow = this._row(_('Angle'), this._chromAngleScale);

        this._controlsBox.append(this._chromStrengthRow);
        this._controlsBox.append(this._chromAngleRow);
    }

    _buildExportSection() {
        this._controlsBox.append(new Gtk.Separator({
            orientation: Gtk.Orientation.HORIZONTAL,
        }));

        this._resolutionDrop = Gtk.DropDown.new_from_strings(
            EXPORT_RESOLUTIONS.map(r => _(r.label)));
        this._resolutionDrop.set_hexpand(true);
        this._resolutionDrop.set_selected(this._getInt('generator-resolution'));
        this._resolutionDrop.connect('notify::selected', () => {
            if (this._syncing)
                return;
            this._settings?.set_int?.('generator-resolution', this._resolutionDrop.get_selected());
        });
        this._controlsBox.append(this._row(_('Export Resolution'), this._resolutionDrop));

        this._formatDrop = Gtk.DropDown.new_from_strings(['PNG', 'JPG']);
        this._formatDrop.set_hexpand(true);
        this._formatDrop.set_selected(this._getString('generator-format') === 'jpg' ? 1 : 0);
        this._formatDrop.connect('notify::selected', () => {
            if (this._syncing)
                return;
            this._settings?.set_string?.('generator-format',
                this._formatDrop.get_selected() === 1 ? 'jpg' : 'png');
        });
        this._controlsBox.append(this._row(_('Format'), this._formatDrop));
    }

    _buildActions() {
        const bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
        });

        const randomize = new Gtk.Button({label: _('Randomize')});
        randomize.connect('clicked', () => this._randomize());

        this._wallpaperBtn = new Gtk.Button({label: _('Set as Wallpaper')});
        this._wallpaperBtn.connect('clicked', () => this._setWallpaper());

        this._exportBtn = new Gtk.Button({
            label: _('Export…'),
            css_classes: ['suggested-action'],
        });
        this._exportBtn.connect('clicked', () => this._export());

        bar.append(randomize);
        bar.append(this._wallpaperBtn);
        bar.append(this._exportBtn);
        this._controlsBox.append(bar);
    }

    // ── Small widget helpers ────────────────────────────────────────────

    _sectionLabel(text) {
        return new Gtk.Label({
            label: text,
            xalign: 0,
            margin_top: 6,
            css_classes: ['dim-label'],
        });
    }

    /** Label + widget row: label expands, widget sits on the right. */
    _row(labelText, widget) {
        return this._rowWidget(new Gtk.Label({label: labelText, xalign: 0}), widget);
    }

    _rowWidget(labelWidget, widget) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
        labelWidget.set_hexpand(true);
        labelWidget.set_halign(Gtk.Align.START);
        box.append(labelWidget);
        box.append(widget);
        return box;
    }

    _makeDrop(labels, selected, onChange) {
        const drop = Gtk.DropDown.new_from_strings(labels);
        drop.set_hexpand(true);
        if (selected >= 0 && selected < labels.length)
            drop.set_selected(selected);
        drop.connect('notify::selected', () => {
            if (this._syncing)
                return;
            onChange(drop.get_selected());
            this._scheduleRender();
        });
        return drop;
    }

    _makeScale(value, min, max, step, onChange) {
        const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, min, max, step);
        scale.set_value(value);
        scale.set_draw_value(true);
        scale.set_value_pos(Gtk.PositionType.RIGHT);
        scale.set_hexpand(true);
        scale.connect('value-changed', () => {
            if (this._syncing)
                return;
            onChange(scale.get_value());
            this._scheduleRender();
        });
        return scale;
    }

    _setScaleRange(scale, [min, max, step]) {
        if (scale) {
            scale.set_range(min, max);
            scale.set_increments(step, step * 10);
        }
    }

    // ── First map / availability ────────────────────────────────────────

    _onFirstMap() {
        if (this._initialized)
            return;
        this._initialized = true;
        this._probeAvailability().then(ok => {
            if (ok)
                this._scheduleRender(0);
        });
    }

    async _probeAvailability() {
        const res = await checkAvailable();
        this._available = res.ok;
        if (!res.ok) {
            this._banner.set_text(
                `${_('The generator needs python3 with numpy and Pillow.')}: ${res.error}`);
            this._banner.set_visible(true);
            this._controlsBox.set_sensitive(false);
        }
        return res.ok;
    }

    // ── Preset / control visibility ─────────────────────────────────────

    _applyPreset(name) {
        applyPreset(this._state, name);
        this._settings?.set_string?.('generator-preset', name);
        this._updateControlVisibility();
        this._syncWidgetsFromState();
        this._scheduleRender();
    }

    /** Preset-dependent visibility + scale ranges (mirrors window.rs). */
    _updateControlVisibility() {
        const c = controlsFor(this._state.preset);
        this._angleRow.set_visible(c.hasAngle);
        this._scaleRow.set_visible(c.hasScale);
        this._speedRow.set_visible(c.hasSpeed);
        this._speedLabel.set_text(_(c.speedLabel));
        this._centerRow.set_visible(c.hasCenter);
        this._variationRow.set_visible(c.hasVariation);

        this._setScaleRange(this._scaleScale, c.scaleRange);
        this._setScaleRange(this._speedScale, c.speedRange);
        this._setScaleRange(this._variationScale, c.variationRange);

        this._updateDistort();
        this._updateEffect();
        this._updateLighting();
        this._updateBlur();
        this._updateBloom();
        this._updateChromatic();
    }

    _updateDistort() {
        const t = this._state.distortType;
        this._distortRow.set_visible(t !== 0);
        if (t !== 0) {
            const {min, max} = distortStrengthRange(t);
            this._setScaleRange(this._distortScale, [min, max, 0.1]);
        }
    }

    _updateEffect() {
        const t = this._state.effectType;
        this._noiseRow.set_visible(t === 1);
        this._ditherStrengthRow.set_visible(t === 2);
        this._ditherLevelsRow.set_visible(t === 2);
        this._grainRow.set_visible(t === 3);
    }

    _updateLighting() {
        const on = this._state.lightingEnabled;
        this._lightingDrop.set_sensitive(on);
        this._lightStrengthRow.set_visible(on);
        this._lightingRow.set_visible(on);
        this._bevelWidthRow.set_visible(on && this._state.lightingType === 0);
        this._lightAngleRow.set_visible(on && this._state.lightingType === 1);
    }

    _updateBlur() {
        const t = this._state.blurType;
        this._blurStrengthRow.set_visible(blurHasStrength(t));
        this._blurAngleRow.set_visible(blurHasAngle(t));
    }

    _updateBloom() {
        const on = this._state.bloomEnabled;
        this._bloomThresholdRow.set_visible(on);
        this._bloomIntensityRow.set_visible(on);
    }

    _updateChromatic() {
        const on = this._state.chromaticEnabled;
        this._chromStrengthRow.set_visible(on);
        this._chromAngleRow.set_visible(on);
    }

    // ── Palette handling ────────────────────────────────────────────────

    _populateCategories() {
        this._categories = listCategories();
        const names = this._categories.map(c => c.name);
        this._syncing = true;
        this._categoryDrop.set_model(Gtk.StringList.new(names.length ? names : [_('No palettes')]));
        this._categoryDrop.set_selected(0);
        this._syncing = false;
        if (this._categories.length)
            this._populatePalettes(0);
    }

    _populatePalettes(catIndex) {
        // Clear the flowbox.
        let child = this._paletteFlow.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._paletteFlow.remove(child);
            child = next;
        }

        const cat = this._categories[catIndex];
        if (!cat)
            return;

        for (const path of cat.images) {
            const picture = new Gtk.Picture({
                width_request: 48,
                height_request: 48,
                can_shrink: true,
                content_fit: Gtk.ContentFit.COVER,
            });
            try {
                _setPictureFile(picture, path);
            } catch (_e) { /* skip unreadable thumbnail */ }

            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
            box.append(picture);
            box.set_tooltip_text(GLib.path_get_basename(path));

            const gesture = new Gtk.GestureClick();
            gesture.connect('released', () => this._selectPalette(path));
            box.add_controller(gesture);

            const flowChild = new Gtk.FlowBoxChild({child: box});
            if (path === this._state.palettePath)
                flowChild.add_css_class('accent');
            this._paletteFlow.append(flowChild);
        }
    }

    _selectPalette(path) {
        try {
            this._state.colors = extractColors(path);
            this._state.palettePath = path;
        } catch (e) {
            this._setStatus(`${_('Error')}: ${e.message}`);
            return;
        }
        this._settings?.set_string?.('generator-palette', path);
        this._updateSwatches();
        this._scheduleRender();
    }

    _restorePalette() {
        const path = this._getString('generator-palette');
        if (path && GLib.file_test(path, GLib.FileTest.EXISTS)) {
            try {
                this._state.colors = extractColors(path);
                this._state.palettePath = path;
            } catch (_e) { /* stale path: ignore */ }
        }
    }

    _updateSwatches() {
        const colors = this._state.colors;
        for (let i = 0; i < 4; i++) {
            const area = this._swatches[i];
            area._rgb = colors?.[i] ?? [0.25, 0.25, 0.25];
            area.queue_draw();
        }
    }

    // ── State ⇄ widgets ─────────────────────────────────────────────────

    _syncWidgetsFromState() {
        this._syncing = true;
        const s = this._state;

        this._presetDrop.set_selected(Math.max(0, PRESET_NAMES.indexOf(s.preset)));
        this._angleScale.set_value(s.angle);
        this._scaleScale.set_value(s.scale);
        this._speedScale.set_value(s.speed);
        this._centerScale.set_value(s.center);
        this._variationScale.set_value(s.variation);
        this._blendScale.set_value(s.blend);

        this._distortDrop.set_selected(s.distortType);
        this._distortScale.set_value(s.distortStrength);

        this._effectDrop.set_selected(s.effectType);
        this._noiseScale.set_value(s.noise);
        this._ditherStrengthScale.set_value(s.ditherStrength);
        this._ditherLevelsScale.set_value(s.ditherLevels);
        this._grainScale.set_value(s.grainIntensity);

        this._lightingSwitch.set_active(s.lightingEnabled);
        this._lightingDrop.set_selected(s.lightingType);
        this._lightStrengthScale.set_value(s.lightStrength);
        this._bevelWidthScale.set_value(s.bevelWidth);
        this._lightAngleScale.set_value(s.lightAngle);

        this._blurDrop.set_selected(s.blurType);
        this._blurStrengthScale.set_value(s.blurStrength);
        this._blurAngleScale.set_value(s.blurAngle);

        this._bloomSwitch.set_active(s.bloomEnabled);
        this._bloomThresholdScale.set_value(s.bloomThreshold);
        this._bloomIntensityScale.set_value(s.bloomIntensity);

        this._chromSwitch.set_active(s.chromaticEnabled);
        this._chromStrengthScale.set_value(s.chromaticStrength);
        this._chromAngleScale.set_value(s.chromaticAngle);

        this._syncing = false;
        this._updateSwatches();
    }

    // ── Randomize / set / export ────────────────────────────────────────

    _randomize() {
        const path = pickRandomPath();
        let palette = null;
        if (path) {
            try {
                palette = {path, colors: extractColors(path)};
            } catch (_e) { /* palette unreadable: keep colors unset */ }
        }

        this._state = randomizeUiState({palette});
        this._settings?.set_string?.('generator-preset', this._state.preset);
        if (this._state.palettePath)
            this._settings?.set_string?.('generator-palette', this._state.palettePath);

        this._updateControlVisibility();
        this._syncWidgetsFromState();
        // Refresh the flowbox highlight for the newly chosen palette.
        if (this._categories.length)
            this._populatePalettes(this._categoryDrop.get_selected());
        this._scheduleRender(0);
    }

    async _setWallpaper() {
        if (!this._state.colors) {
            this._setStatus(_('Choose a palette first.'));
            return;
        }
        const dims = _monitorSize();
        _ensureDir(CACHE_DIR);
        const out = GLib.build_filenamev([CACHE_DIR, 'wallpaper.png']);
        this._setBusy(true);
        try {
            await renderState(this._state, {...dims, out});
            setDesktopWallpaper(Gio.File.new_for_path(out).get_uri());
            this._setStatus(_('Wallpaper applied.'));
        } catch (e) {
            this._setStatus(`${_('Error')}: ${e.message}`);
        } finally {
            this._setBusy(false);
        }
    }

    _exportFolder() {
        const folder = this._getString('generator-export-folder');
        if (folder)
            return folder;
        const pics = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        return pics || GLib.get_home_dir();
    }

    async _export() {
        if (!this._state.colors) {
            this._setStatus(_('Choose a palette first.'));
            return;
        }
        const res = EXPORT_RESOLUTIONS[this._resolutionDrop.get_selected()] ?? EXPORT_RESOLUTIONS[0];
        const dims = res.width > 0
            ? {width: res.width, height: res.height}
            : _monitorSize();
        const fmt = normalizeFormat(this._getString('generator-format') || 'png');
        const folder = this._exportFolder();
        _ensureDir(folder);
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S') || '';
        const out = GLib.build_filenamev([
            folder, `mopivo_${this._state.preset}_${stamp}.${fmt}`]);

        this._setBusy(true);
        try {
            const saved = await renderState(this._state, {...dims, out});
            this._setStatus(`${_('Saved:')} ${saved}`);
        } catch (e) {
            this._setStatus(`${_('Error')}: ${e.message}`);
        } finally {
            this._setBusy(false);
        }
    }

    // ── Rendering ───────────────────────────────────────────────────────

    _scheduleRender(delay = DEBOUNCE_MS) {
        if (this._renderTimeout) {
            GLib.source_remove(this._renderTimeout);
            this._renderTimeout = 0;
        }
        this._renderTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._renderTimeout = 0;
            this._renderPreview();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _renderPreview() {
        if (!this._available)
            return;
        if (!this._state.colors) {
            this._setStatus(_('Choose a palette to generate a preview.'));
            return;
        }
        if (this._rendering) {
            this._dirty = true;
            return;
        }

        this._rendering = true;
        this._spinner.set_visible(true);
        this._spinner.start();
        _ensureDir(CACHE_DIR);
        const out = GLib.build_filenamev([
            CACHE_DIR, `preview-${GLib.get_monotonic_time()}.png`]);

        try {
            const path = await renderState(this._state,
                {width: PREVIEW_W, height: PREVIEW_H, out});
            _setPictureFile(this._preview, path);
            this._setStatus(_('Ready.'));
            const old = this._lastPreviewPath;
            this._lastPreviewPath = path;
            if (old && old !== path)
                Gio.File.new_for_path(old).delete_async(GLib.PRIORITY_LOW, null, null);
        } catch (e) {
            this._setStatus(`${_('Error')}: ${e.message}`);
        } finally {
            this._rendering = false;
            this._spinner.stop();
            this._spinner.set_visible(false);
            if (this._dirty) {
                this._dirty = false;
                this._scheduleRender(0);
            }
        }
    }

    // ── Settings ────────────────────────────────────────────────────────

    _subscribeSettings() {
        const s = this._settings;
        if (!s || typeof s.connect !== 'function')
            return;
        this._settingsIds.push(s.connect('changed::generator-preset', () => {
            const name = this._getString('generator-preset');
            if (name && name !== this._state.preset)
                this._applyPreset(name);
        }));
        this._settingsIds.push(s.connect('changed::generator-palette', () => {
            const path = this._getString('generator-palette');
            if (path && path !== this._state.palettePath
                && GLib.file_test(path, GLib.FileTest.EXISTS))
                this._selectPalette(path);
        }));
    }

    // ── Status / busy ───────────────────────────────────────────────────

    _setStatus(text) {
        this._status.set_text(text);
        this._status.set_visible(!!text);
    }

    _setBusy(busy) {
        this._exportBtn?.set_sensitive(!busy);
        this._wallpaperBtn?.set_sensitive(!busy);
    }

    // ── Settings readers (tolerant of a null/stub settings) ─────────────

    _getString(key) {
        const s = this._settings;
        if (s && typeof s.get_string === 'function')
            return s.get_string(key) || '';
        return '';
    }

    _getInt(key) {
        const s = this._settings;
        if (s && typeof s.get_int === 'function')
            return s.get_int(key);
        return 0;
    }

    /** Disconnect subscriptions and cancel a pending render. */
    destroy() {
        if (this._renderTimeout) {
            GLib.source_remove(this._renderTimeout);
            this._renderTimeout = 0;
        }
        for (const id of this._settingsIds) {
            try {
                this._settings?.disconnect(id);
            } catch (_e) { /* already disconnected */ }
        }
        this._settingsIds = [];
    }
}
