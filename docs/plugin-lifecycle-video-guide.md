# Plugin lifecycle — real browser recordings

These videos are continuous Chromium viewport recordings of the local Cloudflare OS application.
They are not Remotion compositions, slide decks, or screenshot sequences.

1. plugin-lifecycle-01-author-publish.mp4 — an admin creates a worker-rendered incident brief,
   waits for isolated Dynamic Worker checks and signing, publishes the previously hidden exact
   candidate, imports it, and opens its inert worker-rendered UI.
2. plugin-lifecycle-02-cross-user-import-use.mp4 — the admin creates and publishes a persistent
   release board, signs out, creates a different user, imports the Store package, adds an item, and
   moves that item to the Doing column.
3. plugin-lifecycle-03-safe-uninstall.mp4 — the second user reloads the persisted board state,
   uninstalls the plugin, observes the separately retained state record, and purges it only through
   a second explicit destructive confirmation.

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

The verifier requires H.264 at 1280×720, a minimum duration, changing sampled frames, and the
three-scenario browser evidence record in plugin-lifecycle-video-evidence.json.
