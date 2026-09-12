# Gadgets Workshop Frontend

Single-page app for the Gadgets Workshop UI. Built with React, Kumo, Design Token Kit, and Vite.

## Development

```sh
pnpm dev        # start dev server on http://localhost:3000
pnpm build      # type-check and build for production
pnpm preview    # preview production build locally
```

## Design tokens

`src/design-tokens.json` is the light-theme DTCG 2025.10 source of truth and contains the
primitive, semantic, and component layers. `src/design-tokens.dark.json` contains only dark-theme
primitive overrides. Kumo aliases in `src/styles.css` consume the generated semantic variables;
Plugin Store-specific styles consume the component layer.

```sh
pnpm tokens:check  # schema, reference, and three-layer architecture checks
pnpm tokens:build  # validate and regenerate the ignored CSS artifact
```

The normal development, asset, production, and type-check commands run the relevant token check or
generation step automatically. Do not edit `src/design-tokens.generated.css` directly.

## Authentication modes

The frontend supports two authentication modes, selected at build time.

### Password mode (default)

Users log in with a username and password. Account creation is available via `/signup`.
This is the default — no extra configuration needed.

### Cloudflare Access mode

When the backend is deployed behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/), Access handles identity before the user ever reaches the app. In this mode:

- The password-based login page and signup page are disabled.
- On load, the app authenticates automatically using the CF Access session that Access has already established (via `authenticateFromCfAccess()` on the server).

To build in CF Access mode, set `VITE_CF_ACCESS_MODE=true`:

```sh
VITE_CF_ACCESS_MODE=true pnpm build
```

Or add it to a `.env` file for persistent local configuration:

```sh
# .env.local
VITE_CF_ACCESS_MODE=true
```

The backend also needs to be configured with the `CF_ACCESS_ISS` and `CF_ACCESS_AUD` environment variables (see the workshop-backend package) for the JWT verification to work.
