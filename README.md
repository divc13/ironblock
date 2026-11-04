# Ironblock

Ironblock is a small market-town economy game for the NEAR Hackathon **Games With Real Economies** track.

Players gather materials and trade with NPC merchant agents. Each merchant has its own wallet, inventory and pricing personality. Prices respond to stock, recent demand, cash pressure and competition. A merchant that runs out of cash closes until someone invests in it. A fast-forward mode simulates a week of trading in about a minute.

## Status

RPGJS scaffold only. The game loop, economy, NEAR Auth integration and NEP-245 contract are not implemented yet.

The project is testnet-only. No real money is used or custodied.

## Stack

- RPGJS v5, TypeScript and Vite
- NEAR Auth testnet for social/email login
- One NEP-245 contract on NEAR testnet for all item types
- Server-authoritative economy with an observable event stream

## Run

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

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

Production build and smoke test:

```bash
npm run build
npm run test:production
```

## Environment

Copy `.env.example` to `.env` and fill in the testnet values. Never commit `.env` or a treasury private key.

## Planned structure

```text
src/config/          Data-only economy configuration
src/shared/          Pricing rules, types and deterministic simulation
src/modules/         RPGJS maps, merchants, market and player actions
src/server.ts        Server entry point
```

The merchant pricing rules will live in one readable file. All tunable values — merchant count, personalities, inventory, prices, recipes, taxes, bot activity and fast-forward settings — will live in the config layer, separate from execution code.
