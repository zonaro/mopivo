# Wallpaper Providers

A standalone GTK4 + libadwaita app to browse and set desktop wallpapers from
multiple image sources and to play local, streamed or webpage video wallpapers.

- Application id / GSettings schema id: `br.com.redclaw.WallpaperProviders`
- Settings schema path: `/br/com/redclaw/WallpaperProviders/`
- Gettext domain: `wallpaper-providers-gnome`
- Renderer D-Bus name: `org.redclaw.WallpaperProvidersRenderer`

It is built with GJS (ESM) and does not run inside the GNOME Shell. Video
playback happens in a separate renderer subprocess, so a GStreamer crash never
takes down the Shell.

## Requirements

- GNOME 45–50 (Wayland or X11)
- `gjs` (ESM support)
- GTK 4 and libadwaita 1.x
- GStreamer with `gtk4paintablesink` (video wallpaper playback)
- `xprop` (places renderer windows on the X11/XWayland desktop layer)
- `glib-compile-schemas` and `msgfmt` (install only)
- Optional: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (streaming URL sources)
- Optional: WebKitGTK 6.0 (webpage video source)

The install script uses `rsync` when available and falls back to `cp` otherwise.

## Install

```bash
./scripts/install.sh
# or
make install
```

The install script:

1. Disables and uninstalls the old GNOME Shell extension
   (`wallpaper-providers-gnome@redclaw.com.br`) if present, and removes its
   directory under `~/.local/share/gnome-shell/extensions/`.
2. Copies the runtime tree (`main.js`, `app/`, `ui/`, `lib/`, `renderer/`,
   `schemas/`, `locale/`) into `~/.local/share/wallpaper-providers/` (APP_DIR),
   deleting stale files there.
3. Compiles the schema in place at `APP_DIR/schemas/` (the renderer loads it
   from there) and installs it globally to
   `~/.local/share/glib-2.0/schemas/`, then recompiles that directory.
4. Compiles translations to
   `~/.local/share/locale/<lang>/LC_MESSAGES/wallpaper-providers-gnome.mo`.
5. Installs the desktop entry to
   `~/.local/share/applications/br.com.redclaw.WallpaperProviders.desktop` and
   the icon to
   `~/.local/share/icons/hicolor/scalable/apps/br.com.redclaw.WallpaperProviders.svg`.

After install, launch **Wallpaper Providers** from the app grid, or run it
directly:

```bash
gjs -m ~/.local/share/wallpaper-providers/main.js
```

Command-line flags:

```
(no options)   open the main window
--prefs        open the preferences window
--smoke-test   headless check (settings + providers), then exit
--version      print the version and exit
--help         show help and exit
```

For a source-checkout run at the repository root, use
`gjs -m main.js`, or `make smoke` for the headless smoke test.

## Uninstall

```bash
./scripts/uninstall.sh
# or
make uninstall
```

The uninstall script stops any running renderer (`pkill -f renderer/renderer.js`)
and removes the APP_DIR, the desktop entry, the icon, the global schema XML
(followed by a schema recompile) and the compiled translation catalogs. Your
GNOME wallpaper settings (`org.gnome.desktop.background`) are left untouched.

## Configuration

All settings live in the `br.com.redclaw.WallpaperProviders` schema and are
edited in the Preferences window (five pages: Providers, Filters, Downloads,
Help Center, Video) or with `gsettings`:

```bash
gsettings list-keys br.com.redclaw.WallpaperProviders
gsettings set br.com.redclaw.WallpaperProviders video-mode true
```

Key groups:

- **Providers** — `active-provider`, `language`, `api-key`,
  `pexels-api-key`, `unsplash-api-key`, `pixabay-api-key`, `local-folders`,
  `local-recursive`, `wallrus-folders`, `wallrus-recursive`.
- **Filters** — `search-query`, `categories`, `purity`, `sorting`, `order`,
  `top-range`, `atleast`, `resolutions`, `ratios`, `colors`, `ai-art-filter`.
