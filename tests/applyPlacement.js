// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for lib/applyPlacement.js (pure placement helpers).
//
// Run with: GDK_BACKEND=headless gjs -m tests/applyPlacement.js
// No display, network or GTK window needed.

import System from 'system';

import {
    PLACEMENT_COPY,
    PLACEMENT_EXTEND,
    normalizeMonitors,
    allConnectors,
    buildPerMonitorEntries,
    settingsForPlacement,
    placementSummary,
} from '../lib/applyPlacement.js';

// ---------------------------------------------------------------------------
// Assertion helpers (same style as tests/monitors.js)
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
// Group 1 — normalizeMonitors
// ---------------------------------------------------------------------------

function testNormalizeMonitors() {
    const g = new Group('normalizeMonitors');

    // Out of order, with a duplicate connector and a negative origin.
    const norm = normalizeMonitors([
        {connector: 'HDMI-1', x: 1920, y: 0, width: 1920, height: 1080},
        {connector: 'eDP-1', x: 0, y: 0, width: 1920, height: 1080},
        {connector: 'HDMI-1', x: 9999, y: 9999, width: 1, height: 1},
        {connector: 'DP-2', x: -1280, y: 0, width: 1280, height: 1024},
    ]);

    g.eq(norm.length, 3, 'duplicate connector is dropped');
    g.eq(norm[0].connector, 'DP-2', 'leftmost monitor sorts first');
    g.eq(norm[1].connector, 'eDP-1', 'origin monitor sorts second');
    g.eq(norm[2].connector, 'HDMI-1', 'right-hand monitor sorts last');
    g.eq(norm[2].x, 1920, 'the duplicate entry did not overwrite the first');
    g.eq(norm[0].x, -1280, 'negative x is preserved');
    g.eq(norm[2].width, 1920, 'width preserved');

    // Coercion + defaults.
    const coerced = normalizeMonitors([
        {connector: 'A', x: '10', y: undefined, width: '-5', height: '720'},
        null,
        'garbage',
        {connector: 'B', name: 'Built-in', width: 800, height: 600},
    ]);
    g.eq(coerced.length, 2, 'non-object entries are skipped');
    g.eq(coerced[0].connector, 'B', 'origin monitor sorts first');
    g.eq(coerced[0].name, 'Built-in', 'explicit name kept');
    g.eq(coerced[0].height, 600, 'default height kept');
    g.eq(coerced[1].connector, 'A', 'string connector kept');
    g.eq(coerced[1].x, 10, 'numeric string x coerced');
    g.eq(coerced[1].y, 0, 'undefined y becomes 0');
    g.eq(coerced[1].width, 0, 'negative width clamps to 0');
    g.eq(coerced[1].height, 720, 'string height coerced');
    g.eq(coerced[1].name, 'A', 'name defaults to the connector');

    g.eq(normalizeMonitors(null).length, 0, 'null yields []');
    g.eq(normalizeMonitors(undefined).length, 0, 'undefined yields []');

    return g;
}

// ---------------------------------------------------------------------------
// Group 2 — allConnectors
// ---------------------------------------------------------------------------

function testAllConnectors() {
    const g = new Group('allConnectors');

    const conns = allConnectors([
        {connector: 'HDMI-1', x: 1920, width: 1920, height: 1080},
        {connector: 'eDP-1', x: 0, width: 1920, height: 1080},
        {connector: '', x: 0, width: 100, height: 100},
    ]);
    g.eq(conns.length, 2, 'blank connector is skipped');
    g.eq(conns[0], 'eDP-1', 'connectors follow normalized order');
    g.eq(conns[1], 'HDMI-1', 'second connector returned');
    g.eq(allConnectors([]).length, 0, 'empty list yields []');

    return g;
}

// ---------------------------------------------------------------------------
// Group 3 — buildPerMonitorEntries
// ---------------------------------------------------------------------------

