# Ironblock demo — 5–8 minute judge walkthrough

**One-line thesis:** A playable market town where NPC merchants price, go broke,
and recover in public — and every item can settle as a NEP-245 token on NEAR
testnet.

This walkthrough targets the integrated Phase 2 build: playable market square,
server-authoritative economy, `/spectator` dashboard, and the testnet NEP-245
settlement proof. It is **testnet only**; no real money is used or custodied.

> **Integration note:** `/spectator` and `/api/market/*` are part of the Phase 2
> integration. If this branch does not have that merge yet, the spectator route
> returns 404; the game, economy and on-chain proof below are unaffected. The
> exact route in the integrated build is `/spectator`.

## Run sheet

| Time | Scene | What the judge sees |
| --- | --- | --- |
| 0:00–1:00 | Setup and login | One Auth0 popup, no wallet or seed phrase |
| 1:00–2:30 | Scene 1 — market town | Gather, smelt, sell, buy bread; HUD cash and bag change |
| 2:30–3:15 | Scene 2 — price reasons | Tooltip causal trail; stock and demand move a quote |
| 3:15–5:00 | Scene 3 — seven days | 2 bankruptcies, 1 rescue investment, reopen, 415 order units |
| 5:00–7:00 | Scene 4 — spectator and proof | Live snapshot, events, recap, one real testnet transfer |
| 7:00–8:00 | Scene 5 — close | Thesis, what is real, honest limitations |

---

## Before you start

### Prerequisites

- A modern browser with popups allowed for the demo origin.
- Public demo: open **<https://ironblock.up.railway.app>**.
- Local fallback: **Node 22 or newer**, npm, `npm install`, and a `.env` copied
  from `.env.example` with `AUTH_MODE=auth0`, the `AUTH0_*`/`VITE_AUTH0_*` values,
  and a random **`NEAR_AUTH_SESSION_SECRET` of at least 32 characters**.
- `npm run dev`, then open **exactly** <http://localhost:3000>.
- Local `AUTH_MODE=near` remains available for NEAR Auth/MPC testing; it is not
  the public login path.

```bash
node --version          # v22 or newer
npm install
cp .env.example .env
# Set NEAR_AUTH_SESSION_SECRET, then set AUTH_MODE=auth0 and the Auth0 block.
# Generate a secret once with: openssl rand -base64 48
npm run dev
```

For local Auth0 login, add `http://localhost:3000` (and its trailing-slash
variant) to the Auth0 application’s callback URLs and web origins. For local
`near` mode, open <http://localhost:3000>, **not** `http://127.0.0.1:3000` and
not another port; the shared NEAR Auth testnet application only allows the exact
`http://localhost:3000` callback.

Optional preflight in a second terminal:

```bash
npm run config:check
```

### Login — one Auth0 popup, no wallet

1. The login overlay says **“Enter the market town”** and offers
   **“Continue with Google”** and **“Continue with email”**.
2. Choose **one** method and complete the Auth0 flow in the single popup.
3. There is **no wallet extension, seed phrase, wallet popup or gas prompt**.
   In public Auth0 mode the player supplies a NEAR payout address; it is only a
   withdrawal destination and is never used to sign. In local `near` mode the
   NEAR key is derived by the MPC network and the app never receives a private
   key.
4. After Auth0 returns, the overlay offers an optional **NEAR payout address**
   field. Enter a testnet account you control, or choose **“Skip for now”**.
   Withdrawals stay disabled until an address is set; it can also be set later
   from the withdrawal panel.
5. The overlay shows **“Session verified. Entering the town…”** and the game
   starts in place. There is no guest mode and no mock economy behind the login
   screen.

---

## Scene 1 — Market town: gather, smelt, sell, buy bread (≈90 s)

**What to point at first**

- The market square has eight merchant stalls, four resource areas and all
  eight named townsfolk. They are the same bots that fill the Market Wire: they
  wander the square, and when the live loop reports a gather, trade or order
  delivery they walk to the matching resource area, merchant stall or the Guild
  Orders board near the south gate. Nameplates travel above them. Movement is
  server-side, so every client sees the same positions. The authoritative
  engine still decides the economic outcome; the walk is a visual mirror of its
  events, not a second simulation. Fast-forward is not animated. The two newest
  stalls, Sable Voss (fixer) and Rook Kestrel (smuggler), sit on the bottom row.
  Talk to any townsperson for a one-line character beat.
