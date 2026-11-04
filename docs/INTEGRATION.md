# Phase 1 integration record

This document describes how `feat/integration-phase1` was assembled, which
conflicts were resolved and how to verify the result. It is the base for
Phase 2 work (economy engine, world/UI, settlement, observability).

## Branch merge

`feat/integration-phase1` is based on `main` and merges the three completed
Phase 1 branches with ordinary git merges, in this order:

| Order | Branch | Commit | Content |
| --- | --- | --- | --- |
| 1 | `feat/foundation` | `9741e22` | Config, shared types, pricing, market events, validation, foundation tests |
| 2 | `feat/near-auth` | `e81b7dc` | NEAR Auth login, JWT/MPC verification, sessions, production host, auth tests |
| 3 | `feat/nep245-contract` | `c15a661` | Rust NEP-245 contract, deployment toolkit, final v2 testnet record |

Conflicts encountered and how they were resolved:

- `package.json` — combined both sides: `config:check` and the foundation unit
  tests from `feat/foundation`, `start`, `test:auth`, `test:production` and
  `test:production:auth` from `feat/near-auth`. Dependencies are the union of
  both branches (`tsx`, `zod`, `@types/node` from foundation; `vitest`,
  `@types/ws`, `jose`, `near-api-js`, `ws`, `buffer`, `@fast-auth-near/*` from
  auth). No script is duplicated.
- `package-lock.json` — regenerated with `npm install` against the merged
  `package.json`.
- `.env.example` — combined: NEAR Auth server/client variables from
  `feat/near-auth`, RPC URL from `feat/near-auth`
  (`https://rpc.testnet.near.org`), and the v2 contract/treasury IDs from
  `feat/nep245-contract`. No secrets added.
- Everything else (`vite.config.ts`, `src/server.ts`,
  `src/config/config.server.ts`, `README.md`,
  `test/production-preview.test.mjs`, `src/modules/main/server.ts`) merged
  automatically; the resulting files keep both behaviours:

  - `src/server.ts` registers the validated economy config provider
    (`economyConfigProvider` from `src/config/config.server.ts`) **before**
    the RPGJS server starts, so invalid economy data fails fast.
  - `src/modules/main/server.ts` keeps the RPGJS `engine.auth` hook wired to
    `authenticateGameSocket`, so game sockets still require the server-issued
    session.
  - `vite.config.ts` keeps the NEAR Auth API plugin, the dev-only ephemeral
    session secret (with a console warning), the client/server auth
    consistency check, and the production adapters from `src/server/production.ts`.
  - Production refuses to guess a session secret: `src/server/auth/config.ts`
    throws when `NEAR_AUTH_SESSION_SECRET` is missing outside development.

The NEP-245 contract source under `contracts/nep245/` is unchanged from
`feat/nep245-contract`; only game-side config and docs were touched.

## Final testnet IDs

| Field | Value |
| --- | --- |
| Contract | `v2.ironblock-items.testnet` |
| Owner | `v2.ironblock-items.testnet` |
| Treasury | `v2.ironblock-treasury.testnet` |
| Tokens | 13 |
| Total genesis supply | 533,000 |
| Deployment record | `contracts/nep245/deployments/testnet.json` |
| Explorer | <https://explorer.testnet.near.org/accounts/v2.ironblock-items.testnet> |

The earlier `ironblock-items.testnet` deployment (11 tokens) is superseded and
is intentionally no longer referenced by game code.

Game-side token references in `src/config/economy.ts` were updated to:

- `contract: 'v2.ironblock-items.testnet'`
- `reference: 'nep245:v2.ironblock-items.testnet:<tokenId>'`
- Symbols aligned with the deployed contract: `IORE`, `IING`, `GRN`, `FLR`,
  `TMB`, `PLK`, `WOL`, `CLT`, `PCK`, `HOE`, `AXE`, `BREAD`, `CLOAK`.

Prices, stocks, recipes and all other economy values are untouched. Each
item's `reference` was verified to point at its own token ID (the `iron_ingot`
entry correctly references `iron_ingot`, not `axe`).

