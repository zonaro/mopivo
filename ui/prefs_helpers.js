// ui/prefs_helpers.js — Reusable builders for Adw preferences widgets
// Extracted to keep prefs.js under 400 lines.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {_} from '../lib/i18n.js';

// ── ComboRow helpers ─────────────────────────────────────────────────────────

/**
 * Create an Adw.ComboRow backed by a list of string options.
 *
 * @param {object} opts
 * @param {string} opts.title       - Row title.
 * @param {string} opts.subtitle    - Row subtitle.
 * @param {string[]} opts.options   - Array of string values.
 * @param {string} opts.current     - Currently selected value.
 * @param {function} opts.onChange  - Callback receiving the selected string.
 * @returns {Adw.ComboRow}
 */
export function createComboRow({title, subtitle, options, current, onChange}) {
    const row = new Adw.ComboRow({
        title,
        subtitle: subtitle || '',
    });

    const model = Gio.ListStore.new(Gtk.StringObject);
    for (const opt of options)
        model.append(Gtk.StringObject.new(opt));

    row.set_model(model);

    const idx = options.indexOf(current);
    row.set_selected(idx >= 0 ? idx : 0);

    row.connect('notify::selected', () => {
        const selectedIdx = row.get_selected();
        if (selectedIdx < options.length)
            onChange(options[selectedIdx]);
    });

    return row;
}

// ── API Key row helpers ──────────────────────────────────────────────────────

/**
 * Build an API key EntryRow with status subtitle.
 *
 * @param {object} opts
 * @param {Gio.Settings} opts.settings  - GSettings instance.
 * @param {string} opts.keyName         - GSettings key name.
 * @param {string} opts.providerLabel   - Human-readable provider name.
 * @param {Adw.PreferencesGroup} opts.group - Group to add rows to.
 * @returns {{ entryRow: Adw.EntryRow, statusRow: Adw.ActionRow }}
 */
export function buildApiKeyGroup({settings, keyName, providerLabel, group}) {
    const entryRow = new Adw.EntryRow({
        title: _(`${providerLabel} API Key`),
        showApplyButton: true,
    });
    entryRow.set_text(settings.get_string(keyName));
    settings.bind(keyName, entryRow, 'text', Gio.SettingsBindFlags.DEFAULT);
    group.add(entryRow);

    const statusRow = new Adw.ActionRow({
        title: '',
    });
    statusRow.add_css_class('dim-label');
    _updateKeyStatus(statusRow, settings, keyName, providerLabel);
    group.add(statusRow);

    settings.connect(`changed::${keyName}`, () => {
        _updateKeyStatus(statusRow, settings, keyName, providerLabel);
    });

    return {entryRow, statusRow};
}

function _updateKeyStatus(statusRow, settings, keyName, providerLabel) {
    const key = settings.get_string(keyName);
    if (key && key.length > 0) {
        statusRow.set_title(_(`${providerLabel} API key is configured.`));
        statusRow.remove_css_class('warning');
        statusRow.add_css_class('dim-label');
    } else {
        statusRow.set_title(_(`API key required to enable ${providerLabel}.`));
        statusRow.remove_css_class('dim-label');
        statusRow.add_css_class('warning');
    }
}

// ── Help Center builder ──────────────────────────────────────────────────────

/**
 * Build a provider help section as an ExpanderRow with link buttons.
 *
 * @param {object} opts
 * @param {string} opts.providerName   - Display name.
 * @param {string} opts.description    - What the provider offers.
 * @param {string} opts.getKeyUrl      - URL to get API key.
 * @param {string[]} opts.steps        - Setup steps (3 max).
 * @param {string} opts.rateLimit      - Rate limit info.
 * @param {Adw.PreferencesGroup} opts.group - Group to add to.
 */
export function buildProviderHelp({providerName, description, getKeyUrl, steps, rateLimit, group}) {
    const expander = new Adw.ExpanderRow({
        title: providerName,
        subtitle: description,
    });

    // Description row
    const descRow = new Adw.ActionRow({
        title: _('Description'),
        subtitle: description,
    });
    descRow.add_css_class('dim-label');
    expander.add_row(descRow);

    // Steps
    for (let i = 0; i < steps.length; i++) {
        const stepRow = new Adw.ActionRow({
            title: _('Step') + ' ' + (i + 1),
            subtitle: steps[i],
        });
        expander.add_row(stepRow);
    }

    // Rate limit
    if (rateLimit) {
        const rateRow = new Adw.ActionRow({
            title: _('Rate Limit'),
            subtitle: rateLimit,
        });
        expander.add_row(rateRow);
    }

    // Link button row (skipped for providers without a URL, e.g. local ones)
    if (getKeyUrl) {
        const linkRow = new Adw.ActionRow({
            title: _('Get API Key'),
            subtitle: getKeyUrl,
            activatable: true,
        });
        linkRow.add_suffix(new Gtk.Image({
            icon_name: 'external-link-symbolic',
        }));
        linkRow.connect('activated', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(getKeyUrl, null);
            } catch (_e) {
                // Fallback: no default handler
            }
        });
        expander.add_row(linkRow);
    }

    group.add(expander);
}

// ── Help Center page builder ─────────────────────────────────────────────────

