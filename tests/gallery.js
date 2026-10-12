// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for ui/gallery.js (normalizeResult).
//
// Run with: GDK_BACKEND=headless gjs -m tests/gallery.js
// No network, display or GStreamer needed — only the pure normalization
// helper is exercised; importing the module must not construct widgets.

import System from 'system';

import {normalizeResult, extensionFor} from '../ui/gallery.js';

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
// Group 1 — wallhaven-shaped payload
// ---------------------------------------------------------------------------

function testWallhavenShape() {
    const g = new Group('normalizeResult wallhaven');

    const raw = {
        items: [
            {
                id: 'e4r9tb',
                thumbs: {small: 'https://w.wallhaven.cc/thumb/small/e4r9tb.jpg'},
                path: 'https://w.wallhaven.cc/full/e4r9tb.jpg',
                resolution: '1920x1080',
                url: 'https://wallhaven.cc/w/e4r9tb',
                purity: 'sfw',
            },
            {
                id: '7k2mqn',
                thumbs: {small: 'https://w.wallhaven.cc/thumb/small/7k2mqn.jpg'},
                path: 'https://w.wallhaven.cc/full/7k2mqn.jpg',
                resolution: '3840x2160',
            },
        ],
        meta: {current_page: 3, last_page: 10, total: 240},
    };
    const n = normalizeResult(raw, 1);

    g.eq(n.results.length, 2, 'results length is 2');
    g.eq(n.page, 3, 'page comes from meta.current_page');
    g.eq(n.totalPage, 10, 'totalPage comes from meta.last_page');

    const first = n.results[0];
    g.eq(first.id, 'e4r9tb', 'item id mapped');
    g.eq(first.previewUrl, 'https://w.wallhaven.cc/thumb/small/e4r9tb.jpg',
        'item previewUrl mapped from thumbs.small');
    g.eq(first.fullUrl, 'https://w.wallhaven.cc/full/e4r9tb.jpg',
        'item fullUrl mapped from path');
    g.eq(first.path, first.fullUrl, 'item path aliases fullUrl');
    g.eq(first.resolution, '1920x1080', 'item resolution kept as-is');
    g.eq(first.width, 1920, 'item width parsed from resolution');
    g.eq(first.height, 1080, 'item height parsed from resolution');
    g.eq(first.sourceUrl, 'https://wallhaven.cc/w/e4r9tb',
        'item sourceUrl mapped from raw url');

    const second = n.results[1];
    g.eq(second.width, 3840, 'second item width parsed');
    g.eq(second.height, 2160, 'second item height parsed');

    return g;
}

// ---------------------------------------------------------------------------
// Group 2 — generic {data, meta} payload
// ---------------------------------------------------------------------------

function testGenericShape() {
    const g = new Group('normalizeResult generic');

    const raw = {
        data: [
            {
                id: 'a1',
                thumbnail: 'https://cdn.example.com/a1_t.jpg',
                image: 'https://cdn.example.com/a1_full.jpg',
                dimensions: '800x600',
            },
            {
                id: 'b2',
                urls: {thumb: 'https://cdn.example.com/b2_t.jpg',
                    full: 'https://cdn.example.com/b2_full.jpg'},
                resolution: '1600x900',
            },
        ],
        meta: {current_page: 2, per_page: 24, total: 100},
    };
    const n = normalizeResult(raw, 7);

    g.eq(n.results.length, 2, 'results length is 2');
    g.eq(n.page, 2, 'page comes from meta.current_page');
    g.eq(n.totalPage, 5, 'totalPage derived from ceil(total / per_page)');

    const first = n.results[0];
    g.eq(first.id, 'a1', 'generic item id mapped');
    g.eq(first.previewUrl, 'https://cdn.example.com/a1_t.jpg',
        'previewUrl mapped from thumbnail');
    g.eq(first.fullUrl, 'https://cdn.example.com/a1_full.jpg',
        'fullUrl mapped from image');
    g.eq(first.resolution, '800x600', 'resolution mapped from dimensions');
    g.eq(first.width, 800, 'width parsed from dimensions');
    g.eq(first.height, 600, 'height parsed from dimensions');

    const second = n.results[1];
    g.eq(second.previewUrl, 'https://cdn.example.com/b2_t.jpg',
        'previewUrl mapped from urls.thumb');
    g.eq(second.fullUrl, 'https://cdn.example.com/b2_full.jpg',
        'fullUrl mapped from urls.full');
    g.eq(second.width, 1600, 'second width parsed from resolution');
    g.eq(second.height, 900, 'second height parsed from resolution');

    return g;
}

