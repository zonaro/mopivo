import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gettext from 'gettext';

const TEXT_DOMAIN = 'wallpaper-providers-gnome';

let _initialized = false;

function _initGettext() {
    if (_initialized)
        return;

    let localeDir = null;

    // Try user-local install path
    const localPath = GLib.build_filenamev([
        GLib.get_home_dir(),
        '.local', 'share', 'gnome-shell-extensions',
        'wallpaper-providers-gnome@redclaw.com.br', 'locale',
    ]);

    const localFile = Gio.File.new_for_path(localPath);
    if (localFile.query_exists(null))
        localeDir = localPath;

    // Try system-wide paths
    if (!localeDir) {
        for (const dir of GLib.get_system_data_dirs()) {
            const sysPath = GLib.build_filenamev([dir, 'gnome-shell-extensions', 'wallpaper-providers-gnome@redclaw.com.br', 'locale']);
            const sysFile = Gio.File.new_for_path(sysPath);
            if (sysFile.query_exists(null)) {
                localeDir = sysPath;
                break;
            }
        }
    }

    if (localeDir)
        Gettext.bindtextdomain(TEXT_DOMAIN, localeDir);
    else
        Gettext.bindtextdomain(TEXT_DOMAIN, GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'locale']));

    Gettext.textdomain(TEXT_DOMAIN);
    _initialized = true;
}

/**
 * Translate a string using gettext.
 * Falls back to the original string if no translation is found.
 */
export function _(str) {
    _initGettext();
    return Gettext.dgettext(TEXT_DOMAIN, str) || str;
}
