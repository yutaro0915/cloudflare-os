# Rubric: branching, environments, and release flow

SSOT for how change moves from idea to production across the two repos
(cloudflare-os = the OS code; cloudflare-os-starter = the fleet manifest).
Everything else — workflow prompts, playbooks, skills, CONTRIBUTING, README,
plan docs — derives from this file and must reference it instead of restating it.

## Norms

- `main` is the only long-lived branch in cloudflare-os. All work happens on
  short-lived `feature/*` or `agent-fix/*` branches that PR into `main`.
- **Every feature PR gets its own live environment** (the preview fleet, one per
  PR, no shared dev environment). Functional verification happens there, and the
  PR carries evidence from it: recording / screenshots of the deployed behavior,
  plus the Playwright script that produced them.
- The only road into `main` is the merge train (`automerge` label): it re-verifies
  CI against the latest `main` and merges serially. Nobody — human or agent —
  pushes to `main` directly.
- `main` is the production-candidate line: every commit on it is releasable.
  Anything not good enough to release does not get merged.
- The starter's gitlink may only ever point at a SHA that is an ancestor of
  cloudflare-os `main` (mechanically enforced in the bump workflow). Production =
  a human-approved pin of one of those SHAs; the starter's git history is the
  release ledger.
- Preview environments are ephemeral: created on PR open, updated on push, torn
  down on PR close. A closed PR must leave no workers behind.
- Deployment configuration has one home (the starter). Preview tooling checks the
  starter out and derives per-PR configs from it; it never forks the config.
- Secrets never appear in either repo or in generated configs; they are injected
  from GitHub Actions secrets at deploy time.

## Decision record

### 2026-08-08 — per-feature environments; main = production-candidate line

Adopted (user decision) over two rejected alternatives:

- ~~develop branch + always-on dev environment~~ — retired the same day. The
  extra branch made "what is dev showing?" ambiguous and put a second merge
  ceremony between fix and release.
- ~~single dev environment mirroring main's tip~~ — rejected because it can only
  show merged work: no way to check a feature in a real environment *before* it
  reaches main, and parallel features can't be inspected side by side.

Chosen model: verification moves to per-PR preview fleets (unlimited, one per
feature), so `main` receives only work that was already exercised in a live
environment. The starter stops being a deploy trigger for development entirely;
its gitlink is a production pin and nothing else. Consequences accepted:
per-environment seeding is mandatory (signup is off), worker count grows with
open PRs (bounded by teardown discipline), preview URLs are workers.dev (custom
domain is production-only).

## Derived artifacts (keep pointing here, never restating)

- `.github/workflows/`: merge-train.yml, claude-fix.yml, claude-review.yml,
  preview-env.yml, preview-teardown.yml (cloudflare-os); bump-submodule.yml,
  deploy.yml (starter)
- `.github/agents/`: HARNESS.md, rubrics/fix.md, playbooks/repro-playwright.md,
  skills/playwright-repro
- CONTRIBUTING.md (human-facing summary)
- starter `docs/branching-and-environments-plan.md` (implementation plan/status)