/**
 * Build the complete Help Center preferences page.
 *
 * @param {Adw.PreferencesWindow} window - The preferences window.
 * @returns {Adw.PreferencesPage}
 */
export function buildHelpCenterPage(window) {
    const page = new Adw.PreferencesPage({
        title: _('Help Center'),
        iconName: 'help-browser-symbolic',
    });
    window.add(page);

    // ── Provider Setup Guides ───────────────────────────────────────
    const providerHelpGroup = new Adw.PreferencesGroup({
        title: _('Provider Setup Guides'),
        description: _('Step-by-step instructions to configure each wallpaper provider.'),
    });
    page.add(providerHelpGroup);

    buildProviderHelp({
        providerName: _('Wallhaven'),
        description: _('Wallpaper community with SFW, Sketchy, and NSFW content.'),
        getKeyUrl: 'https://wallhaven.cc/settings/account',
        steps: [
            _('Create an account at wallhaven.cc'),
            _('Go to Account Settings and generate an API key'),
            _('Paste the API key in the Providers tab above'),
        ],
        rateLimit: _('No official rate limit, but be respectful (max ~3 req/s recommended).'),
        group: providerHelpGroup,
    });

    buildProviderHelp({
        providerName: _('Pexels'),
        description: _('Free high-quality stock photos and wallpapers.'),
        getKeyUrl: 'https://www.pexels.com/api/',
        steps: [
            _('Create a free account at pexels.com'),
            _('Go to pexels.com/api and request an API key'),
            _('Paste the API key in the Providers tab above'),
        ],
        rateLimit: _('200 requests/hour for free accounts.'),
        group: providerHelpGroup,
    });

    buildProviderHelp({
        providerName: _('Unsplash'),
        description: _('High-resolution free photography.'),
        getKeyUrl: 'https://unsplash.com/developers',
        steps: [
            _('Create an account at unsplash.com'),
            _('Go to unsplash.com/developers and create an application'),
            _('Copy the Access Key and paste in the Providers tab above'),
        ],
        rateLimit: _('50 requests/hour for demo apps, 5000/hour for production.'),
        group: providerHelpGroup,
    });

    buildProviderHelp({
        providerName: _('Safebooru'),
        description: _('Anime image board — SFW only, no API key required.'),
        getKeyUrl: 'https://safebooru.org',
        steps: [
            _('No API key needed — just select Safebooru in the Providers tab'),
            _('Use tags separated by spaces in the search query'),
            _('Safebooru only serves SFW content'),
        ],
        rateLimit: _('Be respectful; avoid excessive rapid requests.'),
        group: providerHelpGroup,
    });

    buildProviderHelp({
        providerName: _('Pixabay'),
        description: _('Free images with a permissive license.'),
        getKeyUrl: 'https://pixabay.com/api/docs/',
        steps: [
            _('Create a free account at pixabay.com'),
            _('Go to pixabay.com/api/docs and copy your API key'),
            _('Paste the API key in the Providers tab above'),
        ],
        rateLimit: _('100 requests/hour for free accounts (basic key).'),
        group: providerHelpGroup,
    });

    buildProviderHelp({
        providerName: _('Waifu.im'),
        description: _('Curated anime image archive — SFW only, no API key required.'),
        getKeyUrl: 'https://www.waifu.im',
        steps: [
            _('No API key needed — just select Waifu.im in the Providers tab'),
            _('Use tags separated by spaces in the search query (e.g. "maid uniform")'),
            _('Leave the query empty to browse random waifus'),
        ],
        rateLimit: _('1 request every 200ms. Each search returns up to 30 fresh random images.'),
        group: providerHelpGroup,
    });

    buildProviderHelp({
        providerName: _('Local Files'),
        description: _('Your own image collection on this computer — no network needed.'),
        getKeyUrl: '',
        steps: [
            _('Your Pictures folder is searched by default'),
            _('Add more folders in the Providers tab, separated by colons'),
            _('Toggle subfolder search and leave the query empty to browse everything'),
        ],
        rateLimit: null,
        group: providerHelpGroup,
    });

// ── General Tips ────────────────────────────────────────────────
    const tipsGroup = new Adw.PreferencesGroup({
        title: _('General Tips'),
    });
    page.add(tipsGroup);

    const switchTip = new Adw.ActionRow({
        title: _('Switching Providers'),
        subtitle: _('Select a provider in the Providers tab. Each provider has its own search filters and content. You can switch at any time.'),
    });
    switchTip.add_css_class('dim-label');
    tipsGroup.add(switchTip);

    const nsfwTip = new Adw.ActionRow({
        title: _('NSFW Content'),
        subtitle: _('NSFW content is only available through Wallhaven and requires a valid API key. Enable the NSFW purity filter only if you have a Wallhaven API key configured.'),
    });
    nsfwTip.add_css_class('dim-label');
    tipsGroup.add(nsfwTip);

    const safebooruTip = new Adw.ActionRow({
        title: _('Safebooru Tag Syntax'),
        subtitle: _('Safebooru uses tags for search. Use underscores for multi-word tags (e.g. "blue_hair, solo"). Combine tags with commas.'),
    });
    safebooruTip.add_css_class('dim-label');
    tipsGroup.add(safebooruTip);

    return page;
}
