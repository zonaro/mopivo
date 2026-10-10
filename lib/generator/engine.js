// SPDX-License-Identifier: GPL-3.0-or-later
// lib/generator/engine.js — generator orchestration.
//
// Bridges the GTK UI and the numpy/PIL renderer (renderer/generator.py):
//   * holds the canonical UI-state shape (degrees, 0..1 ranges) and converts
//     it to the generator.py JSON spec (radians, per-pass sub-objects),
//   * ports the Wallrus "Randomize" button (window.rs) parameter by parameter,
//   * spawns `python3 renderer/generator.py` as a Gio.Subprocess, feeding the
//     JSON spec on stdin and returning the written image path.
//
// No GTK imports: this module is safe to unit-test headlessly.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    PRESET_NAMES,
    GLOBAL_DEFAULTS,
    controlsFor,
    distortStrengthRange,
} from './presets.js';

/** Export resolution presets (port of export.rs::ExportResolution). Index 0 is
 * the live monitor size and carries no fixed dimensions. */
export const EXPORT_RESOLUTIONS = Object.freeze([
    {id: 'display', label: 'Display', width: 0, height: 0},
    {id: 'hd', label: 'HD (1920×1080)', width: 1920, height: 1080},
    {id: 'qhd', label: 'QHD (2560×1440)', width: 2560, height: 1440},
    {id: '4k', label: '4K (3840×2160)', width: 3840, height: 2160},
    {id: 'phone', label: 'Phone (1080×2400)', width: 1080, height: 2400},
]);

const DEG2RAD = Math.PI / 180.0;

/** Convert degrees to radians (UI → spec). */
export function degToRad(deg) {
    return deg * DEG2RAD;
}

function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
}

// ── UI state ────────────────────────────────────────────────────────────────

/**
 * A fresh UI state for a preset: global defaults plus the preset's own
 * scale/speed/variation defaults. `colors` stays null until a palette is
 * picked (the preview shows a prompt until then).
 * @param {string} [preset]
 * @returns {object}
 */
export function defaultUiState(preset = 'Bars') {
    const name = PRESET_NAMES.includes(preset) ? preset : 'Bars';
    const c = controlsFor(name);
    return {
        preset: name,
        palettePath: null,
        colors: null,
        ...GLOBAL_DEFAULTS,
        scale: c.scaleRange[3],
        speed: c.speedRange[3],
        variation: c.variationRange[3],
    };
}

/**
 * Apply the preset-specific ranges (defaults + visibility) to an existing
 * state after the preset changes, exactly like window.rs's preset handler:
 * scale/speed/variation are reset to the new preset defaults and `center` is
 * reset to 0.
 * @param {object} state
 * @param {string} preset
 * @returns {object} the same state, mutated
 */
export function applyPreset(state, preset) {
    if (!PRESET_NAMES.includes(preset))
        return state;
    const c = controlsFor(preset);
    state.preset = preset;
    state.scale = c.scaleRange[3];
    state.speed = c.speedRange[3];
    state.variation = c.variationRange[3];
    state.center = 0.0;
    return state;
}

// ── Randomize (port of window.rs randomize_button) ──────────────────────────

function randRange(rng, lo, hi) {
    return lo + (hi - lo) * rng();
}

function randInt(rng, lo, hiExclusive) {
    return Math.floor(randRange(rng, lo, hiExclusive));
}

/**
 * Randomize every parameter, mirroring the Wallrus randomize button. A random
 * preset is chosen first (so its scale/speed/variation ranges apply), then all
 * shared controls. When `opts.palette` is given ({path, colors}) it is applied
 * too — the caller picks it via lib/generator/palettes.js, keeping this module
 * free of filesystem access.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.rng] RNG in [0,1) (defaults to Math.random)
 * @param {{path: string, colors: Array<[number,number,number]>}|null} [opts.palette]
 * @returns {object} a complete UI state
 */
