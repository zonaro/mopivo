// SPDX-License-Identifier: GPL-3.0-or-later
// Headless unit tests for lib/wallpaper-web.js (WE/Lively web-wallpaper helpers).
// Run: GDK_BACKEND=headless gjs -m tests/wallpaperWeb.js
// Uses the real /mnt/GIT/susuwatari manifests when present, inline fixtures otherwise.

import System from 'system';
import GLib from 'gi://GLib';

import {
    parseProjectJson, parseLivelyProperties, mergeProperties,
    isWebProjectFolder, resolveEntryFile, jsonToProperties,
    propertiesToJson, buildBridgeScript,
} from '../lib/wallpaper-web.js';

const SAMPLE_DIR = '/mnt/GIT/susuwatari';
const SAMPLE_PROJECT = `${SAMPLE_DIR}/project.json`;
const SAMPLE_LIVELY = `${SAMPLE_DIR}/LivelyProperties.json`;
const hasSample = GLib.file_test(SAMPLE_PROJECT, GLib.FileTest.EXISTS);

const PROJECT_FIXTURE = JSON.stringify({
    title: 'Fixture', type: 'Web', file: 'index.html',
    general: {properties: {
        size: {type: 'slider', value: 20, text: 'Size', order: 2},
        flag: {type: 'bool', value: true, text: 'Flag', order: 1},
        onlyProject: {type: 'textinput', value: 'p', order: 3},
    }},
});

const LIVELY_FIXTURE = JSON.stringify({
    size: {type: 'slider', value: 18, text: 'Size'},
    flag: {type: 'checkbox', value: true, text: 'Flag'},
    onlyLively: {type: 'slider', value: 3, text: 'Only Lively'},
    label: {type: 'textbox', value: 'hi', text: 'Label'},
});

function readText(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok || !bytes)
        throw new Error(`cannot read ${path}`);
    return new TextDecoder('utf-8').decode(bytes);
}

