import './styles.css'
import { characters } from '../config/characters'
import type {
  FastForwardClonePayload,
  ProofPayload,
  PublicSnapshot,
  PublicTrade,
  Recap,
  RecapMerchantStanding,
  SequencedMarketEvent,
} from '../server/observability'
import {
  buildPlayerAliases,
  buildProofPayload,
  buildRecap,
  buildTape,
  explorerUrlFor,
} from '../server/observability'
import type { EconomyConfig, ItemId, MarketEventType, MerchantId } from '../shared/types'
import { createFeed, type MarketFeed, type MarketStreamMessage } from './api'
import { FastForwardPlayback, type PlaybackItem, type PlaybackProgress } from './playback'
import {
  legendHtml,
  merchantCashSeries,
  renderLineChart,
  renderSparkline,
  seriesColor,
  type Point,
} from './charts'

/* ------------------------------------------------------------------ state */

const NO_ALIASES = buildPlayerAliases({})
const EVENT_BUFFER_LIMIT = 600

let feed: MarketFeed | null = null
let config: EconomyConfig | null = null
let snapshot: PublicSnapshot | null = null
let proof: ProofPayload | null = null
let demoNotice: string | null = null
let eventBuffer: SequencedMarketEvent[] = []
const eventIds = new Set<string>()
const priceHistory = new Map<string, Point[]>()
let mirroringRecap: Recap | null = null
let selectedEventId: string | null = null
let selectedPriceItem: ItemId | null = null
const priceItemFilter = { text: '' }
const filters = { group: 'all', merchant: 'all', item: '' }
let playbackState: {
  playback: FastForwardPlayback
  summaryByDay: Map<number, number>
  mirror: Map<MerchantId, { cash?: number; stock?: Record<string, number>; open?: boolean; bankrupt?: boolean }>
} | null = null
let lastFastForward: FastForwardClonePayload | null = null
let runningRequest = false

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`missing element #${id}`)
  return element as T
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const money = (value: number): string =>
  `${config?.currency.symbol ?? 'IB'} ${(Number.isFinite(value) ? value : 0).toFixed(2)}`

const dayOf = (time: number): number => Math.floor(time / 86400) + 1

