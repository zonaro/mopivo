// SPDX-License-Identifier: GPL-3.0-or-later
// lib/generator/presets.js — preset metadata for the wallpaper Generator.
//
// Port of Wallrus `src/shader_presets.rs` (controls_for) plus the global slider
// defaults from `src/window.rs`. This module is pure data: it tells the UI
// which controls a preset exposes, their per-preset slider ranges/defaults, and
// the fixed defaults for the shared effect controls. No gi:// imports.
//
// The UI state built on top of these values is converted to the generator.py
// JSON spec by lib/generator/engine.js (the only place that knows the
// degrees→radians and light-angle rules).

/**
 * Preset names in display order (mirrors shader_presets::preset_names and the
 * generator.py PRESETS tuple).
 * @type {ReadonlyArray<string>}
 */
export const PRESET_NAMES = Object.freeze([
    'Bars', 'Circle', 'Plasma', 'Waves', 'Terrain', 'Dunes', 'Spark',
]);

/** Distortion type labels (combo index = value). */
export const DISTORTION_TYPES = Object.freeze([
    'None', 'Swirl', 'Fish Eye', 'Sine Wave',
]);

/** Effect type labels (combo index = value). */
export const EFFECT_TYPES = Object.freeze([
    'None', 'Noise', 'Ordered Dither', 'Film Grain',
]);

/** Lighting type labels — combo index 0..2 maps to uniform type 1..3. */
export const LIGHTING_TYPES = Object.freeze([
    'Bevel', 'Gradient', 'Vignette',
]);

/** Blur type labels (combo index = value). */
export const BLUR_TYPES = Object.freeze([
    'None', 'Gaussian', 'Tilt-Shift', 'Radial', 'Vignette', 'Directional',
]);

/**
 * Per-preset control metadata, ported verbatim from
 * `shader_presets.rs::controls_for`. Ranges are `[min, max, step, default]`.
 * `speedLabel` is "Speed" for Bars and "Time" for everything else.
 * @type {Record<string, object>}
 */
const CONTROLS = Object.freeze({
    Bars: {
        hasAngle: true, hasScale: false, hasSpeed: false,
        hasCenter: false, hasVariation: false,
        speedLabel: 'Speed',
        speedRange: [0.0, 3.0, 0.1, 1.0],
        scaleRange: [0.1, 5.0, 0.1, 1.0],
        variationRange: [0.0, 1.0, 0.01, 0.0],
    },
    Plasma: {
        hasAngle: false, hasScale: true, hasSpeed: true,
        hasCenter: false, hasVariation: false,
        speedLabel: 'Time',
        speedRange: [0.0, 20.0, 0.1, 0.0],
        scaleRange: [0.1, 2.0, 0.1, 1.0],
        variationRange: [0.0, 1.0, 0.01, 0.0],
    },
    Waves: {
        hasAngle: true, hasScale: true, hasSpeed: true,
        hasCenter: false, hasVariation: false,
        speedLabel: 'Time',
        speedRange: [0.0, 20.0, 0.1, 0.0],
        scaleRange: [0.1, 5.0, 0.1, 1.0],
        variationRange: [0.0, 1.0, 0.01, 0.0],
    },
    Terrain: {
        hasAngle: false, hasScale: true, hasSpeed: true,
        hasCenter: false, hasVariation: false,
        speedLabel: 'Time',
        speedRange: [0.0, 20.0, 0.1, 0.0],
        scaleRange: [0.1, 2.0, 0.01, 0.5],
        variationRange: [0.0, 1.0, 0.01, 0.0],
    },
    Circle: {
        hasAngle: false, hasScale: true, hasSpeed: false,
        hasCenter: true, hasVariation: false,
        speedLabel: 'Time',
        speedRange: [0.0, 20.0, 0.1, 0.0],
        scaleRange: [0.5, 3.0, 0.1, 1.0],
        variationRange: [0.0, 1.0, 0.01, 0.0],
    },
    Dunes: {
        hasAngle: false, hasScale: true, hasSpeed: false,
        hasCenter: false, hasVariation: true,
        speedLabel: 'Time',
        speedRange: [0.0, 20.0, 0.1, 0.0],
        scaleRange: [0.1, 3.0, 0.1, 1.0],
        variationRange: [0.0, 20.0, 0.1, 0.0],
    },
    Spark: {
        hasAngle: false, hasScale: true, hasSpeed: false,
        hasCenter: false, hasVariation: false,
        speedLabel: 'Time',
        speedRange: [0.0, 20.0, 0.1, 0.0],
        scaleRange: [0.1, 5.0, 0.1, 1.0],
        variationRange: [0.0, 1.0, 0.01, 0.0],
    },
});

/**
 * Control metadata for a preset. Unknown names fall back to the Bars-like
 * default (angle + speed), matching `controls_for`'s wildcard arm.
 * @param {string} name
 * @returns {object}
 */
export function controlsFor(name) {
    return CONTROLS[name] ?? CONTROLS.Bars;
}

/**
 * Fixed defaults for the shared (non-preset) effect controls, taken from
 * `window.rs` widget initialisation. Degrees are kept in UI units; the engine
 * converts to radians.
 * @type {Readonly<object>}
 */
export const GLOBAL_DEFAULTS = Object.freeze({
    // Rotation
    angle: 45.0,                 // 0..360 degrees (angle_scale.set_value(45.0))
    blend: 0.5,                  // 0..1
    center: 0.0,                 // −1..1
    // Distortion
    distortType: 0,              // 0 None, 1 Swirl, 2 Fish Eye, 3 Sine Wave
    distortStrength: 0.0,
    // Grain & texture
    effectType: 0,               // 0 None, 1 Noise, 2 Dither, 3 Film Grain
    noise: 0.0,
    ditherStrength: 0.5,
    ditherLevels: 4.0,
    grainIntensity: 0.3,
    // Lighting
    lightingEnabled: false,
    lightingType: 0,             // 0 Bevel, 1 Gradient, 2 Vignette
    lightStrength: 0.0,
    bevelWidth: 0.05,
    lightAngle: 45.0,            // degrees (light_angle_scale.set_value(45.0))
    // Blur
    blurType: 0,                 // 0 None .. 5 Directional
    blurStrength: 0.5,
    blurAngle: 0.0,              // degrees
    // Bloom / glow
    bloomEnabled: false,
    bloomThreshold: 0.5,
    bloomIntensity: 1.0,
    // Chromatic aberration
    chromaticEnabled: false,
    chromaticStrength: 0.5,
    chromaticAngle: 0.0,         // degrees
});

/**
 * Distortion strength slider range for a given distortion type.
 * Sine Wave is 0..5; Swirl / Fish Eye are −10..10.
 * @param {number} type
 * @returns {{min: number, max: number}}
 */
export function distortStrengthRange(type) {
    return type === 3 ? {min: 0.0, max: 5.0} : {min: -10.0, max: 10.0};
}

/**
 * Whether a blur type exposes the angle slider (Tilt-Shift=2, Directional=5).
 * @param {number} type
 * @returns {boolean}
 */
export function blurHasAngle(type) {
    return type === 2 || type === 5;
}

/**
 * Whether a blur type exposes the strength slider (everything but None).
 * @param {number} type
 * @returns {boolean}
 */
export function blurHasStrength(type) {
    return type !== 0;
}