// Assertion helpers (same style as tests/monitors.js).
class Group {
    constructor(name) {
        this.name = name;
        this.pass = 0;
        this.fail = 0;
    }
    ok(condition, name, message = '') {
        if (condition)
            this.pass++;
        else {
            this.fail++;
            console.log(`    FAIL  ${name}${message ? ` — ${message}` : ''}`);
        }
        return condition;
    }
    eq(actual, expected, name) {
        return this.ok(actual === expected, name,
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    done() {
        console.log(`  ${this.name}: PASS ${this.pass} FAIL ${this.fail}`);
        return this.fail === 0;
    }
}

function testParseProject() {
    const g = new Group('parseProjectJson');
    const p = hasSample ? parseProjectJson(readText(SAMPLE_PROJECT))
        : parseProjectJson(PROJECT_FIXTURE);
    const s = hasSample ? 'susuwatariSize' : 'size';
    g.ok(p.error === null, 'project.json parses without error');
    g.eq(p.type, 'Web', 'project type is Web');
    g.eq(p.file, 'index.html', 'entry file is index.html');
    g.ok(p.title.length > 0, 'title parsed');
    g.eq(p.properties[s].type, 'slider', 'slider type kept');
    g.eq(p.properties[s].value, hasSample ? 18 : 20, 'slider default value');
    g.eq(p.properties[s].text, hasSample ? 'Initial Susuwatari Size' : 'Size', 'text parsed');
    g.eq(p.properties[s].order, hasSample ? 100 : 2, 'order parsed');
    if (hasSample) {
        g.eq(p.properties.audioVisualizationEnabled.type, 'bool', 'bool type kept');
        g.eq(p.properties.audioVisualizationEnabled.value, true, 'bool value kept');
        g.eq(p.properties.schemecolor.type, 'color', 'color type kept');
        g.eq(p.properties.backgroundImagePicker.type, 'file', 'file type kept');
        g.ok(Object.keys(p.properties).length >= 10, 'many properties parsed');
    } else {
        g.eq(p.properties.flag.type, 'bool', 'bool type kept');
        g.eq(p.properties.flag.value, true, 'bool value kept');
        g.eq(p.properties.onlyProject.type, 'textinput', 'textinput type kept');
        g.eq(p.properties.onlyProject.value, 'p', 'textinput value kept');
        g.ok(Object.keys(p.properties).length === 3, 'all properties parsed');
    }
    return g;
}

function testProjectErrors() {
    const g = new Group('parseProjectJson errors');
    g.eq(Object.keys(parseProjectJson('{ not json').properties).length, 0, 'bad JSON yields no properties');
    g.ok(parseProjectJson('{ not json').error !== null, 'bad JSON reports a reason');
    g.ok(parseProjectJson('[]').error !== null, 'array JSON reports a reason');
    g.ok(parseProjectJson('').error !== null, 'empty input reports a reason');
    g.ok(parseProjectJson(null).error !== null, 'null input reports a reason');
    return g;
}

function testParseLively() {
    const g = new Group('parseLivelyProperties');
    const real = hasSample && GLib.file_test(SAMPLE_LIVELY, GLib.FileTest.EXISTS);
    const l = real ? parseLivelyProperties(readText(SAMPLE_LIVELY))
        : parseLivelyProperties(LIVELY_FIXTURE);
    const s = real ? 'susuwatariSize' : 'size';
    g.eq(l[s].type, 'slider', 'slider type kept');
    g.eq(l[s].value, 18, 'slider default value');
    const boolKey = real ? 'audioVisualizationEnabled' : 'flag';
    g.eq(l[boolKey].type, 'bool', 'checkbox normalized to bool');
    g.eq(l[boolKey].value, true, 'checkbox value kept');
    const textKey = real ? 'backgroundImageUrl' : 'label';
    g.eq(l[textKey].type, 'textinput', 'textbox normalized to textinput');
    g.eq(l[textKey].value, real ? '' : 'hi', 'text value kept');
    const fileKey = real ? 'backgroundImagePicker' : 'onlyLively';
    g.eq(l[fileKey].type, real ? 'file' : 'slider', 'remaining entry kept');
    g.eq(l[fileKey].value, real ? null : 3, 'remaining entry value kept');
    let reason = null;
    g.eq(Object.keys(parseLivelyProperties('nope', r => {
        reason = r;
    })).length, 0, 'bad JSON yields {}');
    g.ok(typeof reason === 'string' && reason.length > 0, 'onError receives a reason');
    return g;
}

function testMerge() {
    const g = new Group('mergeProperties');
    const proj = parseProjectJson(PROJECT_FIXTURE).properties;
    const liv = parseLivelyProperties(LIVELY_FIXTURE);
    const base = mergeProperties(proj, liv, {});
    g.eq(base.size, 18, 'lively default beats project default');
    g.eq(base.flag, true, 'shared bool resolves to true');
    g.eq(base.onlyProject, 'p', 'project-only key survives');
    g.eq(base.onlyLively, 3, 'lively-only key survives');
    const override = mergeProperties(proj, liv, {size: 99, extra: 'x'});
    g.eq(override.size, 99, 'override beats both manifests');
    g.eq(override.extra, 'x', 'new override key added');
    g.eq(override.onlyProject, 'p', 'overrides do not drop defaults');
    g.eq(Object.keys(mergeProperties(null, undefined, null)).length, 0, 'null inputs yield an empty map');
    return g;
}

function testJsonRoundTrip() {
    const g = new Group('propertiesToJson/jsonToProperties');
    const flat = {a: 1, b: 'x', c: true, d: null};
    g.eq(JSON.stringify(jsonToProperties(propertiesToJson(flat))), JSON.stringify(flat), 'round trip preserves the map');
    g.eq(propertiesToJson(null), '{}', 'null serializes to {}');
    g.eq(propertiesToJson([1, 2]), '{}', 'array serializes to {}');
    let reason = null;
    g.eq(Object.keys(jsonToProperties('garbage', r => {
        reason = r;
    })).length, 0, 'bad JSON yields {}');
    g.ok(typeof reason === 'string' && reason.length > 0, 'bad JSON reports a reason');
    g.eq(Object.keys(jsonToProperties('')).length, 0, 'empty string yields {}');
    return g;
}

function testFilesystem() {
    const g = new Group('filesystem helpers');
    g.eq(isWebProjectFolder('/definitely/not/here-xyz'), false, 'missing folder is not a project');
    g.eq(isWebProjectFolder('/tmp'), false, 'folder without manifest is not a project');
    g.eq(resolveEntryFile('/definitely/not/here-xyz', {file: 'a.html'}), null, 'missing folder yields null');
    if (hasSample) {
        const p = parseProjectJson(readText(SAMPLE_PROJECT));
        g.eq(isWebProjectFolder(SAMPLE_DIR), true, 'sample dir is a web project');
        g.eq(resolveEntryFile(SAMPLE_DIR, p), `${SAMPLE_DIR}/index.html`, 'entry resolves to index.html');
    } else {
        const dir = GLib.build_filenamev([GLib.get_tmp_dir(), 'mopivo-web-test']);
        GLib.mkdir_with_parents(dir, 0o755);
        GLib.file_set_contents(`${dir}/project.json`, PROJECT_FIXTURE);
        GLib.file_set_contents(`${dir}/index.html`, '<html></html>');
        g.eq(isWebProjectFolder(dir), true, 'temp project dir detected');
        g.eq(resolveEntryFile(dir, {file: ''}), `${dir}/index.html`, 'entry falls back to index.html');
        g.eq(resolveEntryFile(dir, {file: 'missing.html'}), `${dir}/index.html`, 'missing file falls back');
    }
    return g;
}

function testBridgeScript() {
    const g = new Group('buildBridgeScript');
    const script = buildBridgeScript({
        properties: {susuwatariSize: 25, flag: true},
        livelyProperties: {susuwatariSize: {type: 'slider', value: 18}},
        audioEnabled: true, env: 'both',
    });
    g.ok(script.includes('wallpaperPropertyListener'), 'defines the WE property surface');
    g.ok(script.includes('livelyPropertyListener'), 'calls the Lively property listener');
    g.ok(script.includes('wallpaperRegisterAudioListener'), 'defines the WE audio surface');
    g.ok(script.includes('mopivoPushAudio'), 'exposes the audio feeder');
    g.ok(script.includes('mopivoApplyProperties'), 'exposes the property pusher');
    g.ok(script.includes('isWallpaperEngine'), 'sets the WE env flag');
    g.ok(script.includes('isLivelyWallpaper'), 'sets the Lively env flag');
    g.ok(script.includes('"susuwatariSize":25'), 'embeds the effective values');
    g.ok(script.includes('var AUDIO = true;'), 'audio enabled flag embedded');
    let compiled = true;
    try {
        new Function(script); // Parses only; the shim is never executed here.
    } catch (e) {
        compiled = false;
        console.log(`    FAIL  bridge script parses — ${e.message}`);
    }
    g.ok(compiled, 'bridge script parses as JavaScript');
    g.ok(buildBridgeScript({properties: {}}).includes('var AUDIO = false;'), 'audio defaults to disabled');
    g.ok(buildBridgeScript({env: 'lively'}).includes('"lively"'), 'env is embedded verbatim');
    return g;
}

function main() {
    const groups = [
        testParseProject(), testProjectErrors(), testParseLively(), testMerge(),
        testJsonRoundTrip(), testFilesystem(), testBridgeScript(),
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

System.exit(main() ? 1 : 0);
