# Playbook: verify before PR

Fresh-checkout gotcha: workspace packages need their dist entries before dependents'
tests can import them. **Build first.**

```sh
pnpm install
pnpm run build          # required once per fresh checkout
pnpm run lint           # oxlint + types:check across packages
pnpm test               # full suite (slow) — prefer targeted first:
pnpm --dir packages/<touched-package> test
```

- Frontend: `pnpm --dir packages/workshop-frontend test` (vitest).
- Backend: `pnpm --dir packages/workshop-backend test` (vitest + integration config).
- Type check only: `pnpm run types:check`.

Minimum bar for a PR: targeted tests of every touched package + `pnpm run lint`.
Run the full `pnpm test` when the change crosses package boundaries. CI (ci.yml) runs
build → lint → test on the PR either way; a PR that fails CI wastes a cycle, so run
locally-equivalent checks first and report them in the PR's Verification section.
