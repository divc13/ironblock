# Hosting Ironblock

Ironblock is **testnet-only**. No real money is used or custodied. This page is
the deployment runbook; the judge-facing path is [`DEMO.md`](DEMO.md).

For the full environment-variable reference, see
[`../README.md#environment`](../README.md#environment). Do not commit `.env`,
an Auth0 token, the game-session secret, or any treasury key.

## Choose a login mode

| Mode | Use it for | Login path |
| --- | --- | --- |
| `auth0` | Public deployment (`https://ironblock.up.railway.app`) | Your own Auth0 SPA tenant, Google/email popup, server-verified OIDC ID token |
| `near` | Local NEAR Auth/MPC testing only | Shared NEAR Auth testnet tenant + MPC-derived identity |

`AUTH_MODE` is server-only; `VITE_AUTH_MODE` is compiled into the browser. Set
both to the same value. The build fails on a mismatch. The public deployment
must use `auth0`; `near` mode is deliberately not a public fallback.

## Choose a run mode

| Mode | Command | What runs |
| --- | --- | --- |
| Development | `npm run dev` | Vite on **port 3000**, auth API, economy API, RPGJS WebSocket, and the `/spectator` dev rewrite. |
| Built preview | `npm run build` then `npx vite preview` | Built assets plus the HTTP routes that use `configurePreviewServer`. It does **not** start the RPGJS game WebSocket. |
| Production host | `npm run build` then `npm start` | `dist/client`, `/api/auth/*`, the authenticated economy API and the RPGJS WebSocket transport. |

`npm start` reads `.env` if present, then loads `dist/server/production.js`.
Build before starting.

## Requirements

- Node 22 or newer and npm.
- A `.env` copied from `.env.example`.
- A random server-only `NEAR_AUTH_SESSION_SECRET` of at least 32 characters.
- For public Auth0 mode: an Auth0 SPA application with Google and the desired
  email connection enabled, plus the deployment callback/web origins.
- For local `near` mode only: the shared NEAR Auth testnet application allows
  exactly `http://localhost:3000`. `localhost` and port `3000` must match;
  `127.0.0.1` and other ports are rejected.

Generate a session secret once, paste it into `.env`, and keep it out of git:

```bash
openssl rand -base64 48
```

In development, Vite creates an ephemeral secret if none is set and prints a
warning. Sessions then reset whenever the dev server restarts. Outside
development, the server refuses to start without a real secret.

## Public Auth0 deployment

Set these values on Railway (or any Node host). The Auth0 domain, client id and
audience are public; the session secret and treasury key are not.

```bash
AUTH_MODE=auth0
VITE_AUTH_MODE=auth0
AUTH0_DOMAIN=dev-y6d3ancokvaznjrh.us.auth0.com
AUTH0_CLIENT_ID=5yM76v1griNYFvF8jNz2i8YfIytTm8wF
AUTH0_AUDIENCE=5yM76v1griNYFvF8jNz2i8YfIytTm8wF
VITE_AUTH0_DOMAIN=dev-y6d3ancokvaznjrh.us.auth0.com
VITE_AUTH0_CLIENT_ID=5yM76v1griNYFvF8jNz2i8YfIytTm8wF
VITE_AUTH0_AUDIENCE=5yM76v1griNYFvF8jNz2i8YfIytTm8wF
NEAR_AUTH_SESSION_SECRET=<random 32+ character secret>
```

In the Auth0 SPA application settings:

- **Allowed Callback URLs**: `https://ironblock.up.railway.app`,
  `https://ironblock.up.railway.app/`, `http://localhost:3000`,
  `http://localhost:3000/`
- **Allowed Web Origins**: `https://ironblock.up.railway.app`,
  `http://localhost:3000`
- **Allowed Logout URLs**: the same origins.

The server verifies the raw OIDC **ID token**; its audience is the SPA client
id. No Auth0 API/resource server and no client secret are required. Auth0 tokens
stay in the SDK's in-memory cache and are never written to browser storage.

The player-supplied NEAR payout address is optional at login. Withdrawals are
blocked with `NEAR_ACCOUNT_REQUIRED` until the player sets one, either in the
login step or from the withdrawal panel. The address is only a payout
destination; Ironblock never asks for its private key.

## Local NEAR Auth mode

`AUTH_MODE=near` remains available for local NEAR Auth/MPC testing. Use the
shared testnet values in `.env.example` and open exactly
<http://localhost:3000>. This path is not used for the public deployment and
must not be used as a public fallback.

## Local development

```bash
npm install
cp .env.example .env
# Edit .env: set NEAR_AUTH_SESSION_SECRET to the generated value.
# For public Auth0 login, set AUTH_MODE=auth0 and the AUTH0_*/VITE_AUTH0_* block.
npm run dev
```

Open exactly <http://localhost:3000>. The same origin serves the game, the auth
routes, the authenticated economy routes, and — when the observability module is
mounted — the read-only `/spectator` page and `/api/market/*`.

Port 3000 is fixed with `strictPort` in `vite.config.ts`. If it is occupied, stop
the other process instead of moving Ironblock to another port.

## Build and production start

```bash
npm install
cp .env.example .env
# Set NEAR_AUTH_SESSION_SECRET and, only if you need settlement,
# the server-only treasury signer settings.
npm run build
npm start
```

The production host binds `0.0.0.0:3000` by default. Override with `HOST`,
`PORT`, and `IRONBLOCK_BASE_PATH`; override the built client directory with
`IRONBLOCK_CLIENT_DIR` (default `dist/client`).

The economy owns one live NPC loop per process. `IRONBLOCK_LIVE_TICK_MS`
(default `1000`) controls the real-time cadence and
`IRONBLOCK_LIVE_TICK_SECONDS` controls how much simulation time each tick
advances (default `1`; raise it to accelerate the town). High ratios can flood
the retained event feed. `IRONBLOCK_LIVE_SAVE_MS` (default `15000`) delays
full-world saves; shutdown flushes once.

Health checks:

```bash
curl -sS http://localhost:3000/health
curl -sS http://localhost:3000/api/auth/health
```

Expected shapes:

- `GET /health` → `{"status":"ok","service":"ironblock"}`
- `GET /api/auth/health` → `{"status":"ok","service":"ironblock-auth","mode":"auth0","network":"testnet"}` (or `"mode":"near"` for local near mode)

`vite preview` serves built assets and the auth/economy HTTP routes, but not the
authoritative game WebSocket. Use `npm start` for a playable built server.

## Spectator and market API in production

The Spectator dashboard is a read-only layer. In development and preview the
Vite plugin mounts it at `<base>/spectator` and exposes `/api/market/*`. For
`npm start`, mount `createObservabilityNodeHandler()` from
`src/server/observability/node-mount.ts` in the production host; the full mount
contract is in [`observability.md`](observability.md).

The default API base is `<base>/api/market`; the single switch is
`IRONBLOCK_OBSERVABILITY_API_PATH` (for example
`IRONBLOCK_OBSERVABILITY_API_PATH=/quest/api/market`). If the page cannot reach
the live API it labels itself **DEMO REPLAY** and runs the deterministic engine
locally. That is an honest fallback, not a live market.

## Subpath deployment

Build and start with the same base:

```bash
npx vite build --base=/quest/
IRONBLOCK_BASE_PATH=/quest/ npm start
```

The client posts to `/quest/api/auth/auth0` (public mode) or
`/quest/api/auth/near` (local near mode), and `/quest/api/economy/*`. If the
spectator is mounted under the same base, also set
`IRONBLOCK_OBSERVABILITY_API_PATH=/quest/api/market` when your host does not
derive it from the Vite base.

## Settlement and treasury

Settlement is **testnet-only** and treasury-mediated. The server signs
`mt_transfer` from `v2.ironblock-treasury.testnet` with exactly 1 yoctoNEAR; the
receiver is pinned to the signed-in player's saved payout account. In public
Auth0 mode that address is player-supplied and may be absent until the player
sets it; withdrawals then return `NEAR_ACCOUNT_REQUIRED`. In local near mode it
is the MPC-derived implicit account. The treasury key never reaches the browser
and is never a `VITE_*` value.

Configure the signer only on the server, using one of the sources documented in
[`../README.md#environment`](../README.md#environment):

- `NEAR_TREASURY_PRIVATE_KEY` for injected secrets/CI, or
- `NEAR_TREASURY_KEYSTORE_PATH` for a near-cli keystore JSON, or
- the default near-cli keychain entry for the treasury account.

Never commit the key or keystore. If no signer is configured, the host should
keep serving the game and auth while settlement health reports the degraded
state. See [`DEMO.md`](DEMO.md) for the
recorded proof.

## Deployment checklist

- [ ] Node 22+ and `npm install` completed.
- [ ] `.env` created from `.env.example`; no secrets committed.
- [ ] `NEAR_AUTH_SESSION_SECRET` is random and at least 32 characters.
- [ ] Public deployment uses `AUTH_MODE=auth0` and `VITE_AUTH_MODE=auth0`.
- [ ] Auth0 SPA callback URLs, web origins and logout URLs include
      `https://ironblock.up.railway.app` and `http://localhost:3000`.
- [ ] Google and the desired email connection are enabled in Auth0.
- [ ] Local `near` mode, if used, opens `http://localhost:3000` exactly.
- [ ] `npm run config:check` passes.
- [ ] `npm run build` emits `dist/client` and `dist/server`.
- [ ] `npm start` serves `/health` and `/api/auth/health` with the expected mode.
- [ ] `/spectator` is mounted and shows **LIVE** if you want the live dashboard.
- [ ] TLS terminates in front of the host; the game session is a bearer token
      in the WebSocket query string.
- [ ] Rate limits/session storage are process-local. Run one process, or add a
      shared store and limiter before scaling out.

## Honest hosting limits

- Public Auth0 login requires the deployment owner’s tenant to allow the public
  origin. The values in this repository do not grant access; configure the
  callback URLs and web origins in the Auth0 dashboard.
- Auth sessions, the revocation list and rate limits are in memory. A restart
  clears them; multiple processes do not share them.
- A plain static host cannot run the Auth0/MPC exchange or the authoritative
  RPGJS WebSocket. It can serve assets, but login and the live game need the
  Node host. The spectator page can replay locally, but that is not live data.
- Settlement is testnet-only: no deposits, no burn, and no player-signed
  transfers in this phase.
- The player-supplied payout address is not a verified NEAR identity. It only
  names the receiver of a treasury-signed testnet transfer.