- The HUD shows **Cash**, **Carry**, **Stamina**, **Day** and **Town**, plus
  **Bag (I)**, **Orders (O)**, **Townsfolk (T)**, **Week (F)** and **Recap (R)**.
- The **Market Wire** feed on the right records every trade and price move.
  The eight named townsfolk keep acting and moving on their own while you
  explore, so the feed fills without waiting for a player trade. Open
  **Townsfolk (T)** to meet Marlowe Vane, Calla Morn, Don Ottavio, Rhea Vance,
  Yuri Blaine, Trinity Vale, Bram Sol and Ines Calder.

**Gather 10×**

1. Walk to the **Iron Veins** in the top-left of the map. The prompt reads
   **“Gather Iron Vein”** with `4 stamina · requires pickaxe`.
2. Press **E**, **Space** or **Enter** to gather. Each gather takes 2.5 s and
   yields 1–3 **Iron Ore**.
3. Gather **10 times**. The four Iron Vein nodes respawn every 45 s; if the
   prompt reports depleted nodes, step away and return, or use the wait to open
   the price tooltip in Scene 2.
4. Open **Bag (I)** to confirm the ore count. You need at least **10 Iron Ore**.

**Smelt ingots**

1. In **Bag & Workshop**, scroll to **Workshop**.
2. Click **Craft Smelt Iron Ingot** five times. Each craft consumes
   **2 Iron Ore → 1 Iron Ingot**, costs 3 stamina, and takes 4 s.
3. The bag now shows **5 Iron Ingots** (or more if your gathers yielded extra).

**Sell to a merchant**

1. Walk to **Toolsmith** (stall 5, centre of the square). Toolsmith buys
   `iron_ingot`; Broker also buys it.
2. Press **E**, open the **“Sell to merchant”** tab, set **Iron Ingot** to
   quantity **5**, and click **Sell**.
3. Point out the HUD: **Cash rises**, **Carry falls**, and the toast plus
   **Market Wire** record the trade.

**Buy bread**

1. Walk to **Wheatley** (stall 2, top-centre) or **Broker** (stall 6).
2. Press **E**. Wheatley opens on **“Buy from Wheatley”**; choose **Bread**,
   quantity **1**, and click **Buy**.
3. Point out the HUD once more: **Cash falls**, **Carry rises**, and **Bag (I)**
   shows the bread. The player also starts with 2 bread, so the count is now 3.

**Say:** “Every action is authoritative server state: the HUD, the bag and the
Market Wire all change together. This is not a local animation.”

---

## Scene 2 — Why is that the price? (≈45 s)

1. Open **Wheatley** again and look at the **Unit price** cell for **Bread**.
2. Click the **`?`** next to the price. The tooltip is titled
   **“Price breakdown”**.
3. Read the summary, then the rows in order:
   - **Base value**
   - **Low stock** or **Excess stock** — `Stock X vs target Y`
   - **Recent demand** — `Demand EMA X units over 900s`
   - **Cash pressure** — `Cash X vs reserve Y`
   - **Sell margin**
   - **Market spread**
   - **Rival quotes**
   - **Price clamps** / **Price floor** / **Price ceiling**
   - **Rounding**

   Each row shows the input, the signed effect, and the running causal trail.

4. Buy **6–8 bread**. Close and reopen the merchant panel, then hover the
   **`?`** again. The quote should move: stock is lower and the demand EMA is
   higher. The **Low stock** and **Recent demand** rows now show the new
   pressure.
5. Click the bread purchase in **Market Wire**. The event panel shows
   **“Why the price moved”**, the before/after stock and cash, and the same
   reasons. This is the auditable trail, not a hand-written explanation.

If the price barely moves because of rounding, sell **10 Iron Ore to Ferro**:
its stock rises above target, and its next bid is visibly lower. The same
tooltip shows the **Excess stock** row.

**Say:** “The price is a pure function of stock, demand, cash, margin, spread,
rivals, clamps and rounding. The tooltip is the arithmetic, in order.”

---

## Scene 3 — Seven days in under a minute (≈105 s)

The town is already alive: the live NPC loop advances one in-game second per
real second, so bots are gathering, trading and delivering orders before you
press anything. Fast-forward compresses the next seven days into the same
deterministic engine.

**Run it**