const timeLabel = (time: number): string => {
  const seconds = ((time % 86400) + 86400) % 86400
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

const itemLabel = (itemId: string | null): string =>
  itemId ? config?.items[itemId]?.displayName ?? itemId : '—'

const itemNameById = new Map<string, string>()
const rebuildItemNames = (): void => {
  itemNameById.clear()
  if (!config) return
  for (const item of Object.values(config.items)) {
    itemNameById.set(item.id.toLowerCase(), item.id)
    itemNameById.set(item.displayName.toLowerCase(), item.id)
  }
}

/* ------------------------------------------------------------------ panels */

const PANEL_ORDER = {
  health: 'economy-health',
  merchants: 'merchant-cards',
  townsfolk: 'townsfolk-panel',
  tape: 'market-tape',
  stream: 'event-stream-panel',
  charts: 'charts-panel',
  ff: 'ff-panel',
  recap: 'recap-panel',
  proof: 'proof-panel',
}

const panel = (
  id: string,
  title: string,
  bodyHtml: string,
  headerExtra = '',
  bodyClass = 'body',
): string => `
  <section class="panel" id="${id}" aria-label="${esc(title)}">
    <header><h2>${esc(title)}</h2>${headerExtra}</header>
    <div class="${bodyClass}" id="${id}-body">${bodyHtml}</div>
  </section>`

function buildPanels(): void {
  const left = $('col-left')
  const main = $('col-main')
  const right = $('col-right')

  left.innerHTML = [
    panel(
      PANEL_ORDER.health,
      'Economy health',
      `<div class="stat-grid" id="health-grid"><p class="loading-note">loading…</p></div>`,
    ),
    panel(
      PANEL_ORDER.merchants,
      'Merchants',
      `<div class="merchant-grid" id="merchant-grid"><p class="loading-note">loading…</p></div>`,
    ),
    panel(
      PANEL_ORDER.townsfolk,
      'Townsfolk',
      `<div class="townsfolk-grid" id="townsfolk-grid"><p class="loading-note">loading…</p></div>`,
    ),
  ].join('')

  main.innerHTML = [
    panel(
      PANEL_ORDER.tape,
      'Market tape — recent trades',
      `<ul class="tape-list" id="tape-list"><p class="loading-note">loading…</p></ul>`,
    ),
    panel(
      PANEL_ORDER.stream,
      'Event stream — click an event for causes',
      '',
      `<div class="filterbar" style="border-bottom:none;padding:8px 12px">
        <label class="visually-hidden" for="filter-group">filter by type</label>
        <select id="filter-group">
          <option value="all">all types</option>
          <option value="trades">trades</option>
          <option value="merchants">merchants</option>
          <option value="sinks">sinks & rent</option>
          <option value="caravan">caravan</option>
          <option value="orders">orders</option>
          <option value="system">system</option>
        </select>
        <label class="visually-hidden" for="filter-merchant">filter by merchant</label>
        <select id="filter-merchant"><option value="all">all merchants</option></select>
        <label class="visually-hidden" for="filter-item">filter by item</label>
        <input id="filter-item" type="text" placeholder="item…" spellcheck="false" />
      </div>`,
      'events-wrapper',
    ),
    panel(
      PANEL_ORDER.charts,
      'Charts — price history & merchant cash',
      `<div class="chart-body" id="price-chart"></div><div class="chart-legend" id="price-legend"></div>
       <div class="chart-body" style="margin-top:10px" id="cash-chart"></div><div class="chart-legend" id="cash-legend"></div>`,
      `<label class="visually-hidden" for="price-item">price chart item</label>
       <select id="price-item" class="filterbar-select"></select>`,
    ),
  ].join('')

  right.innerHTML = [
    panel(
      PANEL_ORDER.ff,
      'Fast-forward — simulate 7 days',
      `<div class="ff-controls">
        <button class="btn primary" id="ff-run" type="button">▶ Simulate 7 days</button>
        <button class="btn" id="ff-toggle" type="button" disabled>⏸</button>
        <button class="btn" id="ff-step" type="button" disabled>Step</button>
        <button class="btn" id="ff-skip" type="button" disabled>⏭ Skip to end</button>
        <label class="visually-hidden" for="ff-speed">playback speed</label>
        <select id="ff-speed" disabled>
          <option value="1">1×</option>
          <option value="2">2×</option>
          <option value="4">4×</option>
        </select>
      </div>
      <div class="progress" id="ff-progress-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="simulated week progress"><span id="ff-progress"></span></div>
      <div class="progress-label"><span id="ff-progress-left">idle</span><span id="ff-progress-right">&nbsp;</span></div>
      <p class="ff-status" id="ff-status" aria-live="polite">Runs a deterministic 7-day clone; the live world is untouched.</p>
      <div class="annotation" id="ff-annotation" hidden></div>
      <ul class="ff-feed" id="ff-feed" aria-live="off"></ul>`,
    ),
    panel(
      PANEL_ORDER.recap,
      'Town newspaper — recap',
      `<div class="newspaper" id="newspaper"><p class="loading-note">loading…</p></div>`,
    ),
    panel(
      PANEL_ORDER.proof,
      'On-chain proof — NEP-245 testnet',
      `<p class="loading-note">loading…</p>`,
    ),
  ].join('')

  wireStaticEvents()
}

function wireStaticEvents(): void {
  $('filter-group').addEventListener('change', event => {
    filters.group = (event.target as HTMLSelectElement).value
    renderEventStream()
  })
  $('filter-merchant').addEventListener('change', event => {
    filters.merchant = (event.target as HTMLSelectElement).value
    renderEventStream()
  })
  $('filter-item').addEventListener('input', event => {
    filters.item = (event.target as HTMLInputElement).value.trim().toLowerCase()
    renderEventStream()
  })
  $('price-item').addEventListener('change', event => {
    selectedPriceItem = (event.target as HTMLSelectElement).value || null
    renderCharts()
  })
  $('ff-run').addEventListener('click', () => {
    void startFastForward()
  })
  $('ff-toggle').addEventListener('click', toggleFastForward)
  $('ff-step').addEventListener('click', () => playbackState?.playback.step())
  $('ff-skip').addEventListener('click', () => playbackState?.playback.skipToEnd())
  $('ff-speed').addEventListener('change', event => {
    playbackState?.playback.setSpeed(Number((event.target as HTMLSelectElement).value) || 1)
  })
}

/* ------------------------------------------------------------------ boot */

void boot()

async function boot(): Promise<void> {
  buildPanels()
  const created = await createFeed()
  feed = created.feed
  demoNotice = created.fallbackReason ?? null
  config = feed.config
  rebuildItemNames()
  renderModeBadge()

  const unsubscribe = feed.subscribe(onStreamMessage)
  window.addEventListener('beforeunload', unsubscribe)

  try {
    proof = await feed.proof()
    renderProof()
  } catch {
    proof = buildProofPayload(config, {})
    renderProof()
  }

  try {
    snapshot = await feed.getSnapshot()
    seedPriceHistory()
    renderAll()
  } catch (cause) {
    $('seq-chip').textContent = `snapshot error: ${(cause as Error).message}`
  }
}

function onStreamMessage(message: MarketStreamMessage): void {
  if (message.kind === 'snapshot' && message.snapshot) {
    snapshot = message.snapshot
    seedPriceHistory()
    renderAll()
    return
  }
  if (message.kind === 'events' && message.events?.length) {
    mergeEvents(message.events)
    updatePriceHistoryFromEvents(message.events)
    renderTape()
    renderEventStream()
    renderCharts()
    renderClock()
  }
}

function mergeEvents(events: SequencedMarketEvent[]): void {
  for (const event of events) {
    if (eventIds.has(event.id)) continue
    eventIds.add(event.id)
    eventBuffer.push(event)
  }
  if (eventBuffer.length > EVENT_BUFFER_LIMIT) {
    const overflow = eventBuffer.length - EVENT_BUFFER_LIMIT
    for (const removed of eventBuffer.splice(0, overflow)) eventIds.delete(removed.id)
  }
  eventBuffer.sort((left, right) => left.sequence - right.sequence)
}

/* ------------------------------------------------------------------ price history */

function seedPriceHistory(): void {
  if (!snapshot) return
  for (const merchant of snapshot.merchants) {
    for (const [itemId, ask] of Object.entries(merchant.askPrices)) {
      pushPricePoint(merchant.id, itemId, snapshot.time, ask)
    }
  }
}

function pushPricePoint(merchantId: string, itemId: string, time: number, price: number): void {
  const key = `${merchantId}|${itemId}`
  const series = priceHistory.get(key) ?? []
  const last = series[series.length - 1]
  if (last && last.x === time) {
    series[series.length - 1] = { x: time, y: price }
  } else {
    series.push({ x: time, y: price })
  }
  if (series.length > 420) series.splice(0, series.length - 420)
  priceHistory.set(key, series)
}

function updatePriceHistoryFromEvents(events: SequencedMarketEvent[]): void {
  for (const event of events) {
    if (event.type !== 'trade.buy' && event.type !== 'trade.sell' && event.type !== 'bot.trade') continue
    const merchant = merchantOfEvent(event)
    if (!merchant) continue
    if (event.after.ask !== null && event.item) {
      pushPricePoint(merchant, event.item, event.time, event.after.ask)
    }
  }
}

function merchantOfEvent(event: SequencedMarketEvent): MerchantId | null {
  if (!config) return null
  const tape = buildTape([event], NO_ALIASES, config)
  return tape[0]?.merchantId ?? null
}

/* ------------------------------------------------------------------ renderers */

function renderAll(): void {
  if (!snapshot || !config) return
  renderModeBadge()
  renderClock()
  renderEventDeltaTime()
  renderHealth()
  renderMerchants()
  renderTownsfolk()
  renderTape()
  renderEventStream()
  renderCharts()
  renderNewspaper(mirroringRecap ?? buildRecap(snapshot, config), mirroringRecap !== null)
  renderProof()
}

function renderModeBadge(): void {
  if (!feed) return
  const badge = $('mode-badge')
  badge.classList.toggle('demo', feed.mode === 'demo')
  $('mode-text').textContent = feed.mode === 'live' ? 'LIVE' : 'DEMO REPLAY'
  if (demoNotice) {
    badge.title = demoNotice
    $('ff-status').textContent = demoNotice
  }
  if (feed.mode === 'demo') {
    badge.setAttribute('aria-label', 'Demo replay: deterministic local simulation, not a live service')
  } else {
    badge.setAttribute('aria-label', 'Live: connected to the running economy service')
  }
}

function renderClock(): void {
  if (!snapshot) return
  $('clock-chip').textContent = `day ${snapshot.day} (day ${snapshot.day} · ${timeLabel(snapshot.time)})`.replace(
    `day ${snapshot.day} (day ${snapshot.day}`,
    `day ${snapshot.day} (${timeLabel(snapshot.time)}`,
  )
  $('seq-chip').textContent = `events ${snapshot.sequence}`
}

function renderEventDeltaTime(): void {
  // The live/pause indicator reflects whether the SSE feed is delivering.
  if (!feed) return
  const chip = $('clock-chip')
  chip.classList.toggle('paused', feed.mode === 'demo')
}

function renderHealth(): void {
  if (!snapshot) return
  const stats = snapshot.stats
  const cash =
    snapshot.merchants.reduce((sum, merchant) => sum + merchant.cash, 0) +
    snapshot.travelers.totalCash +
    snapshot.bots.totalCash
  const inventoryValue = snapshot.merchants.reduce(
    (total, merchant) =>
      total +
      Object.entries(merchant.stock).reduce(
        (sum, [itemId, quantity]) =>
          sum + Math.max(0, quantity) * (config?.items[itemId]?.baseValue ?? 0),
        0,
      ),
    0,
  )
  const openOrders = snapshot.orders.filter(order => order.status === 'open').length
  const acceptedOrders = snapshot.orders.filter(order => order.status === 'accepted').length
  const activeInvestments = snapshot.investments.filter(investment => investment.status === 'active').length

  const tiles: { label: string; value: string; sub: string }[] = [
    {
      label: 'cash in circulation',
      value: money(cash),
      sub: `${snapshot.merchants.length} stalls · ${snapshot.bots.count} townsfolk · ${snapshot.travelers.count} travelers`,
    },
    { label: 'inventory value', value: money(inventoryValue), sub: 'merchants only, at base value' },
    { label: 'sinks today', value: money(snapshot.daily.sinks.total), sub: `all-time ${money(stats.sinks.total)}` },
    {
      label: 'caravan arrivals',
      value: `${stats.caravanArrivals}`,
      sub: `today ${snapshot.daily.caravan.arrivals} · next day ${dayOf(snapshot.caravan.nextArrivalAt)}`,
    },
    {
      label: 'bankruptcies',
      value: `${stats.bankruptcies}`,
      sub: snapshot.daily.bankruptcies.length > 0 ? `today: ${snapshot.daily.bankruptcies.join(', ')}` : 'none today',
    },
    {
      label: 'orders',
      value: `${openOrders} open`,
      sub: `${acceptedOrders} accepted · ${stats.orderUnits} delivered (${money(stats.orderPayouts)})`,
    },
    {
      label: 'investments',
      value: `${activeInvestments} active`,
      sub: `${stats.investments} total · ${money(stats.investmentAmount)}`,
    },
    {
      label: 'townsfolk trades',
      value: `${stats.botTrades}`,
      sub: `player trades ${stats.totalBuys + stats.totalSells} units`,
    },
  ]
  $('health-grid').innerHTML = tiles
    .map(
      tile => `<div class="stat"><div class="label">${esc(tile.label)}</div><div class="value">${esc(tile.value)}</div><div class="sub">${esc(tile.sub)}</div></div>`,
    )
    .join('')
}

function merchantColors(): Map<MerchantId, string> {
  const map = new Map<MerchantId, string>()
  if (!snapshot) return map
  const ids = snapshot.merchants.map(merchant => merchant.id).sort()
  ids.forEach((id, index) => map.set(id, seriesColor(id, index)))
  return map
}

function renderMerchants(): void {
  if (!snapshot || !config) return
  const cfg = config
  const colors = merchantColors()
  const currentDayStart = snapshot.daily.merchantCashStart
  const cards = snapshot.merchants.map(merchant => {
    const mirror = playbackState?.mirror.get(merchant.id)
    const cash = mirror?.cash ?? merchant.cash
    const stock = mirror?.stock ?? merchant.stock
    const bankrupt = mirror?.bankrupt ?? merchant.bankrupt
    const open = mirror?.open ?? merchant.open
    const state = bankrupt ? 'closed' : open ? 'open' : 'closed'

    const reserveRatio = Math.max(0, Math.min(1, cash / Math.max(1e-6, merchant.reserve * 1.8)))
    const barClass = reserveRatio < 0.5 ? 'mbar low' : 'mbar'

    const sells = cfg.merchants[merchant.id]?.sells ?? []
    const keyItem = sells[0]
    const quotes = []
    if (keyItem) {
      const ask = merchant.askPrices[keyItem]
      const bid = merchant.bidPrices[keyItem] ?? Object.values(merchant.bidPrices)[0]
      if (ask !== undefined) quotes.push(`<span class="quote-chip"><span class="q">${esc(itemLabel(keyItem))}</span> ask <b>${money(ask)}</b></span>`)
      if (bid !== undefined) quotes.push(`<span class="quote-chip"><span class="q">bid</span> <b>${money(bid)}</b></span>`)
    }

    const sparkKey = keyItem ? priceHistory.get(`${merchant.id}|${keyItem}`) : undefined
    const spark = sparkKey
      ? renderSparkline(sparkKey, { color: colors.get(merchant.id) })
      : ''
    const stockSummary = Object.entries(stock)
      .filter(([, quantity]) => quantity > 0)
      .slice(0, 3)
      .map(([itemId, quantity]) => `${quantity} ${itemLabel(itemId)}`)
      .join(' · ')
    const dayChange = cash - (currentDayStart[merchant.id] ?? cash)

    return `<div class="mcard ${state === 'closed' ? 'closed' : ''}" data-merchant="${esc(merchant.id)}">
      <div class="mhead">
        <span class="mname">${esc(merchant.displayName)}</span>
        <span class="mtag">${esc(merchant.personality)}</span>
        <span class="mstate ${state}">${bankrupt ? 'bankrupt' : open ? 'open' : 'closed'}</span>
      </div>
      <div class="cashline"><span>cash</span><span>${money(cash)} <span style="color:${dayChange >= 0 ? 'var(--gain)' : 'var(--loss)'}">${dayChange >= 0 ? '▲' : '▼'}${Math.abs(dayChange).toFixed(2)}</span></span></div>
      <div class="${barClass}"><span style="width:${(reserveRatio * 100).toFixed(0)}%"></span></div>
      <div class="cashline"><span>reserve ${money(merchant.reserve)}</span><span>target <span style="color:var(--text-faint)">${Object.entries(merchant.targetStock).reduce((sum, [, target]) => sum + target, 0)} u</span></span></div>
      <div class="quotes">${quotes.join('')}</div>
      ${spark}
      <div class="stockline">stock: ${esc(stockSummary || '—')}</div>
    </div>`
  })
  $('merchant-grid').innerHTML = cards.join('')
}

function renderTownsfolk(): void {
  if (!snapshot) return
  const grid = document.getElementById('townsfolk-grid')
  if (!grid) return
  grid.innerHTML = characters
    .map(
      character => `<div class="tfolk" data-character="${esc(character.id)}">
        <div class="tfolk-head">
          <span class="tfolk-name">${esc(character.displayName)}</span>
          <span class="tfolk-role">${esc(character.archetype)}</span>
        </div>
        <p class="tfolk-line">${esc(character.line)}</p>
      </div>`,
    )
    .join('')
}

function renderTape(): void {
  if (!snapshot || !config) return
  const list = $('tape-list')
  const tape = buildTape(eventBuffer, NO_ALIASES, config)
  const rows = tape.length > 0 ? tape : snapshot.tape
  if (rows.length === 0) {
    list.innerHTML = '<p class="loading-note">no trades yet this session.</p>'
    return
  }
  list.innerHTML = rows
    .slice(0, 24)
    .map(
      trade => `<li><button class="tape-row" type="button" data-event="${esc(trade.eventId)}">
        <span class="t">d${dayOf(trade.time)} ${timeLabel(trade.time)}</span>
        <span class="side-badge ${trade.side}">${trade.side === 'buy' ? 'BUY' : 'SELL'}</span>
        <span class="desc"><span class="who">${esc(trade.traderName)}</span> <span class="qty">${trade.quantity}×</span> ${esc(itemLabel(trade.item))} <span class="merchant">@ ${esc(trade.merchantName ?? '?')}</span>${trade.reason ? ` <span class="reason">— ${esc(trade.reason)}</span>` : ''}</span>
        <span class="price"><b>${money(trade.unitPrice)}</b>/u</span>
      </button></li>`,
    )
    .join('')
  wireTapeRows()
}

function wireTapeRows(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#tape-list .tape-row')) {
    button.addEventListener('click', () => {
      selectedEventId = button.dataset.event ?? null
      renderEventStream(true)
    })  }
}

