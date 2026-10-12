# `.agents/` — Mopivo knowledge base

Detailed, agent-facing documentation for the Mopivo project. The top-level
[`../AGENTS.md`](../AGENTS.md) is the concise summary; this folder holds the
long-form detail.

| Document | Contents |
|---|---|
| [`architecture.md`](architecture.md) | What the app is, canonical identifiers, runtime tree, startup flow, subsystems overview, storage layout, settings, known doc drift. |
| [`ui.md`](ui.md) | GTK4 + libadwaita conventions, widget modules (`ui/`), preferences pages, UI rules, adding a view/widget. |
| [`implementations.md`](implementations.md) | Deep dive on the three subsystems — providers, video/renderer, generator — and the cross-cutting rules for shipping changes. |
| [`issues.md`](issues.md) | **Hard rule:** every implementation/fix needs a categorized GitHub issue. Labels, workflow, commit conventions, templates. |
| [`landing.md`](landing.md) | **Hard rule:** every major implementation needs a `/docs` landing-page section in marketing/conversion language. How to add one. |
| [`testing.md`](testing.md) | `make check` / `make smoke`, the headless harness, `tests/`, how to write tests. |
| [`i18n.md`](i18n.md) | Gettext domain, languages, locale workflow, and the landing page's separate client-side i18n. |

## Reading order

New to the project? Read `architecture.md` → `implementations.md` → `ui.md`, then
the two hard rules in `issues.md` and `landing.md` before you touch anything.

## The two non-negotiables

1. **Every new implementation or fix is attached to a GitHub issue**, properly
   categorized with labels (see [`issues.md`](issues.md)).
2. **Every major implementation gets a landing-page section** under `/docs`,
   written in marketing/conversion language, never technical language
   (see [`landing.md`](landing.md)).

Everything else in this folder explains how the code is organized so those
changes land cleanly and consistently.
