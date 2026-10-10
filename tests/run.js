// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for the Wallpaper Providers app foundation.
//
// Run with: GDK_BACKEND=headless gjs -m tests/run.js
// (also wired into `make check`). No network, display or GStreamer needed.

import System from 'system';
import Gio from 'gi://Gio';

import {
    APPLICATION_ID,
    EXT_SCHEMA_ID,
    EXT_SCHEMA_PATH,
    RENDERER_OBJECT_PATH,
} from '../lib/video/constants.js';
import {
    PROVIDER_IDS,
    PROVIDER_META,
    getProvider,
    isProviderConfigured,
} from '../lib/providers/registry.js';

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * A named group of assertions. Tracks how many passed/failed, and prints a
 * per-group `PASS <n> / FAIL <m>` summary via the dedicated `done()` call.
 */
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
 * Minimal validity check for a D-Bus well-known name: dot-separated,
 * non-empty segments, allowed characters, no digit leading segment.
 */
function isValidDbusName(name) {
    if (typeof name !== 'string' || name.length === 0)
        return false;
    if (!name.includes('.'))
        return false;

    const segments = name.split('.');
    if (segments.some((s) => s.length === 0))
        return false;
    if (segments.some((s) => /[^A-Za-z0-9_-]/.test(s)))
        return false;
    if (segments.some((s) => s[0] >= '0' && s[0] <= '9'))
        return false;
    return true;
}

/**
 * GSettings stub for provider configuration checks. All key lookups return
 * "empty"; `get_strv` returns an always-existing directory so folder-based
 * providers (local, wallrus) are deterministically "configured".
 */
const emptySettings = {
    get_string: () => '',
    get_strv: () => ['/tmp'],
    get_boolean: () => false,
    get_int: () => 0,
};

// ---------------------------------------------------------------------------
// Group 1 — schema coverage
// ---------------------------------------------------------------------------

// The 51 keys that existed in the original extension schema (unchanged).
const EXISTING_KEYS = [
    'active-provider',
    'language',
    'api-key',
    'pexels-api-key',
    'unsplash-api-key',
    'pixabay-api-key',
    'search-query',
    'categories',
    'purity',
    'sorting',
    'order',
    'top-range',
    'atleast',
    'resolutions',
    'ratios',
    'colors',
    'ai-art-filter',
    'download-folder',
    'set-background',
    'page-size',
    'local-folders',
    'local-recursive',
    'video-mode',
    'video-mode-type',
    'video-path',
    'video-folder',
    'video-streaming-url',
    'video-webpage-url',
    'video-webpage-local-html',
    'video-volume',
    'video-mute',
    'video-fade-duration-sec',
    'video-audio-primary-monitor-only',
    'video-fit-mode',
    'video-random-start',
    'video-monitor-paths',
    'pause-on-maximize-or-fullscreen',
    'pause-on-focus',
    'pause-on-battery',
    'low-battery-threshold',
    'pause-on-mpris-playing',
    'change-wallpaper',
    'change-wallpaper-directory-path',
    'change-wallpaper-interval',
    'change-wallpaper-mode',
    'static-wallpaper-from-video',
    'static-wallpaper-blur-enabled',
    'static-wallpaper-blur-radius',
    'show-on-lock-screen',
    'wallrus-folders',
    'wallrus-recursive',
];

// The 6 keys added for video renderer integration + app parity.
const NEW_KEYS = [
    'startup-delay',
    'show-panel-menu',
    'enable-va',
    'enable-nvsl',
    'prefer-clappersink',
    'force-mediafile',
];

