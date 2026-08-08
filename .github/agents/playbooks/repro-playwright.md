# Playbook: reproduce UI bugs with Playwright

Use when an issue describes user-visible frontend behavior you can't confirm from code
alone. The reproduction script is the primary artifact — screenshots are supporting
evidence for human reviewers.

## Loop

1. Start the app locally: `pnpm run-local` (serves the built frontend on :8787; rebuild
   with `pnpm run build` after frontend edits, then restart).
2. Write a Playwright script following the issue's steps (see the playwright-repro
   skill for the seeded-login helper and script template).
3. Confirm it FAILS on the pre-fix code — this is the existence proof of the bug.
4. Implement the fix; confirm the same script passes.
5. Promote the script to a regression test in the touched package's test suite when it
   can run against the test harness; otherwise attach it to the PR.

## Evidence in the PR

- State "repro script fails before / passes after" with the script path.
- Screenshots: commit under the `pr-assets` branch (never into develop) and link with
  raw URLs; traces/videos go to Actions artifacts.
