# Testing & builds

## Commands (Makefile)

| Target | What it does |
|---|---|
| `make check` | `node --check` on every JS file **+ headless unit tests + `glib-compile-schemas --strict`**. This is the gate. |
| `make smoke` | Headless smoke test: `gjs -m main.js --smoke-test` (settings + providers), then exit. |
| `make i18n` | Compiles `.mo` files in-tree. |
| `make compile` | Compiles the GSettings schema in-tree. |
| `make clean` | Removes compiled schema + in-tree `.mo`. |

Run `make check` after every logical unit of work. It must pass before you report
completion. If it fails only on pre-existing, unrelated issues, say so explicitly
instead of fixing unrelated code.

## Headless harness

Tests run without a display:

- `GDK_BACKEND=headless`
- `GSETTINGS_SCHEMA_DIR=$(CURDIR)/schemas`

The entry point is `tests/run.js`, which loads the per-module suites:

`tests/gallery.js`, `tests/filters.js`, `tests/videoController.js`,
`tests/videoGallery.js`, `tests/emptySearch.js`, `tests/monitors.js`,
`tests/generator.js`.

Because `main.js` gates side effects behind `IS_MAIN`, and the `lib/` modules are
GTK-free where possible (notably `lib/generator/`), logic can be imported and
exercised straight from the harness.

## Writing tests

1. Add the suite under `tests/` and register it in `tests/run.js`.
2. Keep tests headless: no real windows, no network. Inject RNG/time where the
   module allows it (e.g. `randomizeUiState({rng})`).
3. Prefer testing pure logic (spec building, placement math, pagination, filter
   mapping, playback-state transitions) over GTK rendering.
4. For subsystems that shell out (`renderer/generator.py`), test the JS boundary
   (spec shape, `checkAvailable()` behavior) and keep the Python side covered by
   its own probes (`--version`, `--presets`).

## Rules

- **Never delete a failing test to make the suite pass.** Fix the cause or, if the
  test encodes wrong behavior, fix the test with justification.
- **Never suppress errors** (`as any`-style escapes, empty `catch {}`, disabling
  `make check`) to get green.
- Keep `glib-compile-schemas --strict` clean: schema edits (new keys, enums) must
  be valid or `make check` fails.
- Smoke test is the fastest sanity check for a change that touches providers or
  settings wiring.
