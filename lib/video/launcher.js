// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper subsystem — renderer process launcher (app-side, no GNOME Shell).
// Ported from Hanabi LaunchSubprocess. Spawns the renderer under GDK_BACKEND=x11
// (XWayland) so it can set _NET_WM_WINDOW_TYPE_DESKTOP on its windows (Hidamari-style).
//
// Exit notification: the optional `onExit(status)` constructor callback (also
// assignable as `launcher.onExit`) fires exactly once per spawned renderer when
// it exits — on its own, by crash, or via stop()/kill(). Never fires for a
// process superseded by a later start().

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ARG_EXT_PATH, ARG_FILE_PATH, LOG_PREFIX} from './constants.js';

export class RendererLauncher {
    // Options: {appDir, log?, onExit?} — appDir is the app root directory.
    constructor({appDir, log = console.log, onExit = null} = {}) {
        this._appDir = appDir;
        this._logSink = log;
        this.onExit = onExit;
        this._subprocess = null;
        this._cancellable = null;
        this._exited = true;
        this._stopping = false;
    }

    /** The current Gio.Subprocess, or null when no renderer is tracked. */
    get subprocess() {
        return this._subprocess;
    }

    /** True while a spawned renderer is running (false right after stop()). */
    isRunning() {
        return this._subprocess !== null && !this._exited && !this._stopping;
    }

    /** Renderer argv — exposed so tests can assert it without spawning. */
    buildArgv(filePath = null) {
        const gjsPath = GLib.find_program_in_path('gjs');
        const rendererPath = GLib.build_filenamev([
            this._appDir, 'renderer', 'renderer.js',
        ]);
        const argv = [gjsPath, rendererPath, ARG_EXT_PATH, this._appDir];
        if (filePath)
            argv.push(ARG_FILE_PATH, filePath);
        return argv;
    }

    /** Configured SubprocessLauncher (GDK_BACKEND=x11) — exposed for tests. */
    createSubprocessLauncher() {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.setenv('GDK_BACKEND', 'x11', true); // XWayland → DESKTOP type works
        return launcher;
    }

    /** Spawn the renderer. Restarts (stops first) if already running. */
    start({filePath} = {}) {
        if (this._subprocess && !this._exited)
            this.stop();

        const argv = this.buildArgv(filePath ?? null);
        this._log(`Spawning renderer: ${argv.join(' ')}`);

        const launcher = this.createSubprocessLauncher();
        let proc;
        try {
            proc = launcher.spawnv(argv);
        } catch (e) {
            this._log(`Renderer spawn failed: ${e.message}`);
            if (launcher.close)
                launcher.close();
            return null;
        }
        if (launcher.close)
            launcher.close();

        const cancellable = new Gio.Cancellable();
        this._subprocess = proc;
        this._cancellable = cancellable;
        this._exited = false;
        this._stopping = false;

        this._readPipe(proc.get_stdout_pipe());
        this._readPipe(proc.get_stderr_pipe());

        proc.wait_async(cancellable, (p, res) => {
            if (this._subprocess !== p) {
                cancellable.cancel(); // superseded by a newer start()
                return;
            }
            let status = null;
            try {
                p.wait_finish(res);
                if (p.get_if_exited())
                    status = p.get_exit_status();
            } catch (_e) {
                status = null; // cancelled or signal-killed
            }
            cancellable.cancel();
            this._subprocess = null;
            this._cancellable = null;
            this._exited = true;
            this._stopping = false;
            this._log(`Renderer exited (status: ${status ?? 'unknown'})`);
            if (typeof this.onExit === 'function')
                this.onExit(status);
        });

        this._log('Renderer process launched');
        return proc;
    }

    /** Terminate the renderer (SIGTERM, SIGKILL escalation after 3 s). Idempotent. */
    stop() {
        const proc = this._subprocess;
        if (!proc || this._exited || this._stopping)
            return;
        this._stopping = true;
        this._log('Stopping renderer process');
        try {
            proc.send_signal(15); // SIGTERM
        } catch (_e) {
            return;
        }
        // Safety net in case the renderer ignores SIGTERM.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            if (this._subprocess === proc && this._stopping && !this._exited) {
                try {
                    proc.force_exit();
                } catch (_e) { /* already exited */ }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Alias for stop() — matches the old launcher's kill() name. */
    kill() {
        this.stop();
    }

    _log(msg) {
        this._logSink(`${LOG_PREFIX} [launcher] ${msg}`);
    }

    _readPipe(pipe) {
        const dis = Gio.DataInputStream.new(pipe);
        const cancellable = this._cancellable;
        const readNext = () => {
            dis.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                try {
                    const [line, length] = s.read_line_finish_utf8(res);
                    if (line === null)
                        return; // EOF — stop reading
                    if (length > 0)
                        this._log(`[renderer] ${line}`);
                } catch (_e) {
                    return; // cancelled or closed — stop silently
                }
                readNext();
            });
        };
        readNext();
    }
}