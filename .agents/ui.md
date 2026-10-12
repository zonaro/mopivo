# UI conventions

Toolkit: **GTK4 + libadwaita (`Adw`)**. Language: **GJS with ESM imports**
(`import Gtk from 'gi://Gtk'`, `import Adw from 'gi://Adw'`, …).

## Window structure

`app/window.js::buildWindow()` is the composition root. It builds:

- a `Adw.ApplicationWindow` (or equivalent shell) with an `Adw.HeaderBar` /
  header view switcher;
- an `Adw.ViewStack` with three top-level views — **Image gallery**, **Video**,
  **Generator** — switched from the header;
- a search entry, a provider dropdown, and a filters button that belongs to the
  image view.

The `video-mode` setting is the switch that replaces the image gallery with the
video experience. Keep view switching centralized in `window.js`; widgets should
not reach into other views directly.

## Widget modules (`ui/`)

| File | Responsibility |
|---|---|
| `ui/gallery.js` | Image gallery: `Gtk.FlowBox` of thumbnails + pagination. |
| `ui/videoGallery.js` | Online video gallery (Pexels/Pixabay) + pagination + posters. |
| `ui/filters.js` | Wallhaven filter popover (categories, purity, sorting, ratios, colors, AI-art filter). |
| `ui/videoControls.js` | Video controls pane (source, path/URL, play/pause, next/lucky, mute/volume, fit mode). State is synced via D-Bus with the renderer. |
| `ui/prefs_helpers.js` | `Adw` row builders used by `prefs.js` + the Help Center content. |

Preferences (`prefs.js`) has **5 pages**: Providers, Filters, Downloads, Help
Center, Video. Reuse `prefs_helpers.js` builders instead of hand-rolling
`Adw.ActionRow`/`Adw.SwitchRow`/`Adw.ComboRow`; it keeps the pages consistent and
keeps gettext strings in one place.

## Rules

- **No hardcoded user-facing strings.** Every label, tooltip and dialog string
  goes through `_(str)` from `lib/i18n.js`. See [`i18n.md`](i18n.md).
- **Follow libadwaita patterns**: use `Adw` widgets and `.Adw` style classes;
  do not re-implement stock widgets. `Adw.PreferencesPage`/`Group`/`Row` for
  settings, `Adw.StatusPage` for empty/error states, `Adw.Toast` for transient
  feedback.
- **Respect the system theme** (light/dark) — never hardcode colors in the main
  app. The only stylesheet is `renderer/stylesheet.css`, and it only styles the
  renderer subprocess window.
- **Provider-aware UI**: features that only apply to one source (e.g. the
  Wallhaven filter popover) must be shown/hidden by the active provider, not
  left enabled and silently no-op.
- **API-key gating**: providers that require a key must present the
  "configure me" state instead of failing silently. The Providers page shows
  which key is missing and the Help Center has a per-source step-by-step guide.
- **Multi-monitor awareness**: video fit modes and placement controls operate per
  monitor; use `Gdk.Display` monitors as the source of truth.
- **Accessibility & QoL**: keyboard-navigable, sensible defaults, no modal traps.
  Where a platform limitation exists (e.g. Wayland auto-pause), surface it in the
  UI as a warning instead of hiding it.

## Adding a view/widget

1. Put the widget in `ui/` and keep it free of app-wide singletons; pass what it
   needs in the constructor.
2. Wire it in `app/window.js` (or the relevant page).
3. Route strings through `_()` and add them to the `.pot` (see
   [`i18n.md`](i18n.md)).
4. Add a headless test under `tests/` when the logic is non-trivial
   (see [`testing.md`](testing.md)).
5. A new user-facing feature is a **major implementation**: it needs an issue and
   a landing-page section — see [`issues.md`](issues.md) and
   [`landing.md`](landing.md).
