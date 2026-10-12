// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for ui/videoGallery.js (online video gallery helpers).
//
// Run with: GDK_BACKEND=headless gjs -m tests/videoGallery.js
// No network, display or GStreamer needed — only the pure helpers
// (videoFileName, resolveVideoDownloadPath, normalizeVideoItems) and the
// registry contract are exercised. Importing the module must not construct
// any GTK widget.

import System from 'system';
import GLib from 'gi://GLib';

import {
    VIDEO_PAGE_SIZE,
    videoFileName,
    resolveVideoDownloadPath,
    normalizeVideoItems,
} from '../ui/videoGallery.js';
import {getDefaultVideoDir} from '../lib/paths.js';
import {VIDEO_PROVIDER_IDS, PROVIDER_META} from '../lib/providers/registry.js';

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
// Group 1 — page size constant
// ---------------------------------------------------------------------------

function testConstants() {
    const g = new Group('constants');

    g.eq(VIDEO_PAGE_SIZE, 10, 'VIDEO_PAGE_SIZE is 10');

    return g;
}

// ---------------------------------------------------------------------------
// Group 2 — videoFileName derivation and sanitization
// ---------------------------------------------------------------------------

function testVideoFileName() {
    const g = new Group('videoFileName');

    const pexelsMp4 = {
        id: '1234',
        videoUrl: 'https://videos.pexels.com/video-files/1234.mp4',
    };
    g.eq(videoFileName('pexels', pexelsMp4), 'pexels-1234.mp4',
        'pexels mp4 keeps the mp4 extension');

    g.eq(
        videoFileName('pexels', {id: '1234', videoUrl: 'https://cdn.example.com/a.webm'}),
        'pexels-1234.webm',
        'webm extension is derived from the url'
    );

    g.eq(
        videoFileName('pexels', {id: '1234', videoUrl: 'https://cdn.example.com/live'}),
        'pexels-1234.mp4',
        'extensionless url falls back to mp4'
    );

    g.eq(
        videoFileName('pexels', {id: '1234', videoUrl: 'not a url'}),
        'pexels-1234.mp4',
        'non-URL videoUrl still defaults to mp4'
    );

    g.eq(
        videoFileName('pexels', {id: '1234', videoUrl: ''}),
        'pexels-1234.mp4',
        'empty videoUrl still defaults to mp4'
    );

    const sanitized = videoFileName('pexels', {id: 'a/b c', videoUrl: 'https://x/a.mp4'});
    g.ok(sanitized.includes('_'), "unsafe id chars are replaced with '_'", sanitized);
    g.ok(!/[\/\s]/.test(sanitized), 'sanitized name has no slash or whitespace', sanitized);
    g.ok(sanitized.endsWith('.mp4'), 'sanitized name keeps the mp4 extension', sanitized);

    return g;
}

// ---------------------------------------------------------------------------
// Group 3 — resolveVideoDownloadPath folder resolution
// ---------------------------------------------------------------------------

function testResolveVideoDownloadPath() {
    const g = new Group('resolveVideoDownloadPath');

    const item = {
        id: '1234',
        videoUrl: 'https://videos.pexels.com/video-files/1234.mp4',
    };

    const defaultStub = {get_string: () => ''};
    const expected = GLib.build_filenamev([getDefaultVideoDir(), 'pexels-1234.mp4']);
    g.eq(resolveVideoDownloadPath(defaultStub, 'pexels', item), expected,
        'empty video-folder falls back to the default video dir');

    const customStub = {
        get_string: (k) => (k === 'video-folder' ? '/tmp/vids' : ''),
    };
    const custom = resolveVideoDownloadPath(customStub, 'pexels', item);
    g.ok(custom.startsWith('/tmp/vids/pexels-1234.mp4'),
        'video-folder from settings prefixes the file name', custom);

    return g;
}

// ---------------------------------------------------------------------------
// Group 4 — normalizeVideoItems filtering and shape
// ---------------------------------------------------------------------------

function testNormalizeVideoItems() {
    const g = new Group('normalizeVideoItems');

    const raw = [
        {
            id: 'v1',
            previewUrl: 'https://x/v1.jpg',
            videoUrl: 'https://x/v1.mp4',
            resolution: '1920x1080',
            duration: 12,
            source: 'Jane Doe',
            sourceUrl: 'https://www.pexels.com/video/v1/',
        },
        {id: 'v2', videoUrl: 'https://x/v2.mp4'},
        {previewUrl: 'https://x/v3.jpg', videoUrl: 'https://x/v3.mp4'},
        {id: 'v4'},
    ];

    const n = normalizeVideoItems(raw);

    g.eq(n.length, 2, 'items missing id or videoUrl are dropped');
    g.eq(n[0].id, 'v1', 'kept item id preserved');
    g.eq(n[0].previewUrl, 'https://x/v1.jpg', 'previewUrl preserved');
    g.eq(n[0].videoUrl, 'https://x/v1.mp4', 'videoUrl preserved');
    g.eq(n[0].resolution, '1920x1080', 'resolution preserved');
    g.eq(n[0].duration, 12, 'duration preserved');
    g.eq(n[0].source, 'Jane Doe', 'source preserved');
    g.eq(n[0].sourceUrl, 'https://www.pexels.com/video/v1/', 'sourceUrl preserved');

    const minimal = normalizeVideoItems([{id: 'x', videoUrl: 'https://x/x.mp4'}]);
    const keys = Object.keys(minimal[0]).sort().join(',');
    const expectedKeys = [
        'id', 'previewUrl', 'videoUrl', 'resolution',
        'duration', 'source', 'sourceUrl',
    ].sort().join(',');
    g.eq(keys, expectedKeys, 'normalized item keeps the canonical shape');
    g.eq(minimal[0].resolution, '', 'missing resolution defaults to empty string');
    g.eq(minimal[0].duration, 0, 'missing duration defaults to 0');
    g.eq(minimal[0].source, '', 'missing source defaults to empty string');
    g.eq(minimal[0].sourceUrl, '', 'missing sourceUrl defaults to empty string');
    g.eq(minimal[0].previewUrl, '', 'missing previewUrl defaults to empty string');

    for (const [value, label] of [
        [null, 'null'],
        [undefined, 'undefined'],
        [{}, 'object'],
        ['nope', 'string'],
        [42, 'number'],
    ]) {
        const out = normalizeVideoItems(value);
        g.ok(Array.isArray(out) && out.length === 0,
            `non-array input (${label}) yields []`);
    }

    return g;
}

// ---------------------------------------------------------------------------
// Group 5 — registry integration
// ---------------------------------------------------------------------------

function testRegistryIntegration() {
    const g = new Group('registry integration');

    g.eq(
        JSON.stringify(VIDEO_PROVIDER_IDS),
        JSON.stringify(['pexels', 'pixabay', 'streaming']),
        'VIDEO_PROVIDER_IDS deep-equals [pexels, pixabay]'
    );
    g.eq(PROVIDER_META.pexels.supportsVideo, true,
        'PROVIDER_META.pexels.supportsVideo is true');
    g.eq(PROVIDER_META.pixabay.supportsVideo, true,
        'PROVIDER_META.pixabay.supportsVideo is true');

    return g;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const groups = [
    testConstants(),
    testVideoFileName(),
    testResolveVideoDownloadPath(),
    testNormalizeVideoItems(),
    testRegistryIntegration(),
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