const EVENT_GROUPS: Record<string, MarketEventType[]> = {
  trades: ['trade.buy', 'trade.sell', 'bot.trade'],
  merchants: ['merchant.restock', 'merchant.bankrupt', 'merchant.investment', 'merchant.price', 'merchant.reopen', 'merchant.recovery', 'merchant.distribution'],
  sinks: ['sink.rent', 'sink.tax', 'player.repair'],
  caravan: ['caravan.arrival'],
  orders: ['order.created', 'order.accepted', 'order.fulfilled', 'order.expired'],
  system: ['player.join', 'player.use', 'player.craft', 'player.gather', 'bot.gather', 'system.fast-forward', 'system.configuration'],
}

function eventVisible(event: SequencedMarketEvent): boolean {
  if (filters.group !== 'all') {
    const group = EVENT_GROUPS[filters.group] ?? []
    if (!group.includes(event.type)) return false
  }
  if (filters.merchant !== 'all') {
    const merchantName = config?.merchants[filters.merchant]?.displayName ?? ''
    if (!event.message.includes(merchantName)) return false
  }
  if (filters.item) {
    const haystack = `${event.item ?? ''} ${itemLabel(event.item)}`.toLowerCase()
    if (!haystack.includes(filters.item)) return false
  }
  return true
}

