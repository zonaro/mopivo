// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for empty-query fallbacks across image providers.
//
// Run with: GDK_BACKEND=headless gjs -m tests/emptySearch.js
// No network required — private URL builders and _normalize are exercised
// directly against synthetic responses.

import System from 'system';

import {SafebooruProvider} from '../lib/providers/safebooru.js';
import {PixabayProvider} from '../lib/providers/pixabay.js';
import {PexelsProvider} from '../lib/providers/pexels.js';
import {UnsplashProvider} from '../lib/providers/unsplash.js';

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

    contains(haystack, needle, name) {
        if (typeof haystack !== 'string') {
            return this.ok(false, name, 'expected string');
        }
        return this.ok(haystack.includes(needle), name,
            `expected "${needle}" in "${haystack}"`);
    }

    done() {
        console.log(`  ${this.name}: PASS ${this.pass} FAIL ${this.fail}`);
        return this.fail === 0;
    }
}

// Minimal fake settings.
const fakeSettings = {
    get_string: (k) => {
        if (k === 'pixabay-api-key') return 'test-key-pixabay';
        if (k === 'pexels-api-key') return 'test-key-pexels';
        if (k === 'unsplash-api-key') return 'test-key-unsplash';
        return '';
    },
    get_strv: () => ['/tmp'],
};

// ---------------------------------------------------------------------------
// Group 1 — safebooru: empty query produces default tags (wallpaper)
// ---------------------------------------------------------------------------

function testSafebooruEmpty() {
    const g = new Group('safebooru empty query');
    const p = new SafebooruProvider();

    const urlEmpty = p._buildUrl('', 1, 24);
    g.contains(urlEmpty, 'tags=wallpaper', 'empty query uses wallpaper fallback tag');
    g.ok(!urlEmpty.includes('safe:order'), 'no fake safe:order meta-tag is added');

    const urlWhitespace = p._buildUrl('   ', 1, 24);
    g.contains(urlWhitespace, 'tags=wallpaper', 'whitespace-only query uses wallpaper fallback');

    const urlNormal = p._buildUrl('blue_hair scenery', 1, 24);
    g.contains(urlNormal, 'tags=blue_hair_scenery',
        'non-empty query uses user tags only');

    // Synthetic response: 15 items (≥10) → lastPage becomes page+1 when < MAX_PER_PAGE? MAX_PER_PAGE is 100; 15 < 100, so lastPage = page + 1? Let us check.
    const synth = new Array(15).fill(0).map((_, i) => ({
        id: 1000 + i,
        preview_url: `/thumbnails/${i}.jpg`,
        sample_url: `/samples/${i}.jpg`,
        width: 1920,
        height: 1080,
    }));
    const norm = p._normalize(synth, 1);
    g.eq(norm.items.length, 15, 'normalizes ≥10 items');
    g.eq(norm.page, 1, 'page preserved');
    g.eq(norm.lastPage, 1, 'lastPage remains current page when results < MAX_PER_PAGE (no next page inferred)');
    g.eq(norm.total, 15, 'total estimated from count when results > 0');

    return g;
}

// ---------------------------------------------------------------------------
// Group 2 — pixabay: empty query uses q=wallpaper + editors_choice + order=popular
// ---------------------------------------------------------------------------

function testPixabayEmpty() {
    const g = new Group('pixabay empty query');
    const p = new PixabayProvider();

    const urlEmpty = p._buildUrl('test-key-pixabay', '', 1, 24);
    g.contains(urlEmpty, 'q=wallpaper', 'empty query falls back to wallpaper');
    g.contains(urlEmpty, 'editors_choice=true', 'fallback includes editors_choice=true');
    g.contains(urlEmpty, 'order=popular', 'fallback includes order=popular');
    g.contains(urlEmpty, 'safesearch=true', 'safesearch enforced');

    const urlWhitespace = p._buildUrl('test-key-pixabay', '   ', 2, 30);
    g.contains(urlWhitespace, 'q=wallpaper', 'whitespace-only falls back');
    g.contains(urlWhitespace, 'editors_choice=true', 'whitespace fallback includes curated params');
    g.contains(urlWhitespace, 'page=2', 'page preserved');

    const urlNormal = p._buildUrl('test-key-pixabay', 'sunset', 1, 24);
    g.ok(!urlNormal.includes('editors_choice'), 'non-empty query does not force curated params');
    g.ok(!urlNormal.includes('order=popular'), 'non-empty query does not force order=popular');
    g.contains(urlNormal, 'q=sunset', 'non-empty query uses original term');

    const synth = {
        hits: new Array(12).fill(0).map((_, i) => ({
            id: 2000 + i,
            previewURL: `https://cdn.example.com/p${i}_thumb.jpg`,
            largeImageURL: `https://cdn.example.com/p${i}_large.jpg`,
            imageWidth: 1920,
            imageHeight: 1080,
            user: 'Tester',
            pageURL: `https://pixabay.com/photos/p${i}/`,
            tags: 'wallpaper,nature',
        })),
        totalHits: 12,
    };
    const norm = p._normalize(synth, 1);
    g.eq(norm.items.length, 12, 'normalizes ≥10 items');
    g.eq(norm.page, 1, 'page preserved');
    g.eq(norm.lastPage, 1, 'lastPage derived from totalHits/perPage');

    return g;
}