1. Press **F** or click **Week**.
2. The panel is titled **“Fast-Forward the Week”** and notes
   **“Seven days in about 60s · 30s ticks”**.
3. Click **Run 7 days**. On the authoritative server the week is computed in
   about **3 seconds**; the playback and narration budget is **under one
   minute**.
4. When it completes, open **Recap (R)** to show the town newspaper summary.

**Canonical numbers (verified, fresh world)**

Run this in a second terminal for the reproducible checkpoint:

```bash
npm run sim -- --days 7
```

| Metric | Verified value |
| --- | --- |
| Simulation | 20,160 steps (about **3 s** on this machine) |
| Bankruptcies | **2** |
| Rescue investments | **1**, **IB120.00** by the Guild Factor |
| Orders delivered | **415 units** (47 orders created, IB5,037.59 paid) |
| End state | **7 of 8 stalls open**; Weaver is closed for the player |

**Narrate the story**

- **Day 2 — Timberly.** A speculative hardwood load: Timberly buys 53 Timber at
  IB8.50 each (IB450.50), leaving IB3.86 against a IB70.00 reserve. The stall
  goes bankrupt and closes. Six hours later the **Guild Factor invests
  IB120.00**, and Timberly **reopens**.
- **Day 5 — Weaver.** The loom repair bill consumes IB225.80, leaving IB0.00
  against a IB60.00 reserve. Weaver goes bankrupt and stays closed.
- **End of week.** Seven of eight stalls are open. Open Weaver’s merchant panel
  to show **“Reopen stall — IB120.00”** (the button shows the current required
  amount). If you click it, that is a **second, player-funded investment**;
  don’t count it in the recorded “1 investment” checkpoint.

**Say:** “This is the point of the demo: a shock, a bankruptcy, a rescue and a
reopen are all visible as events with causes — not a static balance sheet.”

The in-game run starts from the live world you have already traded in, so the
exact events can differ. The **canonical fresh-world checkpoint** is the
`npm run sim -- --days 7` output above; use the events the panel actually shows
when narrating the live run.

---

## Scene 4 — Spectator view and on-chain proof

**≈120 s.**

Open a new tab at the exact route:

- Public: **<https://ironblock.up.railway.app/spectator>**
- Local: **<http://localhost:3000/spectator>**

Wait for the top-bar badge to read **LIVE**. If it reads **DEMO REPLAY**, the
live API is unavailable and the page is running the same deterministic engine
locally — clearly labelled, but not live.

**Market snapshot, events, recap**

Point out these panels:

- **Economy health** and **Merchants** — day, clock, open/closed stalls, cash
  and personality.
- **Market tape — recent trades** — the latest units and prices.
- **Event stream — click an event for causes** — filter by type, merchant or
  item, then click an event to see its causes and before/after state.
- **Charts — price history & merchant cash**.
- **Town newspaper — recap** — headline, day, standings and highlights.
- **On-chain proof — NEP-245 testnet**.

The public feed pseudonymizes players as `Traveler-XXXX`; it does not expose
player ids, session tokens, emails or wallets.

**One real NEP-245 testnet proof**

The proof panel shows the recorded deployment: contract
`v2.ironblock-items.testnet`, treasury `v2.ironblock-treasury.testnet`, 13
tokens and 533,000 genesis units, with explorer links. The endpoint is a
recorded deployment record and makes no live RPC call; the transfer below is
the real testnet transaction to show separately.

