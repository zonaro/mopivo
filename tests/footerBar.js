// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for ui/footerBar.js (footer video/streaming controls).
//
// Run with: GDK_BACKEND=headless gjs -m tests/footerBar.js
// No display, GStreamer or D-Bus needed: importing the module builds no widget,
// so only the pure helpers and the exported class surface are exercised.
// English is forced so the label assertions are locale-independent.

import System from 'system';

import {
    FooterBar,
    FOOTER_SOURCE_TYPES,
    FOOTER_FIT_MODES,
    volumeToPercent,
    percentToScale,
    fitModeChoices,
    fitModeIndex,
    describeSource,
} from '../ui/footerBar.js';
import {initI18n} from '../lib/i18n.js';

initI18n('en');

// ---------------------------------------------------------------------------
// Assertion helpers (same style as tests/videoGallery.js)
// ---------------------------------------------------------------------------

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

    done() {
        console.log(`  ${this.name}: PASS ${this.pass} FAIL ${this.fail}`);
        return this.fail === 0;
    }
}

// ---------------------------------------------------------------------------
// Group 1 — exported API surface
// ---------------------------------------------------------------------------

function testModuleApi() {
    const g = new Group('module api');

    g.eq(typeof FooterBar, 'function', 'FooterBar is a class');
    for (const fn of [volumeToPercent, percentToScale, fitModeChoices,
        fitModeIndex, describeSource]) {
        g.eq(typeof fn, 'function', `${fn.name} is a function`);
    }
    for (const method of ['setActive', 'sync', 'destroy']) {
        g.eq(typeof FooterBar.prototype[method], 'function',
            `FooterBar.prototype.${method} is a function`);
    }
    const widgetDescriptor = Object.getOwnPropertyDescriptor(
        FooterBar.prototype, 'widget');
    g.eq(typeof widgetDescriptor?.get, 'function',
        'FooterBar.prototype.widget is a getter');

    g.ok(Array.isArray(FOOTER_SOURCE_TYPES), 'FOOTER_SOURCE_TYPES is an array');
    g.eq(FOOTER_SOURCE_TYPES.join(','), 'local,streaming,webpage',
        'FOOTER_SOURCE_TYPES lists local/streaming/webpage');
    g.eq(FOOTER_FIT_MODES.join(','), 'fill,contain,cover,scale-down',
        'FOOTER_FIT_MODES mirrors the schema choices');

    return g;
}

// ---------------------------------------------------------------------------
// Group 2 — volumeToPercent (slider 0..1 → stored 0..100 percent)
// ---------------------------------------------------------------------------

function testVolumeToPercent() {
    const g = new Group('volumeToPercent');

    g.eq(volumeToPercent(0), 0, '0 → 0');
    g.eq(volumeToPercent(0.25), 25, '0.25 → 25');
    g.eq(volumeToPercent(0.5), 50, '0.5 → 50');
    g.eq(volumeToPercent(0.999), 100, '0.999 rounds up to 100');
    g.eq(volumeToPercent(1), 100, '1 → 100');

    g.eq(volumeToPercent(1.5), 100, 'values above 1 clamp to 100');
    g.eq(volumeToPercent(-1), 0, 'negative values clamp to 0');
    g.eq(volumeToPercent('0.5'), 50, 'numeric strings are coerced');
    g.eq(volumeToPercent(null), 0, 'null coerces to 0');
    g.eq(volumeToPercent(undefined), 0, 'undefined is not finite → 0');
    g.eq(volumeToPercent(NaN), 0, 'NaN is not finite → 0');
    g.eq(volumeToPercent(Infinity), 0, 'Infinity is not finite → 0');

    return g;
}

// ---------------------------------------------------------------------------
// Group 3 — percentToScale (stored 0..100 percent → slider 0..1)
// ---------------------------------------------------------------------------

