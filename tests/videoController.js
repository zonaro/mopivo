// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for app/videoController.js (pure helpers + argv contract).
//
// Run with: GDK_BACKEND=headless gjs -m tests/videoController.js
// No network, D-Bus, subprocess, display or GStreamer needed: only the pure
// helpers (`pickRandom`, `sourcePathsFromSettings`) and the renderer argv
// builder (via RendererLauncher.buildArgv) are exercised, plus a construction
// sanity check proving that constructing a VideoController touches nothing.

import System from 'system';

import {RendererLauncher} from '../lib/video/launcher.js';
import {
    VideoController,
    pickRandom,
    sourcePathsFromSettings,
} from '../app/videoController.js';

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

// Settings-like stub that records writes (Gio.Settings-shaped API).
function makeSettings(initial = {}) {
    const data = {...initial};
    const writes = [];
    return {
        _data: data,
        _writes: writes,
        get_string(k) { return data[k] ?? ''; },
        set_string(k, v) { data[k] = v; writes.push([k, v]); },
        get_boolean(k) { return data[k] ?? false; },
        set_boolean(k, v) { data[k] = v; writes.push([k, v]); },
        get_int(k) { return data[k] ?? 0; },
        set_int(k, v) { data[k] = v; writes.push([k, v]); },
    };
}

// ---------------------------------------------------------------------------
// Group 1 — module API surface
// ---------------------------------------------------------------------------

function testModuleApi() {
    const g = new Group('module api');

    g.eq(typeof VideoController, 'function', 'VideoController is a function');
    g.eq(typeof pickRandom, 'function', 'pickRandom is a function');
    g.eq(typeof sourcePathsFromSettings, 'function', 'sourcePathsFromSettings is a function');
    g.eq(typeof VideoController.prototype.playFile, 'function', 'VideoController.playFile is a function');

    return g;
}

// ---------------------------------------------------------------------------
// Group 2 — pickRandom
// ---------------------------------------------------------------------------

function testPickRandom() {
    const g = new Group('pickRandom');

    const files = ['a.mp4', 'b.mp4', 'c.mp4'];

    g.eq(pickRandom(files, () => 0), 'a.mp4', 'rng 0 picks the first file');
    g.eq(pickRandom(files, () => 0.5), 'b.mp4', 'rng 0.5 floors to index 1');
    g.eq(pickRandom(files, () => 0.999), 'c.mp4', 'rng 0.999 floors to the last file');
    g.eq(pickRandom(files, () => 1), 'c.mp4', 'rng 1 is clamped to the last file');

    g.eq(pickRandom([], () => 0), null, 'empty array returns null');
    g.eq(pickRandom(null, () => 0), null, 'null returns null');
    g.eq(pickRandom(undefined, () => 0), null, 'undefined returns null');
    g.eq(pickRandom('not-an-array', () => 0), null, 'non-array returns null');

    // Default rng is used when none is injected, and it stays in-bounds.
    const picked = pickRandom(files);
    g.ok(files.includes(picked), 'default rng picks a member of the input');

    return g;
}

// ---------------------------------------------------------------------------
// Group 3 — sourcePathsFromSettings mapping
// ---------------------------------------------------------------------------

function testSourceMapping() {
    const g = new Group('sourcePathsFromSettings');

    // Gio.Settings-shaped stub.
    const localStub = makeSettings({
        'video-mode-type': 'local',
        'video-path': '/vids/a.mp4',
        'video-folder': '/vids',
    });
    const local = sourcePathsFromSettings(localStub);
    g.eq(local.type, 'local', 'local → type local');
    g.eq(local.filePath, '/vids/a.mp4', 'local → filePath from video-path');
    g.eq(local.url, null, 'local → url null');
    g.eq(local.folder, '/vids', 'local → folder from video-folder');

    const localEmpty = sourcePathsFromSettings(makeSettings({'video-mode-type': 'local'}));
    g.eq(localEmpty.type, 'local', 'local without path → type local');
    g.eq(localEmpty.filePath, null, 'local without path → filePath null');
    g.ok(typeof localEmpty.folder === 'string' && localEmpty.folder.length > 0,
        'local without folder → falls back to default folder string');

    const streaming = sourcePathsFromSettings(makeSettings({
        'video-mode-type': 'streaming',
        'video-streaming-url': 'https://youtube.com/watch?v=x',
    }));
    g.eq(streaming.type, 'streaming', 'streaming → type streaming');
    g.eq(streaming.url, 'https://youtube.com/watch?v=x', 'streaming → url from video-streaming-url');
    g.eq(streaming.filePath, null, 'streaming → filePath null');

    const webpage = sourcePathsFromSettings(makeSettings({
        'video-mode-type': 'webpage',
        'video-webpage-url': 'https://example.com/page',
    }));
    g.eq(webpage.type, 'webpage', 'webpage → type webpage');
    g.eq(webpage.url, 'https://example.com/page', 'webpage → url from video-webpage-url');
    g.eq(webpage.filePath, null, 'webpage → filePath null');

    const webpageHtml = sourcePathsFromSettings(makeSettings({
        'video-mode-type': 'webpage',
        'video-webpage-local-html': '/tmp/page.html',
    }));
    g.eq(webpageHtml.url, '/tmp/page.html', 'webpage → falls back to video-webpage-local-html');

    // Plain-object stubs are supported too (no get_string).
    const plain = sourcePathsFromSettings({
        'video-mode-type': 'streaming',
        'video-streaming-url': 'https://x/y',
    });
    g.eq(plain.type, 'streaming', 'plain object stub → type streaming');
    g.eq(plain.url, 'https://x/y', 'plain object stub → url read');

    // Missing type defaults to local.
    const missingType = sourcePathsFromSettings({});
    g.eq(missingType.type, 'local', 'missing video-mode-type defaults to local');

    return g;
}

