# Implementations

Three subsystems carry the product. Everything else is shared core. Read this
before extending any of them, and re-read [`issues.md`](issues.md) /
[`landing.md`](landing.md): a new implementation or fix requires a categorized
GitHub issue, and a major implementation also requires a landing-page section.

## 1. Providers (image sources)

Layout: `lib/providers/`

- `base.js` — the provider contract every source implements.
- `registry.js` — the single place that maps ids to modules. Exposes
  `PROVIDER_IDS`.
- `wallhaven.js` (+ `wallhaven-client.js`), `pexels.js`, `unsplash.js`,
  `safebooru.js`, `pixabay.js`, `waifuim.js`, `local.js` — one module per source.
- `README.md` — the authoritative **checklist for adding a new provider**.

`PROVIDER_IDS` is:

```js
['wallhaven', 'pexels', 'unsplash', 'safebooru', 'pixabay', 'waifuim', 'local']
```

The landing page markets "**8 sources**" because it also counts the built-in
**Generator** (which is not a network provider). Keep this distinction in mind
when editing copy or the provider list.

Notes that matter:

- Providers that need an API key (Pexels, Unsplash, Pixabay) must degrade to a
  "needs key" state, driven by `*-api-key` settings, and the Providers page must
  name the missing key.
- Wallhaven is the only source with the full filter popover (`ui/filters.js`).
- `local.js` browses the user's Pictures folder + extra `local-folders`
  (`local-recursive` toggles recursion).
- Provider results are paginated; `page-size` (default 10) controls page size.
- Thumbnails are cached under `~/.cache/mopivo/<provider>/`; downloads go to
  `download-folder` (empty = `~/Pictures/Mopivo`) as `<provider>-<id>.<ext>`.

### Adding a provider

Follow `lib/providers/README.md` exactly: create the module, implement the
`base.js` contract, register it in `registry.js`, add its id to `PROVIDER_IDS`,
add any Settings keys (schema XML → `make compile`), add a Help Center guide in
`prefs_helpers.js`, and update the README provider table + landing page.

## 2. Video & renderer

Layout:

- `app/videoController.js` — lifecycle of the renderer, the D-Bus channel,
  next/lucky/streaming logic.
- `lib/video/constants.js` — shared constants.
- `lib/video/dbus.js` — D-Bus proxy/interface (`org.redclaw.MopivoRenderer`).
- `lib/video/launcher.js` — spawns the renderer under `GDK_BACKEND=x11`
  (`Gio.SubprocessLauncher.setenv`) with `-P <APP_DIR>` and `-F <file>`.
- `lib/video/ytDlp.js` — streaming URL resolution via `yt-dlp`.
- `lib/video/videoThumbs.js` — video poster/thumbnail handling.
- `lib/video/playbackState.js` — playback state model + auto-pause rules.
- `lib/video/staticBlur.js` — static-wallpaper-from-video with blur.
- `renderer/renderer.js` — the subprocess that actually draws video: one window
  per monitor, `playbin` + `xvimagesink`, desktop layer via
  `set_type_hint(Gdk.WindowTypeHint.DESKTOP)`, `fullscreen_on_monitor` fallback.
- `renderer/stylesheet.css` — only used by the renderer window.

Video sources: `local` (`video-path` or `video-folder`), `streaming`
(`video-streaming-url`, resolved with `yt-dlp`), `webpage` (`video-webpage-url`
or `video-webpage-local-html`, WebKitGTK 6.0). Online video browse uses
`video-provider` (Pexels/Pixabay), downloads to `video-folder`
(empty = `~/Videos/Mopivo`) as `<provider>-<id>.mp4`.

Renderer renderer-only settings live under `extSettings` in `renderer.js`:
`startup-delay`, `show-panel-menu`, `enable-va`, `enable-nvsl`,
`prefer-clappersink`, `force-mediafile`.

**Wayland limitation:** auto-pause requires Shell integration a standalone app
does not have, so it is not applied on Wayland. This is surfaced as a warning on
the Video preferences page — do not silently change it. `xvimagesink` only
supports `contain` fit; other fit modes are documented as unsupported and logged.

**Caveat (doc drift):** the README claims `xprop` is required. The code sets the
desktop layer programmatically (`set_type_hint`), not via `xprop`. Trust the code.

## 3. Generator

Layout:

- `app/generatorPage.js` — the Generator tab (presets, palettes, live preview,
  randomize, set-as-wallpaper, export). Preview debounced ~250 ms.
- `lib/generator/engine.js` — UI-state shape, `buildSpec()` (degrees→radians and
  the light-angle `-90°` rule live here and nowhere else), randomize port,
  `Gio.Subprocess` bridge to Python. No GTK imports → unit-testable headless.
- `lib/generator/presets.js` — pure data: 7 presets
  (`Bars, Circle, Plasma, Waves, Terrain, Dunes, Spark`), control visibility and
  ranges, global effect defaults. Ported from Wallrus `shader_presets.rs`.
- `lib/generator/palettes.js` — palette discovery (`data/palettes/`, categories
  `cold`/`dark`, loose images → `Uncategorized`) + `extractColors()` via
  GdkPixbuf (no Rust/image crate).
- `renderer/generator.py` — numpy + Pillow renderer. Reads a JSON spec from
  stdin (or `--spec <file>`), writes the image, prints the output path on stdout.
  `--version` and `--presets` probes are used by `engine.js`. Exits non-zero with
  a stderr message on error.

Pipeline order (matches Wallrus `gl_renderer.rs`):
**Scene → Blur → Bloom → Chromatic Aberration → Effects (+ Lighting)**.

Preview is written to `~/.cache/mopivo/generator/`. Exports use
`generator-resolution` (0 Display / 1 HD / 2 QHD / 3 4K / 4 Phone) and
`generator-format` (`png`/`jpg`) into `generator-export-folder`
(empty = `~/Pictures`).

`engine.js::checkAvailable()` probes python3/numpy/Pillow + `generator.py`
without throwing; when unavailable, the tab shows install guidance. Keep the
GTK-free boundary of `lib/generator/` intact so it stays headless-testable.

## Cross-cutting rules

- **One implementation = one categorized issue.** Categorize with GitHub labels
  (`bug`, `enhancement`, `documentation`, …). See [`issues.md`](issues.md).
- **Major implementation = a landing-page section** in `/docs`, written in
  marketing/conversion language, not technical language. See
  [`landing.md`](landing.md).
- Prefer existing helpers over new ones: `lib/download.js` for fetch-to-file,
  `lib/paths.js` for download folders, `lib/wallpaper.js` for applying the
  background.
- Never suppress type/errors; keep the codebase lint-clean for `make check`.