- **Downloads** — `download-folder`, `set-background`, `page-size`.
- **Video source** — `video-mode`, `video-mode-type`, `video-path`,
  `video-folder`, `video-streaming-url`, `video-webpage-url`,
  `video-webpage-local-html`.
- **Video playback** — `video-volume`, `video-mute`,
  `video-fade-duration-sec`, `video-audio-primary-monitor-only`,
  `video-fit-mode`, `video-random-start`, `video-monitor-paths`.
- **Auto-pause** — `pause-on-maximize-or-fullscreen`, `pause-on-focus`,
  `pause-on-battery`, `low-battery-threshold`, `pause-on-mpris-playing`.
- **Auto-change** — `change-wallpaper`, `change-wallpaper-directory-path`,
  `change-wallpaper-interval`, `change-wallpaper-mode`.
- **Static wallpaper** — `static-wallpaper-from-video`,
  `static-wallpaper-blur-enabled`, `static-wallpaper-blur-radius`.
- **Advanced** — `show-on-lock-screen`, and the six renderer keys
  `startup-delay`, `show-panel-menu`, `enable-va`, `enable-nvsl`,
  `prefer-clappersink`, `force-mediafile`.

The schema exposes 57 keys in total.

## Image mode

The main window shows a search entry, a provider drop-down and a thumbnail
gallery with pagination. Clicking a thumbnail downloads the full-resolution
image, caches it under `~/.cache/wallpaper-providers-gnome/<provider>/` and, when
`set-background` is enabled, applies it as the desktop wallpaper. A filter
popover exposes the Wallhaven filters (categories, purity, sorting, order, top
range, minimum resolution, resolutions, aspect ratios, colors and the AI-art
filter).

Providers (selectable at runtime):

