// SPDX-License-Identifier: GPL-3.0-or-later
// Mopivo — standalone GTK4/libadwaita app entry point (ESM).
//
// Run as:  gjs -m main.js [--smoke-test | --prefs | --version | --help]
//   (no flags)     open the main window
//   --prefs        open the preferences window directly (needs a display)
//   --smoke-test   headless non-UI check: settings + 8 providers, then exit 0
//   --version      print the version and exit
//
// ESM caveat (plan risk R2): the shell's `ARGV` is undefined in ESM, so flags
// are parsed from `programArgs` (the `system` module).

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import GObject from 'gi://GObject';
import System from 'system';
import {programArgs} from 'system';

import {EXT_SCHEMA_ID} from './lib/video/constants.js';
import {initI18n} from './lib/i18n.js';
import {PROVIDER_IDS, getProvider} from './lib/providers/registry.js';

const APP_ID = 'br.com.redclaw.Mopivo';
const APP_NAME = 'mopivo';
const VERSION = '1.0.0';

// GLib does not expose SIGTERM/SIGINT as JS constants; use the POSIX numbers.
const SIGINT = 2;
const SIGTERM = 15;

const ENTRY_PATH = Gio.File.new_for_uri(import.meta.url).get_path();
const APP_DIR = Gio.File.new_for_uri(import.meta.url).get_parent().get_path();

// Only run when this file is the process entry point; importing it (e.g. from a
// headless resolution probe) must stay side-effect free.
const IS_MAIN = System.programPath === ENTRY_PATH;

/**
 * Load GSettings for the app schema from the in-tree `schemas/` directory
 * (works both from a checkout and from the installed APP_DIR, mirroring the
 * renderer's schema loader).
 *
 * @returns {Gio.Settings}
 */
function loadSettings() {
    const schemaDir = GLib.build_filenamev([APP_DIR, 'schemas']);
    const defaultSource = Gio.SettingsSchemaSource.get_default();
    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir, defaultSource, false);
    const schema = source.lookup(EXT_SCHEMA_ID, true);
    if (!schema)
        throw new Error(`Schema ${EXT_SCHEMA_ID} not found in ${schemaDir}`);
    return new Gio.Settings({settings_schema: schema});
}

/**
 * `Adw.Application` shell. Holds the settings shared by every window, builds
 * the main window (or the preferences window for `--prefs`) on `activate`, and
 * quits on SIGTERM/SIGINT.
 */
const WallpaperApp = GObject.registerClass({
    GTypeName: 'WpApplication',
}, class WallpaperApp extends Adw.Application {
    _init(openPrefs) {
        super._init({
            application_id: APP_ID,
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
        });
        this._openPrefs = openPrefs;
        this._settings = null;
        this._window = null;
        this._prefsWindow = null;

        this.connect('activate', () => {
            // Lazy import() yields to the main loop before a window exists;
            // hold() stops GApplication from quitting on that windowless moment.
            this.hold();
            this._onActivate()
                .catch(e => console.error(`[wp] activate failed: ${e.message}`))
                .finally(() => this.release());
        });

        // SIGTERM/SIGINT -> quit. gjs 1.88 moved GLib.unix_signal_add to the
        // platform GLibUnix library; GLibUnix.signal_add is the same call and
        // avoids a deprecation warning on startup.
        GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, SIGTERM, () => {
            this.quit();
            return GLib.SOURCE_REMOVE;
        });
        GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, SIGINT, () => {
            this.quit();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getSettings() {
        if (!this._settings) {
            this._settings = loadSettings();
            initI18n(this._settings.get_string('language'));
        }
        return this._settings;
    }

    async _onActivate() {
        const settings = this._getSettings();

        if (this._openPrefs) {
            await this._openPreferences(settings);
            return;
        }

        if (this._window) {
            this._window.present();
            return;
        }
        const {buildWindow} = await import('./app/window.js');
        this._window = buildWindow(this, settings);
        this._window.connect('close-request', () => {
            this._window = null;
            return false;
        });
        this._window.present();
    }

    async _openPreferences(settings) {
        if (this._prefsWindow) {
            this._prefsWindow.present();
            return;
        }
        const {buildPreferencesWindow} = await import('./prefs.js');
        this._prefsWindow = buildPreferencesWindow(settings, this);
        if (this._window)
            this._prefsWindow.set_transient_for(this._window);
        this._prefsWindow.connect('close-request', () => {
            this._prefsWindow = null;
            return false;
        });
        this._prefsWindow.present();
    }
});

/**
 * Headless smoke test: load GSettings, resolve every registry provider and
 * print a single `SMOKE_OK` line. Creates no widgets and no window, so it runs
 * under `GDK_BACKEND=headless`.
 *
 * @returns {Promise<never>} Exits the process.
 */
async function runSmokeTest() {
    console.log(`${APP_NAME} ${VERSION}`);

    const settings = loadSettings();
    console.log(`settings: schema=${EXT_SCHEMA_ID} ` +
        `active-provider=${settings.get_string('active-provider')} ` +
        `video-mode=${settings.get_boolean('video-mode')}`);

    let resolved = 0;
    for (const id of PROVIDER_IDS) {
        try {
            const provider = await getProvider(id);
            if (provider && typeof provider.search === 'function')
                resolved++;
            else
                console.error(`provider '${id}' has no search()`);
        } catch (e) {
            console.error(`provider '${id}' failed: ${e.message}`);
        }
    }

    console.log(`SMOKE_OK ${VERSION} providers=${resolved}`);
    System.exit(resolved === PROVIDER_IDS.length ? 0 : 1);
}

function printHelp() {
    console.log(`Usage: gjs -m main.js [OPTION]`);
    console.log(`${APP_NAME} ${VERSION} — browse and set desktop wallpapers.`);
    console.log('');
    console.log('  (no options)   open the main window');
    console.log('  --prefs        open the preferences window');
    console.log('  --smoke-test   headless non-UI check (settings + providers)');
    console.log('  --version      print the version and exit');
    console.log('  --help         show this help and exit');
}

function runApp(openPrefs) {
    const app = new WallpaperApp(openPrefs);
    app.run([]);
}

async function main() {
    const args = Array.from(programArgs);

    if (args.includes('--version')) {
        console.log(`${APP_NAME} ${VERSION}`);
        System.exit(0);
    }
    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        System.exit(0);
    }
    if (args.includes('--smoke-test')) {
        await runSmokeTest();
        return;
    }
    runApp(args.includes('--prefs'));
}

if (IS_MAIN)
    await main();
