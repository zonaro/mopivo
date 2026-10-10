import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gettext from 'gettext';

const TEXT_DOMAIN = 'mopivo';

let _initialized = false;

function _initGettext() {
    if (_initialized)
        return;

    // Locale directory resolution:
    //   1. Primary: user-local install path (~/.local/share/locale)
    //   2. Fallback: repository <repo>/locale (source-checkout runs)
    let localeDir = null;

    const localPath = GLib.build_filenamev([
        GLib.get_home_dir(),
        '.local', 'share', 'locale',
    ]);
    const localFile = Gio.File.new_for_path(localPath);
    if (localFile.query_exists(null))
        localeDir = localPath;

    if (!localeDir) {
        // i18n.js lives at <repo>/lib/i18n.js — the repo root is two levels up.
        const self = Gio.File.new_for_uri(import.meta.url);
        const repoPath = GLib.build_filenamev([self.get_parent().get_parent().get_path(), 'locale']);
        const repoFile = Gio.File.new_for_path(repoPath);
        if (repoFile.query_exists(null))
            localeDir = repoPath;
    }

    Gettext.bindtextdomain(TEXT_DOMAIN, localeDir || localPath);
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