function renderEventStream(scrollToSelected = false): void {
  if (!snapshot) return
  const list = document.getElementById('event-list')
  const wrapper = document.querySelector('.events-wrapper')
  if (!wrapper) return
  const events = eventBuffer.filter(eventVisible).slice(-200).reverse()

  const merchantSelect = $('filter-merchant') as HTMLSelectElement
  if (!snapshot || merchantSelect.options.length <= 1) {
    const options = snapshot.merchants
      .map(merchant => `<option value="${esc(merchant.id)}">${esc(merchant.displayName)}</option>`)
      .join('')
    merchantSelect.innerHTML = `<option value="all">all merchants</option>${options}`
  }

  if (!list) {
    const newList = document.createElement('ul')
    newList.id = 'event-list'
    newList.className = 'event-list'
    wrapper.appendChild(newList)
  }
  renderEventList(document.getElementById('event-list') as HTMLUListElement, events, scrollToSelected)
}

function renderEventList(list: HTMLUListElement, events: SequencedMarketEvent[], scrollToSelected: boolean): void {
  if (!config) return
  list.className = 'event-list'
  list.innerHTML = events
    .map(event => {
      const annotated = isAnnotatedType(event.type)
      const selected = event.id === selectedEventId
      return `<li><button class="event-row ${selected ? 'selected' : ''} ${annotated ? 'annotated' : ''}" type="button" data-event="${esc(event.id)}">
        <span class="t">d${dayOf(event.time)} ${timeLabel(event.time)}</span>
        <span class="etype">${esc(event.type)}</span>
        <span class="emsg">${esc(publicMessage(event))}</span>
      </button></li>`
    })
    .join('')

  for (const button of list.querySelectorAll<HTMLButtonElement>('.event-row')) {
    button.addEventListener('click', () => {
      selectedEventId = button.dataset.event ?? null
      renderEventList(list, events, false)
    })
  }

  const previousDetail = document.querySelector('.event-detail')
  if (previousDetail) previousDetail.remove()
  const chosen = events.find(event => event.id === selectedEventId)
  if (chosen) {
    const detail = document.createElement('div')
    detail.className = 'event-detail'
    detail.innerHTML = eventDetailHtml(chosen)
    list.after(detail)
    if (scrollToSelected) detail.scrollIntoView({ block: 'nearest' })
  }
}

