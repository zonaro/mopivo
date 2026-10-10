# Provider Abstraction Layer

Wallpaper source providers with a unified interface for searching, normalizing, and downloading images.

## Architecture

```
lib/providers/
  base.js              BaseProvider abstract class + NormalizedItem/Result types
  registry.js          Dynamic provider registry + metadata (PROVIDER_IDS, PROVIDER_META)
  wallhaven.js         WallhavenProvider — wraps the raw client, normalizes output
  wallhaven-client.js  WallhavenClient — raw Wallhaven API v1 HTTP client
                       (imported by wallhaven.js; keep the class/file
                       names in sync: file <name>.js holds the legacy client,
                       provider modules are named after the provider id)
  pexels.js            PexelsProvider (API key required)
  unsplash.js          UnsplashProvider (API key required)
  safebooru.js         SafebooruProvider (no key)
  pixabay.js           PixabayProvider (API key required)
  waifuim.js           WaifuimProvider (no key)
  local.js             LocalProvider (no key) + getDefaultPicturesDir() helper
  README.md            This file

lib/download.js        Shared download helper (Soup for http(s), Gio copy for file://)
lib/i18n.js            Gettext helper — _(str) with locale auto-detection
```

## Normalized Result Shape

All providers return the same structure from `search()`:

```js
{
  items: [              // NormalizedItem[]
    {
      id: string,       // Unique ID within the provider
      previewUrl: string,  // URL to small thumbnail image
      fullUrl: string,     // URL to full-resolution image
      resolution: string,  // Human-readable (e.g. "1920x1080")
      previewWidth: number,  // Preview width in pixels (0 = unknown)
      previewHeight: number, // Preview height in pixels (0 = unknown)
      source: string,      // Provider ID (e.g. "wallhaven")
      sourceUrl: string,   // Item URL on provider website
      purity?: string,     // Optional purity label (e.g. "sfw", "sketchy", "nsfw")
      tags?: string[],     // Optional tag names
    }
  ],
  total: number,        // Total results available
  page: number,         // Current page (1-based)
  lastPage: number,     // Total pages
}
```

## Wallhaven Field Mapping

| Raw Wallhaven `data[]` field | Normalized field | Notes |
|---|---|---|
| `id` | `id` | Direct copy |
| `thumbs.small` | `previewUrl` | Falls back to `.medium` then `.large` |
| `path` | `fullUrl` | Direct download URL |
| `resolution` | `resolution` | Kept as-is (e.g. "1920x1080") |
| `resolution` (parsed) | `previewWidth` / `previewHeight` | Integer pixels from "WxH" |
| `'wallhaven'` (constant) | `source` | Provider identifier |
| `url` | `sourceUrl` | Link to wallhaven.cc page |
| `purity` | `purity` | Optional, e.g. "sfw" |
| `tags[].name` | `tags` | Optional string array |

## Usage

### Via Registry (recommended)

```js
import {getProvider, isProviderConfigured} from './lib/providers/registry.js';

// Get a provider instance (lazy-loaded, cached)
const provider = await getProvider('wallhaven');

// Check if API key is configured
if (provider.requiresApiKey) {
    const ok = await isProviderConfigured('wallhaven', settings);
}

// Search
const {items, total, page, lastPage} = await provider.search(
    {q: 'nature', sorting: 'date_added'},
    session,
    settings
);

// Download
await provider.downloadToFile(items[0].fullUrl, '/tmp/wallpaper.jpg', session);
```

### Direct Import (Wallhaven raw client)

```js
import {WallhavenClient, WALLHAVEN_DEFAULTS} from './lib/providers/wallhaven-client.js';

const client = new WallhavenClient({apiKey: '...'});
const {data, meta} = await client.search({q: 'nature'});
```

### Adding a New Provider

1. Create `lib/providers/<id>.js` exporting `<Id>Provider`
   (class name is derived from the id: `id[0].toUpperCase() + id.slice(1) + 'Provider'`)
2. Add the id to `PROVIDER_IDS` in `registry.js`
3. Add metadata to `PROVIDER_META` in `registry.js`
4. Add the module to `PROVIDER_MODULES` in `registry.js`
   (the app window builds its provider list dynamically from `PROVIDER_IDS`)
5. Add the id/label/key mapping to `PROVIDER_OPTIONS`, `PROVIDER_LABELS`,
   `PROVIDER_KEY_MAP` in `prefs.js` (`null` key = no API key needed)
6. Add a `buildProviderHelp({...})` block in `ui/prefs_helpers.js`
   (omit `getKeyUrl` when there is no URL — the link row is skipped)
7. Add any new GSettings keys to the `.gschema.xml`
   (note: keyless providers like `local`/`safebooru` need no key)
8. Add new translatable strings to `locale/wallpaper-providers-gnome.pot` and both `.po` files

### API Key Convention

- Wallhaven: `api-key` (existing GSettings key, legacy name preserved)
- Others: `<id>-api-key` (e.g. `pexels-api-key`, `unsplash-api-key`)

`BaseProvider.isConfigured()` handles both conventions automatically.
