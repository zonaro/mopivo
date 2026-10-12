# AGENTS.md — Mopivo

Summary of working rules for this repository. Full detail lives in
[`.agents/`](.agents/README.md) — read it before making non-trivial changes.

## What this is

**Mopivo** — a standalone **GTK4 + libadwaita** app written in **GJS (ESM)** to
browse and apply wallpapers from multiple sources and to play video wallpapers.
It does **not** run inside GNOME Shell: video plays in a separate renderer
subprocess, so a GStreamer crash never takes down the Shell.

- Application / schema id: `br.com.redclaw.Mopivo`
- Schema path: `/br/com/redclaw/Mopivo/` · Gettext domain: `mopivo`
- Renderer D-Bus name: `org.redclaw.MopivoRenderer`
- Runtime dir (`APP_DIR`): `~/.local/share/mopivo/`
- Repo `github.com/zonaro/mopivo` · Landing `zonaro.github.io/mopivo` · GPL-3.0-or-later

## The two non-negotiable rules

1. **Every new implementation or fix MUST have a linked GitHub issue, properly
   categorized with labels** (`bug`, `enhancement`, `documentation`, …). No
   issue → no implementation. → [`.agents/issues.md`](.agents/issues.md)

2. **Every major implementation MUST add a section on the landing page under
   `/docs`, written in marketing / conversion language — not technical
   language.** → [`.agents/landing.md`](.agents/landing.md)

(Note: the repo has **no `.github/` directory yet** — labels, issue templates and
the PR template still need to be created; that itself is a tracked issue.)

## Layout at a glance

```
main.js · prefs.js              entry point + preferences window
app/                            window composition, video controller, generator page
ui/                             GTK4 widgets (gallery, filters, video*, prefs_helpers)
lib/                            core helpers + providers/ + video/ + generator/
renderer/                       GStreamer/WebKit renderer + numpy/Pillow generator
schemas/ · locale/ · tests/     settings schema · gettext · headless unit tests
data/ · scripts/ · docs/        assets · install/uninstall · GitHub Pages landing
```

Details: [`architecture.md`](.agents/architecture.md),
[`implementations.md`](.agents/implementations.md),
[`ui.md`](.agents/ui.md).

## Workflow

1. **Issue first** (rule 1). Label it. Mark `major` if a landing section is due.
2. **Plan** 2+ step changes; decompose and execute.
3. **Code** matching existing patterns. Strings via `_(…)`
   ([`i18n.md`](.agents/i18n.md)). Never suppress errors.
4. **Test**: run `make check` (node --check + headless tests + strict schema).
   Never delete a failing test to pass. → [`testing.md`](.agents/testing.md)
5. **Landing section** for major features (rule 2), in all three languages.
6. **Commit**: `<prefix>: <summary> (#<issue>)` with a `Closes #<n>` line when it
   resolves the issue. Prefixes in use: `mopivo:`, `docs:`, `ui:`, `video:`,
   `renderer:`, `chore:`. Never commit unless explicitly asked.

## Hard rules (never)

- Never implement without a categorized GitHub issue.
- Never ship a major implementation without a marketing-toned `/docs` section.
- Never hardcode user-facing strings — always `_(…)`.
- Never add an id/schema/domain other than the canonical ones above; never add a
  migration/compat layer (the app was never released).
- Never suppress errors (`as any`-style escapes, empty `catch {}`, disabling
  `make check`).
- Never delete a failing test to make the suite green.
- Never commit without an explicit request.

## Known doc drift

`README.md` lists `xprop` as required; the code sets the desktop layer
programmatically (`set_type_hint(Gdk.WindowTypeHint.DESKTOP)` under
`GDK_BACKEND=x11`) and never calls `xprop`. Trust the code, fix the README when
you touch that area. See [`architecture.md`](.agents/architecture.md#known-documentation-drift).