function publicMessage(event: SequencedMarketEvent): string {
  return event.message
}

const ANNOTATED_TYPES = new Set<MarketEventType>([
  'merchant.bankrupt',
  'merchant.reopen',
  'merchant.distribution',
  'merchant.recovery',
  'caravan.arrival',
  'sink.rent',
  'order.expired',
])

const isAnnotatedType = (type: MarketEventType): boolean => ANNOTATED_TYPES.has(type)

function eventDetailHtml(event: SequencedMarketEvent): string {
  const snapRow = (label: string, before: number | null, after: number | null): string =>
    `<tr><th>${esc(label)}</th><td>${before === null ? '—' : before.toFixed(2)}</td><td>${after === null ? '—' : after.toFixed(2)}</td></tr>`
  const reasons = event.reasons
    .map(
      reason =>
        `<li><b>${esc(reason.label)}</b> ≈ ${esc(reason.value.toFixed(2))}${
          Number.isFinite(reason.effect) && reason.effect !== 0
            ? ` (<span class="${reason.effect > 0 ? 'up' : 'down'}">${reason.effect > 0 ? '+' : ''}${reason.effect.toFixed(2)}</span>)`
            : ''
        }${reason.detail ? ` — ${esc(reason.detail)}` : ''}</li>`,
    )
    .join('')
  return `<h3>${esc(event.type)} · d${dayOf(event.time)} ${timeLabel(event.time)} · seq ${event.sequence}</h3>
    <table>
      <tr><th>field</th><th>before</th><th>after</th></tr>
      ${snapRow('stock', event.before.stock, event.after.stock)}
      ${snapRow('cash', event.before.cash, event.after.cash)}
      ${snapRow('bid', event.before.bid, event.after.bid)}
      ${snapRow('ask', event.before.ask, event.after.ask)}
    </table>
    <ul class="reasons">${reasons || '<li>no decomposition recorded</li>'}</ul>
    <p style="margin:8px 0 0;font-size:12px;color:var(--text-faint)">${esc(event.message)}</p>`
}

