/**
 * Provider Registry — discover and instantiate wallpaper providers.
 *
 * Usage:
 *   import {getProvider, isProviderConfigured, PROVIDER_IDS} from './registry.js';
 *   const wh = await getProvider('wallhaven');
 *   const result = await wh.search({q: 'nature'}, session, settings);
 *
 * Providers are lazy-loaded on first access via dynamic import().
 * Providers not yet implemented will throw on import (caught by caller).
 *
 * @module registry
 */

// ---------------------------------------------------------------------------
// Provider IDs — canonical list of supported providers
// ---------------------------------------------------------------------------

/** @type {string[]} */
export const PROVIDER_IDS = [
    'wallhaven',
    'pexels',
    'unsplash',
    'safebooru',
    'pixabay',
    'waifuim',
    'local',
];

// ---------------------------------------------------------------------------
// Provider metadata (static, no import needed)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ProviderMeta
 * @property {string}  displayName    Human-readable name
 * @property {boolean} requiresApiKey Whether API key is mandatory
 * @property {boolean} supportsVideo  Whether the provider can search videos
 * @property {string}  website        Provider homepage URL
 * @property {string}  keyUrl         URL where users can obtain an API key
 */

/** @type {Object<string, ProviderMeta>} */
export const PROVIDER_META = {
    wallhaven: {
        displayName: 'Wallhaven',
        requiresApiKey: false,
        supportsVideo: false,
        website: 'https://wallhaven.cc',
        keyUrl: 'https://wallhaven.cc/settings#api-key',
    },
    pexels: {
        displayName: 'Pexels',
        requiresApiKey: true,
        supportsVideo: true,
        website: 'https://www.pexels.com',
        keyUrl: 'https://www.pexels.com/api/',
    },
    unsplash: {
        displayName: 'Unsplash',
        requiresApiKey: true,
        supportsVideo: false,
        website: 'https://unsplash.com',
        keyUrl: 'https://unsplash.com/developers',
    },
    safebooru: {
        displayName: 'Safebooru',
        requiresApiKey: false,
        supportsVideo: false,
        website: 'https://safebooru.org',
        keyUrl: '',
    },
    pixabay: {
        displayName: 'Pixabay',
        requiresApiKey: true,
        supportsVideo: true,
        website: 'https://pixabay.com',
        keyUrl: 'https://pixabay.com/api/docs/',
    },
    waifuim: {
        displayName: 'Waifu.im',
        requiresApiKey: false,
        supportsVideo: false,
        website: 'https://www.waifu.im',
        keyUrl: '',
    },
    local: {
        displayName: 'Local Files',
        requiresApiKey: false,
        supportsVideo: false,
        website: '',
        keyUrl: '',
    },
};

/**
 * Provider ids that can search videos, derived from PROVIDER_META.
 * @type {string[]}
 */
export const VIDEO_PROVIDER_IDS = PROVIDER_IDS.filter(
    id => PROVIDER_META[id].supportsVideo
);

// ---------------------------------------------------------------------------
// Dynamic import map — lazy-loaded provider classes
// ---------------------------------------------------------------------------

/**
 * Map of provider ID -> module path (relative to this file).
 * Add new entries here as providers are implemented.
 * @type {Object<string, string>}
 */
const PROVIDER_MODULES = {
    wallhaven: './wallhaven.js',
    pexels: './pexels.js',
    unsplash: './unsplash.js',
    safebooru: './safebooru.js',
    pixabay: './pixabay.js',
    waifuim: './waifuim.js',
    local: './local.js',
};

/** Cache for instantiated provider singletons. */
const _instances = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get a provider instance by ID. Returns a cached singleton.
 * The provider module is dynamically imported on first access.
 *
 * @param {string} id  Provider identifier (e.g. 'wallhaven')
 * @returns {Promise<import('./base.js').BaseProvider>}
 * @throws {Error} If the provider ID is unknown or its module cannot be loaded
 */
export async function getProvider(id) {
    if (_instances.has(id))
        return _instances.get(id);

    const modulePath = PROVIDER_MODULES[id];
    if (!modulePath)
        throw new Error(`Unknown provider: '${id}'. Available: ${PROVIDER_IDS.join(', ')}`);

    // Dynamic import — returns {WallhavenProvider}, {PexelsProvider}, etc.
    const mod = await import(modulePath);

    // Convention: each provider module exports a class named <Id>Provider
    // e.g. WallhavenProvider, PexelsProvider
    const className = `${id.charAt(0).toUpperCase()}${id.slice(1)}Provider`;
    const ProviderClass = mod[className];

    if (!ProviderClass)
        throw new Error(
            `Provider module '${modulePath}' does not export '${className}'`
        );

    const instance = new ProviderClass();
    _instances.set(id, instance);
    return instance;
}

/**
 * Check whether a provider is configured (API key present if required).
 *
 * @param {string}       id        Provider identifier
 * @param {Gio.Settings} settings  Extension GSettings instance
 * @returns {Promise<boolean>}
 */
export async function isProviderConfigured(id, settings) {
    try {
        const provider = await getProvider(id);
        return provider.isConfigured(settings);
    } catch {
        return false;
    }
}