export function randomizeUiState({rng = Math.random, palette = null} = {}) {
    const preset = PRESET_NAMES[randInt(rng, 0, PRESET_NAMES.length)];
    const c = controlsFor(preset);
    const state = defaultUiState(preset);

    if (palette) {
        state.palettePath = palette.path ?? null;
        state.colors = palette.colors ?? null;
    }

    // Rotation / shared sliders.
    state.angle = randRange(rng, 0.0, 360.0);
    state.scale = randRange(rng, c.scaleRange[0], c.scaleRange[1]);
    state.speed = randRange(rng, c.speedRange[0], c.speedRange[1]);
    state.blend = randRange(rng, 0.0, 1.0);
    state.center = randRange(rng, -1.0, 1.0);
    if (c.hasVariation)
        state.variation = randRange(rng, c.variationRange[0], c.variationRange[1]);

    // Distortion.
    state.distortType = randInt(rng, 0, 4);
    if (state.distortType !== 0) {
        const {min, max} = distortStrengthRange(state.distortType);
        state.distortStrength = randRange(rng, min, max);
    } else {
        state.distortStrength = 0.0;
    }

    // Grain & texture.
    state.effectType = randInt(rng, 0, 4);
    if (state.effectType === 1) {
        state.noise = randRange(rng, -0.2, 0.2);
    } else if (state.effectType === 2) {
        state.ditherStrength = randRange(rng, 0.5, 1.0);
        state.ditherLevels = Math.floor(randRange(rng, 2.0, 9.0));
    } else if (state.effectType === 3) {
        state.grainIntensity = randRange(rng, 0.05, 0.3);
    }

    // Lighting (50% chance).
    state.lightingEnabled = rng() < 0.5;
    if (state.lightingEnabled) {
        state.lightingType = randInt(rng, 0, 3);
        state.lightStrength = randRange(rng, 0.0, 1.0);
        if (state.lightingType === 0)
            state.bevelWidth = randRange(rng, 0.01, 0.15);
        if (state.lightingType === 1)
            state.lightAngle = randRange(rng, 0.0, 360.0);
    }

    // Blur.
    state.blurType = randInt(rng, 0, 6);
    if (state.blurType !== 0)
        state.blurStrength = randRange(rng, 0.0, 1.0);
    if (state.blurType === 2 || state.blurType === 5)
        state.blurAngle = randRange(rng, 0.0, 360.0);

    // Bloom / glow (30% chance).
    state.bloomEnabled = rng() < 0.3;
    if (state.bloomEnabled) {
        state.bloomThreshold = randRange(rng, 0.0, 1.0);
        state.bloomIntensity = randRange(rng, 0.0, 3.0);
    }

    // Chromatic aberration (30% chance).
    state.chromaticEnabled = rng() < 0.3;
    if (state.chromaticEnabled) {
        state.chromaticStrength = randRange(rng, 0.0, 1.0);
        state.chromaticAngle = randRange(rng, 0.0, 360.0);
    }

    return state;
}

// ── Spec building ───────────────────────────────────────────────────────────

/**
 * Convert a UI state into the generator.py JSON spec.
 *
 * Angle conversions follow window.rs: `angle` and `blur_angle` are plain
 * degrees→radians; `light_angle` is `(degrees − 90)` so 0° means "light from
 * the top"; `chromatic_angle` is plain degrees→radians.
 *
 * @param {object} state      UI state (from defaultUiState/randomizeUiState)
 * @param {object} dims
 * @param {number} dims.width
 * @param {number} dims.height
 * @param {string} dims.out   output path (.png / .jpg / .jpeg)
 * @returns {object} JSON-serializable spec
 */
export function buildSpec(state, {width, height, out}) {
    return {
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
        preset: state.preset,
        colors: state.colors,
        angle: degToRad(state.angle),
        scale: state.scale,
        speed: state.speed,
        blend: state.blend,
        center: state.center,
        variation: state.variation,
        distort: {
            type: state.distortType,
            strength: state.distortStrength,
        },
        lighting: {
            type: state.lightingEnabled ? state.lightingType + 1 : 0,
            strength: state.lightStrength,
            bevel_width: state.bevelWidth,
            angle: degToRad(state.lightAngle - 90.0),
        },
        blur: {
            type: state.blurType,
            strength: state.blurStrength,
            angle: degToRad(state.blurAngle),
        },
        bloom: {
            enabled: state.bloomEnabled,
            threshold: state.bloomThreshold,
            intensity: state.bloomIntensity,
        },
        chromatic: {
            enabled: state.chromaticEnabled,
            strength: state.chromaticStrength,
            angle: degToRad(state.chromaticAngle),
        },
        effects: {
            type: state.effectType,
            noise: state.noise,
            dither_strength: state.ditherStrength,
            dither_levels: state.ditherLevels,
            grain_intensity: state.grainIntensity,
        },
        out,
    };
}

