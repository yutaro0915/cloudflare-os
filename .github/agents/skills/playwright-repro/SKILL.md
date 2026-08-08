---
name: playwright-repro
description: Reproduce a user-reported frontend bug in this repo with Playwright — start the local server, log in with the CI seed account, script the issue's repro steps, capture evidence (screenshot/trace), and turn the script into a regression test. Use whenever an issue describes UI behavior that must be confirmed or demonstrated, before and after a fix.
---

# playwright-repro

This skill exists only in CI: the workflow copies `.github/agents/skills/` into
`.claude/skills/` on the runner. It is not part of the local development setup.

## Steps

1. **Server**: `pnpm run build && pnpm run-local &` — app on http://localhost:8787.
   Wait for a 200 from `/` before driving the browser.
2. **Login**: use the CI seed account (created by `CI_SEED_USERNAME` /
   `CI_SEED_PASSWORD` env if provided by the workflow). If no seed account is
   available, say so on the issue and fall back to code-level verification.
3. **Script**: `npx playwright test` with a spec that follows the issue's numbered
   repro steps exactly. Assert the *expected* behavior — so the test FAILS while the
   bug exists.
4. **Evidence**: run once pre-fix (expect FAIL) and once post-fix (expect PASS).
   Capture `--trace on` for the failing run; screenshot the fixed state.
5. **Promote**: move the spec into the touched package's test suite if it can run
   there; otherwise include it in the PR and note why it stays standalone.

## Rules

- Never weaken the assertion to make the test pass; the assertion encodes the issue's
  expected behavior.
- Report both runs (FAIL→PASS) in the PR's Verification section with the spec path.
