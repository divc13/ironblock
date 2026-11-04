# Ironblock pricing rules

This is the readable rulebook for the Ironblock market. Every number below is
either read from `src/config/economy.ts` or produced by
`src/shared/pricing.ts`; none of it is invented marketing copy. The simulation
checkpoint at the end can be reproduced with `npm run sim`.

Two files own the behaviour:

| File | What it owns |
| --- | --- |
| `src/config/economy.ts` | Every coefficient, item base value, merchant personality, stock target, margin, clamp, sink, caravan and order setting. Data only. |
| `src/shared/pricing.ts` | The quote pipeline: `computeSidePrice()`, rival selection, bid/ask guard, fill limits and the `quote()` entry point. It reads coefficients from config and never hard-codes a merchant or item id. |

`src/shared/price-bounds.ts` is the single source for unit-price clamps, used by
both validation and pricing so the two cannot drift.

## Bid and ask

A quote is always written from the **player's point of view**:

| Quote side | Player action | Merchant side used | Config list that must contain the item |
| --- | --- | --- | --- |
| `buy` | Player buys from the stall | Merchant **ask** | `merchants.<id>.sells` |
| `sell` | Player sells to the stall | Merchant **bid** | `merchants.<id>.buys` |

The spread is positive because the ask is lifted and the bid is lowered by the
same half-spread and by opposite margin directions. `quote()` also contains a
**bid/ask guard**: if a merchant both buys and sells the same item and the two
computed sides cross, the current side is moved to the rounded midpoint of the
two (reason code `spread-guard`) so a player can never buy below the stall's own
bid.

Day-1 example from the real engine (fresh world, seed
`ironblock-testnet-2026`):

| Stall | Item | Ask (player buys) | Bid (player sells) | Base |
| --- | --- | ---: | ---: | ---: |
| Wheatley | Grain | IB3.55 | IB2.75 | IB3.00 |
| Wheatley | Bread | IB11.78 | IB9.11 | IB10.00 |
| Ferro | Iron Ore | IB7.19 | IB5.54 | IB6.00 |

## The quote pipeline (9 steps)

`computeSidePrice()` applies the steps in this exact order for **both** sides.
The reason trail returned to the UI is built in the same order, so the price
tooltip is a literal trace of the arithmetic.

| # | Step | Config fields | Operation |
| --- | --- | --- | --- |
| 1 | Base value | `items.<id>.baseValue` | `price = baseValue` |
| 2 | Stock pressure | `pricing.stock.elasticity` (0.55), `minFactor` (0.35), `maxFactor` (2.2), `fallbackTargetStock` (1), plus `personalities.<id>.stockSensitivity` | `p = clamp((target − stock) / target, −1, 1)`; `factor = clamp(1 + 0.55 × sensitivity × p, 0.35, 2.2)` |
| 3 | Demand EMA | `pricing.demand.weight` (0.3), `maxPressure` (2), `windowSeconds` (900), `emaAlpha` (0.2), plus `demandSensitivity` | `p = clamp(demandEma / target, 0, 2)`; `factor = 1 + 0.3 × sensitivity × p` |
| 4 | Cash pressure | `pricing.cash.weight` (0.4), `bidWeight` (1), `askWeight` (0.25), `comfortMultiple` (3), `minFactor` (0.1), `maxFactor` (2), plus `cashBidSensitivity` / `cashAskSensitivity` | See below. Ask is lifted, bid is cut as the stall runs thin. |
| 5 | Merchant margin | `merchants.<id>.margins.buy` / `.sell`, `personalities.<id>.buyMarginMultiplier` / `sellMarginMultiplier` | Ask `× (1 + sellMargin × multiplier)`; bid `× (1 − buyMargin × multiplier)` |
| 6 | Market spread | `pricing.spread.base` (0.015), `min` (0.005), `max` (0.2), `spreadMultiplier` | `r = clamp(0.015 × multiplier, 0.005, 0.2)`; ask `× (1 + r)`, bid `× (1 − r)` |
| 7 | Rival quotes | `pricing.rival.weight` (0.25), `maxAdjustment` (0.3), `maxRivals` (3), `rotationSeconds` (3600), `rivalSensitivity` | Pull toward the mean competing same-side price; see below. |
| 8 | Clamps | `pricing.clamps.minMultiplier` (0.35), `maxMultiplier` (2.8), `minUnitPrice` (0.01), `maxUnitPrice` (10000) | `min = max(base × 0.35, 0.01)`, `max = min(base × 2.8, 10000)`; clamp the price. |
| 9 | Rounding | `pricing.rounding.decimals` (2), `mode` (`nearest`) | Round, then clamp again so rounding cannot escape the bounds. |