| Provider | API key | Notes |
|---|---|---|
| Wallhaven | Optional (required for NSFW) | Full filter set: categories, purity, sorting, top range, resolution, ratios, colors, AI-art filter |
| Pexels | Required — [pexels.com/api](https://www.pexels.com/api/) | Curated endpoint used for empty queries |
| Unsplash | Required — [unsplash.com/developers](https://unsplash.com/developers) | Access Key used as `Client-ID`; photo feed used for empty queries |
| Safebooru | None | SFW anime board; tags use underscores (`blue_hair`) |
| Pixabay | Required — [pixabay.com/api/docs](https://pixabay.com/api/docs/) | `safesearch` always on |
| Waifu.im | None | Curated anime archive, SFW only; tags use hyphens; up to 30 fresh results per search (no pagination) |
| Local Files | None | Your `~/Pictures` folder plus extra folders from settings; filename search, newest first |
| Wallrus | None | Browses wallpapers generated by the Wallrus app (`~/Pictures/Wallrus` plus extra folders) |

Providers that need an API key stay unusable until the key is configured; the
Providers page shows which provider is missing one. Each provider has a
step-by-step setup guide in Preferences → Help Center.

## Video mode

Toggle the video-mode switch in the header bar (or set `video-mode`) to swap the
image gallery for the video controls pane. Video playback is delegated to the
renderer subprocess launched by `lib/video/launcher.js`.

### Sources

Set the source with `video-mode-type`:

| Source | Value | Settings |
|---|---|---|
| Local files | `local` | `video-path` (single file) or `video-folder` (scanned for next/lucky) |
| Streaming URL | `streaming` | `video-streaming-url`, resolved with yt-dlp |
| Webpage | `webpage` | `video-webpage-url` or `video-webpage-local-html` (WebKitGTK) |

When no `video-folder` is set, `~/Videos/Hidamari` is used.

### Controls

The video pane (`ui/videoControls.js`) provides:

- Source drop-down: Local Files / Streaming URL / Webpage.
- Video Path with a **Browse…** button (GTK file dialog).
- Streaming URL entry.
- Play/Pause toggle, **Next** (cycles the folder) and **Lucky** (random video).
- Mute toggle and a volume slider.
- Fit Mode: Fill / Contain / Cover / Scale down.

Playback state is synced from the renderer over D-Bus.

### Desktop-layer mechanism

On X11 and under Wayland via XWayland, the launcher spawns the renderer with
`GDK_BACKEND=x11` and passes `-P <APP_DIR>` (plus `-F <file>` for a chosen
file). After each window is mapped, the renderer resolves its X11 window id and
runs `xprop -id <xid> -f _NET_WM_WINDOW_TYPE 32a -set _NET_WM_WINDOW_TYPE
_NET_WM_WINDOW_TYPE_DESKTOP`, sizing the window to the monitor geometry instead
of going fullscreen. When the X11 desktop layer is unavailable, the renderer
falls back to `fullscreen_on_monitor`.

### Known limit: auto-pause on Wayland

The auto-pause options (`pause-on-maximize-or-fullscreen`, `pause-on-focus`,
`pause-on-battery`, `pause-on-mpris-playing`) require GNOME Shell integration
that a standalone app cannot access on GNOME Wayland; they are not applied
there. The Video preferences page shows this as a note. Auto-change
(`change-wallpaper`) and the static-wallpaper options are handled by the
renderer and are independent of auto-pause.

## Troubleshooting

Watch the app and renderer logs:

```bash
journalctl -f -o cat /usr/bin/gjs
```

Inspect the schema and its current values:

```bash
gsettings list-keys br.com.redclaw.WallpaperProviders
gsettings get br.com.redclaw.WallpaperProviders video-mode
```

Inspect the renderer D-Bus interface while it is running:

```bash
gdbus introspect --session \
  --dest org.redclaw.WallpaperProvidersRenderer \
  --object-path /org/redclaw/WallpaperProvidersRenderer
```

Common checks:

- Renderer does not start: confirm `gtk4paintablesink` and `xprop` are
  installed, and that a video source is configured.
- Streaming fails: confirm `yt-dlp` is on `PATH`.
- Webpage source is blank: confirm WebKitGTK 6.0 is installed.
- Schema missing after a source run: run `make compile` or reinstall.

## Project structure

```
main.js               Entry point (Adw.Application, flags, smoke test)
prefs.js              Preferences window (Providers/Filters/Downloads/Help Center/Video)
app/
  window.js           Main window: image + video stacks, provider switching
  videoController.js  Renderer lifecycle, D-Bus channel, next/lucky/streaming
ui/
  gallery.js          Gtk.FlowBox thumbnail gallery + pagination
  filters.js          Wallhaven filter popover
  videoControls.js    Video controls pane
  prefs_helpers.js    Adw row builders + Help Center content
lib/
  download.js         Shared fetch-to-file (Soup for http(s), Gio copy for file://)
  i18n.js             Gettext helper
  wallpaper.js        Sets the GNOME desktop background
  providers/          One module per source + registry (see lib/providers/README.md)
  video/              Video subsystem (constants, dbus, launcher, ytDlp,
                      videoThumbs, playbackState, staticBlur)
renderer/
  renderer.js         GStreamer/WebKit renderer subprocess (one window per monitor)
  stylesheet.css      Renderer window CSS
schemas/              GSettings schema
locale/               .pot template + pt_BR / es translations
tests/                Headless unit tests (tests/run.js, gallery, filters, videoController)
data/                 Desktop entry template + app icon
scripts/              install.sh, uninstall.sh
```

To add a new provider, follow the checklist in
[lib/providers/README.md](lib/providers/README.md#adding-a-new-provider).

## Development

English by default, with translations for Brazilian Portuguese (`pt_BR`) and
Spanish (`es`). UI strings go through `lib/i18n.js` (`_(str)`).

```bash
make check    # node --check on all JS, headless unit tests, strict schema compile
make smoke    # headless app smoke test (main.js --smoke-test)
make i18n     # compile in-tree .mo files
make compile  # compile the schema
make clean    # remove compiled schema and in-tree .mo files
```

## License

GPL-3.0-or-later. See source headers.
