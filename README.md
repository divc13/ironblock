# Ironblock

**Judge one-liner:** A playable market town where NPC merchants price, go broke,
and recover in public — and every item can settle as a NEP-245 token on NEAR
testnet.

Ironblock is a small market-town economy game for the NEAR Hackathon **Games With Real Economies** track.

Players gather materials and trade with NPC merchant agents. Each merchant has its own wallet, inventory and pricing personality. Prices respond to stock, recent demand, cash pressure and competition. A merchant that runs out of cash closes until someone invests in it. A fast-forward mode simulates a week of trading in about a minute.

**Judge path:** start with [`docs/DEMO.md`](docs/DEMO.md) for the timed 5–8
minute walkthrough.

## Status

**Phase 2 integrated and shipped on `main`:** data-driven economy foundation,
public Auth0 Google/email login, the deployed NEP-245 v2 items contract, the
playable market loop, a live autonomous NPC town, the standalone spectator
dashboard and the economy-backed settlement bridge. See
[`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the merge record, final testnet
IDs and known blockers.

Implemented:

- Data-only economy configuration (`src/config/economy.ts`) with validated
  bootstrap (`src/config/config.server.ts`), pricing rules, market events and
  a `npm run config:check` gate plus 30+ foundation tests.
- Eight merchant agents, including noir fixer **Sable Voss** and smuggler
  **Rook Kestrel**, each with their own cash, stock, pricing personality and
  generated stall.
- Eight named townsfolk — Marlowe Vane, Calla Morn, Don Ottavio, Rhea Vance,
  Yuri Blaine, Trinity Vale, Bram Sol and Ines Calder — all visible on the
  market square as server-authoritative economy-bot actors. They wander the
  square and walk to the matching resource area, merchant stall or Guild Orders
  board when the live loop reports a gather, trade or order delivery. Their
  nameplates travel on the sprites. The economy engine remains the source of
  truth; the visual director only mirrors its events, and fast-forward playback
  is never animated.
- One process-wide **live NPC loop** in production, dev and preview. Bots gather,
  trade and deliver orders; merchants restock and pay rent; caravans arrive on
  their own. The loop advances 1 in-game second per real second, serializes with
  player actions and fast-forward, and batches disk writes.
- “Continue with Google” and “Continue with email” login overlay in the RPGJS
  client. Login is mandatory: there is no guest or mock-economy path.
- Public `AUTH_MODE=auth0` login through the deployment owner’s Auth0 SPA tenant.
- Optional player-supplied NEAR testnet payout address. It can be skipped at
  login and set later before the first withdrawal; withdrawals are disabled
  until it exists.
- Local `AUTH_MODE=near` login through the official NEAR Auth browser SDK and
  MPC-derived ed25519 identity.
- Client-side check that the NEAR Auth ID token and access token describe the
  same subject (near mode only).
- Server-side Auth0 JWT verification (JWKS signature, issuer, audience, expiry).
- Server-side MPC `derived_public_key` lookup and comparison against the client
  key (near mode only).
- Stable pseudonymous player id and server-issued HMAC game session.
- RPGJS WebSocket authentication using the game session, never an Auth0 token.
- Session restore, server-side logout/revocation, and TTL expiry at socket connect.
- In-process per-IP/per-subject login limits and MPC concurrency limits.
- Built production host that serves the client, auth API and authoritative game socket.
- No wallet extension, seed phrase, wallet popup or gas prompt in the normal start.
- NEP-245 items contract deployed on testnet at
  [`v2.ironblock-items.testnet`](https://explorer.testnet.near.org/accounts/v2.ironblock-items.testnet)
  (13 tokens, 533,000 genesis supply, owner and treasury recorded in
  [`contracts/nep245/deployments/testnet.json`](contracts/nep245/deployments/testnet.json)).
  Every item in `src/config/economy.ts` references
  `nep245:v2.ironblock-items.testnet:<tokenId>` with the deployed symbol.

Phase 2 adds the playable market loop, world UI, a standalone spectator build
(it no longer loads the RPGJS canvas client), named merchants/townsfolk and the
testnet settlement bridge. The judge-facing path is
[`docs/DEMO.md`](docs/DEMO.md). The project is testnet-only; no real money is
used or custodied.

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/DEMO.md`](docs/DEMO.md) | 5–8 minute judge walkthrough: login, gather/smelt/trade, price reasons, seven-day fast-forward, spectator view, NEP-245 proof, limitations. |
| [`docs/PRICING.md`](docs/PRICING.md) | The readable pricing rulebook: quote pipeline, stock/demand/cash/rival effects, merchant presets, config knobs and the verified checkpoint. |
| [`docs/observability.md`](docs/observability.md) | Read-only spectator API and dashboard: `/api/market/*`, `/spectator`, privacy boundary and mount points. |
| [`docs/HOSTING.md`](docs/HOSTING.md) | Development, build, production start, Auth0 callback, subpath and settlement hosting notes. |
| [`docs/INTEGRATION.md`](docs/INTEGRATION.md) | Phase 1 merge record, final testnet IDs and known blockers. |
| [`docs/near-auth-manual-test.md`](docs/near-auth-manual-test.md) | NEAR Auth login checklist, recorded manual attempt and known limitations. |

