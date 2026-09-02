<!--
Security fix? Stop — do not open a PR. See SECURITY.md for private reporting.
-->

## What this changes

<!-- One or two sentences. The commit messages carry the detail. -->

## Why

<!-- What was broken, or what was impossible before. Link the issue if there is one. -->

## What breaks if this is wrong

<!--
The most useful sentence in the whole template. "Nothing, it's a docs fix" is a
perfectly good answer. "A reorg at the tip would be journalled twice" tells a
reviewer exactly where to look.
-->

## Checklist

- [ ] `npm run check` passes (lint + typecheck + test)
- [ ] `npm run format` run
- [ ] Tests cover the change — and for a money-correctness fix, a test that
      **fails without it**
- [ ] Docs in `docs/` updated if behaviour changed
- [ ] `.env.example` updated if a setting was added or changed
- [ ] No credential, address or txid from a real deployment appears anywhere in
      the diff

## Anything a reviewer should know

<!-- Trade-offs you made, things you deliberately left out, questions. Optional. -->
