// SPDX-License-Identifier: GPL-3.0-or-later
// prefs.js — Mopivo standalone preferences window (GTK4/libadwaita)
// 5 pages: Providers, Filters, Downloads, Help Center, Video
// English default; all user strings wrapped in _() for i18n.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import {getDefaultPicturesDir} from './lib/providers/local.js';
import {WALLHAVEN_COLORS} from './lib/providers/wallhaven-client.js';
import {
    getDefaultImageDownloadDir,
    getDefaultVideoDir,
} from './lib/paths.js';

import {_} from './lib/i18n.js';
import {
    createComboRow,
    buildApiKeyGroup,
    buildHelpCenterPage,
} from './ui/prefs_helpers.js';

const PROVIDER_OPTIONS = ['wallhaven', 'pexels', 'unsplash', 'safebooru', 'pixabay', 'waifuim', 'local'];

const PROVIDER_LABELS = {
    wallhaven: 'Wallhaven',
    pexels: 'Pexels',
    unsplash: 'Unsplash',
    safebooru: 'Safebooru',
    pixabay: 'Pixabay',
    waifuim: 'Waifu.im',
    local: 'Local Files',
};

const PROVIDER_KEY_MAP = {
    wallhaven: 'api-key',
    pexels: 'pexels-api-key',
    unsplash: 'unsplash-api-key',
    safebooru: null,
    pixabay: 'pixabay-api-key',
    waifuim: null,
    local: null,
};

export function buildPreferencesWindow(settings, application = null) {
    const window = new Adw.PreferencesWindow({
        title: _('Mopivo'),
        application,
    });

    // ── Page 1: Providers ──────────────────────────────────────────
    buildProvidersPage(window, settings);

    // ── Page 2: Filters ────────────────────────────────────────────
    buildFiltersPage(window, settings);

    // ── Page 3: Downloads ──────────────────────────────────────────
    buildDownloadsPage(window, settings);

    // ── Page 4: Help Center ────────────────────────────────────────
    buildHelpCenterPage(window);

    // ── Page 5: Video ─────────────────────────────────────────────
    buildVideoPage(window, settings);

    return window;
}

// ── Page 1: Providers ────────────────────────────────────────────────

function buildProvidersPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Providers'),
            iconName: 'network-transmit-receive-symbolic',
        });
        window.add(page);

        // API Key section
        const apiKeyGroup = new Adw.PreferencesGroup({
            title: _('API Keys'),
            description: _('Configure API keys for each provider. Keys are required to enable the corresponding provider.'),
        });
        page.add(apiKeyGroup);

        // Wallhaven
        buildApiKeyGroup({
            settings,
            keyName: 'api-key',
            providerLabel: 'Wallhaven',
            group: apiKeyGroup,
        });

        // Pexels
        buildApiKeyGroup({
            settings,
            keyName: 'pexels-api-key',
            providerLabel: 'Pexels',
            group: apiKeyGroup,
        });

        // Unsplash
        buildApiKeyGroup({
            settings,
            keyName: 'unsplash-api-key',
            providerLabel: 'Unsplash',
            group: apiKeyGroup,
        });

        // Pixabay
        buildApiKeyGroup({
            settings,
            keyName: 'pixabay-api-key',
            providerLabel: 'Pixabay',
            group: apiKeyGroup,
        });

        // Safebooru — no key needed
        const safebooruRow = new Adw.ActionRow({
            title: _('Safebooru'),
            subtitle: _('No API key required'),
        });
        safebooruRow.add_suffix(new Gtk.Image({
            icon_name: 'emblem-ok-symbolic',
        }));
        apiKeyGroup.add(safebooruRow);

        // Local Files — folders instead of API key
        const localGroup = new Adw.PreferencesGroup({
            title: _('Local Files'),
            description: _('Search wallpapers in folders on this computer.'),
        });
        page.add(localGroup);

        const picturesDir = getDefaultPicturesDir();
        const defaultFolderRow = new Adw.ActionRow({
            title: _('Default Folder'),
            subtitle: picturesDir || _('Not found'),
        });
        defaultFolderRow.add_css_class('dim-label');
        localGroup.add(defaultFolderRow);

        const extraFoldersRow = new Adw.EntryRow({
            title: _('Extra Folders'),
            showApplyButton: true,
        });
        extraFoldersRow.set_text(settings.get_strv('local-folders').join(':'));
        extraFoldersRow.set_placeholder_text?.(_('/home/user/Wallpapers:/mnt/photos'));
        extraFoldersRow.connect('apply', () => {
            const folders = extraFoldersRow.get_text().split(':')
                .map(s => s.trim()).filter(Boolean);
            settings.set_strv('local-folders', folders);
        });
        localGroup.add(extraFoldersRow);

        const extraFoldersHint = new Adw.ActionRow({
            title: _('Separate multiple folders with a colon (:)'),
        });
        extraFoldersHint.add_css_class('dim-label');
        localGroup.add(extraFoldersHint);

        const recursiveRow = new Adw.SwitchRow({
            title: _('Include Subfolders'),
            subtitle: _('Search inside subfolders recursively'),
        });
        settings.bind('local-recursive', recursiveRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        localGroup.add(recursiveRow);

        // Interface language
        const languageGroup = new Adw.PreferencesGroup({
            title: _('Language'),
        });
        page.add(languageGroup);

        const languageOptions = [
            {value: 'en', label: _('English')},
            {value: 'pt_BR', label: _('Portuguese (Brazil)')},
            {value: 'es', label: _('Spanish')},
        ];
        const languageRow = createComboRow({
            title: _('Interface Language'),
            subtitle: _('Choose the language of the interface'),
            options: languageOptions.map((opt) => opt.label),
            current: (languageOptions.find(
                (opt) => opt.value === settings.get_string('language')
            ) || languageOptions[0]).label,
            onChange: (label) => {
                const chosen = languageOptions.find((opt) => opt.label === label);
                if (chosen)
                    settings.set_string('language', chosen.value);
            },
        });
        languageGroup.add(languageRow);

        // Provider status note
        const statusGroup = new Adw.PreferencesGroup({
            title: _('Provider Status'),
        });
        page.add(statusGroup);

    const statusRow = new Adw.ActionRow({
        title: '',
    });
    statusRow.add_css_class('dim-label');
    statusGroup.add(statusRow);

    refreshProviderStatus(statusRow, settings);

    settings.connect('changed::active-provider', () => {
        refreshProviderStatus(statusRow, settings);
    });
    settings.connect('changed::api-key', () => {
        refreshProviderStatus(statusRow, settings);
    });
    settings.connect('changed::pexels-api-key', () => {
        refreshProviderStatus(statusRow, settings);
    });
    settings.connect('changed::unsplash-api-key', () => {
        refreshProviderStatus(statusRow, settings);
    });
    settings.connect('changed::pixabay-api-key', () => {
        refreshProviderStatus(statusRow, settings);
    });
}

function refreshProviderStatus(statusRow, settings) {
    const provider = settings.get_string('active-provider');
    const keyName = PROVIDER_KEY_MAP[provider];

    if (!keyName) {
        // No API key needed
        statusRow.set_title(
            _('Active provider: ') + PROVIDER_LABELS[provider] + ' — ' + _('Ready')
        );
        statusRow.remove_css_class('warning');
        statusRow.add_css_class('dim-label');
        return;
    }

    const key = settings.get_string(keyName);
    if (key && key.length > 0) {
        statusRow.set_title(
            _('Active provider: ') + PROVIDER_LABELS[provider] + ' — ' + _('Ready')
        );
        statusRow.remove_css_class('warning');
        statusRow.add_css_class('dim-label');
    } else {
        statusRow.set_title(
            _('Active provider: ') + PROVIDER_LABELS[provider] + ' — ' + _('API key required')
        );
        statusRow.remove_css_class('dim-label');
        statusRow.add_css_class('warning');
    }
}

function buildFiltersPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Filters'),
            iconName: 'system-search-symbolic',
        });
        window.add(page);

        // ── Search ──────────────────────────────────────────────────────
        const searchGroup = new Adw.PreferencesGroup({
            title: _('Search'),
        });
        page.add(searchGroup);

        const searchQueryRow = new Adw.EntryRow({
            title: _('Search Query'),
        });
        searchQueryRow.set_placeholder_text?.(_('Leave empty for recent wallpapers'));
        settings.bind('search-query', searchQueryRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        searchGroup.add(searchQueryRow);

        // ── Categories and Purity ───────────────────────────────────────
        const filterGroup = new Adw.PreferencesGroup({
            title: _('Filters'),
        });
        page.add(filterGroup);

        const categoriesRow = new Adw.EntryRow({
            title: _('Categories'),
        });
        categoriesRow.set_placeholder_text?.(_('111 (general, anime, people)'));
        settings.bind('categories', categoriesRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        filterGroup.add(categoriesRow);

        const purityRow = new Adw.EntryRow({
            title: _('Purity'),
        });
        purityRow.set_placeholder_text?.(_('100 (sfw, sketchy, nsfw)'));
        settings.bind('purity', purityRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        filterGroup.add(purityRow);

        // ── Sorting ─────────────────────────────────────────────────────
        const sortingRow = createComboRow({
            title: _('Sorting'),
            subtitle: _('Sort method for results'),
            options: ['date_added', 'relevance', 'random', 'views', 'favorites', 'toplist'],
            current: settings.get_string('sorting'),
            onChange: (val) => settings.set_string('sorting', val),
        });
        filterGroup.add(sortingRow);

        // ── Order ───────────────────────────────────────────────────────
        const orderRow = createComboRow({
            title: _('Order'),
            subtitle: _('Sort direction'),
            options: ['desc', 'asc'],
            current: settings.get_string('order'),
            onChange: (val) => settings.set_string('order', val),
        });
        filterGroup.add(orderRow);

        // ── Top Range ───────────────────────────────────────────────────
        const topRangeRow = createComboRow({
            title: _('Top Range'),
            subtitle: _('Time range for toplist sorting'),
            options: ['1d', '3d', '1w', '1M', '3M', '6M', '1y'],
            current: settings.get_string('top-range'),
            onChange: (val) => settings.set_string('top-range', val),
        });
        filterGroup.add(topRangeRow);

        // ── Resolution / Aspect Ratio / Color ───────────────────────────
        const atleastRow = new Adw.EntryRow({
            title: _('At Least (minimum resolution)'),
        });
        atleastRow.set_placeholder_text?.('1920x1080');
        settings.bind('atleast', atleastRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        filterGroup.add(atleastRow);

        const resolutionsRow = new Adw.EntryRow({
            title: _('Resolutions'),
        });
        resolutionsRow.set_placeholder_text?.('1920x1080,2560x1440');
        settings.bind('resolutions', resolutionsRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        filterGroup.add(resolutionsRow);

        const ratiosRow = new Adw.EntryRow({
            title: _('Aspect Ratios'),
        });
        ratiosRow.set_placeholder_text?.('16x9,16x10,21x9');
        settings.bind('ratios', ratiosRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        filterGroup.add(ratiosRow);

        const COLOR_ANY_LABEL = _('Any color');
        const colorOptions = [COLOR_ANY_LABEL, ...WALLHAVEN_COLORS];
        const colorsRow = createComboRow({
            title: _('Colors'),
            subtitle: _('Filter wallpapers by dominant color'),
            options: colorOptions,
            current: settings.get_string('colors') || COLOR_ANY_LABEL,
            onChange: (val) => {
                settings.set_string('colors', val === COLOR_ANY_LABEL ? '' : val);
            },
        });
        filterGroup.add(colorsRow);

        // ── AI Art Filter ───────────────────────────────────────────────
        const aiArtFilterRow = new Adw.SwitchRow({
            title: _('AI Art Filter'),
            subtitle: _('Filter out AI-generated content'),
        });
        settings.bind('ai-art-filter', aiArtFilterRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        filterGroup.add(aiArtFilterRow);
    }

    // ── Page 3: Downloads ─────────────────────────────────────────────────

function buildDownloadsPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Downloads'),
            iconName: 'folder-download-symbolic',
        });
        window.add(page);

        const downloadGroup = new Adw.PreferencesGroup({
            title: _('Download Settings'),
        });
        page.add(downloadGroup);

        const downloadFolderRow = new Adw.EntryRow({
            title: _('Download Folder'),
        });
        downloadFolderRow.set_placeholder_text?.(getDefaultImageDownloadDir());
        downloadFolderRow.set_tooltip_text?.(getDefaultImageDownloadDir());
        settings.bind('download-folder', downloadFolderRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        downloadGroup.add(downloadFolderRow);

        const setBackgroundRow = new Adw.SwitchRow({
            title: _('Set as Wallpaper'),
            subtitle: _('Automatically apply the downloaded wallpaper'),
        });
        settings.bind('set-background', setBackgroundRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        downloadGroup.add(setBackgroundRow);

        const pageSizeAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 24,
            stepIncrement: 1,
            pageIncrement: 6,
            value: settings.get_int('page-size'),
        });

        const pageSizeRow = new Adw.SpinRow({
            title: _('Page Size'),
            subtitle: _('Number of wallpapers per page (1-24)'),
            adjustment: pageSizeAdjustment,
            digits: 0,
        });
        settings.bind('page-size', pageSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        downloadGroup.add(pageSizeRow);

        const placementRow = createComboRow({
            title: _('Placement'),
            subtitle: _('How wallpapers are applied across monitors'),
            options: ['same', 'span', 'per-monitor'],
            current: settings.get_string('wallpaper-mode'),
            onChange: (val) => settings.set_string('wallpaper-mode', val),
        });
        downloadGroup.add(placementRow);
    }

    // ── Page 5: Video ─────────────────────────────────────────────────────

function buildVideoPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Video'),
            iconName: 'video-x-generic-symbolic',
        });
        window.add(page);

        // ── Source ──────────────────────────────────────────────────
        const sourceGroup = new Adw.PreferencesGroup({
            title: _('Source'),
            description: _('Configure the video wallpaper source.'),
        });
        page.add(sourceGroup);

        const videoModeRow = new Adw.SwitchRow({
            title: _('Enable Video Mode'),
            subtitle: _('Switch from image browsing to video wallpaper mode'),
        });
        settings.bind('video-mode', videoModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        sourceGroup.add(videoModeRow);

        const sourceTypeRow = createComboRow({
            title: _('Source Type'),
            subtitle: _('Type of video source'),
            options: ['local', 'streaming', 'webpage'],
            current: settings.get_string('video-mode-type'),
            onChange: (val) => settings.set_string('video-mode-type', val),
        });
        sourceGroup.add(sourceTypeRow);

        const videoFolderRow = new Adw.EntryRow({
            title: _('Video Folder'),
        });
        videoFolderRow.set_placeholder_text?.(getDefaultVideoDir());
        videoFolderRow.set_tooltip_text?.(getDefaultVideoDir());
        settings.bind('video-folder', videoFolderRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        sourceGroup.add(videoFolderRow);

        const videoPathRow = new Adw.EntryRow({
            title: _('Video Path'),
        });
        videoPathRow.set_placeholder_text?.('/home/user/Videos/wallpaper.mp4');
        settings.bind('video-path', videoPathRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        sourceGroup.add(videoPathRow);

        const streamingUrlRow = new Adw.EntryRow({
            title: _('Streaming URL'),
        });
        streamingUrlRow.set_placeholder_text?.('https://www.youtube.com/watch?v=...');
        settings.bind('video-streaming-url', streamingUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        sourceGroup.add(streamingUrlRow);

        const webpageUrlRow = new Adw.EntryRow({
            title: _('Webpage URL'),
        });
        webpageUrlRow.set_placeholder_text?.('https://example.com');
        settings.bind('video-webpage-url', webpageUrlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        sourceGroup.add(webpageUrlRow);

        const localHtmlRow = new Adw.EntryRow({
            title: _('Local HTML File'),
        });
        localHtmlRow.set_placeholder_text?.('/home/user/page.html');
        settings.bind('video-webpage-local-html', localHtmlRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        sourceGroup.add(localHtmlRow);

        // ── Playback ────────────────────────────────────────────────
        const playbackGroup = new Adw.PreferencesGroup({
            title: _('Playback'),
            description: _('Audio and video playback settings.'),
        });
        page.add(playbackGroup);

        const volumeAdj = new Gtk.Adjustment({
            lower: 0,
            upper: 100,
            step_increment: 1,
            page_increment: 10,
            value: settings.get_int('video-volume'),
        });
        const volumeRow = new Adw.SpinRow({
            title: _('Volume'),
            subtitle: _('Audio volume of the video wallpaper (0-100)'),
            adjustment: volumeAdj,
            digits: 0,
        });
        settings.bind('video-volume', volumeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        playbackGroup.add(volumeRow);

        const muteRow = new Adw.SwitchRow({
            title: _('Mute'),
            subtitle: _('Mute the video wallpaper audio'),
        });
        settings.bind('video-mute', muteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        playbackGroup.add(muteRow);

        const fadeAdj = new Gtk.Adjustment({
            lower: 0,
            upper: 10,
            step_increment: 0.5,
            page_increment: 1,
            value: settings.get_double('video-fade-duration-sec'),
        });
        const fadeRow = new Adw.SpinRow({
            title: _('Fade Duration'),
            subtitle: _('Volume fade duration in seconds'),
            adjustment: fadeAdj,
            digits: 1,
        });
        settings.bind('video-fade-duration-sec', fadeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        playbackGroup.add(fadeRow);

        const audioPrimaryRow = new Adw.SwitchRow({
            title: _('Audio Only on Primary Monitor'),
            subtitle: _('Play audio only on the primary monitor'),
        });
        settings.bind('video-audio-primary-monitor-only', audioPrimaryRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        playbackGroup.add(audioPrimaryRow);

        const fitModeRow = createComboRow({
            title: _('Fit Mode'),
            subtitle: _('How the video is fitted on screen'),
            options: ['contain', 'cover', 'fill', 'scale-down'],
            current: settings.get_string('video-fit-mode'),
            onChange: (val) => settings.set_string('video-fit-mode', val),
        });
        playbackGroup.add(fitModeRow);

        const randomStartRow = new Adw.SwitchRow({
            title: _('Random Start'),
            subtitle: _('Seek to a random position when playback starts'),
        });
        settings.bind('video-random-start', randomStartRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        playbackGroup.add(randomStartRow);

        const monitorPathsRow = new Adw.EntryRow({
            title: _('Per-Monitor Video Paths'),
        });
        monitorPathsRow.set_placeholder_text?.('HDMI-1=/path/a.mp4:eDP-1=/path/b.mp4');
        const monitorPaths = settings.get_strv('video-monitor-paths');
        monitorPathsRow.set_text(monitorPaths.join(':'));
        monitorPathsRow.connect('apply', () => {
            const paths = monitorPathsRow.get_text().split(':')
                .map(s => s.trim()).filter(Boolean);
            settings.set_strv('video-monitor-paths', paths);
        });
        playbackGroup.add(monitorPathsRow);

        // ── Auto-Pause ──────────────────────────────────────────────
        const autoPauseGroup = new Adw.PreferencesGroup({
            title: _('Auto-Pause'),
            description: _('Automatically pause the video wallpaper.'),
        });
        page.add(autoPauseGroup);

        const PM_MAX_LABELS = [_('Never'), _('Any monitor'), _('All monitors')];
        const pauseMaxCombo = new Adw.ComboRow({
            title: _('Pause on Maximize/Fullscreen'),
            subtitle: _('Pause video when a window is maximized or fullscreen'),
        });
        const pmMaxModel = Gio.ListStore.new(Gtk.StringObject);
        for (const label of PM_MAX_LABELS)
            pmMaxModel.append(Gtk.StringObject.new(label));
        pauseMaxCombo.set_model(pmMaxModel);
        pauseMaxCombo.set_selected(settings.get_int('pause-on-maximize-or-fullscreen'));
        pauseMaxCombo.connect('notify::selected', () => {
            settings.set_int('pause-on-maximize-or-fullscreen', pauseMaxCombo.get_selected());
        });
        autoPauseGroup.add(pauseMaxCombo);

        const pauseFocusRow = new Adw.SwitchRow({
            title: _('Pause on Window Focus'),
            subtitle: _('Pause video whenever any window has focus'),
        });
        settings.bind('pause-on-focus', pauseFocusRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoPauseGroup.add(pauseFocusRow);

        const PWR_LABELS = [_('Never'), _('Low battery'), _('Always')];
        const pauseBatteryCombo = new Adw.ComboRow({
            title: _('Pause on Battery'),
            subtitle: _('Pause video based on power status'),
        });
        const pwrModel = Gio.ListStore.new(Gtk.StringObject);
        for (const label of PWR_LABELS)
            pwrModel.append(Gtk.StringObject.new(label));
        pauseBatteryCombo.set_model(pwrModel);
        pauseBatteryCombo.set_selected(settings.get_int('pause-on-battery'));
        pauseBatteryCombo.connect('notify::selected', () => {
            settings.set_int('pause-on-battery', pauseBatteryCombo.get_selected());
        });
        autoPauseGroup.add(pauseBatteryCombo);

        const thresholdAdj = new Gtk.Adjustment({
            lower: 0,
            upper: 100,
            step_increment: 1,
            page_increment: 5,
            value: settings.get_int('low-battery-threshold'),
        });
        const thresholdRow = new Adw.SpinRow({
            title: _('Low Battery Threshold'),
            subtitle: _('Battery percentage below which to pause'),
            adjustment: thresholdAdj,
            digits: 0,
        });
        settings.bind('low-battery-threshold', thresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        autoPauseGroup.add(thresholdRow);

        const pauseMprisRow = new Adw.SwitchRow({
            title: _('Pause on Media Playing'),
            subtitle: _('Pause video whenever a media player is playing'),
        });
        settings.bind('pause-on-mpris-playing', pauseMprisRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoPauseGroup.add(pauseMprisRow);

        const waylandPauseNote = new Adw.ActionRow({
            title: _('Auto-pause is unavailable on GNOME Wayland'),
        });
        waylandPauseNote.add_css_class('dim-label');
        autoPauseGroup.add(waylandPauseNote);

        // ── Auto-Change ─────────────────────────────────────────────
        const autoChangeGroup = new Adw.PreferencesGroup({
            title: _('Auto-Change'),
            description: _('Automatically change the video wallpaper periodically.'),
        });
        page.add(autoChangeGroup);

        const changeWallpaperRow = new Adw.SwitchRow({
            title: _('Auto-Change Wallpaper'),
            subtitle: _('Periodically change the video wallpaper from a directory'),
        });
        settings.bind('change-wallpaper', changeWallpaperRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        autoChangeGroup.add(changeWallpaperRow);

        const changeDirRow = new Adw.EntryRow({
            title: _('Auto-Change Directory'),
        });
        changeDirRow.set_placeholder_text?.('/home/user/Videos/Wallpapers');
        settings.bind('change-wallpaper-directory-path', changeDirRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        autoChangeGroup.add(changeDirRow);

        const changeIntervalAdj = new Gtk.Adjustment({
            lower: 1,
            upper: 1440,
            step_increment: 1,
            page_increment: 15,
            value: settings.get_int('change-wallpaper-interval'),
        });
        const changeIntervalRow = new Adw.SpinRow({
            title: _('Auto-Change Interval'),
            subtitle: _('Minutes between automatic wallpaper changes'),
            adjustment: changeIntervalAdj,
            digits: 0,
        });
        settings.bind('change-wallpaper-interval', changeIntervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        autoChangeGroup.add(changeIntervalRow);

        const CHG_LABELS = [_('Sequential'), _('Reverse'), _('Random')];
        const changeModeCombo = new Adw.ComboRow({
            title: _('Change Mode'),
            subtitle: _('Order when changing wallpapers'),
        });
        const chgModel = Gio.ListStore.new(Gtk.StringObject);
        for (const label of CHG_LABELS)
            chgModel.append(Gtk.StringObject.new(label));
        changeModeCombo.set_model(chgModel);
        changeModeCombo.set_selected(settings.get_int('change-wallpaper-mode'));
        changeModeCombo.connect('notify::selected', () => {
            settings.set_int('change-wallpaper-mode', changeModeCombo.get_selected());
        });
        autoChangeGroup.add(changeModeCombo);

        // ── Static ──────────────────────────────────────────────────
        const staticGroup = new Adw.PreferencesGroup({
            title: _('Static'),
            description: _('Extract a frame from the video as static wallpaper.'),
        });
        page.add(staticGroup);

        const staticFromVideoRow = new Adw.SwitchRow({
            title: _('Extract Static Wallpaper from Video'),
            subtitle: _('Extract a frame and set it as the static desktop background'),
        });
        settings.bind('static-wallpaper-from-video', staticFromVideoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        staticGroup.add(staticFromVideoRow);

        const blurEnabledRow = new Adw.SwitchRow({
            title: _('Blur Static Wallpaper'),
            subtitle: _('Blur the extracted frame before setting as wallpaper'),
        });
        settings.bind('static-wallpaper-blur-enabled', blurEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        staticGroup.add(blurEnabledRow);

        const blurRadiusAdj = new Gtk.Adjustment({
            lower: 0,
            upper: 100,
            step_increment: 1,
            page_increment: 10,
            value: settings.get_int('static-wallpaper-blur-radius'),
        });
        const blurRadiusRow = new Adw.SpinRow({
            title: _('Blur Radius'),
            subtitle: _('Gaussian blur radius for the static wallpaper'),
            adjustment: blurRadiusAdj,
            digits: 0,
        });
        settings.bind('static-wallpaper-blur-radius', blurRadiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        staticGroup.add(blurRadiusRow);

        // ── Advanced ────────────────────────────────────────────────
        const advancedGroup = new Adw.PreferencesGroup({
            title: _('Advanced'),
        });
        page.add(advancedGroup);

        const lockScreenRow = new Adw.SwitchRow({
            title: _('Show on Lock Screen'),
            subtitle: _('Keep the video wallpaper visible on the lock screen'),
        });
        settings.bind('show-on-lock-screen', lockScreenRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(lockScreenRow);

        const startupDelayAdj = new Gtk.Adjustment({
            lower: 0,
            upper: 10000,
            step_increment: 100,
            page_increment: 500,
            value: settings.get_int('startup-delay'),
        });
        const startupDelayRow = new Adw.SpinRow({
            title: _('Startup Delay'),
            subtitle: _('Milliseconds to wait before launching the renderer'),
            adjustment: startupDelayAdj,
            digits: 0,
        });
        settings.bind('startup-delay', startupDelayRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(startupDelayRow);

        const panelMenuRow = new Adw.SwitchRow({
            title: _('Show Panel Menu'),
            subtitle: _('Show the video control menu in the panel'),
        });
        settings.bind('show-panel-menu', panelMenuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(panelMenuRow);

        const enableVaRow = new Adw.SwitchRow({
            title: _('Enable VA-API Hardware Decoding'),
            subtitle: _('Prefer VA-API hardware decoding for the video wallpaper'),
        });
        settings.bind('enable-va', enableVaRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(enableVaRow);

        const enableNvslRow = new Adw.SwitchRow({
            title: _('Enable NVIDIA Stateless Decoders'),
            subtitle: _('Use NVIDIA stateless decoders for hardware decoding'),
        });
        settings.bind('enable-nvsl', enableNvslRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(enableNvslRow);

        const clappersinkRow = new Adw.SwitchRow({
            title: _('Prefer Clappersink'),
            subtitle: _('Prefer clappersink over gtk4paintablesink'),
        });
        settings.bind('prefer-clappersink', clappersinkRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(clappersinkRow);

        const forceMediafileRow = new Adw.SwitchRow({
            title: _('Force GTK MediaFile Backend'),
            subtitle: _('Use Gtk.MediaFile backend instead of GStreamer'),
        });
        settings.bind('force-mediafile', forceMediafileRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(forceMediafileRow);
    }
