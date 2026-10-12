import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gettext from 'gettext';

const TEXT_DOMAIN = 'mopivo';

// Languages offered by the settings UI (mirrors the `language` key).
const SUPPORTED_LANGUAGES = ['en', 'pt_BR', 'es'];

let _initialized = false;

/**
 * Resolve the locale directory:
 *   1. Primary: user-local install path (~/.local/share/locale)
 *   2. Fallback: repository <repo>/locale (source-checkout runs)
 */
function _resolveLocaleDir() {
    const localPath = GLib.build_filenamev([
        GLib.get_home_dir(),
        '.local', 'share', 'locale',
    ]);
    const localFile = Gio.File.new_for_path(localPath);
    if (localFile.query_exists(null))
        return localPath;

    // i18n.js lives at <repo>/lib/i18n.js — the repo root is two levels up.
    const self = Gio.File.new_for_uri(import.meta.url);
    const repoPath = GLib.build_filenamev([self.get_parent().get_parent().get_path(), 'locale']);
    const repoFile = Gio.File.new_for_path(repoPath);
    if (repoFile.query_exists(null))
        return repoPath;

    return localPath;
}

function _initGettext() {
    if (_initialized)
        return;

    Gettext.bindtextdomain(TEXT_DOMAIN, _resolveLocaleDir());
    Gettext.textdomain(TEXT_DOMAIN);
    _initialized = true;
}

/**
 * Initialize gettext for an explicit interface language.
 *
 * A supported language is exported through `LANGUAGE` and libc's locale is
 * re-read (`setlocale(LC_ALL, '')`) so gettext honors the stored key before
 * the domain is bound. Empty, null or unsupported values leave the ambient
 * environment untouched (no setenv). The domain is bound only once, so both
 * this and `_()` are safe to call repeatedly.
 *
 * @param {string|null|undefined} lang - One of 'en', 'pt_BR' or 'es'.
 */
export function initI18n(lang) {
    if (lang && SUPPORTED_LANGUAGES.includes(lang)) {
        GLib.setenv('LANGUAGE', lang, true);
        Gettext.setlocale(Gettext.LocaleCategory.ALL, '');
    }
    _initGettext();
}

/**
 * Translate a string using gettext.
 * Falls back to the original string if no translation is found.
 */
export function _(str) {
    _initGettext();
    return Gettext.dgettext(TEXT_DOMAIN, str) || str;
}