After pricing, `quote()` adds the bid/ask guard, blocked reasons, and fill
constraints (stock, merchant cash, player cash, player inventory, carry weight
and the 100-unit trade cap). The result is pure: it reads state and never
mutates it.

### Stock factor in detail

- **Target stock** is `merchant.targetStock[itemId]`, falling back to
  `merchants.<id>.targetStock[itemId]`, then
  `pricing.stock.fallbackTargetStock`.
- **Stock pressure** is +1 when the shelf is empty, 0 at target, and negative
  above target (down to −1). Low stock raises the ask *and* the bid; excess
  stock lowers both.
- Initial stock is `floor(targetStock × restockRate.targetRatio)` per merchant.
  Example: Ferro targets 40 iron ore with `targetRatio` 0.95, so it opens with
  38 and a small low-stock lift.
- Buying more than `targetStock × pricing.trade.maxStockMultiple` (3×) is
  blocked by `maxByStock`, which keeps a stall from being strip-mined.

### Demand EMA in detail

- `demandEma[itemId]` starts at 0 and is updated only when the merchant
  **sells** an item: player buys, bot buys, or the caravan buys out of town.
  The update is `ema += emaAlpha × (units − ema)` with `emaAlpha = 0.2`.
- Every simulation step decays the EMA by `max(0, 1 − seconds / windowSeconds)`.
  At the default 30 s step that is a 0.9667 multiplier per step; a 900 s step
  clears it.
- Demand pressure is `EMA / targetStock`, capped at `maxPressure = 2`, so even a
  demand spike can lift a balanced merchant's price by at most 60%
  (`1 + 0.3 × 2`).

### Cash pressure in detail

`merchantCashPressure()` is:

```text
comfort  = max(reserve × comfortMultiple, minUnitPrice)   // 3× reserve
excess   = max(0, cash − reserve)
pressure = clamp(1 − excess / comfort, 0, 1)
```

So pressure is 1 at the reserve floor, 0 once the stall holds three reserves of
excess cash, and linear in between. It then enters as:

```text
cashFactor = clamp(1 + direction × 0.4 × sideWeight × cashSensitivity × pressure, 0.1, 2)
direction  = +1 for the ask, −1 for the bid
sideWeight = askWeight 0.25 (ask) / bidWeight 1 (bid)
```

A balanced merchant at full pressure therefore asks up to 10% more and bids up
to 40% less. A `desperate` merchant (`cashBidSensitivity` 2.2) cuts its bid by
up to 88% before the 0.1 floor. This is the visible "cash-thin stall quotes
badly" behaviour.

### Rival undercut in detail

`selectRivalMerchants()` builds a deterministic, bounded sample:

- Candidates are other merchants that can trade, have a known personality, and
  on the quote's side either **sell the item with stock > 0** (ask rivals) or
  **buy the item with cash > reserve** (bid rivals).
- Candidates are sorted by stable codepoint, then rotated by a hash of
  `[seed, merchantId, itemId, side, day, floor(time / 3600)]`. The sample
  changes once an in-game hour and no merchant is permanently favoured.