Contracts and deployment records live in
[`contracts/nep245/`](contracts/nep245/), with the final testnet record in
[`contracts/nep245/deployments/testnet.json`](contracts/nep245/deployments/testnet.json).

## Stack

- RPGJS v5, TypeScript and Vite
- Auth0 Google/email login for the public build; optional local NEAR Auth/MPC path
- One NEP-245 contract on NEAR testnet for all item types
- Server-authoritative economy with an observable event stream

## Quick start

Requirements: **Node 22+** and npm. Testnet only.

```bash
npm install
cp .env.example .env
# Edit .env and set NEAR_AUTH_SESSION_SECRET to a random 32+ character value.
# Generate one once with: openssl rand -base64 48
npm run dev
```

Open exactly <http://localhost:3000>. The game starts only after login; there is
no guest path. The first successful login does not reload the page: the game is
started after the server-issued session exists. Wait for the town and the “Live
market” chip. The market keeps moving while you watch: press **T** for the
Townsfolk roster and watch the Market Wire for their gather/trade/order events as
the named bots walk to the matching resource area, stall or Guild Orders board.
The full walkthrough is in [`docs/DEMO.md`](docs/DEMO.md).

### Public Auth0 mode

The public deployment uses the deployment owner’s Auth0 SPA tenant. Set these
server and browser values (all public except the session secret):

```bash
AUTH_MODE=auth0
VITE_AUTH_MODE=auth0
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=your-spa-client-id
AUTH0_AUDIENCE=your-spa-client-id
VITE_AUTH0_DOMAIN=your-tenant.us.auth0.com
VITE_AUTH0_CLIENT_ID=your-spa-client-id
VITE_AUTH0_AUDIENCE=your-spa-client-id
```

In the Auth0 application, add `https://ironblock.up.railway.app` and
`http://localhost:3000` to **Allowed Callback URLs**, **Allowed Web Origins** and
**Allowed Logout URLs**. Enable Google and the email/password or passwordless
connection you want. No Auth0 client secret is used by this SPA and no Auth0
token is stored in browser storage. The server verifies the raw OIDC ID token;
its audience is the SPA client id, so no separate Auth0 API/resource server is
required.

The player can enter a NEAR testnet payout address after Google/email login, or
skip it and set it from the withdrawal panel before the first withdrawal. The
address is a payout destination only; Ironblock never asks for its private key.

### Local NEAR Auth mode

`AUTH_MODE=near` remains available for local NEAR Auth/MPC testing. The shared
NEAR Auth testnet application allows `http://localhost:3000` as a callback URL.
`localhost` and port `3000` must match exactly. Do not use `127.0.0.1` or another
port. Use the manual checklist in
[`docs/near-auth-manual-test.md`](docs/near-auth-manual-test.md). This mode is
separate from the public Auth0 path and must not be used for public login.

The default economy config runs the deterministic `demoScenario` story. To run the
stable sandbox economy instead, use the exported switch:

```ts
import { economy, stableSandboxScenario } from './src/config/economy'
import type { EconomyConfig } from './src/shared/types'

const config: EconomyConfig = {
  ...economy,
  scenario: stableSandboxScenario,
}
```

