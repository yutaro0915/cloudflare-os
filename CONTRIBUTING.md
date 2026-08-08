# Contributing to Cloudflare OS

This repo follows a develop-only PR flow so humans and agents work the same way.

## Branch flow

- All PRs target `develop` (the default branch). Do not open PRs against `main`.
- `develop` -> PR -> human merge is the only road into `main`. PRs into `main` are
  rejected unless they come from `develop` (required check `pr-from-develop`).
- `main` is release-only: no direct pushes, merges into it are performed by a human,
  and production deploys require a manual approval in the starter repo.

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

<!-- merge-train smoke test 2026-08-08 -->