function renderCharts(): void {
  if (!snapshot || !config) return

  // Price chart: per-merchant ask series for the selected item.
  const itemSelect = $('price-item') as HTMLSelectElement
  const tradeable = new Set<ItemId>()
  for (const merchant of snapshot.merchants) {
    for (const itemId of Object.keys(merchant.askPrices)) tradeable.add(itemId)
    for (const itemId of Object.keys(merchant.bidPrices)) tradeable.add(itemId)
  }
  const items = [...tradeable].sort()
  if (!selectedPriceItem || !items.includes(selectedPriceItem)) {
    // default to the most materially traded item in the tape
    selectedPriceItem = items[0] ?? null
  }
  const options = items
    .map(itemId => `<option value="${esc(itemId)}" ${itemId === selectedPriceItem ? 'selected' : ''}>${esc(itemLabel(itemId))}</option>`)
    .join('')
  if (itemSelect.innerHTML !== options) itemSelect.innerHTML = options

  const colors = merchantColors()
  const priceSeries = snapshot.merchants
    .map(merchant => ({
      label: merchant.displayName,
      color: colors.get(merchant.id),
      points: selectedPriceItem ? priceHistory.get(`${merchant.id}|${selectedPriceItem}`) ?? [] : [],
    }))
    .filter(candidate => candidate.points.length > 0)
  $('price-chart').innerHTML = renderLineChart(priceSeries, {
    yLabel: selectedPriceItem ? `ask price · ${itemLabel(selectedPriceItem)}` : 'ask price',
    width: 760,
    height: 240,
  })
  $('price-legend').innerHTML = legendHtml(
    priceSeries.map(candidate => ({ label: candidate.label, color: candidate.color ?? seriesColor(candidate.label) })),
  )

  const cash = merchantCashSeries(snapshot.summaries, snapshot)
  $('cash-chart').innerHTML = renderLineChart(cash, {
    yLabel: 'merchant cash by day',
    width: 760,
    height: 240,
  })
  $('cash-legend').innerHTML = legendHtml(
    cash.map(candidate => ({ label: candidate.label, color: candidate.color ?? seriesColor(candidate.label) })),
  )
}

/* ------------------------------------------------------------------ newspaper */

function renderNewspaper(recap: Recap, isClone: boolean): void {
  if (!config) return
  const cfg = config
  const movers = recap.topMovers
    .map(
      mover =>
        `<tr><td>${esc(itemLabel(mover.itemId))}</td><td>${esc(cfg.merchants[mover.merchantId]?.displayName ?? mover.merchantId)}</td>
         <td class="${mover.changePct >= 0 ? 'up' : 'down'}">${mover.changePct >= 0 ? '▲' : '▼'} ${Math.abs(mover.changePct).toFixed(1)}%</td>
         <td>${money(mover.open)} → ${money(mover.close)}</td></tr>`,
    )
    .join('')

  const standings: RecapMerchantStanding[] = recap.standings
  const best = standings.reduce<RecapMerchantStanding | null>(
    (current, candidate) => (current === null || candidate.cashChange > current.cashChange ? candidate : current),
    null,
  )
  const worst = standings.reduce<RecapMerchantStanding | null>(
    (current, candidate) => (current === null || candidate.cashChange < current.cashChange ? candidate : current),
    null,
  )

  $('newspaper').innerHTML = `
    <div class="recap-mast"><span>Ironblock daily</span><span>day ${recap.day}</span></div>
    <p class="headline">${esc(recap.headline)}</p>
    <ul>${recap.story.map(line => `<li>${esc(line)}</li>`).join('')}</ul>
    <table class="movers">
      <tr><th>item</th><th>merchant</th><th>change</th><th>open → close</th></tr>
      ${movers}
    </table>
    ${best && worst && best.merchantId !== worst.merchantId
      ? `<p style="margin-top:10px;font-size:12px;color:var(--text-faint)">Best: ${esc(best.displayName)} (${money(best.cashChange)}) · worst: ${esc(worst.displayName)} (${money(worst.cashChange)})</p>`
      : ''}
    <p style="margin-top:10px;font-size:11.5px;color:var(--text-faint)">
      ${isClone ? 'Deterministic 7-day clone recap — same seed reproduces every number. ' : 'Live economy recap, updated continuously. '}
      Causal annotations are shown during fast-forward playback.
    </p>`
}