// ---------------------------------------------------------------------------
// Group 3 — malformed / empty payloads
// ---------------------------------------------------------------------------

function testEmptyShapes() {
    const g = new Group('normalizeResult empty');

    const emptyObj = normalizeResult({}, 4);
    g.eq(emptyObj.results.length, 0, '{} yields an empty results list');
    g.eq(emptyObj.page, 4, '{} preserves the fallback page');
    g.eq(emptyObj.totalPage, 1, '{} yields a single page');

    const emptyItems = normalizeResult({items: []}, 2);
    g.eq(emptyItems.results.length, 0, '{items: []} yields an empty results list');
    g.eq(emptyItems.page, 2, '{items: []} preserves the fallback page');
    g.eq(emptyItems.totalPage, 1, '{items: []} yields a single page');

    const nullPayload = normalizeResult(null, 3);
    g.eq(nullPayload.results.length, 0, 'null yields an empty results list');
    g.eq(nullPayload.page, 3, 'null preserves the fallback page');

    const noItems = normalizeResult({meta: {current_page: 1}}, 5);
    g.eq(noItems.results.length, 0, 'payload without items yields nothing');
    g.eq(noItems.page, 5, 'payload without items preserves the fallback page');

    return g;
}

// ---------------------------------------------------------------------------
// Group 4 — already-normalized provider payload (modern providers)
// ---------------------------------------------------------------------------

function testNormalizedShape() {
    const g = new Group('normalizeResult normalized');

    const raw = {
        items: [
            {
                id: 'wh-1',
                previewUrl: 'https://w.wallhaven.cc/thumb/small/wh-1.jpg',
                fullUrl: 'https://w.wallhaven.cc/full/wh-1.jpg',
                resolution: '2560x1440',
                previewWidth: 2560,
                previewHeight: 1440,
                source: 'wallhaven',
            },
        ],
        total: 12,
        page: 2,
        lastPage: 3,
    };
    const n = normalizeResult(raw, 1);

    g.eq(n.results.length, 1, 'normalized payload passes items through');
    g.eq(n.page, 2, 'page comes from payload page field');
    g.eq(n.totalPage, 3, 'totalPage comes from payload lastPage field');
    g.eq(n.results[0].previewUrl, 'https://w.wallhaven.cc/thumb/small/wh-1.jpg',
        'normalized previewUrl kept');
    g.eq(n.results[0].width, 2560, 'normalized previewWidth kept over parsing');

    return g;
}

// ---------------------------------------------------------------------------
// Group 5 — download extension derivation
// ---------------------------------------------------------------------------

function testExtensionFor() {
    const g = new Group('extensionFor');

    g.eq(extensionFor('https://x/a.jpg'), 'jpg', 'jpg kept');
    g.eq(extensionFor('https://x/a.jpeg'), 'jpeg', 'jpeg kept');
    g.eq(extensionFor('https://x/a.png?w=100'), 'png', 'query string is ignored');
    g.eq(extensionFor('https://x/a.webp#frag'), 'webp', 'fragment is ignored');
    g.eq(extensionFor('https://x/PHOTO.JPG'), 'jpg', 'extension is lowercased');
    g.eq(extensionFor('https://x/a.gif'), 'jpg', 'unsupported extension → jpg');
    g.eq(extensionFor('https://x/noext'), 'jpg', 'no extension → jpg');
    g.eq(extensionFor('not a url'), 'jpg', 'non-URL input → jpg');
    g.eq(extensionFor(''), 'jpg', 'empty input → jpg');

    return g;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const groups = [
    testWallhavenShape(),
    testGenericShape(),
    testEmptyShapes(),
    testNormalizedShape(),
    testExtensionFor(),
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