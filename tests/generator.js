// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for the wallpaper Generator modules.
//
// Run with: GDK_BACKEND=headless gjs -m tests/generator.js
// (also wired into `make check`). No GTK widgets are constructed: presets,
// engine and palettes are pure data/logic or GdkPixbuf-only. The optional
// render group is skipped when python3 + numpy + Pillow are unavailable.

import System from 'system';
import GLib from 'gi://GLib';

import {
    PRESET_NAMES,
    controlsFor,
    GLOBAL_DEFAULTS,
    DISTORTION_TYPES,
    EFFECT_TYPES,
    LIGHTING_TYPES,
    BLUR_TYPES,
    distortStrengthRange,
    blurHasAngle,
} from '../lib/generator/presets.js';
import {
    EXPORT_RESOLUTIONS,
    defaultUiState,
    applyPreset,
    randomizeUiState,
    buildSpec,
    normalizeFormat,
    checkAvailable,
    generatorPath,
} from '../lib/generator/engine.js';
import {
    listCategories,
    extractColors,
    allPalettePaths,
    pickRandomPath,
} from '../lib/generator/palettes.js';

class Group {
    constructor(name) {
        this.name = name;
        this.pass = 0;
        this.fail = 0;
    }

    ok(condition, name, message = '') {
        if (condition) {
            this.pass++;
        } else {
            this.fail++;
            console.log(`    FAIL  ${name}${message ? ` — ${message}` : ''}`);
        }
        return condition;
    }

