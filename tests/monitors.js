// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for lib/wallpaper-multi.js (pure placement helpers).
//
// Run with: GDK_BACKEND=headless gjs -m tests/monitors.js
// No network, display or GTK window needed: only parse/normalize plus a real
// GdkPixbuf composite of two tiny generated PNGs.

import System from 'system';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {
    parseMonitorAssignments,
    normalizeRects,
    composite,
    wallpaperCacheDir,
} from '../lib/wallpaper-multi.js';

// ---------------------------------------------------------------------------
// Assertion helpers (same style as tests/run.js)
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
// Group 1 — parseMonitorAssignments
// ---------------------------------------------------------------------------

function testParse() {
    const g = new Group('parseMonitorAssignments');

    const parsed = parseMonitorAssignments([
        'HDMI-1=file:///home/u/a.jpg',
        'eDP-1=file:///home/u/b.jpg',
    ]);
    g.eq(parsed.length, 2, 'two valid entries parsed');
    g.eq(parsed[0].connector, 'HDMI-1', 'first connector parsed');
    g.eq(parsed[0].uri, 'file:///home/u/a.jpg', 'first uri parsed');
    g.eq(parsed[1].connector, 'eDP-1', 'second connector parsed');
    g.eq(parsed[1].uri, 'file:///home/u/b.jpg', 'second uri parsed');

    // A URI containing '=' keeps everything after the first separator.
    const withEquals = parseMonitorAssignments(['DP-1=file:///x/a=b.jpg']);
    g.eq(withEquals.length, 1, 'uri with equals still parses');
    g.eq(withEquals[0].uri, 'file:///x/a=b.jpg', 'uri keeps the trailing equals');

    // Malformed entries are skipped, valid ones survive.
    const mixed = parseMonitorAssignments([
        'no-equals-here',
        '=file:///empty-connector.jpg',
        'HDMI-1=',
        '   ',
        'eDP-1=file:///ok.jpg',
    ]);
    g.eq(mixed.length, 1, 'only the well-formed entry survives');
    g.eq(mixed[0].connector, 'eDP-1', 'surviving connector is eDP-1');
    g.eq(mixed[0].uri, 'file:///ok.jpg', 'surviving uri is kept');

    g.eq(parseMonitorAssignments([]).length, 0, 'empty array yields []');
    g.eq(parseMonitorAssignments(null).length, 0, 'null yields []');
    g.eq(parseMonitorAssignments(undefined).length, 0, 'undefined yields []');
    g.eq(parseMonitorAssignments('garbage').length, 0, 'garbage string yields []');
    g.eq(parseMonitorAssignments([1, 2]).length, 0, 'non-string entries yield []');

    return g;
}

// ---------------------------------------------------------------------------
// Group 2 — normalizeRects
// ---------------------------------------------------------------------------

function testNormalize() {
    const g = new Group('normalizeRects');

    // Monitor to the left of origin: x = -1920. The other sits at 0,0.
    const norm = normalizeRects([
        {x: -1920, y: 0, width: 1920, height: 1080},
        {x: 0, y: 0, width: 800, height: 600},
    ]);
    g.eq(norm.rects.length, 2, 'both rects kept');
    g.eq(norm.width, 2720, 'bounding box width is 1920 + 800');
    g.eq(norm.height, 1080, 'bounding box height is the tallest monitor');
    g.eq(norm.rects[0].x, 0, 'leftmost rect shifts to x = 0');
    g.eq(norm.rects[0].y, 0, 'leftmost rect y stays 0');
    g.eq(norm.rects[1].x, 1920, 'second rect shifts by +1920');
    g.eq(norm.rects[0].width, 1920, 'first rect width preserved');
    g.eq(norm.rects[1].height, 600, 'second rect height preserved');

    // Arbitrary order + negative y as well.
    const shuffled = normalizeRects([
        {x: 1920, y: -240, width: 1920, height: 1080},
        {x: 0, y: 0, width: 1920, height: 1080},
    ]);
    g.eq(shuffled.width, 3840, 'two side-by-side monitors give width 3840');
    g.eq(shuffled.height, 1320, 'bounding box height spans the -240..1080 range');
    g.eq(shuffled.rects[0].x, 1920, 'right-hand monitor keeps relative x');
    g.eq(shuffled.rects[0].y, 0, 'negative y shifts to origin');
    g.eq(shuffled.rects[1].x, 0, 'origin monitor shifts to x = 0');
    g.eq(shuffled.rects[1].y, 240, 'origin monitor shifts down by 240');

    const empty = normalizeRects([]);
    g.eq(empty.rects.length, 0, 'empty input yields no rects');
    g.eq(empty.width, 0, 'empty input width 0');
    g.eq(empty.height, 0, 'empty input height 0');

    return g;
}

// ---------------------------------------------------------------------------
// Group 3 — composite (real GdkPixbuf canvas)
// ---------------------------------------------------------------------------

function makePng(path, rgba) {
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 40, 40);
    pb.fill(rgba);
    pb.savev(path, 'png', [], []);
    return path;
}

function fileUri(path) {
    return Gio.File.new_for_path(path).get_uri();
}

function pixelAt(pixbuf, x, y) {
    const rowstride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const pixels = pixbuf.get_pixels();
    const off = y * rowstride + x * channels;
    return [pixels[off], pixels[off + 1], pixels[off + 2]];
}

function testComposite() {
    const g = new Group('composite');

    const dir = GLib.build_filenamev([GLib.get_tmp_dir(), 'mopivo-monitors-test']);
    GLib.mkdir_with_parents(dir, 0o755);

    const redPath = makePng(GLib.build_filenamev([dir, 'red.png']), 0xff0000ff);
    const bluePath = makePng(GLib.build_filenamev([dir, 'blue.png']), 0x0000ffff);
    const outPath = GLib.build_filenamev([dir, 'canvas.png']);

    const norm = normalizeRects([
        {x: -1920, y: 0, width: 1920, height: 1080},
        {x: 0, y: 0, width: 800, height: 600},
    ]);

    const returned = composite(
        [fileUri(redPath), fileUri(bluePath)], norm.rects, outPath);
    g.eq(returned, outPath, 'composite returns the output path');

    const outFile = Gio.File.new_for_path(outPath);
    g.ok(outFile.query_exists(null), 'output PNG exists');

    const out = GdkPixbuf.Pixbuf.new_from_file(outPath);
    g.eq(out.get_width(), norm.width, 'canvas width equals the bounding box width');
    g.eq(out.get_height(), norm.height, 'canvas height equals the bounding box height');

    const left = pixelAt(out, 100, 100);
    g.ok(left[0] > 200 && left[1] < 60 && left[2] < 60,
        'left monitor is covered by the red image');
    const right = pixelAt(out, 2200, 100);
    g.ok(right[2] > 200 && right[0] < 60 && right[1] < 60,
        'right monitor is covered by the blue image');

    const cache = wallpaperCacheDir();
    g.ok(typeof cache === 'string' && cache.length > 0,
        'wallpaperCacheDir returns a non-empty path');

    return g;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const groups = [];
    groups.push(testParse());
    groups.push(testNormalize());
    groups.push(testComposite());

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