- The reference is the **mean of each rival's own same-side computed price**
  (computed with `includeRivals = false`, so the graph stays acyclic).
- The pull is `gap = clamp((reference − price) / max(reference, 0.01), −1, 1)`
  and `factor = clamp(1 + 0.25 × rivalSensitivity × gap, 0.7, 1.3)`. This is a
  soft pull toward competitors, not a hard undercut.

Verified day-1 example: Weaver asks IB16.26 for cloth while Broker asks IB18.10,
so Weaver's rival step adds +IB0.53. Broker asks IB18.10 while Weaver asks
IB16.26 (Sable Voss also competes), so Broker's rival step subtracts −IB0.19.

### Merchant margins and the personalities

Margins are per merchant, then scaled by the personality preset. For example,
Toolsmith has `margins.sell = 0.22` and the `premium` preset has
`sellMarginMultiplier = 1.5`, so its effective ask margin is **33%**.

`merchants.<id>.margins.sell` must be greater than `margins.buy`
(`config-validation.ts` enforces this), which is what keeps the two sides from
crossing even before the guard runs.

Numeric personality presets (`src/config/economy.ts → personalities`):

| Preset | stockSens. | demandSens. | cashBidSens. | cashAskSens. | rivalSens. | buyMarginMult. | sellMarginMult. | spreadMult. |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `balanced` | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
| `aggressive` | 1.35 | 1.50 | 1.20 | 1.10 | 1.60 | 0.80 | 0.75 | 0.70 |
| `hoarder` | 1.80 | 0.70 | 0.35 | 0.80 | 0.50 | 1.15 | 1.35 | 1.30 |
| `premium` | 0.80 | 0.80 | 0.50 | 0.60 | 0.35 | 1.25 | 1.50 | 1.60 |
| `desperate` | 0.90 | 1.20 | 2.20 | 0.25 | 1.40 | 1.50 | 0.50 | 0.50 |

### Price clamps

`priceBoundsFor(item, config)` is authoritative:

```text
min = max(baseValue × 0.35, 0.01)
max = min(baseValue × 2.8, 10000)
```

| Item | Base | Min | Max |
| --- | ---: | ---: | ---: |
| Iron Ore | 6 | 2.10 | 16.80 |
| Iron Ingot | 16 | 5.60 | 44.80 |
| Grain | 3 | 1.05 | 8.40 |
| Flour | 7 | 2.45 | 19.60 |
| Timber | 4 | 1.40 | 11.20 |
| Plank | 9 | 3.15 | 25.20 |
| Wool | 5 | 1.75 | 14.00 |
| Cloth | 13 | 4.55 | 36.40 |
| Pickaxe | 48 | 16.80 | 134.40 |
| Hoe | 42 | 14.70 | 117.60 |
| Axe | 45 | 15.75 | 126.00 |
| Bread | 10 | 3.50 | 28.00 |
| Cloak | 38 | 13.30 | 106.40 |

The `maxUnitPrice` ceiling of 10,000 never binds at these base values; it is a
safety rail for future items. The UI tooltip shows the clamp row and the allowed
range for every quote.

## Reserve, bankruptcy, investment and cash recovery

- **Reserve** is a per-merchant cash floor (`merchants.<id>.reserve`).
- **Bankruptcy** is `cash <= reserve × pricing.cash.bankruptcyRatio` (ratio 1.0).
  `isMerchantBankrupt()` is a pure check; `canMerchantTrade()` also requires
  `open`.
- The engine calls `detectBankruptcy()` after every player trade, bot trade,
  caravan arrival and day close. A closed stall gets `open = false`,
  `bankrupt = true` and `bankruptAt = time`, emits `merchant.bankrupt`, and
  refuses all trades (`merchant_below_reserve`).