`npm run sim` uses the default demo scenario and prints bankruptcies, rescue
investments, order deliveries, caravan impact and top movers.

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
`/quest/api/auth/auth0` (or `/quest/api/auth/near` in local near mode) in that
example.

## Tests

```bash
npm run test:unit                 # economy foundation + observability + node-mount tests
npm run test:auth                 # Auth0/near login, sessions, logout, socket, rate limits
npm run test:settlement           # ledger, withdrawal store, service, settlement HTTP (mocked chain)
npm run test:production           # standalone asset smoke test (RPG_TYPE=rpg)
npm run test:production:auth      # built preview + production auth probe
npm run test:production:settlement # built preview + production settlement probe (no 404 routes)
npm test                          # all of the above
npm run config:check && npm run sim -- --days 7  # deterministic demo economy checkpoint
npm run smoke:settlement          # REAL testnet transfer: 1 item -> fresh implicit account (operator tool)
```

## Settlement (withdrawals)

The settlement bridge moves items from the server-side game ledger to the
player's saved NEAR testnet payout account as real NEP-245 tokens. Contract
`v2.ironblock-items.testnet`, treasury `v2.ironblock-treasury.testnet` (see
[`contracts/nep245/deployments/testnet.json`](contracts/nep245/deployments/testnet.json)).
In public Auth0 mode the payout account is supplied by the player and may be
empty until they set it; in local NEAR Auth mode it is the MPC-derived implicit
account. Testnet only; no deposits, no player-signed transfers, no burn in this
phase.

### Withdrawal flow

1. The client sends the bearer game session to `POST /api/settlement/withdraw`
   with `{ requestId, tokenId, amount }`. The server verifies the session
   (same store as `/api/auth`).
2. Validation: tokenId must exist on the deployed contract, amount must be a
   positive integer, and the receiver is pinned to the session's saved
   `nearAccountId`. If no payout address is set, the server returns
   `NEAR_ACCOUNT_REQUIRED` and the player must set one first. A client cannot
   request a different receiver.
3. The ledger (in-memory adapter; the economy engine binds here) atomically
   **holds** the amount so duplicate submits cannot overdraw.
4. An idempotent withdrawal record is keyed by `(playerId, requestId)`. A
   replayed request returns the original record without transferring again.
5. The server signs `mt_transfer` from the treasury with exactly **1
   yoctoNEAR**, memo `ironblock withdraw <record id>`, and broadcasts.
6. The server waits for **FINAL** execution within `NEAR_SETTLEMENT_TIMEOUT_MS`
   (default 45s). Success commits the ledger debit; an on-the-chain failure
   releases the hold (`refunded`, safe public message). A timeout keeps
   `pending` with funds reserved until reconcile decides (no guess).
7. The response carries status `confirmed`, `pending`/`submitted` (HTTP 202) or
   an error, plus tx hash + explorer link for success. `GET
   /api/settlement/withdrawals/:id` re-reads and reconciles pending records.

The treasury key is loaded server-side from (in order)
`NEAR_TREASURY_PRIVATE_KEY`, `NEAR_TREASURY_KEYSTORE_PATH` (legacy keystore
JSON), or the default **near-cli-rs keychain** (macOS: keychain item
`near-testnet-<account>`). The key never reaches the browser, never signs with
a player key, and no wallet popup or gas prompt exists.

### Ledger integration point

`src/server/settlement/ledger.ts` defines the seam:

- `SettlementLedger`: `hold()` / `commit()` / `release()` / `snapshot()`.
- `createEconomySettlementLedger(service)` is the production/demo binding: it
  reads authoritative inventory from the running economy engine, reserves holds
  in memory, and debits through `EconomyService.withdrawItem()` only when the
  on-chain transfer commits. A failed commit restores the reservation.
- `InMemorySettlementLedger` remains for isolated tests and smoke runs.
- The Vite dev/preview host uses `createLazyEconomySettlementLedger()` because
  config creation is synchronous; it resolves the shared economy singleton on
  first use. The production host starts the singleton during boot and wires the
  same ledger directly.

### Real testnet proof