// ---------------------------------------------------------------------------
// Group 4 — renderer launcher argv contract
// ---------------------------------------------------------------------------

function testLauncherArgv() {
    const g = new Group('launcher argv');

    const launcher = new RendererLauncher({appDir: '/fake/app', log: () => {}});
    const argv = launcher.buildArgv('/vids/a.mp4');

    g.ok(argv.includes('-P'), 'argv includes the -P flag');
    g.ok(argv.includes('/fake/app'), 'argv includes the APP_DIR right after -P');
    g.ok(
        argv.some((a) => typeof a === 'string' && a.endsWith('renderer.js')),
        'argv references renderer/renderer.js'
    );
    g.ok(argv.includes('-F'), 'argv includes -F when a file is given');
    g.ok(argv.includes('/vids/a.mp4'), 'argv includes the file path right after -F');

    const noFile = launcher.buildArgv();
    g.ok(!noFile.includes('-F'), 'argv has no -F when no file is given');

    // GDK_BACKEND is applied to the subprocess env (not the argv); the launcher
    // exposes the configured SubprocessLauncher so we can confirm it builds.
    const subLauncher = launcher.createSubprocessLauncher();
    g.ok(subLauncher !== null && typeof subLauncher.spawnv === 'function',
        'createSubprocessLauncher() builds a configured SubprocessLauncher');

    return g;
}

// ---------------------------------------------------------------------------
// Group 5 — VideoController construction is side-effect free
// ---------------------------------------------------------------------------

async function testConstruction() {
    const g = new Group('controller construction');

    const stub = makeSettings({'video-mode-type': 'streaming'});
    const controller = new VideoController({settings: stub});

    g.ok(controller.started === false, 'constructing does not start the pipeline');
    g.ok(controller.isPlaying === false, 'isPlaying defaults to false');
    g.eq(controller._launcher, null, 'no RendererLauncher is created at construction');
    g.eq(controller._dbus, null, 'no RendererDBus is created at construction');

    for (const method of ['start', 'stop', 'play', 'pause', 'togglePlay',
        'next', 'lucky', 'playFile', 'setSource']) {
        g.eq(typeof controller[method], 'function', `controller.${method} is a function`);
    }

    const id = controller.connect('is-playing-changed', () => {});
    g.ok(typeof id === 'number' && id > 0, 'is-playing-changed is a connectable GObject signal');
    controller.disconnect(id);

    // setSource on a stopped controller only writes the setting.
    await controller.setSource('local');
    g.eq(stub._data['video-mode-type'], 'local', 'setSource writes video-mode-type');
    g.ok(
        stub._writes.some(([k, v]) => k === 'video-mode-type' && v === 'local'),
        'video-mode-type write is recorded'
    );
    g.ok(controller.started === false, 'setSource does not start a stopped controller');

    // Unknown source types are rejected without touching settings.
    const before = stub._writes.length;
    await controller.setSource('bogus');
    g.eq(stub._writes.length, before, 'setSource with an unknown type writes nothing');

    return g;
}

// ---------------------------------------------------------------------------
// Group 6 — playFile persists source and starts a stopped controller
// ---------------------------------------------------------------------------

async function testPlayFile() {
    const g = new Group('playFile');

    const stub = makeSettings({'video-mode-type': 'streaming'});
    const controller = new VideoController({settings: stub});

    // Stub start() so the test never spawns a renderer subprocess.
    let startCalls = 0;
    controller.start = async () => { startCalls++; controller._started = true; };

    await controller.playFile('/vids/clip.mp4');
    g.eq(stub._data['video-path'], '/vids/clip.mp4', 'playFile writes video-path');
    g.eq(stub._data['video-mode-type'], 'local', 'playFile forces the local source');
    g.eq(startCalls, 1, 'playFile starts a stopped controller');

    await controller.playFile(null);
    g.eq(startCalls, 1, 'playFile ignores a missing path');
    g.eq(stub._data['video-path'], '/vids/clip.mp4', 'playFile(null) keeps the previous path');

    return g;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const groups = [];
    groups.push(testModuleApi());
    groups.push(testPickRandom());
    groups.push(testSourceMapping());
    groups.push(testLauncherArgv());
    groups.push(await testConstruction());
    groups.push(await testPlayFile());

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