    eq(actual, expected, name) {
        return this.ok(
            actual === expected,
            name,
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
    }

    close(actual, expected, name, eps = 1e-6) {
        return this.ok(
            Math.abs(actual - expected) < eps,
            name,
            `expected ~${expected}, got ${actual}`
        );
    }

    done() {
        console.log(`  ${this.name}: PASS ${this.pass} FAIL ${this.fail}`);
        return this.fail === 0;
    }
}

/** Small deterministic RNG (mulberry32) so randomize tests are reproducible. */
function seededRng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------

function testPresets() {
    const g = new Group('presets');

    g.eq(PRESET_NAMES.length, 7, 'seven presets');
    g.eq(PRESET_NAMES[0], 'Bars', 'first preset is Bars');
    g.eq(PRESET_NAMES[2], 'Plasma', 'third preset is Plasma');

    const bars = controlsFor('Bars');
    g.eq(bars.hasAngle, true, 'Bars has angle');
    g.eq(bars.hasScale, false, 'Bars has no scale');
    g.eq(bars.speedLabel, 'Speed', 'Bars speed label is Speed');

    const plasma = controlsFor('Plasma');
    g.eq(plasma.hasAngle, false, 'Plasma has no angle');
    g.eq(plasma.hasScale, true, 'Plasma has scale');
    g.eq(plasma.hasSpeed, true, 'Plasma has speed');
    g.eq(plasma.speedLabel, 'Time', 'Plasma speed label is Time');
    g.close(plasma.scaleRange[0], 0.1, 'Plasma scale min 0.1');
    g.close(plasma.scaleRange[1], 2.0, 'Plasma scale max 2.0');
    g.close(plasma.scaleRange[3], 1.0, 'Plasma scale default 1.0');

    const terrain = controlsFor('Terrain');
    g.close(terrain.scaleRange[3], 0.5, 'Terrain scale default 0.5');
    g.close(terrain.scaleRange[2], 0.01, 'Terrain scale step 0.01');

    const dunes = controlsFor('Dunes');
    g.eq(dunes.hasVariation, true, 'Dunes has variation');
    g.close(dunes.variationRange[1], 20.0, 'Dunes variation max 20');

    const circle = controlsFor('Circle');
    g.eq(circle.hasSpeed, false, 'Circle has no speed');
    g.eq(circle.hasCenter, true, 'Circle has center');

    // Unknown name falls back to the Bars-like default.
    g.eq(controlsFor('Nope').hasAngle, true, 'unknown preset falls back to angle');

    g.eq(DISTORTION_TYPES.length, 4, 'four distortion types');
    g.eq(EFFECT_TYPES.length, 4, 'four effect types');
    g.eq(LIGHTING_TYPES.length, 3, 'three lighting types');
    g.eq(BLUR_TYPES.length, 6, 'six blur types');

    const sine = distortStrengthRange(3);
    g.close(sine.min, 0.0, 'sine distortion min 0');
    g.close(sine.max, 5.0, 'sine distortion max 5');
    const swirl = distortStrengthRange(1);
    g.close(swirl.min, -10.0, 'swirl distortion min -10');
    g.close(swirl.max, 10.0, 'swirl distortion max 10');

    g.eq(blurHasAngle(2), true, 'tilt-shift blur has angle');
    g.eq(blurHasAngle(5), true, 'directional blur has angle');
    g.eq(blurHasAngle(1), false, 'gaussian blur has no angle');

    g.close(GLOBAL_DEFAULTS.angle, 45.0, 'global angle default 45');
    g.close(GLOBAL_DEFAULTS.lightAngle, 45.0, 'global light angle default 45');
    g.close(GLOBAL_DEFAULTS.blend, 0.5, 'global blend default 0.5');

    return g;
}

function testEngine() {
    const g = new Group('engine');

    g.eq(EXPORT_RESOLUTIONS.length, 5, 'five export resolutions');
    g.eq(EXPORT_RESOLUTIONS[0].width, 0, 'display resolution has no fixed width');
    g.eq(EXPORT_RESOLUTIONS[1].width, 1920, 'HD width 1920');
    g.eq(EXPORT_RESOLUTIONS[3].height, 2160, '4K height 2160');
    g.eq(EXPORT_RESOLUTIONS[4].width, 1080, 'phone width 1080');

    const st = defaultUiState('Terrain');
    g.eq(st.preset, 'Terrain', 'default state carries preset');
    g.close(st.scale, 0.5, 'default state uses preset scale default');
    g.eq(st.colors, null, 'default state has no colors yet');

    const st2 = defaultUiState('Bogus');
    g.eq(st2.preset, 'Bars', 'invalid preset falls back to Bars');

    applyPreset(st2, 'Dunes');
    g.eq(st2.preset, 'Dunes', 'applyPreset switches preset');
    g.close(st2.center, 0.0, 'applyPreset resets center');
    g.close(st2.variation, 0.0, 'applyPreset resets variation default');

    // Spec conversions.
    const spec = buildSpec(defaultUiState('Bars'), {
        width: 100, height: 50, out: '/tmp/x.png',
    });
    g.close(spec.angle, Math.PI / 4, '45 degrees -> PI/4 radians');
    g.close(spec.lighting.angle, -Math.PI / 4, 'light 45deg -> (45-90) rad');
    g.eq(spec.lighting.type, 0, 'lighting disabled -> type 0');
    g.eq(spec.colors, null, 'spec mirrors null colors');
    g.eq(spec.effects.type, 0, 'effect type default 0');

    const lit = defaultUiState('Bars');
    lit.lightingEnabled = true;
    lit.lightingType = 2; // Vignette
    const litSpec = buildSpec(lit, {width: 10, height: 10, out: '/tmp/y.png'});
    g.eq(litSpec.lighting.type, 3, 'vignette combo 2 -> uniform type 3');

    // Randomize is deterministic under a seeded RNG.
    const a = randomizeUiState({rng: seededRng(42)});
    const b = randomizeUiState({rng: seededRng(42)});
    g.eq(a.preset, b.preset, 'randomize preset reproducible');
    g.close(a.angle, b.angle, 'randomize angle reproducible');
    g.eq(a.distortType, b.distortType, 'randomize distort reproducible');
    g.eq(PRESET_NAMES.includes(a.preset), true, 'randomize picks a valid preset');
    g.ok(a.angle >= 0 && a.angle <= 360, 'randomize angle in range');
    g.ok(a.distortType >= 0 && a.distortType <= 3, 'randomize distort in range');
    g.ok(a.blurType >= 0 && a.blurType <= 5, 'randomize blur in range');

    // Randomize respects the chosen preset's scale range.
    const ctrl = controlsFor(a.preset);
    g.ok(a.scale >= ctrl.scaleRange[0] - 1e-9 && a.scale <= ctrl.scaleRange[1] + 1e-9,
        'randomize scale within preset range');

    // Palette override is applied.
    const withPal = randomizeUiState({
        rng: seededRng(7),
        palette: {path: '/tmp/pal.png', colors: [[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0.2, 0.4, 0.6]]},
    });
    g.eq(withPal.palettePath, '/tmp/pal.png', 'randomize applies palette path');
    g.eq(withPal.colors.length, 4, 'randomize applies four colors');

    g.eq(normalizeFormat('JPG'), 'jpg', 'normalizeFormat JPG -> jpg');
    g.eq(normalizeFormat('.jpeg'), 'jpg', 'normalizeFormat .jpeg -> jpg');
    g.eq(normalizeFormat('png'), 'png', 'normalizeFormat png -> png');
    g.eq(normalizeFormat(''), 'png', 'normalizeFormat empty -> png');

    g.ok(generatorPath().endsWith('renderer/generator.py'),
        'generatorPath points at renderer/generator.py');

    return g;
}

function testPalettes() {
    const g = new Group('palettes');

    const cats = listCategories();
    g.ok(cats.length >= 2, 'at least two palette categories found');
    const names = cats.map(c => c.name);
    g.ok(names.includes('cold'), 'cold category present');
    g.ok(names.includes('dark'), 'dark category present');

    const paths = allPalettePaths();
    g.ok(paths.length >= 100, 'many palette images available');
    g.ok(paths.every(p => GLib.path_is_absolute(p)), 'palette paths are absolute');

    if (paths.length) {
        const colors = extractColors(paths[0]);
        g.eq(colors.length, 4, 'extract returns four colors');
        const flat = colors.flat();
        g.ok(flat.every(v => v >= 0 && v <= 1), 'colors normalized to 0..1');
        g.ok(colors.every(c => c.length === 3), 'each color has three channels');
    }

    const p1 = pickRandomPath(seededRng(1));
    const p2 = pickRandomPath(seededRng(1));
    g.eq(p1, p2, 'pickRandomPath deterministic with seeded RNG');
    g.ok(p1 && paths.includes(p1), 'pickRandomPath returns a known path');

    return g;
}

async function testRender() {
    const g = new Group('render');
    const avail = await checkAvailable();
    if (!avail.ok) {
        console.log(`    SKIP  renderer unavailable (${avail.error || 'missing python/numpy/PIL'})`);
        return g;
    }
    g.ok(avail.version.startsWith('mopivo-generator'), 'generator --version reports name');

    const colors = [[0.05, 0.10, 0.30], [0.15, 0.45, 0.75], [0.60, 0.80, 0.95], [0.95, 0.93, 0.82]];
    const out = GLib.build_filenamev([GLib.get_tmp_dir(), 'mopivo_gen_test.png']);

    // Render one preset per family (a shape and a gradient) at tiny size.
    for (const preset of ['Bars', 'Plasma']) {
        const st = defaultUiState(preset);
        st.colors = colors;
        st.palettePath = '/tmp/unit-palette.png';
        const {renderState} = await import('../lib/generator/engine.js');
        await renderState(st, {width: 48, height: 27, out});
        g.ok(GLib.file_test(out, GLib.FileTest.EXISTS), `renders ${preset} to a file`);
    }

    return g;
}

// ---------------------------------------------------------------------------

async function main() {
    const groups = [
        testPresets(),
        testEngine(),
        testPalettes(),
        await testRender(),
    ];

    let pass = 0;
    let fail = 0;
    for (const g of groups) {
        g.done();
        pass += g.pass;
        fail += g.fail;
    }

    console.log('');
    if (fail > 0)
        console.log(`SOME TESTS FAILED (${pass} passed, ${fail} failed)`);
    else
        console.log(`ALL TESTS PASSED (${pass} passed)`);

    return fail > 0;
}

System.exit((await main()) ? 1 : 0);