function testSchema() {
    const g = new Group('schema');

    const self = Gio.File.new_for_uri(import.meta.url);
    const file = self.get_parent().get_parent().get_child('schemas')
        .get_child('br.com.redclaw.WallpaperProviders.gschema.xml');
    const [loaded, contents] = file.load_contents(null);
    g.ok(loaded, 'schema file loads');
    if (!loaded)
        return g;

    const xml = new TextDecoder().decode(contents);

    g.ok(
        xml.includes('id="br.com.redclaw.WallpaperProviders"'),
        'schema id is br.com.redclaw.WallpaperProviders'
    );
    g.ok(
        xml.includes('path="/br/com/redclaw/WallpaperProviders/"'),
        'schema path is /br/com/redclaw/WallpaperProviders/'
    );

    const foundKeys = [...xml.matchAll(/<key\s+name="([^"]+)"/g)]
        .map((m) => m[1]);

    const expectedKeys = [...EXISTING_KEYS, ...NEW_KEYS];
    g.eq(foundKeys.length, expectedKeys.length, 'schema key count is 57');

    for (const key of expectedKeys) {
        g.ok(foundKeys.includes(key), `schema key present: ${key}`);
    }
    for (const key of foundKeys) {
        g.ok(expectedKeys.includes(key), `no unexpected schema key: ${key}`);
    }

    return g;
}

// ---------------------------------------------------------------------------
// Group 2 — shared constants
// ---------------------------------------------------------------------------

const SCHEMA_ID = 'br.com.redclaw.WallpaperProviders';
const SCHEMA_PATH = '/br/com/redclaw/WallpaperProviders/';

function testConstants() {
    const g = new Group('constants');

    g.eq(EXT_SCHEMA_ID, SCHEMA_ID, 'EXT_SCHEMA_ID matches app schema id');
    g.eq(EXT_SCHEMA_PATH, SCHEMA_PATH, 'EXT_SCHEMA_PATH matches app schema path');
    g.ok(RENDERER_OBJECT_PATH.startsWith('/'), 'RENDERER_OBJECT_PATH starts with /');
    g.ok(isValidDbusName(APPLICATION_ID), 'APPLICATION_ID is a valid D-Bus name');

    return g;
}

// ---------------------------------------------------------------------------
// Group 3 — provider registry
// ---------------------------------------------------------------------------

async function testRegistry() {
    const g = new Group('registry');

    g.ok(Array.isArray(PROVIDER_IDS), 'PROVIDER_IDS is an array');
    g.eq(PROVIDER_IDS.length, 8, 'PROVIDER_IDS has 8 entries');
    g.eq(
        new Set(PROVIDER_IDS).size,
        PROVIDER_IDS.length,
        'PROVIDER_IDS entries are unique'
    );

    for (const id of PROVIDER_IDS) {
        g.ok(typeof id === 'string' && id.length > 0, `provider id is non-empty: ${id}`);

        const provider = await getProvider(id);
        g.ok(provider !== null && provider !== undefined, `getProvider(${id}) resolves`);
        g.ok(typeof provider.search === 'function', `getProvider(${id}).search is a function`);

        const meta = PROVIDER_META[id];
        g.ok(meta !== undefined, `PROVIDER_META[${id}] exists`);
        if (meta) {
            g.ok(
                typeof meta.displayName === 'string' && meta.displayName.length > 0,
                `PROVIDER_META[${id}] has a displayName`
            );
        }
    }

    g.eq(
        Object.keys(PROVIDER_META).length,
        PROVIDER_IDS.length,
        'PROVIDER_META has one entry per provider id'
    );

    // Keyed providers: with an empty-key stub they must be "not configured".
    for (const id of ['pexels', 'unsplash', 'pixabay']) {
        g.eq(await isProviderConfigured(id, emptySettings), false,
            `isProviderConfigured(${id}) is false with an empty API key`);
    }

    // Wallhaven is always "configured" (basic search works without a key;
    // the key only unlocks NSFW content — see WallhavenProvider.isConfigured).
    g.eq(await isProviderConfigured('wallhaven', emptySettings), true,
        'isProviderConfigured(wallhaven) is true without an API key');

    // Keyless providers: always available (folder checks use the stub's /tmp).
    for (const id of ['local', 'safebooru', 'waifuim', 'wallrus']) {
        g.eq(await isProviderConfigured(id, emptySettings), true,
            `isProviderConfigured(${id}) is true without an API key`);
    }

    return g;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const groups = [];
    groups.push(testSchema());
    groups.push(testConstants());
    groups.push(await testRegistry());

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