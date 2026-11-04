# Ironblock

Ironblock is a small market-town economy game for the NEAR Hackathon **Games With Real Economies** track.

Players gather materials and trade with NPC merchant agents. Each merchant has its own wallet, inventory and pricing personality. Prices respond to stock, recent demand, cash pressure and competition. A merchant that runs out of cash closes until someone invests in it. A fast-forward mode simulates a week of trading in about a minute.

## Status

**Phase 1: NEAR Auth testnet login spike + server-issued player identity/session.**

Implemented:

- “Continue with Google” and “Continue with email” login overlay in the RPGJS client.
- Auth0 popup login through the official NEAR Auth browser SDK.
- MPC-derived ed25519 public key for the signed-in Auth0 subject.
- Client-side check that the Auth0 ID token and access token describe the same subject.
- Server-side Auth0 JWT verification (JWKS signature, issuer, audience, expiry).
- Server-side MPC `derived_public_key` lookup and comparison against the client key.
- Stable pseudonymous player id and server-issued HMAC game session.
- RPGJS WebSocket authentication using the game session, never an Auth0 token.
- Session restore, server-side logout/revocation, and TTL expiry at socket connect.
- In-process per-IP/per-subject login limits and MPC concurrency limits.
- Built production host that serves the client, auth API and authoritative game socket.
- No wallet extension, seed phrase, wallet popup or gas prompt in the normal start.

Not implemented yet: economy, NEP-245 contract, merchant agents and the game loop. The project is testnet-only; no real money is used or custodied.

## Stack

- RPGJS v5, TypeScript and Vite
- NEAR Auth testnet (Auth0 + MPC) for social/email login
- One NEP-245 contract on NEAR testnet for all item types
- Server-authoritative economy with an observable event stream

## Run

Development:

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

The port is deliberate: the shared NEAR Auth testnet Auth0 application allows
`http://localhost:3000` as a callback URL. `localhost` and port `3000` must match
exactly. Use the manual checklist in
[`docs/near-auth-manual-test.md`](docs/near-auth-manual-test.md).

## Build, preview and production start

```bash
npm run build
# Set a real server-only secret before starting outside development:
#   NEAR_AUTH_SESSION_SECRET="$(openssl rand -base64 48)"
npm start
```

`npm start` runs the small Node host in `src/server/production.ts`. It serves
`dist/client`, mounts the same `/api/auth/*` handler used by Vite, and hosts the
authoritative RPGJS WebSocket transport. It binds `0.0.0.0:3000` by default;
override with `HOST`, `PORT` and `IRONBLOCK_BASE_PATH`.

`vite preview` is also supported for built assets and the auth HTTP routes via
`configurePreviewServer`. It does **not** start the RPGJS game WebSocket, so use
`npm start` whenever you need a playable built server.

Health endpoints:

- `GET /health` — production host health
- `GET /api/auth/health` — auth handler/configuration health

For a subpath deployment, build and start with the same base:

```bash
npx vite build --base=/quest/
IRONBLOCK_BASE_PATH=/quest/ npm start
```

The client derives its login path from Vite's `BASE_URL`, so it posts to
`/quest/api/auth/near` in that example.

## Tests

```bash
npm run test:auth           # JWT, MPC identity, sessions, logout, socket, rate limits
npm run test:production     # standalone asset smoke test (RPG_TYPE=rpg)
npm run test:production:auth # built preview + production auth probe
npm test                    # all of the above
```

## Authentication flow

1. The RPGJS client boots with `deferConnection: true`, then shows the login overlay.
2. The player signs in through the Auth0 popup (Google or email).
3. The client compares the ID-token `sub` with the access-token `sub` and fails
   clearly if Auth0 returns inconsistent identities. The MPC path uses the
   ID-token subject; the server uses the independently verified access-token
   subject.
4. The NEAR Auth browser SDK derives the player's ed25519 public key through the
   testnet MPC signer. No private key reaches the browser or this app.
5. The browser sends the Auth0 **access token** and the MPC public key to
   `POST /api/auth/near` (or `<base>/api/auth/near`).
6. The server verifies the Auth0 token with Auth0's JWKS (RS256, issuer,
   audience, expiry, subject), recomputes
   `jwt#https://login.testnet.fast-auth.com/#<sub>`, reads
   `derived_public_key` from the MPC contract, and compares it with the client key.
7. The server maps the Auth0 `sub` to a stable pseudonymous player id, records the
   player in the in-memory store, and issues a short-lived HMAC-signed game session.
8. The browser stores only the game session in `sessionStorage` and connects to
   the RPGJS WebSocket with it. The server verifies the game session and checks
   the in-process session record before accepting the socket.
9. `POST /api/auth/logout` revokes the session. Both `/api/auth/session` and later
   WebSocket connections reject the revoked token.

The Auth0 access token exists in browser memory during login, but is never
persisted by the client and is never written to server logs. `sessionStorage` is
per-tab, so a second tab normally asks for login separately. If storage is
unavailable, an in-memory cache lets the current page connect, but a reload
requires signing in again. Auth0 email may be absent; the display name then
falls back to a short public subject hash.

## Environment

