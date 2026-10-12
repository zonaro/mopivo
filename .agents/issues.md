# Issues & tracking

> **Hard rule — no exceptions.**
> **Every new implementation or fix MUST be attached to a GitHub issue, properly
> categorized with labels** (`bug`, `enhancement`, `documentation`, …).
> No issue → no implementation. No uncategorized issue → no implementation.

This rule applies to every change to behavior, UI, providers, video, generator,
schema, installer, docs or translations. The only acceptable exceptions are
purely internal chores with no user-visible effect (e.g. typo in a comment,
dependency bump) — and even those should reference an issue when a tracker entry
exists.

## Why

Tracking every change on an issue keeps the changelog, the landing page and the
commit history aligned, and makes the "major implementation → landing section"
rule ([`landing.md`](landing.md)) enforceable: you cannot mark an issue as a
major implementation without also pointing at the landing section that ships it.

## Workflow

1. **Open (or find) the issue first.** Search existing issues before creating a
   new one. Do the implementation only once the issue exists.
2. **Categorize it with labels** (see below). At minimum one type label; add
   area labels when useful.
3. **Reference the issue in the work**:
   - commit subject or body includes `(#<n>)` or `Refs #<n>`;
   - when the change fully resolves it, add a closing keyword on its own line in
     the commit/PR body: `Closes #<n>` / `Fixes #<n>`.
4. **Every commit of a multi-commit feature references the same issue.**
5. **Close the issue only when the code, the tests, and (for major features) the
   landing-page section are all merged.**

## Labels

The repository currently has **no `.github/` directory** — labels and templates
do not exist yet. Creating them is itself a tracked task (open it as an
`enhancement`/`documentation` issue). The intended label set:

**Type (exactly one per issue):**

| Label | Use for |
|---|---|
| `bug` | Broken behavior, regressions, crashes, wrong results. |
| `enhancement` | New features and improvements to existing behavior. |
| `documentation` | README, `AGENTS.md`, `.agents/`, landing page, help center, translations. |
| `question` | Support / clarification, no code change expected. |
| `chore` | Build, installer, tooling, dependency bumps, refactors. |

**Area (one or more):**

`providers` · `video` · `renderer` · `generator` · `ui` · `settings` ·
`installer` · `i18n` · `landing`

**State / effort (optional):**

`good first issue` · `help wanted` · `wontfix` · `duplicate` · `major`

Mark an issue `major` when it is a **major implementation** — i.e. it requires a
landing-page section per [`landing.md`](landing.md).

Create the label set with the GitHub CLI (once `.github/` exists):

```bash
gh label create bug           --color d73a4a --description "Something isn't working"
gh label create enhancement   --color a2eeef --description "New feature or request"
gh label create documentation --color 0075ca --description "Docs, landing page, translations"
gh label create chore         --color cfcfcf --description "Build, tooling, refactors"
gh label create providers     --color 5319e7
gh label create video         --color 1d76db
gh label create renderer      --color 0e8a16
gh label create generator     --color fbca04
gh label create ui            --color c5def5
gh label create settings      --color d4c5f9
gh label create installer     --color bfdadc
gh label create i18n          --color c2e0c6
gh label create landing       --color f9d0c4
```

## Commit conventions

Observed prefixes in this repo's history: `mopivo:`, `docs:`, `ui:`, `video:`,
`renderer:`, `chore:`. Keep using them.

Format:

```
<prefix>: <imperative summary> (#<issue>)
```

Examples:

```
renderer: set desktop layer without xprop (#42)
docs: add landing section for the generator (#38)
ui: hide Wallhaven filters for non-Wallhaven providers (#51)
```

## Templates

When `.github/` is introduced, add:

- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/pull_request_template.md` with a mandatory **`Closes #<n>`** line and
  a **landing-page section** checkbox for `major` issues.
