// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for ui/filters.js (GTK4 filter bar).
//
// Run with: GDK_BACKEND=headless gjs -m tests/filters.js
// (also wired into `make check`). No network, display or GStreamer needed:
// the module is imported (widgets are NOT constructed) and only the pure
// `filtersToParams()` helper is exercised.

import System from 'system';

import {FilterBar, filtersToParams} from '../ui/filters.js';

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

/**
 * A complete filter state using the schema defaults. Tests override only the
 * fields they care about, so every case stays a valid state object.
 */
function defaultState(overrides = {}) {
    return {
        q: '',
        categories: {general: true, anime: true, people: true},
        purity: {sfw: true, sketchy: false, nsfw: false},
        sorting: 'date_added',
        order: 'desc',
        topRange: '1M',
        atleast: '',
        resolutions: '',
        ratios: '',
        colors: '',
        aiArtFilter: true,
        ...overrides,
    };
}

function sortedKeys(object) {
    return Object.keys(object).sort().join(',');
}

// ---------------------------------------------------------------------------
// Group 1 — category / purity bit strings
// ---------------------------------------------------------------------------

function testBitStrings() {
    const g = new Group('bit-strings');

    // Bit order is general/anime/people, matching the old St bar.
    g.eq(filtersToParams(defaultState()).categories, '111', 'categories default is 111');
    g.eq(
        filtersToParams(defaultState({
            categories: {general: true, anime: false, people: true},
        })).categories,
        '101',
        'general + people -> 101'
    );
    g.eq(
        filtersToParams(defaultState({
            categories: {general: false, anime: true, people: false},
        })).categories,
        '010',
        'only anime -> 010'
    );
    g.eq(
        filtersToParams(defaultState({
            categories: {general: false, anime: false, people: false},
        })).categories,
        '000',
        'no category -> 000'
    );

    // Bit order is sfw/sketchy/nsfw, matching the old St bar.
    g.eq(filtersToParams(defaultState()).purity, '100', 'purity default is 100');
    g.eq(
        filtersToParams(defaultState({
            purity: {sfw: true, sketchy: true, nsfw: true},
        })).purity,
        '111',
        'all purity -> 111'
    );
    g.eq(
        filtersToParams(defaultState({
            purity: {sfw: false, sketchy: true, nsfw: true},
        })).purity,
        '011',
        'sketchy + nsfw -> 011'
    );
    g.eq(
        filtersToParams(defaultState({
            purity: {sfw: true, sketchy: false, nsfw: true},
        })).purity,
        '101',
        'sfw + nsfw -> 101'
    );

    return g;
}

// ---------------------------------------------------------------------------
// Group 2 — toplist gating
// ---------------------------------------------------------------------------

function testToplistGating() {
    const g = new Group('toplist-gating');

    const top = filtersToParams(defaultState({sorting: 'toplist', topRange: '1M'}));
    g.ok('topRange' in top, 'toplist includes topRange');
    g.eq(top.topRange, '1M', 'topRange value is passed through');
    g.eq(
        filtersToParams(defaultState({sorting: 'toplist', topRange: '3d'})).topRange,
        '3d',
        'topRange accepts other ranges'
    );
    g.ok(!('top_range' in top), 'top_range key is never emitted (contract uses topRange)');

    for (const sorting of ['date_added', 'relevance', 'random', 'views', 'favorites']) {
        const params = filtersToParams(defaultState({sorting}));
        g.ok(!('topRange' in params), `topRange omitted when sorting=${sorting}`);
    }

    return g;
}

// ---------------------------------------------------------------------------
// Group 3 — ai_art_filter mapping
// ---------------------------------------------------------------------------

function testAiArtFilter() {
    const g = new Group('ai-art-filter');

    const on = filtersToParams(defaultState({aiArtFilter: true}));
    g.eq(on.ai_art_filter, 1, 'aiArtFilter=true -> ai_art_filter=1');

    const off = filtersToParams(defaultState({aiArtFilter: false}));
    g.ok(!('ai_art_filter' in off), 'aiArtFilter=false omits ai_art_filter (old behaviour)');

    return g;
}

