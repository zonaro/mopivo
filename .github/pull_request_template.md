<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

## Summary

<!-- What does this change do, and why? -->

## Linked issue

Closes #<issue-number>

<!--
Every implementation or fix requires a categorized GitHub issue.
No issue → no implementation. See .agents/issues.md.
-->

## Type of change

- [ ] `bug` — fix
- [ ] `enhancement` — new feature or improvement
- [ ] `documentation` — docs, landing page, translations
- [ ] `chore` — build, tooling, installer, refactor

## Checklist

- [ ] The linked issue exists and is labeled.
- [ ] `make check` passes (`node --check` + headless tests + strict schema).
- [ ] No hardcoded user-facing strings — all go through `_(…)`.
- [ ] New/changed strings added to the locale catalogs (`.agents/i18n.md`).
- [ ] If this is a **major implementation**: a landing-page section was added
      under `/docs` in marketing/conversion language, in all three languages,
      and the issue is labeled `major` (`.agents/landing.md`).
- [ ] No errors suppressed (`as any`-style escapes, empty `catch {}`, disabled
      checks).
- [ ] No failing test deleted to make the suite pass.