function testBuildEntries() {
    const g = new Group('buildPerMonitorEntries');

    const entries = buildPerMonitorEntries(
        ['HDMI-1', 'eDP-1', 'HDMI-1'], 'file:///home/u/a.jpg');
    g.eq(entries.length, 2, 'duplicate connectors are collapsed');
    g.eq(entries[0], 'HDMI-1=file:///home/u/a.jpg', 'entry uses connector=uri');
    g.eq(entries[1], 'eDP-1=file:///home/u/a.jpg', 'second entry built');

    const withEquals = buildPerMonitorEntries(['DP-1'], 'file:///x/a=b.jpg');
    g.eq(withEquals[0], 'DP-1=file:///x/a=b.jpg', 'uri may contain =');
    g.ok(withEquals[0].indexOf('=') === 'DP-1'.length,
        'separator is the first = after the connector');

    g.eq(buildPerMonitorEntries(['HDMI-1'], '').length, 0, 'blank uri yields []');
    g.eq(buildPerMonitorEntries([], 'file:///a.jpg').length, 0, 'no connectors yields []');
    g.eq(buildPerMonitorEntries(['', '  '], 'file:///a.jpg').length, 0,
        'blank connectors are skipped');
    g.eq(buildPerMonitorEntries(null, 'file:///a.jpg').length, 0, 'null list yields []');

    return g;
}

// ---------------------------------------------------------------------------
// Group 4 — settingsForPlacement
// ---------------------------------------------------------------------------

function testSettingsForPlacement() {
    const g = new Group('settingsForPlacement');

    const copy = settingsForPlacement({
        placement: PLACEMENT_COPY,
        connectors: ['HDMI-1', 'eDP-1'],
        uri: 'file:///home/u/a.jpg',
    });
    g.eq(copy.mode, 'per-monitor', 'copy maps to per-monitor mode');
    g.eq(copy.defaultUri, 'file:///home/u/a.jpg', 'copy keeps the uri as default');
    g.eq(copy.perMonitor.length, 2, 'copy builds one entry per connector');
    g.eq(copy.perMonitor[0], 'HDMI-1=file:///home/u/a.jpg', 'copy entry format');

    const extend = settingsForPlacement({
        placement: PLACEMENT_EXTEND,
        connectors: ['HDMI-1', 'eDP-1'],
        uri: 'file:///home/u/b.jpg',
    });
    g.eq(extend.mode, 'span', 'extend maps to span mode');
    g.eq(extend.defaultUri, 'file:///home/u/b.jpg', 'extend keeps the uri as default');
    g.eq(extend.perMonitor.length, 0, 'extend has no per-monitor entries');

    const fallback = settingsForPlacement({connectors: ['HDMI-1']});
    g.eq(fallback.mode, 'per-monitor', 'unknown placement defaults to copy');
    g.eq(fallback.defaultUri, '', 'missing uri yields an empty default');
    g.eq(fallback.perMonitor.length, 0, 'missing uri yields no entries');

    return g;
}

// ---------------------------------------------------------------------------
// Group 5 — placementSummary
// ---------------------------------------------------------------------------

function testPlacementSummary() {
    const g = new Group('placementSummary');

    const copy = placementSummary(PLACEMENT_COPY, 2);
    const single = placementSummary(PLACEMENT_COPY, 1);
    const extend = placementSummary(PLACEMENT_EXTEND, 3);

    g.ok(typeof copy === 'string' && copy.length > 0, 'copy summary is a string');
    g.ok(copy.includes('2'), 'copy summary includes the count');
    g.ok(single.includes('1'), 'single summary includes the count');
    g.ok(extend.includes('3'), 'extend summary includes the count');
    g.ok(copy !== extend, 'copy and extend summaries differ');
    g.ok(placementSummary(PLACEMENT_COPY, 0).length > 0, 'zero count still renders');

    return g;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const groups = [
        testNormalizeMonitors(),
        testAllConnectors(),
        testBuildEntries(),
        testSettingsForPlacement(),
        testPlacementSummary(),
    ];

    let pass = 0;
    let fail = 0;
    for (const group of groups) {
        group.done();
        pass += group.pass;
        fail += group.fail;
    }

    console.log('');
    if (fail > 0)
        console.log(`SOME TESTS FAILED (${pass} passed, ${fail} failed)`);
    else
        console.log(`ALL TESTS PASSED (${pass} passed)`);

    return fail > 0;
}

System.exit((await main()) ? 1 : 0);
