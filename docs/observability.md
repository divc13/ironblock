# Ironblock observability — spectator API & dashboard

Read-only observability layer for the Ironblock market-town economy: a public
API, a `/spectator` dashboard, and a deterministic fast-forward demo. It never
changes economy rules, auth, contracts, or the game page.

Everything here is additive. The game keeps its `index.html` entry; the
observability layer only adds the `/api/market/*` routes, `spectator.html`, and
the `/spectator` dev/preview rewrite.

---

## 1. Mount points

### Vite host (this repository already does this)

`vite.config.ts`:

```ts
import { observabilityApiPlugin } from './src/server/observability'

export default defineConfig({
  plugins: [
    // ...existing plugins...
    observabilityApiPlugin(),
  ],
})
```

The plugin mounts itself for **dev** (`configureServer`), **preview**
(`configurePreviewServer`), and **build**:

- dev + preview: serves `<base>/api/market/*` and rewrites `<base>/spectator`
  → `<base>/spectator.html` (configurable via `spectatorPath`).
- build: keeps the existing game entry and adds `spectator.html` as a second
  HTML input. The RPGJS build writes it beside the game entry
  (`dist/client/spectator.html`); the production mount also checks
  `dist/spectator.html`.
- standalone browser entry: `spectatorStandalonePlugin()` runs after the RPGJS
  HTML transform and restores `src/spectator/main.ts` for the dashboard. The
  built page loads only its own `spectator-*.js`/`.css`, never the game
  `client-*.js` or `canvasengine-*.js`. The build fails if that regresses.

The dashboard includes a Townsfolk roster (names, archetypes and one-line
character beats) and the Market Tape labels each bot trade with its roster
name. This is presentation only; it reads the same sanitized public snapshot
as the rest of the dashboard.

Plugin options (`ObservabilityPluginOptions`):

```ts
observabilityApiPlugin({
  apiPath: '/api/market',        // full API mount path (env switch wins over default)
  spectatorPath: '/spectator',   // default
  rateLimit: { max: 6, windowMs: 60_000 },
  bodyLimit: 4096,               // POST body cap, bytes
  stream: { pollMs: 1000, snapshotEveryMs: 15_000 },
  economy: { /* StartEconomyOptions: save path, autosave */ },
})
```

The economy service starts lazily on the first observability request, so game
boot never waits on it.

### Plain Node / Express / any Connect-style server

Option A — bring your own economy source:

```ts
import { createObservabilityMiddleware } from './src/server/observability'
import { asObservabilitySource } from './src/server/observability'

const middleware = createObservabilityMiddleware({
  apiPath: '/api/market',
  getService: () => asObservabilitySource(liveEngine),
})

// Node:
http.createServer((req, res) => middleware(req, res, () => hostFallback(req, res)))
// Express:
app.use(middleware)
```

Option B — let the layer start its own economy service (production integration
point):

```ts
import { startObservability } from './src/server/observability'

const observability = await startObservability({ /* middleware options */ })
httpServer.on('request', observability.middleware)
// or app.use(observability.middleware)
// or viteServer.middlewares.use(observability.middleware)
```

`startObservability()` returns:

| field | purpose |
| --- | --- |
| `apiPath` | normalized mount path (env/config aware) |
| `middleware` | Connect/Express/`http.createServer` compatible handler |
| `plugin` | Vite plugin equivalent |
| `getService()` | lazily starts (once) and returns the live economy service |
| `getServiceOrNull()` | current service or `null` if not started |

Non-matching paths call `next()`, so the game, auth, and asset routes are
untouched. If you mount under a subpath, use the same base for the page and the
API (see the switch below).

### Single base-path switch (subpath deployments)

Server side — one environment variable (or `apiPath` option, which wins):

```sh
IRONBLOCK_OBSERVABILITY_API_PATH=/quest/api/market
```

The value is used verbatim (normalized to leading slash / no trailing slash).
When unset and the Vite plugin is in use, the API sits under the Vite base,
e.g. base `/quest/` → `/quest/api/market`.

Page side — the dashboard resolves the same base:

1. `window.IRONBLOCK_OBSERVABILITY_API_BASE` (set inline before the module
   loads; wins when present), else
2. Vite `BASE_URL` + `/api/market`.

So for a subpath deployment, either set
`IRONBLOCK_OBSERVABILITY_API_PATH=/quest/api/market` at build/serve time (the
page follows the Vite base automatically), or set both explicitly. One switch
moves the whole API.

---

## 2. Endpoints

