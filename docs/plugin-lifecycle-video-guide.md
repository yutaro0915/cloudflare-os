# Plugin lifecycle — real browser recordings

These videos are continuous Chromium viewport recordings of the local Cloudflare OS application.
They are not Remotion compositions, slide decks, or screenshot sequences.

1. plugin-lifecycle-01-author-publish.mp4 — an admin creates a worker-rendered incident brief,
   waits for isolated Dynamic Worker checks and signing, publishes the previously hidden exact
   candidate, imports it, and opens its inert worker-rendered UI.
2. plugin-lifecycle-02-cross-user-import-use.mp4 — the admin creates and publishes a persistent
   release board, signs out, signs in as a visibly identified different user, reviews the exact
   package and capability before importing it, adds an item, moves that item to Doing, and reloads
   the page to prove that the state persisted.
3. plugin-lifecycle-03-safe-uninstall.mp4 — the second user begins with the persisted board state,
   reviews the uninstall consequences, confirms that navigation disappears while state is retained,
   and purges the retained lifecycle only through a separate irreversible-action review.

The run uses a fresh temporary Wrangler persistence directory, so it never deletes or reuses the
developer's normal local state. The Store publish shown here is a real publication to that local
content-addressed Store, not a production Internet deployment.

## Reproduce and verify

~~~sh
pnpm exec playwright install chromium
pnpm record:plugin-lifecycle
pnpm verify:plugin-lifecycle-videos
~~~

On Linux, Playwright's documented browser system dependencies are required. The recorder also
accepts PLAYWRIGHT_BROWSER_LIB_DIR for a compatible non-system library directory.

The verifier requires H.264 at 1600×900, scenario-specific minimum durations, changing sampled
frames, and an exact ordered set of visible semantic milestones in
plugin-lifecycle-video-evidence.json. The recorder also captures one full-resolution review frame
for each milestone in its temporary work directory so the final videos can be inspected before
publication.