`npm run smoke:settlement` transfers exactly 1 unit of a cheap token
(`iron_ore` preferred, then `bread`) to a freshly generated implicit account,
waits for FINAL, and verifies `mt_balance_of`. Verified run:

- token `iron_ore`, amount `1`, receiver
  `e3136895bba334fab6758465c6f6cccf095ea7af4c552418a598a988ddea67d9`
- tx `5Xg9zyWN4P4eNpmfMtZtSAgzx5gi3VST4AVtrADjroRs`
- <https://explorer.testnet.near.org/transactions/5Xg9zyWN4P4eNpmfMtZtSAgzx5gi3VST4AVtrADjroRs>
- status FINAL; receiver balance `1`; treasury balance after `99999`

### UI integration hook

`src/client/settlement/withdraw-panel.ts` exports `mountWithdrawPanel(options)`
— a vanilla-DOM panel that shows the player's implicit account, on-chain
balances, an item/amount picker, the testnet warning, and pending/confirmed/
failed states with the tx hash + explorer link. The HUD **Withdraw to NEAR**
button mounts it in a closeable overlay and refreshes it on open, using the
server-issued game-session token. No wallet extension, seed phrase, or gas
prompt is involved.

## Authentication flow

The RPGJS client starts with `deferConnection: true` and does not create a world
until the server has issued a game session. There is no guest path.

### Public Auth0 mode (`AUTH_MODE=auth0`)

1. The player chooses **Continue with Google** or **Continue with email**.
2. The Auth0 SPA SDK opens one popup with `openid profile email`. The ID token
   stays in the SDK’s in-memory cache; it is never written to browser storage.
3. The browser sends the raw **ID token** to `POST /api/auth/auth0` (or
   `<base>/api/auth/auth0`). It may also send an optional NEAR payout address.
4. The server verifies the ID token with the tenant JWKS (RS256, issuer,
   audience = SPA client id, expiry, subject), maps the Auth0 `sub` to a stable
   pseudonymous player id, records the optional payout address separately, and
   issues a short-lived HMAC-signed game session.
5. The player may skip the payout address. Withdrawals are blocked with
   `NEAR_ACCOUNT_REQUIRED` until they set one, either in the login step or from
   the withdrawal panel. Setting a new address issues a fresh session and
   revokes the old one.
6. The browser stores only the game session in `sessionStorage` and connects to
   the RPGJS WebSocket with it. The server verifies the session and checks the
   in-process session record before accepting the socket.
7. `POST /api/auth/logout` revokes the session. Both `/api/auth/session` and later
   WebSocket connections reject the revoked token.

### Local NEAR Auth mode (`AUTH_MODE=near`)

1. The player signs in through the shared NEAR Auth testnet popup. This path is
   for local development only.
2. The client compares the ID-token `sub` with the access-token `sub` and fails
   clearly if Auth0 returns inconsistent identities.
3. The NEAR Auth browser SDK derives the player's ed25519 public key through the
   testnet MPC signer. No private key reaches the browser or this app.
4. The browser sends the Auth0 **access token** and the MPC public key to
   `POST /api/auth/near`.
5. The server verifies the access token with Auth0's JWKS, recomputes
   `jwt#https://login.testnet.fast-auth.com/#<sub>`, reads
   `derived_public_key` from the MPC contract, and compares it with the client
   key. It then issues the same kind of game session.
6. The session’s `nearAccountId` is the MPC-derived implicit account and cannot
   be replaced through the Auth0 payout-address endpoint.

In both modes the Auth0 token exists in browser memory only during login, is
never persisted by Ironblock, and is never written to server logs. `sessionStorage`
is per-tab, so a second tab normally asks for login separately. If storage is
unavailable, an in-memory cache lets the current page connect, but a reload
requires signing in again. Auth0 email may be absent; the display name then
falls back to a short public subject hash.

## Settlement (testnet)

The integrated demo includes a testnet-only settlement bridge. It moves items
from the server-side game ledger to the player's saved payout account as real
NEP-245 tokens.

- Contract: `v2.ironblock-items.testnet`
- Treasury: `v2.ironblock-treasury.testnet`
- Withdrawal route: `POST /api/settlement/withdraw` with the bearer game session
  and `{ requestId, tokenId, amount }`. The receiver is pinned to the session's
  saved `nearAccountId`; a client cannot request a different receiver.
