# Architecture

## What Mopivo is

Mopivo is a **standalone GTK4 + libadwaita application written in GJS (ESM)**.
It is not a GNOME Shell extension and does not run inside the Shell. This is a
deliberate design choice: video wallpapers are played by a **separate renderer
subprocess**, so a GStreamer crash can never take down the Shell.

The repository directory is still named `wallpaper-providers-gnome` (historical),
but the project, every bundle id and every settings key are `mopivo`.

## Canonical identifiers

| Thing | Value |
|---|---|
| Application id / GSettings schema id | `br.com.redclaw.Mopivo` |
| GSettings schema path | `/br/com/redclaw/Mopivo/` |
| Gettext domain | `mopivo` |
| Renderer D-Bus name | `org.redclaw.MopivoRenderer` |
| `APP_NAME` / `VERSION` | `mopivo` / `1.0.0` |
| Runtime dir (`APP_DIR`) | `~/.local/share/mopivo/` |
| Remote / landing | `github.com/zonaro/mopivo` · `zonaro.github.io/mopivo` |
| License | GPL-3.0-or-later |

Never introduce a new id, schema path or domain. Never add a compatibility layer:
the app was never released, so there is nothing to migrate.

## Runtime tree

The installer copies exactly this tree to `APP_DIR`:

```
main.js               Adw.Application entry point (flags, smoke test, schema loading)
prefs.js              Preferences window (5 pages)
app/
  window.js           Main window: image + video + generator stacks
  videoController.js  Renderer lifecycle, D-Bus channel, next/lucky/streaming
  generatorPage.js    Generator tab: presets, palettes, live preview, export
ui/                   GTK4 widgets (gallery, filters, videoGallery, videoControls, prefs_helpers)
lib/
  download.js         Shared fetch-to-file (Soup for http(s), Gio copy for file://)
  i18n.js             Gettext helper + supported-language list
  paths.js            Canonical Pictures/Videos download-folder resolution
  wallpaper.js        Sets the GNOME desktop background
  wallpaper-multi.js  Multi-monitor composition (same/span/per-monitor)
  providers/          One module per source + registry (see providers.md)
  video/              Video subsystem (constants, dbus, launcher, ytDlp,
                      videoThumbs, playbackState, staticBlur)
  generator/          Generator engine (engine, presets, palettes)
renderer/
  renderer.js         GStreamer/WebKit renderer subprocess (one window per monitor)
  stylesheet.css      Renderer window CSS
  shaders/            Shader source ported into generator.py
  generator.py        Abstract wallpaper generator (numpy + Pillow)
schemas/              GSettings schema (compiled in-tree by `make compile`)
locale/               .pot template + pt_BR / es translations
tests/                Headless unit tests (tests/run.js + per-module suites)
data/                 Desktop entry template, icons (data/icons/), palettes (data/palettes/)
scripts/              install.sh, uninstall.sh, export-icons.sh
```

Root `install.sh` / `uninstall.sh` are **remote bootstraps**: when run via
`curl | bash` they clone/tarball `master` to a temp dir and delegate to
`scripts/install.sh` / `scripts/uninstall.sh`. When run from a checkout they
delegate directly. The real logic always lives in `scripts/`.

## Startup flow

`main.js` is the only entry point:

1. Computes `APP_DIR` (the installed dir, or the checkout when run locally).
2. Prepends `APP_DIR/schemas` to `GSETTINGS_SCHEMA_DIR` so the in-tree/uninstalled
   schema is found, and sets `TEXT_DOMAIN` (gettext).
3. Parses flags: `--smoke-test`, `--prefs`, `--version`, `--help` (no flag = main
   window). `IS_MAIN` gates side-effectful code so modules stay importable in tests.
4. Builds `Adw.Application` and dispatches to `buildWindow()` (`app/window.js`) or
   `buildPreferencesWindow()` (`prefs.js`).

`app/window.js::buildWindow(app, settings)` is the composition root of the main
window. It owns a `Soup.Session`, the provider registry, the `GalleryManager`,
the `FilterBar`, the `VideoController` and the `GeneratorPage`, and swaps between
the three top-level views via an `Adw.ViewStack` driven by `video-mode` and the
header view switcher.

## Subsystems

Three feature subsystems sit on top of the core helpers. Each is documented in
depth in [`implementations.md`](implementations.md):

- **Providers** — `lib/providers/` (one module per source + `registry.js`).
- **Video / renderer** — `app/videoController.js` + `lib/video/` + `renderer/renderer.js`.
- **Generator** — `app/generatorPage.js` + `lib/generator/` + `renderer/generator.py`.

## Storage layout

| Data | Path |
|---|---|
| Downloaded images | `download-folder` (empty = `~/Pictures/Mopivo`) |
| SVG/high-res image cache | `~/.cache/mopivo/<provider>/` |
| Downloaded videos | `video-folder` (empty = `~/Videos/Mopivo`) |
| Generator preview cache | `~/.cache/mopivo/generator/` |
| Multi-monitor placement cache | `~/.cache/mopivo/placement` |
| Generator export | `generator-export-folder` (empty = `~/Pictures`) |

Image downloads are named `<provider>-<id>.<ext>`; video downloads are
`<provider>-<id>.mp4`; per-monitor compositions are a single `spanned` PNG.

## Settings

Everything is stored in the `br.com.redclaw.Mopivo` schema
(`schemas/br.com.redclaw.Mopivo.gschema.xml`, **65 keys**), editable from the
Preferences window or `gsettings`. Key groups: Providers, Filters, Downloads,
Video source, Video playback, Auto-pause, Auto-change, Static wallpaper,
Advanced (renderer + `show-on-lock-screen`), Generator, and wallpaper placement
(`wallpaper-mode`, `wallpaper-per-monitor`, `wallpaper-default-uri`).

Add a key by editing the XML, then `make compile`. Document it in the README
settings table and, when relevant, in the matching Preferences page.

## Known documentation drift

`README.md` lists `xprop` as a runtime requirement for the desktop-window layer.
The actual implementation does **not** shell out to `xprop`: `renderer/renderer.js`
sets the layer programmatically with `set_type_hint(Gdk.WindowTypeHint.DESKTOP)`
while the renderer runs under `GDK_BACKEND=x11` (XWayland), and falls back to
`fullscreen_on_monitor` when no X11 desktop layer is available
(`lib/video/launcher.js`). Treat the code as the source of truth; fix the README
when touching that area.