All responses are `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`,
JSON unless noted. Public data only (see privacy below).

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/market/snapshot` | Sanitized `{ ok, serverTime, snapshot }`: summary, merchants, tape, daily series, item prices. No player ids. |
| GET | `/api/market/events?since=<seq>&limit=<n>` | `{ ok, cursor, events, count, totalAvailable, truncated, firstRetainedSequence }`. `since` is an exclusive sequence cursor; `limit` defaults 200, max 500. |
| GET | `/api/market/stream` | Server-Sent Events. Wire sequence: an opening comment, the standard `retry: 3000` field, an initial `snapshot` event, then `events` batches (1 s poll) and periodic `snapshot` refreshes (15 s) even while events are flowing; `: ping` comments keep the connection alive when idle. |
| GET | `/api/market/recap` | `{ ok, recap }`: newspaper-style headline, day, merchant standings, highlights — built from live public state. |
| GET | `/api/market/proof` | `{ ok, proof }`: recorded NEAR testnet deployment (contract, treasury, 13 tokens, 533,000 genesis units, explorer links, testnet-only note). **No live chain calls.** |
| POST | `/api/market/fast-forward` | Deterministic clone simulation. Body `{ "days": 7 }` (default 7, max 8; empty body = defaults). |

### Fast-forward behavior

- Runs a **throwaway clone**: `new EconomyEngine(config, { state: live.snapshot() })`.
  The live service is never advanced, reseeded, or persisted to. The response
  reports `live.unchanged`, `sequenceBefore`, `sequenceAfter`, `day`, and
  `time` so callers can verify this.
- Response: `{ ok, mode: 'deterministic-clone', days, startDay, endDay,
  fromTime, toTime, seed, finalSequence, series, summaries, priceHistory,
  events, annotations, recap, finalMerchants, timing: { cloneMs, simulateMs,
  totalMs, steps, days, eventCount }, live }`. `finalMerchants` is the sanitized
  week-end stall state used by the dashboard's final price and stock heatmaps.
- `priceHistory` is captured once at each simulated day close. Each entry is
  `{ day, endedAt, prices: { "merchantId:itemId": { bid, ask } } }`; asks and
  bids are sanitized market quotes only. Merchant and item keys are sorted
  deterministically, independent of snapshot key order. It is computed in the
  throwaway clone and is not added to live SSE snapshots or `/snapshot`. The
  dashboard uses every good at every close for its **Price paths** card,
  indexed to the first close.
- `annotations` are built server-side from real engine events (caravan
  arrivals, shocks, bankruptcies, reopens, distributions, recoveries, rent
  aggregates, day close) with causal-chain strings; the dashboard uses them for
  the ~7 s annotated playback (`playback.ts`) and the price-path markers. It
  does not invent events. Shock annotations come only from observed
  `system.shock` engine events. The engine also records every fired shock in an
  unsampled `shockEvents` list, so a shock dropped from the playback sample is
  still annotated once; the list is server-side evidence and is not included in
  the public response. There is no config-only fallback: a configured shock
  that already fired before the clone window, or was skipped, is not annotated.
- Deterministic: identical live state + identical `days` yield identical
  series/priceHistory/events/annotations (verified by tests).
- Measured on this machine: 7 days ≈ **20,160 steps**, **≈ 3 s** server
  compute; the client playback spreads the simulated week over about 7 s. The
  event count depends on the live state the clone starts from.
- The simulation runs synchronously. While the clone computes a seven-day run
  the Node event loop can be blocked for roughly 3 s, during which other
  requests may pause briefly. The live town is never mutated: the run only
  reads the source snapshot and works on a throwaway clone. Removing the pause
  would need an async/chunked engine or a separate Worker/queue; that
  refactor is not part of this release.
- Limits: body > 4096 bytes → `413 body_too_large`; malformed JSON /
  non-object → `400 invalid_json`; invalid `days` → `400 invalid_days`.
  Rate limit: **6 requests / 60 s per remote address** → `429 rate_limited`
  with `Retry-After`. The body-size check runs before the limiter; other POSTs
  count against the window (a rejected malformed body still consumes a token).
- `503 economy_unavailable` when the live economy service is not ready.

### Privacy boundary

The public feed never exposes player ids, session tokens, emails, or wallets.
Player actors are pseudonymized as `Traveler-XXXX` (stable 4-hex suffix per
player for the session); world-state `players` is stripped from snapshots.
Economy configuration items, merchant names, and aggregate balances are
public by design. `POST /fast-forward` responses apply the same sanitizer.

### Proof constants (testnet only)

- Contract: `v2.ironblock-items.testnet`
- Treasury: `v2.ironblock-treasury.testnet`
- 13 NEP-245 token types, 533,000 genesis supply units
- Explorer links derived from `https://explorer.testnet.near.org/accounts/`
- The endpoint is a recorded deployment record; it performs no RPC, no signing,
  and fakes no transactions. Env overrides: `IRONBLOCK_NEP245_CONTRACT_ID`,
  `IRONBLOCK_TREASURY_ACCOUNT_ID`, `IRONBLOCK_GENESIS_SUPPLY`.

---

## 3. Spectator dashboard

- URL: `<base>/spectator` in dev and preview (with the default base,
  `http://localhost:3000/spectator`); the build emits `spectator.html` for a
  static deployment. No RPGJS client bundle, no UI framework; vanilla TS + inline SVG
  charts.