function testPercentToScale() {
    const g = new Group('percentToScale');

    g.eq(percentToScale(0), 0, '0 → 0');
    g.eq(percentToScale(25), 0.25, '25 → 0.25');
    g.eq(percentToScale(50), 0.5, '50 → 0.5');
    g.eq(percentToScale(100), 1, '100 → 1');

    g.eq(percentToScale(150), 1, 'values above 100 clamp to 1');
    g.eq(percentToScale(-10), 0, 'negative values clamp to 0');
    g.eq(percentToScale('50'), 0.5, 'numeric strings are coerced');
    g.eq(percentToScale(undefined), 0, 'undefined is not finite → 0');
    g.eq(percentToScale(NaN), 0, 'NaN is not finite → 0');

    return g;
}

// ---------------------------------------------------------------------------
// Group 4 — fitModeChoices
// ---------------------------------------------------------------------------

function testFitModeChoices() {
    const g = new Group('fitModeChoices');

    const choices = fitModeChoices();
    g.eq(choices.length, 4, 'four fit-mode choices');
    g.eq(choices.map((c) => c.value).join(','), FOOTER_FIT_MODES.join(','),
        'choice values follow FOOTER_FIT_MODES order');
    g.eq(choices.map((c) => c.label).join(','), 'Fill,Contain,Cover,Scale down',
        'labels are translated English strings');

    for (const choice of choices) {
        g.ok(typeof choice.value === 'string' && choice.value.length > 0,
            `choice ${JSON.stringify(choice.value)} has a non-empty value`);
        g.ok(typeof choice.label === 'string' && choice.label.length > 0,
            `choice ${JSON.stringify(choice.value)} has a non-empty label`);
    }

    // A fresh call returns an independent array (no shared mutable state).
    g.ok(choices !== fitModeChoices(), 'each call returns a new array');

    return g;
}

// ---------------------------------------------------------------------------
// Group 5 — fitModeIndex
// ---------------------------------------------------------------------------

function testFitModeIndex() {
    const g = new Group('fitModeIndex');

    g.eq(fitModeIndex('fill'), 0, 'fill → 0');
    g.eq(fitModeIndex('contain'), 1, 'contain → 1');
    g.eq(fitModeIndex('cover'), 2, 'cover → 2');
    g.eq(fitModeIndex('scale-down'), 3, 'scale-down → 3');

    g.eq(fitModeIndex('bogus'), 1, 'unknown mode falls back to contain');
    g.eq(fitModeIndex(''), 1, 'empty mode falls back to contain');
    g.eq(fitModeIndex(undefined), 1, 'undefined falls back to contain');

    return g;
}

// ---------------------------------------------------------------------------
// Group 6 — describeSource
// ---------------------------------------------------------------------------

function testDescribeSource() {
    const g = new Group('describeSource');

    g.eq(describeSource('local'), 'Local Files', 'local → Local Files');
    g.eq(describeSource('streaming'), 'Streaming URL', 'streaming → Streaming URL');
    g.eq(describeSource('webpage'), 'Webpage', 'webpage → Webpage');

    g.eq(describeSource('nope'), 'Video', 'unknown type → generic Video label');
    g.eq(describeSource(undefined), 'Video', 'undefined → generic Video label');
    g.eq(describeSource(''), 'Video', 'empty type → generic Video label');

    return g;
}

// ---------------------------------------------------------------------------
// Group 7 — volume round-trip
// ---------------------------------------------------------------------------

function testVolumeRoundTrip() {
    const g = new Group('volume round-trip');

    for (const percent of [0, 1, 10, 33, 50, 66, 99, 100]) {
        g.eq(percentToScale(volumeToPercent(percent / 100)), percent / 100,
            `${percent}% survives slider → percent → slider`);
        g.eq(volumeToPercent(percentToScale(percent)), percent,
            `${percent}% survives percent → slider → percent`);
    }

    return g;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const groups = [
    testModuleApi(),
    testVolumeToPercent(),
    testPercentToScale(),
    testFitModeChoices(),
    testFitModeIndex(),
    testDescribeSource(),
    testVolumeRoundTrip(),
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

System.exit(fail > 0 ? 1 : 0);