/* ------------------------------------------------------------------ proof */

function renderProof(): void {
  if (!config) return
  const payload = proof ?? buildProofPayload(config, {})
  const contractLink = $('contract-link') as HTMLAnchorElement
  contractLink.href = payload.explorerUrls.contract
  contractLink.textContent = payload.contractId
  $('proof-panel-body').innerHTML = `
    <div class="proof-title">
      <span>${esc(payload.contractId)}</span><span class="testnet-badge">TESTNET</span>
    </div>
    <dl class="kv" style="margin-top:8px">
      <dt>network</dt><dd>${esc(payload.network)}</dd>
      <dt>contract</dt><dd><a href="${esc(payload.explorerUrls.contract)}" target="_blank" rel="noreferrer noopener">${esc(payload.explorerUrls.contract)}</a></dd>
      <dt>treasury</dt><dd><a href="${esc(payload.explorerUrls.treasury)}" target="_blank" rel="noreferrer noopener">${esc(payload.explorerUrls.treasury)}</a></dd>
      <dt>tokens</dt><dd>${payload.tokenCount} NEP-245 types</dd>
      <dt>genesis supply</dt><dd>${payload.genesisSupply.units.toLocaleString('en-US')} units</dd>
    </dl>
    <p class="proof-note">${esc(payload.note)}</p>`
}

/* ------------------------------------------------------------------ fast forward */

async function startFastForward(): Promise<void> {
  if (!feed || runningRequest) return
  runningRequest = true
  const runButton = $('ff-run') as HTMLButtonElement
  const status = $('ff-status')
  runButton.disabled = true
  playbackState?.playback.destroy()
  playbackState = null
  status.textContent = 'Cloning the world and simulating 7 days… (live economy untouched)'

  try {
    const payload = await feed.runFastForward()
    lastFastForward = payload
    status.textContent = payload.ok
      ? `Clone simulated ${payload.timing.days} day(s) in ${payload.timing.totalMs} ms (` +
        `${payload.timing.steps} steps, ${payload.timing.eventCount} events). Playing back over ~60s.`
      : 'Fast-forward failed.'
    startPlayback(payload)
  } catch (cause) {
    status.textContent = `Fast-forward failed: ${(cause as Error).message}`
  } finally {
    runButton.disabled = false
    runningRequest = false
  }
}

function startPlayback(payload: FastForwardClonePayload): void {
  const mirror = new Map<MerchantId, { cash?: number; stock?: Record<string, number>; open?: boolean; bankrupt?: boolean }>()

  playbackState = { playback: summaryPlayback(payload, mirror), summaryByDay: new Map(), mirror }
  $('ff-feed').innerHTML = ''
  $('ff-annotation').hidden = true
  ;($('ff-toggle') as HTMLButtonElement).disabled = false
  ;($('ff-step') as HTMLButtonElement).disabled = false
  ;($('ff-skip') as HTMLButtonElement).disabled = false
  ;($('ff-speed') as HTMLSelectElement).disabled = false
  $('ff-toggle').textContent = '⏸'
  playbackState.playback.start()
}