- Sections: top bar (status, day, clock, connection + demo badge), week brief,
  section navigation, market tape, merchant cards, economy health, event stream
  with filters and keyboard-usable detail view, chart panels (cash, prices,
  all-good price paths, volume, town cash split, external flows, price/stock
  market map, liquidity × stock risk, per-stall cash attribution), fast-forward
  panel with annotated ~7 s playback (pause/step/skip), newspaper recap,
  on-chain proof panel. The preview is explicitly labelled **Preview only ·
  not saved**; the week runs on a throwaway clone, never advances the live
  town, and is never persisted.
- Week brief: a plain-language summary above the charts. In live mode it covers
  today so far (till cash, biggest price move, top/weakest till, riskiest stall,
  trade pace, two causal notes). In completed preview mode it covers the whole
  preview, labels merchant cash as **over preview**, and links each causal note
  to the matching story. **Copy brief** copies a Markdown version whose section
  links are built from the current dashboard URL, so they work in dev, preview
  and static production deployments.
- Navigation and annotations: the sticky **Jump to** bar links every major
  section. Completed previews add a **What moved the week** callout strip under
  the price paths; activating a callout moves the shared day cursor to the
  matching day and opens/focuses the causal story. Price markers are focusable
  buttons with accessible names and lead to the same story.
- Preview playback: the run strip can pause/resume, step one simulated day
  backward or forward, and skip to the end. With reduced motion the preview
  jumps straight to its completed state. Backward stepping rebuilds the mirrored
  merchant state exactly and replays the intervening events.
- Data semantics: weekly price buckets use calendar days (`dayOf(event.time) -
  startDay + 1`), not elapsed 24-hour windows from a mid-day `fromTime`. When
  the clone ends mid-day, the final partial day is a separate **Final** chart
  bucket and is never folded into D7. Merchant cards after a preview compare
  cash with the preview's opening tills, not the live day's opening tills. The
  newspaper recap is explicitly labelled **final partial day** when the clone
  stops mid-day, so it is not mistaken for a full-week summary.
- Activity: live mode shows **Session actions** recorded in this browser since
  the page opened. Preview mode shows **Preview sample**: sampled actions from
  the throwaway clone. In both cases the daily volume bars count every trade,
  and the activity panel has a table twin with each bot's trade, gather,
  delivery, total and last action.
- Cross-chart interaction: one canonical day cursor (`Open`, `Dn`, `Now`)
  follows the pointer or arrow keys across the price, price-path, cash, flow
  and volume charts. The cursor is a DOM overlay, so live SVG re-renders do not
  destroy it. Every chart has an exact-value table twin (`Show table`) built
  from the same view model as the chart; table scroll regions are keyboard
  focusable.
- Accessibility: focus-visible outlines, keyboard shortcuts, ARIA live/status
  regions, and `prefers-reduced-motion` handling (charts and playback respect
  it). Focus is restored after live re-renders and event selection for story
  rows, event rows, price days and causal markers. Touch targets grow to 44px
  on coarse pointers, and completed previews compact the mobile top bar. Layouts
  verified at 1440×900, 1280×720 and 390×844, with no horizontal overflow or
  console errors.
- Error handling: preview failures use plain language (“The preview could not
  run. Your live town is unchanged.”), keep the technical cause in a title
  tooltip, and leave the live dashboard usable.
- Demo fallback: if the live API is unavailable, the page labels itself
  **Replay / demo** and runs the same `runFastForwardClone` + sanitizers
  against a local engine in the browser. Demo data is never presented as live.

### Run the demo

```sh
npm install
npm run dev          # open http://localhost:3000/spectator
```

Production preview:

```sh
npm run build        # emits the game entry + spectator.html (dist/client here)
npx vite preview     # open http://localhost:3000/spectator
```

Checks:

```sh
npm test             # tsx --test test/*.test.ts
npm run config:check # economy config validation
```

---

## 4. Files the integration agent must mount

| File | Role |
| --- | --- |
| `src/server/observability/index.ts` | Public surface: `startObservability()`, re-exports |
| `src/server/observability/vite-plugin.ts` | **Vite mount**: `observabilityApiPlugin()` (dev/preview/API/build entry) |
| `src/server/observability/http.ts` | **Node/Express mount**: `createObservabilityMiddleware()` |
| `src/server/observability/handlers.ts` | Transport-independent router `handleObservabilityRequest()` |
| `src/server/observability/context.ts` | Base-path switch (`IRONBLOCK_OBSERVABILITY_API_PATH`), limiter, limits |
| `src/server/observability/source.ts` | `asObservabilitySource()` adapter for an existing `EconomyEngine`/service |
| `vite.config.ts` | Registers the plugin (single line, already present) |
| `spectator.html` + `src/spectator/*` | Dashboard page/assets consumed by the plugin's build entry |
| `docs/observability.md` | This document |

Integration contract summary: mount **one** of
`observabilityApiPlugin()` (Vite) or
`createObservabilityMiddleware({ getService })` (Node/Express), or use
`startObservability()` and mount its `middleware`. Keep `index.html` as the
game entry. Set `IRONBLOCK_OBSERVABILITY_API_PATH` only if the API must live
somewhere other than `<vite base>/api/market`.
