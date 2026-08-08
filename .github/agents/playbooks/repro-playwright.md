# Playbook: reproduce UI bugs with Playwright

Use when an issue describes user-visible frontend behavior you can't confirm from code
alone. The reproduction script is the primary artifact — screenshots are supporting
evidence for human reviewers.

## Loop

1. Target, in order of preference (norms: rubrics/flow.md — evidence comes from a
   live environment):
   a. **The PR's preview fleet** — once your PR exists, preview-env.yml deploys it
      and posts the URL as a sticky PR comment. Sign up a throwaway account there
      (fresh previews have signups enabled).
   b. Local fallback (before the PR exists): `pnpm run-local` (serves the built
      frontend on :8787; rebuild with `pnpm run build` after frontend edits).
2. Write a Playwright script following the issue's steps (see the playwright-repro
   skill for the login helper and script template); point it at the target URL.
3. Confirm it FAILS on the pre-fix code — this is the existence proof of the bug.
4. Implement the fix; confirm the same script passes.
5. Promote the script to a regression test in the touched package's test suite when it
   can run against the test harness; otherwise attach it to the PR.

## Evidence in the PR

- State "repro script fails before / passes after" with the script path.
- Screenshots: commit under the `pr-assets` branch (never into main) and link with
  raw URLs; traces/videos go to Actions artifacts.