// ---------------------------------------------------------------------------
// Group 4 — schema defaults and exact key set
// ---------------------------------------------------------------------------

function testDefaults() {
    const g = new Group('defaults');

    const params = filtersToParams(defaultState());
    g.eq(params.categories, '111', 'default categories 111');
    g.eq(params.purity, '100', 'default purity 100');
    g.eq(params.sorting, 'date_added', 'default sorting date_added');
    g.eq(params.order, 'desc', 'default order desc');
    g.eq(params.q, '', 'default query is empty string');
    g.ok(!('topRange' in params), 'default sorting is not toplist -> no topRange');
    g.ok(!('atleast' in params), 'default atleast omitted');
    g.ok(!('resolutions' in params), 'default resolutions omitted');
    g.ok(!('ratios' in params), 'default ratios omitted');
    g.ok(!('colors' in params), 'default colors omitted');
    g.eq(params.ai_art_filter, 1, 'default ai-art-filter (true) -> 1');

    const full = filtersToParams(defaultState({
        q: 'sunset',
        sorting: 'toplist',
        topRange: '1y',
        atleast: '1920x1080',
        resolutions: '1920x1080,2560x1440',
        ratios: '16x9',
        colors: 'ff0000',
        aiArtFilter: true,
    }));
    g.eq(
        sortedKeys(full),
        'ai_art_filter,atleast,categories,colors,order,purity,q,ratios,resolutions,sorting,topRange',
        'full params has exactly the expected keys'
    );

    return g;
}

// ---------------------------------------------------------------------------
// Group 5 — text entries pass through, empty ones are omitted
// ---------------------------------------------------------------------------

function testEntries() {
    const g = new Group('entries');

    const params = filtersToParams(defaultState({
        atleast: '1920x1080',
        resolutions: '1920x1080,2560x1440',
        ratios: '16x9,21x9',
        colors: 'ff0000',
    }));
    g.eq(params.atleast, '1920x1080', 'atleast passed through');
    g.eq(params.resolutions, '1920x1080,2560x1440', 'resolutions passed through');
    g.eq(params.ratios, '16x9,21x9', 'ratios passed through');
    g.eq(params.colors, 'ff0000', 'colors passed through');

    const trimmed = filtersToParams(defaultState({atleast: '  1920x1080  '}));
    g.eq(trimmed.atleast, '1920x1080', 'entry values are trimmed');

    // Empty strings are dropped from the params object, exactly like the old
    // bar (the registry client already treats missing keys as "no filter").
    const empty = filtersToParams(defaultState({atleast: '', resolutions: '', ratios: '', colors: ''}));
    g.ok(!('atleast' in empty), 'empty atleast omitted');
    g.ok(!('resolutions' in empty), 'empty resolutions omitted');
    g.ok(!('ratios' in empty), 'empty ratios omitted');
    g.ok(!('colors' in empty), 'empty colors omitted');

    return g;
}

// ---------------------------------------------------------------------------
// Group 6 — query handling
// ---------------------------------------------------------------------------

function testQuery() {
    const g = new Group('query');

    g.eq(filtersToParams(defaultState({q: ' nature '})).q, 'nature', 'query is trimmed');
    g.eq(filtersToParams(defaultState({q: ''})).q, '', 'empty query kept as empty string');
    g.eq(filtersToParams(defaultState({q: undefined})).q, '', 'undefined query becomes empty string');

    return g;
}

// ---------------------------------------------------------------------------
// Group 7 — module surface
// ---------------------------------------------------------------------------

function testModuleSurface() {
    const g = new Group('module');

    g.eq(typeof FilterBar, 'function', 'FilterBar is exported as a class');
    g.eq(typeof filtersToParams, 'function', 'filtersToParams is exported');

    return g;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const groups = [
        testBitStrings(),
        testToplistGating(),
        testAiArtFilter(),
        testDefaults(),
        testEntries(),
        testQuery(),
        testModuleSurface(),
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