function summaryPlayback(
  payload: FastForwardClonePayload,
  mirror: Map<MerchantId, { cash?: number; stock?: Record<string, number>; open?: boolean; bankrupt?: boolean }>,
): FastForwardPlayback {
  const annotationsByEventId = new Map(
    payload.annotations.filter(annotation => annotation.eventId).map(annotation => [annotation.eventId!, annotation]),
  )
  const feed = $('ff-feed')
  let stick = true
  feed.addEventListener('scroll', () => {
    stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40
  })
  const annotationBox = $('ff-annotation')

  return new FastForwardPlayback(payload, {
    onReveal(item: PlaybackItem) {
      if (item.kind === 'annotation') {
        const annotation = item.annotation!
        annotationBox.hidden = false
        annotationBox.innerHTML = `<div class="kind">${esc(annotation.kind)}</div><b>${esc(annotation.title)}</b><div class="chain">${esc(annotation.chain)}</div>`
        feed.insertAdjacentHTML(
          'afterbegin',
          `<li class="fade-in event-row annotated" style="cursor:default"><span class="t">d${dayOf(item.time)}</span><span class="etype">${esc(annotation.kind)}</span><span class="emsg">${esc(annotation.chain)}</span></li>`,
        )
      } else {
        const event = item.event!
        const annotation = annotationsByEventId.get(event.id)
        applyMirror(event, mirror)
        feed.insertAdjacentHTML(
          'afterbegin',
          `<li><button class="event-row${annotation ? ' hit' : ''}" type="button" data-event="${esc(event.id)}">
            <span class="t">d${dayOf(event.time)} ${timeLabel(event.time)}</span>
            <span class="etype">${esc(event.type)}</span>
            <span class="emsg">${esc(event.message)}</span>
          </button></li>`,
        )
      }
      while (feed.children.length > 120) feed.removeChild(feed.lastChild!)
      if (stick) feed.scrollTop = 0
      renderMerchants()
    },
    onProgress(progress: PlaybackProgress) {
      const bar = $('ff-progress')
      bar.style.width = `${progress.percent.toFixed(1)}%`
      const wrap = $('ff-progress-wrap')
      wrap.setAttribute('aria-valuenow', String(Math.round(progress.percent)))
      $('ff-progress-left').textContent =
        progress.phase === 'done'
          ? 'complete'
          : `d${dayOf(progress.simTime)} ${timeLabel(progress.simTime)} · ${progress.index}/${progress.total} beats`
      $('ff-progress-right').textContent = `day ${Math.floor((progress.simTime - progress.fromTime) / 86400) + 1}/7 · ${progress.speed}×`
    },
    onDone() {
      const status = $('ff-status')
      status.textContent =
        'Done. Final recap is in the newspaper panel; merchant cards and health now show the end-of-week state.'
      $('ff-toggle').textContent = '↻ replay'
      const cloneNode = payload.recap
      mirroringRecap = cloneNode
      renderNewspaper(cloneNode, true)
      renderMerchantFromRecap(payload)
      renderHealthFromRecap(payload)
      annotationBox.hidden = false
      annotationBox.innerHTML = `<div class="kind">recap</div><b>${esc(payload.recap.headline)}</b><div class="chain">${esc(
        payload.recap.story[0] ?? '',
      )}</div>`
    },
  }, { wallSeconds: 60 })

  function annotationByEventId(eventId: string): FastForwardClonePayload['annotations'][number] | undefined {
    return annotationsByEventId.get(eventId)
  }
}

function applyMirror(
  event: SequencedMarketEvent,
  mirror: Map<MerchantId, { cash?: number; stock?: Record<string, number>; open?: boolean; bankrupt?: boolean }>,
): void {
  if (!config) return
  if (event.type === 'trade.buy' || event.type === 'trade.sell' || event.type === 'bot.trade') {
    const merchantId = merchantOfEvent(event)
    if (!merchantId) return
    const entry = mirror.get(merchantId) ?? {}
    entry.cash = event.after.cash ?? entry.cash
    if (event.item) {
      entry.stock = { ...(entry.stock ?? {}), [event.item]: event.after.stock ?? (entry.stock?.[event.item] ?? 0) }
    }
    mirror.set(merchantId, entry)
    return
  }
  if (event.type === 'merchant.bankrupt') {
    mirror.set(event.actor.id, { ...mirror.get(event.actor.id), open: false, bankrupt: true, cash: event.after.cash ?? 0 })
    return
  }
  if (event.type === 'merchant.reopen') {
    mirror.set(event.actor.id, { ...mirror.get(event.actor.id), open: true, bankrupt: false })
  }
}

function renderMerchantFromRecap(payload: FastForwardClonePayload): void {
  // Snap cards to the clone's final, exact state.
  if (!snapshot) return
  playbackState?.mirror.clear()
  for (const standing of payload.recap.standings) {
    playbackState?.mirror.set(standing.merchantId, {
      cash: standing.cash,
      open: standing.open,
      bankrupt: standing.bankrupt,
    })
  }
  renderMerchants()
}

function renderHealthFromRecap(payload: FastForwardClonePayload): void {
  if (!snapshot) return
  const summary = payload.summaries[payload.summaries.length - 1]
  if (!summary) return
  const healthGrid = $('health-grid')
  const tiles = [
    ['sinks (week)', money(summary.sinks.total)],
    ['caravan arrivals (week)', `${summary.caravan.arrivals}`],
    ['bankruptcies (week)', `${summary.bankruptcies.length}`],
    ['orders delivered (week)', `${summary.orders.fulfilled}`],
  ]
  const additions = document.createElement('div')
  additions.className = 'stat-grid'
  additions.dataset.proof = 'ff-week'
  additions.innerHTML = tiles
    .map(
      ([label, value]) =>
        `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`,
    )
    .join('')
  healthGrid.prepend(additions)
}

function toggleFastForward(): void {
  const state = playbackState
  if (!state) return
  const playback = state.playback
  if (playback.phase === 'running') {
    playback.pause()
    ;($('ff-toggle') as HTMLButtonElement).textContent = '▶'
    return
  }
  if (playback.phase === 'paused') {
    playback.play()
    ;($('ff-toggle') as HTMLButtonElement).textContent = '⏸'
  }
}

/* keyboard shortcuts */
window.addEventListener('keydown', event => {
  if ((event.target as HTMLElement)?.tagName === 'INPUT') return
  if (event.key === ' ' && playbackState && playbackState.playback.phase !== 'done') {
    event.preventDefault()
    toggleFastForward()
  }
  if (event.key === 'ArrowRight' && playbackState) {
    playbackState.playback.step()
  }
})
