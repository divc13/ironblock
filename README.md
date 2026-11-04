# Ironblock

Ironblock is a small market-town economy game for the NEAR Hackathon **Games With Real Economies** track.

Players gather materials and trade with NPC merchant agents. Each merchant has its own wallet, inventory and pricing personality. Prices respond to stock, recent demand, cash pressure and competition. A merchant that runs out of cash closes until someone invests in it. A fast-forward mode simulates a week of trading in about a minute.

## Status

**Phase 1: NEAR Auth testnet login spike + server-issued player identity/session.**

Implemented:

- “Continue with Google” and “Continue with email” login overlay in the RPGJS client.
- Auth0 popup login through the official NEAR Auth browser SDK.
- MPC-derived ed25519 public key for the signed-in Auth0 subject.
- Server-side Auth0 JWT verification (JWKS signature, issuer, audience, expiry).
- Server-side MPC `derived_public_key` lookup and comparison against the client key.
- Stable pseudonymous player id and server-issued HMAC game session.
- RPGJS WebSocket authentication using the game session, never an Auth0 token.
- No wallet extension, seed phrase, wallet popup or gas prompt in the normal start.

Not implemented yet: economy, NEP-245 contract, merchant agents and the game loop. The project is testnet-only; no real money is used or custodied.

## Stack

- RPGJS v5, TypeScript and Vite
- NEAR Auth testnet (Auth0 + MPC) for social/email login
- One NEP-245 contract on NEAR testnet for all item types
- Server-authoritative economy with an observable event stream

## Run

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

The port is deliberate: the shared NEAR Auth testnet Auth0 application allows
`http://localhost:3000` as a callback URL. `localhost` and port `3000` must match
exactly. Use the manual checklist in
[`docs/near-auth-manual-test.md`](docs/near-auth-manual-test.md).

Build and tests:

```bash
npm run build          # MMORPG client + authoritative server bundle
npm run test:auth      # JWT, MPC identity, session, store and HTTP route tests
npm run test:production # standalone asset smoke test (RPG_TYPE=rpg)
```

## Authentication flow

1. The RPGJS client boots with `deferConnection: true`, then shows the login overlay.
2. The player signs in through the Auth0 popup (Google or email).
3. The NEAR Auth browser SDK derives the player's ed25519 public key through the
   testnet MPC signer. No private key reaches the browser or this app.
4. The browser sends the Auth0 **access token** and the MPC public key to
   `POST /api/auth/near`.
5. The server verifies the Auth0 token with Auth0's JWKS (RS256, issuer,
   audience, expiry, subject), recomputes
   `jwt#https://login.testnet.fast-auth.com/#<sub>`, reads
   `derived_public_key` from the MPC contract, and compares it with the client key.
6. The server maps the Auth0 `sub` to a stable pseudonymous player id, records the
   player in the in-memory store, and issues a short-lived HMAC-signed game session.
7. The browser stores only the game session in `sessionStorage` and connects to
   the RPGJS WebSocket with it. The server verifies the game session in `auth()`.

The Auth0 access token is never persisted by the client. The game API exposes
only a short subject hash, not the raw Auth0 subject.

## Environment

Copy `.env.example` to `.env`. Never commit `.env` or any private key.

Public browser values (safe to ship):

| Variable | Testnet default |
| --- | --- |
| `VITE_NEAR_AUTH_CLIENT_ID` | shared NEAR Auth testnet client id |
| `VITE_NEAR_AUTH_DOMAIN` | `login.testnet.fast-auth.com` |
| `VITE_NEAR_AUTH_AUDIENCE` | `auth0.jwt.fast-auth.testnet` |
| `VITE_NEAR_RPC_URL` | `https://rpc.testnet.near.org` |

Server-only values:

| Variable | Testnet default / note |
| --- | --- |
| `NEAR_AUTH_ISSUER` | `https://login.testnet.fast-auth.com/` |
| `NEAR_AUTH_JWKS_URL` | `https://login.testnet.fast-auth.com/.well-known/jwks.json` |
| `NEAR_AUTH_FAST_AUTH_CONTRACT_ID` | `fast-auth.testnet` |
| `NEAR_AUTH_MPC_CONTRACT_ID` | `v1.signer-prod.testnet` |
| `NEAR_AUTH_SESSION_SECRET` | required; at least 32 characters |
| `NEAR_AUTH_SESSION_TTL_SECONDS` | `3600` (between 60 and 86400) |

In development, Vite creates an ephemeral session secret in memory if
`NEAR_AUTH_SESSION_SECRET` is unset. Set a real secret for any deployed server.

## Manual test

See [`docs/near-auth-manual-test.md`](docs/near-auth-manual-test.md) for the
checklist and the recorded result of the real testnet browser attempt.

## Planned structure

```text
src/config/          Data-only economy configuration
src/client/          Login overlay, NEAR Auth flow and browser polyfills
src/server/auth/     JWT verification, MPC identity, sessions and HTTP routes
src/shared/          Shared auth DTOs and future pricing rules
src/modules/         RPGJS maps, merchants, market and player actions
src/server.ts        Authoritative server entry point
```

The merchant pricing rules will live in one readable file. All tunable values —
merchant count, personalities, inventory, prices, recipes, taxes, bot activity and
fast-forward settings — will live in the config layer, separate from execution
code.