/** Normalize a user-typed extension to the supported png/jpg set. */
export function normalizeFormat(ext) {
    const e = String(ext || '').toLowerCase().replace(/^\./, '');
    return e === 'jpg' || e === 'jpeg' ? 'jpg' : 'png';
}

// ── Renderer process ────────────────────────────────────────────────────────

/** Root of the installed/checkout tree (parent of lib/). */
function appRoot() {
    return Gio.File.new_for_uri(import.meta.url)
        .get_parent().get_parent().get_parent();
}

/** Absolute path to renderer/generator.py. */
export function generatorPath() {
    return GLib.build_filenamev([appRoot().get_path(), 'renderer', 'generator.py']);
}

let _python = null;

/** Locate a usable python3 interpreter (python3, then python). */
export function findPython() {
    if (_python)
        return _python;
    _python = GLib.find_program_in_path('python3')
        ?? GLib.find_program_in_path('python')
        ?? 'python3';
    return _python;
}

/**
 * Check that the renderer can run: python + numpy + PIL reachable and
 * generator.py present. Resolves to `{ok, python, path, version}` never throws.
 * @returns {Promise<{ok: boolean, python: string, path: string, version: string, error: string}>}
 */
export function checkAvailable() {
    const python = findPython();
    const path = generatorPath();
    return new Promise(resolve => {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            resolve({ok: false, python, path, version: '', error: 'generator.py not found'});
            return;
        }
        let proc;
        try {
            proc = Gio.Subprocess.new(
                [python, path, '--version'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, python, path, version: '', error: e.message});
            return;
        }
        proc.communicate_utf8_async(null, null, (_p, res) => {
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                if (proc.get_successful())
                    resolve({ok: true, python, path, version: (stdout || '').trim(), error: ''});
                else
                    resolve({ok: false, python, path, version: '', error: (stderr || '').trim()});
            } catch (e) {
                resolve({ok: false, python, path, version: '', error: e.message});
            }
        });
    });
}

/**
 * Render a spec to an image by spawning the python generator.
 *
 * @param {object} spec JSON spec (must carry `out`)
 * @param {object} [opts]
 * @param {string} [opts.python] interpreter override
 * @returns {Promise<string>} the written output path (stdout from the child)
 */
export function render(spec, {python = null} = {}) {
    const py = python ?? findPython();
    const path = generatorPath();
    const payload = JSON.stringify(spec);

    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                [py, path],
                Gio.SubprocessFlags.STDIN_PIPE
                | Gio.SubprocessFlags.STDOUT_PIPE
                | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(new Error(`failed to launch generator: ${e.message}`));
            return;
        }

        proc.communicate_utf8_async(payload, null, (_p, res) => {
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                if (/JSONDecodeError|Traceback/i.test(stderr || '')) {
                    reject(new Error((stderr || '').trim()));
                    return;
                }
                if (!proc.get_successful()) {
                    reject(new Error((stderr || '').trim() || 'generator failed'));
                    return;
                }
                resolve((stdout || '').trim());
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Convenience: build a spec from UI state and render it.
 * @param {object} state UI state
 * @param {{width: number, height: number, out: string}} dims
 * @param {object} [opts] forwarded to render()
 * @returns {Promise<string>}
 */
export function renderState(state, dims, opts = {}) {
    const spec = buildSpec(state, dims);
    return render(spec, opts);
}

/**
 * Ask the generator for its preset list (sanity probe used by tests).
 * @returns {Promise<string[]>}
 */
export function listPresets() {
    const py = findPython();
    const path = generatorPath();
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new([py, path, '--presets'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, null, (_p, res) => {
            try {
                const [, stdout] = proc.communicate_utf8_finish(res);
                resolve((stdout || '').split('\n').map(s => s.trim()).filter(Boolean));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export {clamp};