- In public Auth0 mode the payout address is player-supplied and optional until
  set. In local near mode it is the MPC-derived implicit account.
- The server signs `mt_transfer` from the treasury with exactly 1 yoctoNEAR and
  waits for `FINAL`. The treasury key never reaches the browser.
- Recorded proof: [tx `5Xg9zyWN4P4eNpmfMtZtSAgzx5gi3VST4AVtrADjroRs`](https://explorer.testnet.near.org/transactions/5Xg9zyWN4P4eNpmfMtZtSAgzx5gi3VST4AVtrADjroRs)
  transferred **1 `iron_ore`** from the treasury to a fresh smoke-test implicit
  account; status `FINAL`.

**Testnet only; treasury-mediated.** There are no deposits, no burn and no
player-signed transfers in this phase. In-game balances remain off-chain claims
backed by treasury inventory. See the proof and warnings in
[`docs/DEMO.md`](docs/DEMO.md).

## Environment

Copy `.env.example` to `.env`. Never commit `.env` or any private key. Vite fails
the build if the public client mode/values disagree with the server: `AUTH_MODE`
must match `VITE_AUTH_MODE`, and the selected mode’s domain, client id and
audience must match.

Public browser values (safe to ship):

| Variable | Default / note |
| --- | --- |
| `VITE_AUTH_MODE` | `auth0` for public, `near` for local NEAR Auth/MPC |
| `VITE_AUTH0_DOMAIN` | your Auth0 tenant hostname (public mode) |
| `VITE_AUTH0_CLIENT_ID` | your Auth0 SPA client id (public mode) |
| `VITE_AUTH0_AUDIENCE` | optional; defaults to the SPA client id |
| `VITE_AUTH0_GOOGLE_CONNECTION` | `google-oauth2` |
| `VITE_NEAR_NETWORK` | `testnet` |
| `VITE_NEAR_RPC_URL` | `https://rpc.testnet.near.org` |
| `VITE_NEP245_CONTRACT_ID` | `v2.ironblock-items.testnet` (final v2 deployment) |
| `VITE_NEAR_AUTH_NETWORK` | `testnet`; any other value is rejected |
| `VITE_NEAR_AUTH_CLIENT_ID` | shared NEAR Auth testnet client id |
| `VITE_NEAR_AUTH_DOMAIN` | `login.testnet.fast-auth.com` |
| `VITE_NEAR_AUTH_AUDIENCE` | `https://api.testnet.fast-auth.com`; login token audience |
| `VITE_NEAR_AUTH_SIGNING_AUDIENCE` | `auth0.jwt.fast-auth.testnet`; transaction signatures only |
| `VITE_NEAR_AUTH_FAST_AUTH_CONTRACT_ID` | `fast-auth.testnet` |
| `VITE_NEAR_AUTH_MPC_CONTRACT_ID` | `v1.signer-prod.testnet` |

Server-only values:

| Variable | Default / note |
| --- | --- |
| `AUTH_MODE` | `auth0` for public, `near` for local NEAR Auth/MPC |
| `AUTH0_DOMAIN` | your Auth0 tenant hostname (public mode) |
| `AUTH0_CLIENT_ID` | your Auth0 SPA client id (public mode) |
| `AUTH0_AUDIENCE` | optional; defaults to the SPA client id |
| `AUTH0_ISSUER` | optional; must equal `https://${AUTH0_DOMAIN}/` |
| `AUTH0_JWKS_URL` | optional; HTTPS URL on the Auth0 domain |
| `NEAR_AUTH_DOMAIN` | `login.testnet.fast-auth.com`; hostname only |
| `NEAR_AUTH_ISSUER` | must equal `https://${NEAR_AUTH_DOMAIN}/` |
| `NEAR_AUTH_AUDIENCE` | must match the client login API audience |
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
| `NEAR_NETWORK` | `testnet`; settlement refuses any other value |
| `NEAR_RPC_URL` | `https://rpc.testnet.fastnear.com` (testnet JSON-RPC) |
| `NEAR_NEP245_CONTRACT_ID` | `v2.ironblock-items.testnet` (final deployment) |
| `NEAR_TREASURY_ACCOUNT_ID` | `v2.ironblock-treasury.testnet` |
| `NEAR_TREASURY_KEYSTORE_PATH` | optional legacy keystore JSON path; keychain is probed otherwise |
| `NEAR_TREASURY_PRIVATE_KEY` | optional inline key (injected secrets/CI only); never commit |
| `NEAR_SETTLEMENT_TIMEOUT_MS` | `45000` (5000..300000); FINAL-finality budget |

Production host values:

| Variable | Default / note |
| --- | --- |
| `IRONBLOCK_BASE_PATH` | `/`; must match the Vite build base |
| `PORT` | `3000` |
| `HOST` | `0.0.0.0` |
| `IRONBLOCK_CLIENT_DIR` | `dist/client`; optional built-client override |
| `IRONBLOCK_LIVE_TICK_MS` | `1000`; real-time delay between live NPC ticks |
| `IRONBLOCK_LIVE_TICK_SECONDS` | `1`; in-game seconds advanced per tick (raise to accelerate) |
| `IRONBLOCK_LIVE_SAVE_MS` | `15000`; max delay between batched world saves |

The authoritative economy runs one live NPC loop in the process that owns the
world (production host, Vite dev or preview). It uses a recursive `setTimeout`
(never overlapping ticks), shares the service action queue with player actions
and fast-forward, and unrefs its timer. The default advances one in-game second
per real second; raise `IRONBLOCK_LIVE_TICK_SECONDS` only when you want a faster
demo, because high ratios can flood the retained event feed. Live ticks are held
in memory and flushed to disk on the `IRONBLOCK_LIVE_SAVE_MS` cadence and on
shutdown, so the full world is not rewritten every second. The loop never starts
inside `node --test` or Vitest unless a test explicitly opts in.

In development, Vite creates an ephemeral in-memory session secret if
`NEAR_AUTH_SESSION_SECRET` is unset. Set a real secret for any deployed server.
The rate limiter is in-process; a multi-process deployment needs a shared limiter.
`socket.remoteAddress` is used for the IP limit, and `X-Forwarded-For` is not
trusted automatically; configure a trusted proxy/limiter in front if needed.

`NEAR_TREASURY_ACCOUNT_ID` / `NEAR_TREASURY_KEYSTORE_PATH` /
`NEAR_TREASURY_PRIVATE_KEY` configure the settlement treasury signer. The
near-cli-rs keychain is probed when neither explicit source is set (macOS
service `near-testnet-v2.ironblock-treasury.testnet`). Never expose the key
through a `VITE_*` variable and never commit the key or `.env`.

## Security notes

- The Auth0 token is verified server-side: the ID token in public `auth0` mode,
  the login access token in local `near` mode. The raw subject is stored only
  server-side and clients receive a short subject hash.
- In public `auth0` mode the browser never receives or stores a NEAR private key.
  The player-supplied payout address is only a withdrawal destination. In local
  `near` mode MPC derives the public key; the server independently verifies it
  for the verified Auth0 subject.
- The game session is a separate HMAC token with server-controlled TTL. It is a
  bearer token in the WebSocket query string; use TLS and keep the TTL short.
  There is no cookie-based session and no subprotocol transport yet.
- Session expiry is checked when the WebSocket connects. The spike does not
  forcibly disconnect an already-connected socket when its token expires.
- The in-memory session store allows a signed session to survive a process
  restart only until its `exp` time. Logout or revocation in a new process marks
  that process as authoritative and rejects older unrecorded sessions.
- The production host sends a baseline CSP and security headers. The Auth0
  popup/iframe allowlist uses the configured Auth0 domain and RPC; re-test it
  when changing Auth0 domains.
- No wallet extension, seed phrase, wallet popup or gas prompt is used.

## Manual test

See [`docs/near-auth-manual-test.md`](docs/near-auth-manual-test.md) for the
local NEAR Auth checklist and recorded testnet result. Public Auth0 login is
covered by [`docs/HOSTING.md`](docs/HOSTING.md); it needs one human Google/email
popup and a payout-address/withdrawal check.

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