// ---------------------------------------------------------------------------
// Group 3 — pexels: empty query hits curated endpoint; non-empty uses search
// ---------------------------------------------------------------------------

function testPexelsEmpty() {
    const g = new Group('pexels empty query');
    const p = new PexelsProvider();

    const urlEmpty = p._buildUrl('', 1, 24);
    g.contains(urlEmpty, '/v1/curated', 'empty query uses curated endpoint');
    g.ok(!urlEmpty.includes('query='), 'curated endpoint has no query param');
    g.contains(urlEmpty, 'per_page=24', 'per_page preserved');
    g.contains(urlEmpty, 'page=1', 'page preserved');

    const urlWhitespace = p._buildUrl('   ', 3, 40);
    g.contains(urlWhitespace, '/v1/curated', 'whitespace-only hits curated');
    g.contains(urlWhitespace, 'page=3', 'whitespace fallback preserves page');

    const urlNormal = p._buildUrl('mountains', 1, 24);
    g.contains(urlNormal, '/v1/search', 'non-empty uses search endpoint');
    g.contains(urlNormal, 'query=mountains', 'search includes query');

    const synth = {
        photos: new Array(20).fill(0).map((_, i) => ({
            id: 3000 + i,
            src: {
                medium: `https://images.pexels.com/photos/${i}/medium.jpg`,
                large2x: `https://images.pexels.com/photos/${i}/large2x.jpg`,
                original: `https://images.pexels.com/photos/${i}/original.jpg`,
            },
            width: 3840,
            height: 2160,
            photographer: 'P',
            url: `https://www.pexels.com/photo/${i}/`,
            alt: 'mountain',
        })),
        total_results: 500,
    };
    const norm = p._normalize(synth, 1);
    g.eq(norm.items.length, 20, 'normalizes ≥10 items');
    g.eq(norm.page, 1, 'page preserved');
    g.eq(norm.lastPage, 25, 'lastPage derived from total_results/perPage (500/20)');

    return g;
}

// ---------------------------------------------------------------------------
// Group 4 — unsplash: empty query hits /photos; non-empty uses /search/photos
// ---------------------------------------------------------------------------

function testUnsplashEmpty() {
    const g = new Group('unsplash empty query');
    const p = new UnsplashProvider();

    const urlEmpty = p._buildUrl('', 1, 24);
    g.contains(urlEmpty, '/photos', 'empty query uses /photos endpoint (not search)');
    g.ok(!urlEmpty.includes('/search/photos'), 'empty query does not hit search endpoint');
    g.ok(!urlEmpty.includes('query='), '/photos has no query param');

    const urlWhitespace = p._buildUrl('  \t  ', 2, 10);
    g.contains(urlWhitespace, '/photos', 'whitespace-only uses /photos');
    g.contains(urlWhitespace, 'page=2', 'whitespace fallback preserves page');
    g.contains(urlWhitespace, 'per_page=10', 'whitespace fallback preserves per_page');

    const urlNormal = p._buildUrl('nature', 1, 24);
    g.contains(urlNormal, '/search/photos', 'non-empty uses search endpoint');
    g.contains(urlNormal, 'query=nature', 'search includes query');

    // /photos returns array directly
    const synthArray = new Array(15).fill(0).map((_, i) => ({
        id: `uns${i}`,
        urls: {
            small: `https://images.unsplash.com/small${i}.jpg`,
            full: `https://images.unsplash.com/full${i}.jpg`,
        },
        width: 1920,
        height: 1080,
        user: {name: 'U'},
        links: {html: `https://unsplash.com/photos/uns${i}`},
        description: 'nature',
    }));
    const normArray = p._normalize(synthArray, 1);
    g.eq(normArray.items.length, 15, 'normalizes ≥10 items from array response');
    g.eq(normArray.total, 15, 'total derived from array length');
    g.eq(normArray.lastPage, 1, 'lastPage is 1 for array response');
    g.eq(normArray.page, 1, 'page preserved');

    // search results shape
    const synthSearch = {
        results: new Array(10).fill(0).map((_, i) => ({
            id: `unsr${i}`,
            urls: {small: `s${i}`, full: `f${i}`},
            width: 1600,
            height: 900,
            user: {name: 'U2'},
            links: {html: `h${i}`},
            alt_description: 'landscape',
        })),
        total: 50,
        total_pages: 3,
    };
    const normSearch = p._normalize(synthSearch, 2);
    g.eq(normSearch.items.length, 10, 'normalizes search results');
    g.eq(normSearch.total, 50, 'total from search response');
    g.eq(normSearch.lastPage, 3, 'lastPage from total_pages');
    g.eq(normSearch.page, 2, 'page preserved');

    return g;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const groups = [
        testSafebooruEmpty(),
        testPixabayEmpty(),
        testPexelsEmpty(),
        testUnsplashEmpty(),
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