Copy `.env.example` to `.env`. Never commit `.env` or any private key. Vite fails
the build if public client values disagree with server values for the domain,
audience, FastAuth contract or MPC contract.

Public browser values (safe to ship):

| Variable | Testnet default / note |
| --- | --- |
| `VITE_NEAR_NETWORK` | `testnet` |
| `VITE_NEAR_RPC_URL` | `https://rpc.testnet.near.org` |
| `VITE_NEP245_CONTRACT_ID` | `items.ironblock.testnet` (future economy) |
| `VITE_NEAR_AUTH_NETWORK` | `testnet`; any other value is rejected |
| `VITE_NEAR_AUTH_CLIENT_ID` | shared NEAR Auth testnet client id |
| `VITE_NEAR_AUTH_DOMAIN` | `login.testnet.fast-auth.com` |
| `VITE_NEAR_AUTH_AUDIENCE` | `auth0.jwt.fast-auth.testnet` |
| `VITE_NEAR_AUTH_FAST_AUTH_CONTRACT_ID` | `fast-auth.testnet` |
| `VITE_NEAR_AUTH_MPC_CONTRACT_ID` | `v1.signer-prod.testnet` |

Server-only values:

| Variable | Testnet default / note |
| --- | --- |
| `NEAR_AUTH_DOMAIN` | `login.testnet.fast-auth.com`; hostname only |
| `NEAR_AUTH_ISSUER` | must equal `https://${NEAR_AUTH_DOMAIN}/` |
| `NEAR_AUTH_AUDIENCE` | must match the client audience |
| `NEAR_AUTH_JWKS_URL` | HTTPS URL on the same host as the domain |
| `NEAR_AUTH_RPC_URL` | `https://rpc.testnet.near.org` |
| `NEAR_AUTH_FAST_AUTH_CONTRACT_ID` | `fast-auth.testnet` |
| `NEAR_AUTH_MPC_CONTRACT_ID` | `v1.signer-prod.testnet` |
| `NEAR_AUTH_SESSION_SECRET` | required outside development; at least 32 characters |
| `NEAR_AUTH_SESSION_TTL_SECONDS` | `3600` (between 60 and 86400) |
| `NEAR_AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60` |
| `NEAR_AUTH_RATE_LIMIT_IP_MAX` | `20` requests per window per socket IP |
| `NEAR_AUTH_RATE_LIMIT_SUBJECT_MAX` | `8` requests per window per Auth0 subject |
| `NEAR_AUTH_RATE_LIMIT_CONCURRENT_MAX` | `4` concurrent requests per key |

Production host values:

| Variable | Default / note |
| --- | --- |
| `IRONBLOCK_BASE_PATH` | `/`; must match the Vite build base |
| `PORT` | `3000` |
| `HOST` | `0.0.0.0` |
| `IRONBLOCK_CLIENT_DIR` | `dist/client`; optional built-client override |

In development, Vite creates an ephemeral in-memory session secret if
`NEAR_AUTH_SESSION_SECRET` is unset. Set a real secret for any deployed server.
The rate limiter is in-process; a multi-process deployment needs a shared limiter.
`socket.remoteAddress` is used for the IP limit, and `X-Forwarded-For` is not
trusted automatically; configure a trusted proxy/limiter in front if needed.

`NEAR_TREASURY_ACCOUNT_ID` and `NEAR_TREASURY_PRIVATE_KEY` are reserved for the
future economy and are not used by the auth spike. Never expose or commit the
private key.

## Security notes

- The Auth0 access token is verified server-side; the raw subject is stored only
  server-side and clients receive a short subject hash.
- The browser never receives a private key. MPC derives the public key; the
  server independently verifies it for the verified Auth0 subject.
- The game session is a separate HMAC token with server-controlled TTL. It is a
  bearer token in the WebSocket query string; use TLS and keep the TTL short.
  There is no cookie-based session and no subprotocol transport yet.
- Session expiry is checked when the WebSocket connects. The spike does not
  forcibly disconnect an already-connected socket when its token expires.
- The in-memory session store allows a signed session to survive a process
  restart only until its `exp` time. Logout or revocation in a new process marks
  that process as authoritative and rejects older unrecorded sessions.
- The production host sends a baseline CSP and security headers. The Auth0
  popup/iframe allowlist has been kept to the configured testnet tenant and RPC;
  re-test it when changing Auth0 domains.
- No wallet extension, seed phrase, wallet popup or gas prompt is used.

## Manual test

See [`docs/near-auth-manual-test.md`](docs/near-auth-manual-test.md) for the
checklist, the recorded result of the real testnet browser attempt, and known
limitations.

## Planned structure

```text
src/config/          Data-only economy configuration
src/client/          Login overlay, NEAR Auth flow and browser polyfills
src/server/auth/     JWT verification, MPC identity, sessions and HTTP routes
src/server/production.ts  Built client + auth + RPGJS WebSocket host
src/shared/          Shared auth DTOs and future pricing rules
src/modules/         RPGJS maps, merchants, market and player actions
src/server.ts        Authoritative game server definition
```

The merchant pricing rules will live in one readable file. All tunable values —
merchant count, personalities, inventory, prices, recipes, taxes, bot activity and
fast-forward settings — will live in the config layer, separate from execution
code.
