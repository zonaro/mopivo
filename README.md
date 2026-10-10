# Wallpaper Providers for GNOME Shell

Browse and set desktop wallpapers from multiple sources without leaving GNOME Shell.
A panel button with search, filters, a thumbnail grid and pagination; clicking a
thumbnail downloads the full-resolution image and applies it as wallpaper.

> Renamed from `wallhaven-gnome`: the UUID is now
> `wallpaper-providers-gnome@redclaw.com.br` with schema
> `org.gnome.shell.extensions.wallpaper-providers-gnome`. If you had the old
> version installed, uninstall it first (`gnome-extensions uninstall
> wallhaven-gnome@example.com`) — settings do not migrate, and the thumbnail
> cache moved to `~/.cache/wallpaper-providers-gnome`.

## Providers

Switch providers anytime from the panel button or the Preferences → Providers page.

| Provider | API key | Notes |
|---|---|---|
| Wallhaven | Optional (required for NSFW) | Full filter set: categories, purity, sorting, top range, resolution, ratios, colors, AI-art filter |
| Pexels | Required — [pexels.com/api](https://www.pexels.com/api/) | Curated endpoint used for empty queries |
| Unsplash | Required — [unsplash.com/developers](https://unsplash.com/developers) | `Client-ID` auth; photo feed used for empty queries |
| Safebooru | None | SFW anime board; tags use underscores (`blue_hair`) |
| Pixabay | Required — [pixabay.com/api/docs](https://pixabay.com/api/docs/) | `safesearch` always on |
| Waifu.im | None | Curated anime archive, SFW only; tags use hyphens; each search returns up to 30 fresh results (no pagination) |
| Local Files | None | Your `~/Pictures` folder by default, plus extra folders from settings; filename search, newest first |

Providers that need an API key stay unusable until the key is configured — the UI
shows which one is missing it. Every provider has a step-by-step setup guide in
Preferences → Help Center.

## Requirements

- GNOME Shell 45–50 (X11 or Wayland)
- `glib-compile-schemas`, `gnome-extensions` CLI (for install)
- GStreamer + gtk4paintablesink (for video wallpaper mode)
- Optional: [yt-dlp](https://github.com/yt-dlp/yt-dlp) (for streaming URLs)
- Optional: WebKitGTK 6.0 (for webpage rendering mode)

## Install

```bash
# Full install (compiles schemas, copies files, enables the extension)
./scripts/install.sh
# ...or via make
make install && make enable
```

On Wayland, log out and back in after the first install so the shell picks up the
extension; on X11, `Alt+F2 → r → Enter` is enough. Logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Configuration

- **Providers page** — active provider, per-provider API keys, Local Files folders
  (colon-separated extras + subfolder toggle), live provider status.
- **Filters page** — Wallhaven defaults (categories, purity, sorting, resolution…).
- **Downloads page** — download folder, auto-apply wallpaper, page size.
- **Help Center page** — per-provider setup guides with links, plus general tips.
- **Video page** — video wallpaper settings (see below).

## Video Wallpaper

Enable **Video Mode** in Preferences → Video to switch from image browsing to
video wallpapers. When Video Mode is on, the image gallery/search/filters hide
and the panel menu shows video controls (play/pause, mute, volume, next, lucky,
browse) instead.

### Sources

| Source | Setting | Description |
|---|---|---|
| Local folder | `video-folder` | Directory scanned for random/auto-change selection |
| Single file | `video-path` | Path or URI of the local video file |
| Streaming URL | `video-streaming-url` | YouTube or other URL resolved via yt-dlp |
| Webpage | `video-webpage-url` or `video-webpage-local-html` | WebKitGTK-rendered page |

### Dependencies

- **GStreamer** with `gtk4paintablesink` — required for video playback
- **yt-dlp** — optional, required for streaming URL support
- **WebKitGTK 6.0** — optional, required for webpage rendering mode

### Panel Menu Controls

- Toggle video mode on/off
- Play/pause button
- Mute/unmute button
- Volume slider
- Next video (cycles through the video folder)
- I'm Feeling Lucky (random video from folder)
- Browse… (open the in-panel video file picker)

### Auto-Pause Features

- Pause when a window is maximized or fullscreen (per-monitor or all)
- Pause when any window has focus
- Pause on battery (never, low battery, or always)
- Pause when a media player (MPRIS) is playing

### Auto-Change

Enable auto-change to cycle through videos in a directory at set intervals.
Modes: Sequential, Reverse, or Random.

### Troubleshooting

Renderer logs are available via:

```bash
journalctl -f -o cat /usr/bin/gjs
```

Check the journal for GStreamer pipeline errors or renderer startup issues.

## Languages

English by default, with translations for Brazilian Portuguese (`pt_BR`) and
Spanish (`es`). UI strings go through `lib/i18n.js` (`_(str)`).

```bash
# Compile translations (also done automatically on install via system paths)
msgfmt locale/pt_BR/LC_MESSAGES/wallpaper-providers-gnome.po \
  -o locale/pt_BR/LC_MESSAGES/wallpaper-providers-gnome.mo
```

## Project structure

```
extension.js    Panel button, provider switching, gallery wiring
prefs.js        Preferences window (Providers / Filters / Downloads / Help Center / Video)
lib/
  download.js   Shared fetch-to-file (Soup for http(s), Gio copy for file://)
  i18n.js       Gettext helper
  providers/    One module per source + registry (see lib/providers/README.md)
  video/        Video wallpaper subsystem (panelMenu, constants, videoThumbs)
renderer/       GStreamer-based video renderer subprocess
ui/
  gallery.js    Provider-agnostic thumbnail grid + pagination
  filters.js    Wallhaven filter bar
  prefs_helpers.js  Adw row builders + Help Center content
  videoPicker.js    In-panel video file browser
schemas/        GSettings schema (compiled at install time)
locale/         .pot template + pt_BR / es translations
scripts/        install.sh
```

To add a new source, follow the 9-step checklist in
[lib/providers/README.md](lib/providers/README.md#adding-a-new-provider).

## License

GPL-3.0-or-later. See source headers.
