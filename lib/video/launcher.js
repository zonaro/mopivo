// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper subsystem — renderer process launcher.
// Ported from Hanabi (jeffshee/gnome-ext-hanabi) LaunchSubprocess.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {ARG_EXT_PATH, LOG_PREFIX} from './constants.js';

const log = (...args) => console.log(`${LOG_PREFIX} [launcher]`, ...args);
const logError = (...args) =>
    console.error(`${LOG_PREFIX} [launcher]`, ...args);

const shellVersion = parseInt(Config.PACKAGE_VERSION.split('.')[0]);

export class Launcher {
    /**
     * @param {object} ext - Extension instance (requires .path and .uuid).
     */
    constructor(ext) {
        this._extPath = ext.path;
        this._uuid = ext.uuid;

        this._flags =
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_MERGE;

        this._cancellable = new Gio.Cancellable();
        this._subprocessLauncher = new Gio.SubprocessLauncher({
            flags: this._flags,
        });

        // ── GNOME 45 Wayland pre-init workaround ──────────────────────────
        // On Shell < 49, Meta.WaylandClient.new() must be called *before*
        // spawnv() so the client registers with the Wayland display early.
        // Without this, spawnv() fails because the wl_client isn't ready.
        // Ref: mutter MetaWaylandClient, Hanabi commit history.
        if (!this._isX11() && shellVersion < 49) {
            this._waylandClient = Meta.WaylandClient.new(
                global.context,
                this._subprocessLauncher
            );
        }

        this._subprocess = null;
        this._dataInputStream = null;
    }

    _isX11() {
        // GNOME 50+: X11 backend removed, assume Wayland.
        if (shellVersion >= 50) return false;
        return !Meta.is_wayland_compositor();
    }

    /**
     * Spawn the renderer subprocess.
     *
     * @param {string[]} extraArgs - Additional argv entries (e.g. ['-F', path]).
     * @returns {Gio.Subprocess|null}
     */
    spawn(extraArgs = []) {
        const rendererPath = GLib.build_filenamev([
            this._extPath,
            'renderer',
            'renderer.js',
        ]);
        const argv = [
            'gjs',
            rendererPath,
            ARG_EXT_PATH,
            this._extPath,
            ...extraArgs,
        ];

        log(`Spawning renderer: ${argv.join(' ')}`);

        if (!this._isX11()) {
            if (shellVersion < 49) {
                // Shell < 49: use spawnv on pre-initialized WaylandClient.
                this._subprocess = this._waylandClient.spawnv(
                    global.display,
                    argv
                );
            } else {
                // Shell >= 49: new_subprocess bundles client creation + spawn.
                this._waylandClient = Meta.WaylandClient.new_subprocess(
                    global.context,
                    this._subprocessLauncher,
                    argv
                );
                this._subprocess = this._waylandClient.get_subprocess();
            }
        } else {
            this._subprocess = this._subprocessLauncher.spawnv(argv);
        }

        // Release the SubprocessLauncher — GLib >= 2.68 has close().
        if (this._subprocessLauncher.close)
            this._subprocessLauncher.close();
        this._subprocessLauncher = null;

        if (this._subprocess) {
            this._dataInputStream = Gio.DataInputStream.new(
                this._subprocess.get_stdout_pipe()
            );
            this.readOutput();

            this._subprocess.wait_async(this._cancellable, () => {
                this._dataInputStream = null;
                this._cancellable = null;
            });
            log('Renderer process launched');
        }

        return this._subprocess;
    }

    // ── stdout reader ─────────────────────────────────────────────────────
    // Reads lines asynchronously and logs them.  Tolerates renderer death:
    // errors other than CANCELLED cause the loop to stop silently (the
    // wait_async callback handles cleanup).

    readOutput() {
        if (!this._dataInputStream) return;

        this._dataInputStream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (stream, res) => {
                try {
                    const [line, length] = stream.read_line_finish_utf8(res);
                    if (length > 0) log(`[renderer] ${line}`);
                } catch (e) {
                    if (
                        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)
                    )
                        return;
                    // Renderer has likely exited — stop reading silently.
                    return;
                }
                this.readOutput();
            }
        );
    }

    // ── window ownership query ────────────────────────────────────────────
    // Wayland: delegate to WaylandClient.owns_window.
    // X11: always false — WindowManager matches by gtk_application_id.

    queryWindowBelongs(metaWindow) {
        if (this._isX11() || !this._subprocess) return false;
        try {
            return this._waylandClient.owns_window(metaWindow);
        } catch (e) {
            logError('owns_window error:', e.message);
            return false;
        }
    }

    // ── PID query ─────────────────────────────────────────────────────────

    queryPid() {
        if (!this._subprocess) return null;
        const pid = this._subprocess.get_identifier();
        return pid ? parseInt(pid) : null;
    }

    // ── termination ───────────────────────────────────────────────────────

    kill() {
        if (!this._subprocess) return;

        log('Killing renderer process');
        this._cancellable.cancel();
        this._subprocess.send_signal(15); // SIGTERM
        this._subprocess = null;
        this._dataInputStream = null;
        this._waylandClient = null;
        this._cancellable = new Gio.Cancellable();
    }
}