- **Reopening** is `invest(playerId, merchantId, amount)` for the authoritative
  engine: any positive amount reopens the stall as long as it is closed or
  bankrupt. The engine adds the cash, reopens it, resets `lastRestockAt`, and
  excludes the injection from the next profit calculation by adding it to
  `cashAtDayStart`. The mock client instead asks for
  `ceil(2 × reserve − cash)` (the UI's "Reopen stall — IB…" button).
- **Profit share**: at day close, a reopened merchant with an active investment
  pays `investments.profitShareRate` (25%) of positive daily profit
  (`cash − cashAtDayStart`), capped at `cash − reserve`, pro rata by invested
  amount, with `investments.minDistribution` 0.01. Profit is net of that day's
  rent.
- **Cash recovery**: an open, non-bankrupt merchant below
  `reserve × cashRecovery.targetReserveMultiple` (1.8×) receives
  `min(target − cash, reserve × dailyRate)` (12% of reserve per day). This is a
  source, not a sink, and never applies to a bankrupt stall.

## Restock and supply chains

Every open merchant runs its restock loop when
`lastRestockAt + restockRate.intervalSeconds` is due:

1. For each `targetStock` item, top up by at most `restockRate.unitsPerTick`
   toward `floor(targetStock × restockRate.targetRatio)`.
2. If the merchant has a `supplyChain`, run up to `batchesPerRestock` batches:
   consume the configured inputs and produce the outputs, stopping if inputs
   are missing or the output would exceed `targetStock × 3` (the same
   `maxStockMultiple` cap used by trading).
3. Closed stalls do not restock; their `lastRestockAt` is advanced so they do
   not burst-restock on reopening.

Resource nodes respawn independently (`resources.nodes.<id>.respawnSeconds`,
one node at a time up to `nodeCount`). Restocks and respawns create
`merchant.restock` events, which is what the Market Wire calls "Restock".

## Caravan

The external caravan arrives every `caravan.intervalSeconds` (1800 s = 48
arrivals per simulated day). On each arrival:

- For every configured good (`iron_ore` 15–30, `grain` 20–40, `timber` 15–30,
  `wool` 10–20, `bread` 10–20), it picks a deterministic random open merchant
  that **buys** that good, quotes the merchant's normal bid, multiplies by
  `caravan.priceBias.ask` (1.12), and sells as many units as the merchant can
  afford from `cash − reserve`.
- It then picks one good at random and a merchant that **sells** it, quotes the
  normal ask, multiplies by `caravan.priceBias.bid` (0.9), and buys up to the
  available stock.
- Caravan trades bypass the sales tax and do not pay rent.

The event records units sold into town, units bought out of town, and the cash
each way. In the seven-day tuned run: 336 arrivals, 4,459 units sold into town
for IB11,522.51, and 7,012 units bought out of town for IB18,457.24.

## Rent, tax and other sinks

| Sink | Config | Applied when |
| --- | --- | --- |
| Stall rent | `sinks.stallRent.amountPerDay` (20), `graceDays` (1) | Day close, only when `day > graceDays` and the merchant is open. Charged as `min(cash, 20)`, so rent cannot push cash below zero. |
| Sales tax | `sinks.salesTax.rate` (0.04), `appliesTo` (`merchant`) | When the merchant is the seller (player buys or a bot buys). The merchant receives `total − tax`; the tax is recorded in `sinks.salesTax`. With `appliesTo: "player"` the player pays the tax instead. |
| Tool repairs | `sinks.toolDurability.repairCostPerPoint` (0.6) | Player repair action; cost = missing durability × 0.6. |
| Scenario shocks | `scenario.shocks` | Scheduled cash drains / bulk purchases; recorded in `sinks.shocks`. |

Rent is charged before the profit-share calculation, so investment
distributions are paid out of rent-paid profit. In the seven-day run the sinks
were rent IB900.00, sales tax IB1,211.25, repairs IB0.00 and scenario shocks
IB676.30.

## Order pricing

Quest-board orders are **not** market quotes. Their reward is set when the order
is created:

```text
unitReward = max(0.01, round(baseValue × multiplier, 2))
multiplier = random integer percent in [rewardMultiplier.min × 100, rewardMultiplier.max × 100] / 100
```

With the shipped config that is a 1.15×–1.55× multiplier on the item's base
value. Orders have `maxActive` 6, are generated once per `cadenceDays` (1) day,
expire after `expiryDays` (3), and reward the full `unitReward × delivered
units` on fulfillment. Bots may deliver to **open** orders
(`botParticipation.chance` 0.65, at most 6 units per delivery); bots never touch
an order a player has accepted.

| Template id | Issuer | Item | Quantity |
| --- | --- | --- | ---: |
| `smelter_iron_ingot` | Smelter Guild | Iron Ingot | 6–12 |
| `kitchen_bread` | Town Kitchen | Bread | 8–16 |
| `builders_plank` | Builders Guild | Plank | 6–12 |
| `tailors_cloth` | Tailors Guild | Cloth | 4–8 |
| `smelter_iron_ore` | Smelter Guild | Iron Ore | 10–20 |
| `weavers_wool` | Weavers Guild | Wool | 8–14 |

In the tuned seven-day run the board created 47 orders and bots delivered 415
units for IB5,037.59.

## The 13 items (base prices)

| Token id | Display name | Category | Base price | Weight | NEP-245 symbol |
| --- | --- | --- | ---: | ---: | --- |
| `iron_ore` | Iron Ore | ore | 6 | 2.0 | IORE |
| `iron_ingot` | Iron Ingot | metal | 16 | 1.5 | IING |
| `grain` | Grain | grain | 3 | 1.0 | GRN |
| `flour` | Flour | food | 7 | 1.0 | FLR |
| `timber` | Timber | timber | 4 | 2.5 | TMB |
| `plank` | Plank | wood | 9 | 2.0 | PLK |
| `wool` | Wool | fiber | 5 | 0.5 | WOL |
| `cloth` | Cloth | textile | 13 | 0.5 | CLT |
| `pickaxe` | Pickaxe | tool | 48 | 3.0 | PCK |
| `hoe` | Hoe | tool | 42 | 3.0 | HOE |
| `axe` | Axe | tool | 45 | 3.0 | AXE |
| `bread` | Bread | food | 10 | 0.5 | BREAD |
| `cloak` | Cloak | clothing | 38 | 1.0 | CLOAK |

All 13 tokens live in `v2.ironblock-items.testnet` with 0 decimals and the
supplies recorded in `contracts/nep245/deployments/testnet.json`.

## Merchant presets

| Stall | Merchant | Slot | Personality | Cash | Reserve | Buys from player | Sells to player | Margins buy/sell | Restock (s / units / ratio) | Supply chain per restock |
| --- | --- | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- |
| 1 | Ferro | 1 | balanced | 520 | 80 | iron_ore | iron_ore, iron_ingot | 0.10 / 0.16 | 120 / 6 / 0.95 | 2 ore → 1 ingot, ×2 |
| 2 | Wheatley | 2 | balanced | 380 | 60 | grain, flour, bread | grain, flour, bread | 0.07 / 0.11 | 90 / 10 / 1.00 | 2 flour + 1 grain → 2 bread, ×2 |
| 3 | Timberly | 3 | balanced | 460 | 70 | timber | timber, plank | 0.10 / 0.15 | 120 / 8 / 0.95 | 2 timber → 1 plank, ×2 |
| 4 | Weaver | 4 | balanced | 420 | 60 | wool | wool, cloth | 0.09 / 0.14 | 120 / 6 / 0.95 | 3 wool → 1 cloth, ×2 |
| 5 | Toolsmith | 5 | premium | 760 | 110 | iron_ingot, plank, pickaxe, hoe, axe | pickaxe, hoe, axe | 0.14 / 0.22 | 180 / 2 / 0.90 | 5 ingot + 3 plank → 1 pickaxe + 1 hoe + 1 axe, ×1 |
| 6 | Broker | 6 | hoarder | 980 | 150 | iron_ingot, plank, cloth, pickaxe, hoe, axe, bread, cloak | grain, flour, bread, cloth, cloak | 0.12 / 0.18 | 240 / 5 / 0.90 | none |
| 7 | Sable Voss | 7 | premium | 640 | 90 | bread, cloth, cloak | bread, cloth, cloak | 0.12 / 0.19 | 180 / 4 / 0.92 | none |
| 8 | Rook Kestrel | 8 | aggressive | 560 | 85 | iron_ore, iron_ingot, timber, plank | iron_ore, iron_ingot, timber, plank | 0.08 / 0.14 | 100 / 7 / 0.95 | none |

Personalities are assignments, not overrides: a merchant's own `margins` are
still the base, then the personality multiplier scales them.

## Worked example (verified against the engine)

Fresh world at day 1 (seed `ironblock-testnet-2026`), buy **1 Bread from
Wheatley**. The engine returns `unitPrice = IB11.78` with this trail:

| Step | Input | Effect | Running price |
| --- | --- | ---: | ---: |
| Base value | Bread base | — | 10.0000 |
| Stock | 30 on shelf vs target 30 → pressure 0 | 0.0000 | 10.0000 |
| Demand | EMA 0 over 900 s | 0.0000 | 10.0000 |
| Cash | Cash 380 vs reserve 60 → pressure 0 | 0.0000 | 10.0000 |
| Margin | Sell margin 11.00% (balanced ×1) | +1.1000 | 11.1000 |
| Spread | 1.50% half-spread | +0.1665 | 11.2665 |
| Rival | Broker/Sable bread ask reference IB13.79 → gap 0.1827 × 0.25 | +0.5146 | 11.7811 |
| Clamp | Allowed 3.50–28.00 | 0.0000 | 11.7811 |
| Rounding | nearest, 2 decimals | −0.0011 | **11.78** |

The same fresh world, selling **1 Bread to Wheatley** (the player starts with
two), returns **IB9.11**:

```text
10.00                         base
× (1 − 0.07) = 9.30           buy margin (7%, balanced)
× (1 − 0.015) = 9.1605        half-spread
× (1 + 0.25 × −0.0241)        rival pull toward the IB8.95 rival bid
= 9.1053 → IB9.11             rounding
```

Two more verified quotes show the personality and rival effects:

- **1 Pickaxe from Toolsmith** = **IB70.17**. Stock 5 vs target 6 lifts the
  price by +IB3.52; the premium preset turns the 22% margin into 33%
  (+IB17.00); the 1.6× spread adds +IB1.64; no rival sells pickaxes. Base IB48
  → IB70.17.
- **1 Cloth from Weaver** = **IB16.26** vs **IB18.10 from Broker**. Weaver's
  small low-stock lift and 14% margin put it at IB16.26 and Broker's ask pulls
  it up; Broker's 24.3% effective margin puts it at IB18.10 and Weaver's lower
  ask pulls it down. Same item, same day, different stall economics.

## Where to tune this (config only)

Every knob below lives in `src/config/economy.ts`. No execution-code edit is
needed: `pricing.ts` and the engine read these values at runtime, and
`npm run config:check` validates the result before anything starts.

| If you want to change… | Edit | Notes |
| --- | --- | --- |
| Base prices / clamp window | `items.<id>.baseValue` | Clamps move proportionally: `base × 0.35` to `base × 2.8`. |
| How hard stock moves price | `pricing.stock.elasticity`, `minFactor`, `maxFactor` | Elasticity 0 disables stock pressure; factors bound it. |
| How much recent demand matters | `pricing.demand.weight`, `emaAlpha`, `windowSeconds`, `maxPressure` | Demand only rises when the stall sells. |
| How cash-thin stalls quote | `pricing.cash.weight`, `bidWeight`, `askWeight`, `comfortMultiple`, `bankruptcyRatio` | `bankruptcyRatio` also moves the bankruptcy threshold. |
| Rival undercut strength | `pricing.rival.weight`, `maxAdjustment`, `maxRivals`, `rotationSeconds` | `maxRivals` 0 disables competition. |
| Spread | `pricing.spread.base`, `min`, `max` | Effective spread is base × personality `spreadMultiplier`. |
| Merchant personality | `personalities.<preset>.*`, then `merchants.<id>.personality` | Presets are data; add a new one without touching code. |
| A merchant's cash, reserve, goods | `merchants.<id>.cash`, `.reserve`, `.targetStock`, `.buys`, `.sells` | Starting cash must exceed reserve; validation enforces it. |
| Merchant margins | `merchants.<id>.margins.buy` / `.sell` | Sell must be greater than buy. |
| Restock speed / supply chain | `merchants.<id>.restockRate.*`, `.supplyChain.*` | Restock tops up toward `targetStock × targetRatio`. |
| Bankruptcy / recovery | `pricing.cash.bankruptcyRatio`, `cashRecovery.dailyRate`, `.targetReserveMultiple` | Recovery never applies to a bankrupt stall. |
| Rent and tax | `sinks.stallRent.*`, `sinks.salesTax.*` | `appliesTo` supports `merchant` or `player`. |
| Caravan cadence and goods | `caravan.intervalSeconds`, `.goods`, `.priceBias` | Bias `ask` 1.12 sells into town; `bid` 0.9 buys out of town. |
| Order board | `orders.*` (maxActive, cadenceDays, expiryDays, rewardMultiplier, templates, botParticipation) | Rewards are `baseValue × 1.15…1.55`. |
| Investment terms | `investments.profitShareRate`, `.minDistribution` | Distribution is capped by `cash − reserve`. |
| Tool wear / repair | `sinks.toolDurability.*` | Affects gathering, not prices. |
| The week story | `scenario` (`demoScenario` / `stableSandboxScenario`), `scenario.shocks`, `scenario.investor` | Shocks are validated and applied once by id. |
| Fast-forward length and ticks | `fastForward.days`, `.stepSeconds`, `.maxDays`, `.maxSteps`, `seedBehavior` | `durationSeconds` is the UI's advertised playback budget. |
| Bot liquidity | `bots.count`, `bots.behavior.*`, `bots.startingCash`, `.startingInventory` | Bots are the main source of order flow. |

After any edit:

```bash
npm run config:check                 # schema + cross-reference validation
npm test                             # unit, auth, production probes
npm run sim -- --days 7              # deterministic economy checkpoint
```

If a server world is already persisted, changing the config changes its
fingerprint; `EconomyService` resets an incompatible save on boot. To clear it
manually, run `npm run economy:reset` (`data/economy-world.json` by default).

## Verification checkpoint

`npm run sim -- --days 7` on the current config prints:

```text
Simulated 20,160 steps in about 3 s (15,443 events emitted)
Bankruptcies: 2   Investments: 1 (IB120.00)   Investment profit paid: IB40.85
Orders: 47 created, 415 deliveries, 415 units delivered for IB5,037.59
Caravan: 4,459 units sold into town (IB11,522.51), 7,012 units bought (IB18,457.24)
Sinks: rent IB900.00, tax IB1,211.25, repairs IB0.00, shocks IB676.30
End state: 7 of 8 stalls open; Weaver is closed for the player to reopen
```

The two bankruptcies are the two scripted shocks: Timberly's bulk timber
purchase on day 2 (rescued by the Guild Factor after six hours with IB120) and
Weaver's loom repair bill on day 5 (left closed for the player). Sable Voss and
Rook Kestrel both survive the week. The full cause/effect feed is printed by
the same command.