| Field | Value |
| --- | --- |
| Transaction | [`5Xg9zyWN4P4eNpmfMtZtSAgzx5gi3VST4AVtrADjroRs`](https://explorer.testnet.near.org/transactions/5Xg9zyWN4P4eNpmfMtZtSAgzx5gi3VST4AVtrADjroRs) |
| Status | `FINAL` |
| Contract | `v2.ironblock-items.testnet` |
| Treasury / sender | `v2.ironblock-treasury.testnet` |
| Transfer | **1 `iron_ore`** |
| Receiver | Smoke-test implicit account `e3136895bba334fab6758465c6f6cccf095ea7af4c552418a598a988ddea67d9` |
| Memo | `ironblock withdraw smoke-mw1wr1as` |
| Explorer | <https://explorer.testnet.near.org/transactions/5Xg9zyWN4P4eNpmfMtZtSAgzx5gi3VST4AVtrADjroRs> |

A testnet RPC check at documentation time also showed the treasury’s
`iron_ore` balance at **99,999** and the receiver’s at **1**.

**Warnings to say out loud**

- **Testnet only.** These are testnet NEP-245 tokens, not real assets.
- **Treasury-mediated.** The server signs `mt_transfer` from the treasury; the
  player never signs a transaction or pays gas.
- **The receiver is the logged-in player’s saved payout account** for a live
  withdrawal. In public Auth0 mode it is player-supplied and optional until set;
  in local `near` mode it is the MPC-derived implicit account. A client cannot
  request a different receiver. The recorded proof above went to a fresh
  smoke-test implicit account, not to a player.
- This phase has **no deposits, no burn, and no player-signed transfers**.

---

## Scene 5 — Close (≈60 s)

**Thesis:** “Ironblock makes an NPC economy legible: every price has a causal
trail, every shock leaves an event, and every item can settle on NEAR testnet.”

| Real | Simulated / honest limitation |
| --- | --- |
| Public Auth0 Google/email login; optional local NEAR Auth/MPC path. No wallet or seed phrase in the public path. | The market, merchants, bankruptcies, rescue, orders and caravan are a deterministic simulation, not real-world market data. |
| NEP-245 v2 contract deployed at `v2.ironblock-items.testnet`; the recorded transfer is a real testnet transaction. | IB is in-game currency. In-game balances are off-chain claims backed by treasury inventory; no real money is custodied. |
| Server-authoritative economy and a read-only spectator API. | Auth sessions, revocation and rate limits are in memory; run one process. A restart clears sessions. |
| The spectator can show the live server state. | If the API is unavailable it labels itself **DEMO REPLAY** and runs locally; that is not live data. |
| The price tooltip is the actual pricing pipeline. | Settlement is testnet-only, treasury-mediated, with no deposits, burn or player-signed transfers. |
| The proof transaction is `FINAL` on testnet. | Public login requires the deployment Auth0 tenant to allow the deployment origin. The player-supplied payout address is a withdrawal destination, not a verified NEAR identity. |

**Close:** “That’s Ironblock: a small town where the economy is playable,
observable, and honest about what is simulated.”

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The login overlay stays open after the Auth0 popup. | The popup was blocked, closed early, or the server rejected the ID token. | Allow popups for the demo origin, complete one Google/email flow, and check the browser console plus `/api/auth/health`. |
| Auth0 says the callback URL is wrong. | The origin is not in the Auth0 application’s allowed callback list. | Add the exact public origin or `http://localhost:3000` (and trailing-slash variants) to **Allowed Callback URLs** and **Allowed Web Origins**. |
| The game does not start after login. | The server-issued game session could not connect to the WebSocket. | Check `/api/auth/health` mode, then reload once. Sessions are in memory, so a server restart invalidates them. |
| “Set a NEAR payout address” blocks withdrawal. | Public Auth0 login does not create a NEAR identity; the payout address is player-supplied. | Set a testnet account in the withdrawal panel, then retry. The address is a payout destination, not a login credential. |
| Storage-disabled browsers return to login. | The game session cannot be cached or restored. | Use a normal window and allow site storage; private/embedded webviews may not work. |
| Dev server exits because port 3000 is in use. | Vite uses `strictPort: true`; the local Auth0 callback uses port 3000. | `lsof -nP -iTCP:3000 -sTCP:LISTEN`, stop the other process, rerun `npm run dev`. Do not switch ports. |
| `NEAR_AUTH_SESSION_SECRET` is missing. | Development can use an ephemeral secret; production cannot. | Set a random 32+ character value in `.env`. In dev, sessions reset on restart until you do. |
| `/spectator` is 404 or shows **DEMO REPLAY**. | The observability integration is not mounted, or the live API is down. | Use the integrated Phase 2 build and check `/api/market/snapshot`; for the judge path, use the **LIVE** dashboard. |
| Fast-forward numbers differ from this page. | The live world already includes your trades; the checkpoint is a fresh world. | Use the events shown, and quote `npm run sim -- --days 7` for the canonical 2/1/415/≈3 s numbers. |

All numbers in this walkthrough come from `src/config/economy.ts`,
`contracts/nep245/deployments/testnet.json`, `npm run sim -- --days 7`, or a
testnet RPC lookup. Nothing here is an invented metric.