## How to run

```bash
npm install
npm run config:check      # validates the economy config
npm test                  # unit + auth + production preview + production auth probes
npm run build
npm start                 # production host on :3000 (needs NEAR_AUTH_SESSION_SECRET)
```

Development stays on `npm run dev` at <http://localhost:3000> (port fixed to
match the shared NEAR Auth testnet Auth0 callback).

## Production probes

With the production host running (`npm start`), the expected results are:

| Probe | Expected |
| --- | --- |
| `GET /health` | `200` `{"status":"ok","service":"ironblock"}` |
| `GET /api/auth/health` | `200` `{"status":"ok","service":"near-auth","network":"testnet"}` |
| `POST /api/auth/near` with an empty body | `400`/`401`, never `404` |
| `GET /api/auth/session` without a session | `401`, never `404` |
| `GET /` | `200`, built game page |

`npm run test:production:auth` runs these probes automatically against both
`vite preview` and the production host.

## Known real-login blocker

The login flow cannot be end-to-end verified without a human: `POST
/api/auth/near` requires a real Auth0 ID/access token obtained through the
Google/email popup of the shared NEAR Auth testnet tenant, and the MPC key
derivation runs against the testnet signer. Automated tests stop at the
boundary (tokens rejected, routes mounted, sessions issued). A human must
still perform the manual checklist in
[`docs/near-auth-manual-test.md`](near-auth-manual-test.md) with a real
Google/email account to confirm a full login.

## Phase 2 final status

Phase 2 is integrated on `feat/integration-phase2` and shipped on `main`. It
adds:

- the tuned, deterministic economy engine and service (`feat/economy-tuning`);
- the playable market-square world, gather/craft/trade/invest UI
  (`feat/world-ui`);
- the authenticated `/api/economy/*` API and real HTTP client
  (`feat/integration-phase2` game wiring);
- the read-only `/api/market/*` API and `/spectator` dashboard
  (`feat/observability` + production mount);
- the NEP-245 testnet withdrawal bridge and economy-backed settlement ledger
  (`feat/settlement` + `feat/settlement-ledger`);
- the judge walkthrough, pricing rulebook and hosting runbook in
  [`DEMO.md`](DEMO.md), [`PRICING.md`](PRICING.md) and
  [`HOSTING.md`](HOSTING.md).

### Post-integration follow-ups

| Branch | Commit | What changed |
| --- | --- | --- |
| `feat/spectator-standalone` | `9d9d567` | The built dashboard gets its own `spectator-*.js`; RPGJS no longer injects the game canvas into `/spectator`. A regression check fails the build if the game client reappears. |
| `feat/npc-live-loop` | `6e375ee` | One process-wide recursive live loop advances bots, restocks, caravans, rent and order deliveries without player input. Ticks serialize with player actions/fast-forward and batch disk writes. |
| `feat/merchant-characters` | `94a5aa3` | Added Sable Voss (fixer, stall 7) and Rook Kestrel (smuggler, stall 8), with explicit map positions, generated signs and updated seven-day numbers. |
| `feat/townsfolk-characters` | `1380d80` | Added an eight-person, data-only townsfolk roster; names flow into bot events, the in-game Townsfolk panel and the spectator tape. Four ambient characters and name signs stand in the market square. |

Final integrated checks: `npm test` **261/261**, `npm run config:check`,
seven-day simulation (**2 bankruptcies, 1 investment, 415 order units**),
production build, a live snapshot probe showing bot trades advancing without
player input, and a standalone spectator build check. Production probes cover
auth, economy, spectator and settlement health.

Still honest limitations:

- A real Google/email Auth0 login must be completed by a human; automated tests
  stop at the token/MPC boundary.
- Auth sessions, revocation and rate limits are process-local; run one process.
- The shared Auth0 testnet client currently allows the local
  `http://localhost:3000` callback. A public origin needs a tenant callback
  change.
- Settlement is testnet-only, treasury-mediated, with no deposits or burns.
- `npm test` may still report npm audit warnings for transitive dependencies.
