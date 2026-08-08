# Contributing to Cloudflare OS

This repo is trunk-based so humans and agents work the same way.

## Branch flow

- `main` is the only long-lived branch. All work happens on short-lived
  `feature/*` (or `agent-fix/*`) branches that PR into `main`.
- No direct pushes to `main`: everything goes through a PR with CI green.
  PRs labeled `automerge` are merged serially by the merge train
  (`merge-train.yml`), which re-verifies CI against the latest `main`.
- Production release is gated separately in the starter repo: a human merges
  the gitlink-bump PR there, and the deploy waits for a manual Environment
  approval. Merging here does NOT deploy anything by itself.

## CI

- `ci.yml` (build -> lint -> test) must be green before a PR can merge.
- Run `pnpm run build`, `pnpm run lint`, and `pnpm test` locally before opening a PR.

## Bug reports and agent fixes

- File bugs using the structured issue template ("Bug report").
- Adding the `agent-fix` label to an issue queues it for automated fixing.

## Scope

We are not seeking outside contribution beyond the above. We accept small,
trivially-verified PRs that fix a problem; please avoid low-value PRs (e.g. typo
fixes) or PRs larger than a dozen or so lines.

