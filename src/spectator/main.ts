import './styles.css'
import { botIdForIndex, characters } from '../config/characters'
import type {
  FastForwardAnnotation,
  FastForwardClonePayload,
  ProofPayload,
  PublicMerchant,
  PublicSnapshot,
  Recap,
  SequencedMarketEvent,
} from '../server/observability'
import { buildPlayerAliases, buildTape } from '../server/observability/sanitize'
import { buildProofPayload } from '../server/observability/proof'
import { buildRecap } from '../server/observability/recap'
import type { EconomyConfig, ItemId, MarketEventType, MerchantId } from '../shared/types'
import { createFeed, type MarketFeed, type MarketStreamMessage } from './api'
import { FastForwardPlayback, type PlaybackItem, type PlaybackProgress } from './playback'
import {
  renderFlowChart as renderFlowSvg,
  renderHeatmap,
  renderMoneyFlowChart as renderMoneyFlowSvg,
  renderPriceChart as renderPriceSvg,
  renderSparkline,
  renderVolumeChart as renderVolumeSvg,
  type FlowPoint,
  type HeatmapCell,
  type HeatmapColumn,
  type HeatmapRow,
  type HeatmapTone,
  type MoneyFlowPoint,
  type PriceSeries,
  type Point,
} from './charts'

/* ------------------------------------------------------------------ state */

const NO_ALIASES = buildPlayerAliases({})
const EVENT_BUFFER_LIMIT = 900

let feed: MarketFeed | null = null
let config: EconomyConfig | null = null
let snapshot: PublicSnapshot | null = null
let proof: ProofPayload | null = null
let demoNotice: string | null = null
let eventBuffer: SequencedMarketEvent[] = []
const eventIds = new Set<string>()
const priceHistory = new Map<string, Point[]>()
let selectedEventId: string | null = null
let selectedStoryId: string | null = null
let viewMode: 'live' | 'week' = 'live'
let lastFastForward: FastForwardClonePayload | null = null
let runningRequest = false
let fastForwardToken = 0
const filters = { group: 'all', merchant: 'all', item: '' }

type Mover = FastForwardClonePayload['summaries'][number]['topMovers'][number]

interface PricePointView {
  /** 0 is the opening quote; 1..n are recorded day closes. */
  x: number
  /** Indexed to the first recorded quote (100 = opening). */
  y: number
  price: number
  label: string
}

interface PriceItemView {
  id: ItemId
  label: string
  color: string
  base: number
  points: PricePointView[]
}

interface PriceView {
  mode: 'live' | 'week'
  labels: string[]
  items: PriceItemView[]
  key: string
  ariaLabel: string
  emptyText: string
  sourceNote: string
}

interface WealthRowView {
  id: MerchantId
  name: string
  cash: number
  reserve: number
  delta: number
  history: number[]
  open: boolean
  bankrupt: boolean
}

interface VolumePointView {
  label: string
  volume: number
  note?: string
}

interface VolumeView {
  mode: 'live' | 'week'
  points: VolumePointView[]
  ariaLabel: string
  emptyText: string
}

interface MoneyFlowView {
  mode: 'live' | 'week'
  points: MoneyFlowPoint[]
  ariaLabel: string
  emptyText: string
}

interface FlowView {
  mode: 'live' | 'week'
  points: FlowPoint[]
  ariaLabel: string
  emptyText: string
}

type HeatmapMode = 'price' | 'usual' | 'stock'

interface HeatmapBoard {
  columns: HeatmapColumn[]
  rows: HeatmapRow[]
  sub: string
  caption: string
  ariaLabel: string
  emptyText: string
}

interface HeatmapView {
  mode: 'live' | 'week'
  price: HeatmapBoard
  usual: HeatmapBoard
  stock: HeatmapBoard
}

const PRICE_COLORS = ['#eab35e', '#7fb6e8', '#e98a7f', '#9bcf9f', '#c5a3e8']
const hiddenPriceItems = new Set<string>()
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
let activePriceView: PriceView | null = null
let activePriceSignature = ''
let activePriceReveal = 1
let activeCaptionKey = ''
let activeVolumeView: VolumeView | null = null
let activeVolumeCount = -1
let activeMoneyFlowView: MoneyFlowView | null = null
let activeMoneyFlowReveal = -1
let activeFlowView: FlowView | null = null
let activeFlowReveal = -1
let activeHeatmapView: HeatmapView | null = null
let activeHeatmapKey = ''
let heatmapMode: HeatmapMode = 'price'

interface MerchantMirror {
  cash?: number
  open?: boolean
  bankrupt?: boolean
}

type WeekSeriesPoint = FastForwardClonePayload['series'][number]

interface WeekRun {
  payload: FastForwardClonePayload
  series: WeekSeriesPoint[]
  playback: FastForwardPlayback | null
  story: StoryItem[]
  startCash: number
  startOpen: number
  startPrices: Map<ItemId, number>
  startMerchantCash: Map<MerchantId, number>
  priceView: PriceView
  volumeView: VolumeView
  moneyFlowView: MoneyFlowView
  flowView: FlowView
  heatmapView: HeatmapView
  wealthRows: WealthRowView[]
  reopenCount: number
  mirror: Map<MerchantId, MerchantMirror>
  renderedDay: number
  renderedOpen: number
  revealedStoryCount: number
  renderedVolumeDays: number
}

let weekRun: WeekRun | null = null

type StoryTone = 'neutral' | 'trade' | 'money' | 'risk' | 'good' | 'day' | 'system'

interface StoryItem {
  id: string
  time: number
  day: number
  kind: string
  tone: StoryTone
  title: string
  detailHtml: string
}

interface StoryCandidate {
  item: StoryItem
  priority: number
}

/* ------------------------------------------------------------------ helpers */

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`missing element #${id}`)
  return element as T
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const formatNumber = (value: number, digits = 0): string =>
  (Number.isFinite(value) ? value : 0).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })

const money = (value: number): string =>
  `${config?.currency.symbol ?? 'IB'} ${formatNumber(value, 2)}`

const money0 = (value: number): string =>
  `${config?.currency.symbol ?? 'IB'} ${formatNumber(value, 0)}`

const moneyCompact = (value: number): string => {
  const symbol = config?.currency.symbol ?? 'IB'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${symbol} ${(value / 1_000_000).toFixed(1)}m`
  if (abs >= 10_000) return `${symbol} ${(value / 1000).toFixed(0)}k`
  if (abs >= 1_000) return `${symbol} ${(value / 1000).toFixed(1)}k`
  return `${symbol} ${value.toFixed(0)}`
}

const units = (value: number): string => formatNumber(value, 0)

const countLabel = (count: number, singular: string, plural = `${singular}s`): string =>
  `${formatNumber(count, 0)} ${count === 1 ? singular : plural}`

const dayOf = (time: number): number => Math.floor(time / 86400) + 1

const timeLabel = (time: number): string => {
  const seconds = ((time % 86400) + 86400) % 86400
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

const itemLabel = (itemId: string | null): string =>
  itemId ? config?.items[itemId]?.displayName ?? itemId : '—'

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value))

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

const merchantTotalCash = (current: PublicSnapshot): number =>
  sum(current.merchants.map(merchant => merchant.cash))

const townCash = (current: PublicSnapshot): number =>
  merchantTotalCash(current) + current.travelers.totalCash

const openStalls = (current: PublicSnapshot): number =>
  current.merchants.filter(merchant => merchant.open && !merchant.bankrupt).length

const recapOpenStalls = (recap: Recap): number =>
  (recap.standings ?? []).filter(standing => standing.open && !standing.bankrupt).length

const lastWeekVolume = (current: PublicSnapshot): number => {
  const closedDays = current.summaries.filter(summary => summary.day < current.day).slice(-6)
  return sum(closedDays.map(summary => summary.trades.volume)) + current.daily.trades.volume
}

/**
 * Older fast-forward payloads only carried `summaries`; newer ones add
 * `series`. Normalising here keeps the whole week view on one shape.
 */
function weekSeries(payload: FastForwardClonePayload): WeekSeriesPoint[] {
  if (payload.series?.length) return payload.series
  return (payload.summaries ?? []).map(summary => ({
    day: summary.day,
    endedAt: summary.endedAt,
    totalMerchantCash: summary.totalMerchantCash,
    totalPlayerCash: summary.totalPlayerCash,
    tradeVolume: summary.trades.volume,
    tradeValue: summary.trades.value,
    bankruptcies: summary.bankruptcies.length,
    caravanArrivals: summary.caravan.arrivals,
    sinkTotal: summary.sinks.total,
  }))
}

const liveContextLabel = (): string =>
  feed?.mode === 'live' ? 'Live market-town economy' : 'Local demo replay · market-town economy'

const withTimeout = <T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      cause => {
        window.clearTimeout(timer)
        reject(cause)
      },
    )
  })

/* ------------------------------------------------------------------ static page wiring */

function wireStaticEvents(): void {
  $('ff-run').addEventListener('click', () => {
    void startFastForward()
  })
  $('ff-skip').addEventListener('click', () => {
    if (weekRun?.playback && weekRun.playback.phase !== 'done') {
      setRunStatus('Skipping to the end of the week…')
      weekRun.playback.skipToEnd()
    }
  })
  $('view-live').addEventListener('click', returnToLive)

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

  $('story-feed').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.story-row')
    if (!button) return
    const item = button.closest<HTMLElement>('.story-item')
    const detail = item?.querySelector<HTMLElement>('.story-detail')
    if (!item || !detail) return
    const expanded = button.getAttribute('aria-expanded') === 'true'

    for (const openItem of document.querySelectorAll<HTMLElement>('.story-item.open')) {
      openItem.classList.remove('open')
      const openButton = openItem.querySelector<HTMLButtonElement>('.story-row')
      const openDetail = openItem.querySelector<HTMLElement>('.story-detail')
      openButton?.setAttribute('aria-expanded', 'false')
      if (openDetail) openDetail.hidden = true
    }

    if (expanded) {
      button.setAttribute('aria-expanded', 'false')
      detail.hidden = true
      selectedStoryId = null
      return
    }

    item.classList.add('open')
    button.setAttribute('aria-expanded', 'true')
    detail.hidden = false
    selectedStoryId = button.dataset.storyId ?? null
  })

  $('event-list').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.event-row')
    if (!button) return
    selectedEventId = button.dataset.event ?? null
    renderEventStream()
  })

  $('price-legend').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-price-item]')
    if (!button) return
    const itemId = button.dataset.priceItem
    if (!itemId) return
    if (hiddenPriceItems.has(itemId)) hiddenPriceItems.delete(itemId)
    else hiddenPriceItems.add(itemId)
    if (activePriceView) {
      renderPriceCard(activePriceView, activePriceReveal, true)
      const next = Array.from($('price-legend').querySelectorAll<HTMLButtonElement>('.price-key')).find(
        candidate => candidate.dataset.priceItem === itemId,
      )
      next?.focus()
    }
  })

  $('heatmap-toggle').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-heatmap]')
    if (!button) return
    const next = button.dataset.heatmap
    nextHeatmapMode(next === 'stock' ? 'stock' : next === 'usual' ? 'usual' : 'price')
  })

  const priceWrap = $('price-chart-wrap')
  priceWrap.addEventListener('pointermove', event => {
    const band = (event.target as Element).closest<Element>('[data-price-x]')
    if (!band) {
      hidePriceTooltip()
      return
    }
    const x = Number(band.getAttribute('data-price-x'))
    if (!Number.isFinite(x)) return
    showPriceTooltip(x, event.clientX, event.clientY)
  })
  priceWrap.addEventListener('pointerdown', event => {
    const band = (event.target as Element).closest<Element>('[data-price-x]')
    if (!band) return
    const x = Number(band.getAttribute('data-price-x'))
    if (!Number.isFinite(x)) return
    showPriceTooltip(x, event.clientX, event.clientY)
  })
  priceWrap.addEventListener('pointerleave', () => hidePriceTooltip())
  priceWrap.addEventListener('focusin', event => {
    const band = (event.target as Element).closest<Element>('[data-price-x]')
    if (!band) return
    const x = Number(band.getAttribute('data-price-x'))
    if (!Number.isFinite(x)) return
    const rect = band.getBoundingClientRect()
    showPriceTooltip(x, rect.left + rect.width / 2, rect.top + Math.min(80, rect.height / 2))
  })
  priceWrap.addEventListener('focusout', event => {
    if (!priceWrap.contains(event.relatedTarget as Node | null)) hidePriceTooltip()
  })
  priceWrap.addEventListener('keydown', event => {
    if (event.key === 'Escape') hidePriceTooltip()
  })

  let resizeFrame = 0
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => {
      if (activePriceView) renderPriceCard(activePriceView, activePriceReveal, true)
      if (activeVolumeView) renderVolumeCard(activeVolumeView, activeVolumeCount, true)
      if (activeMoneyFlowView) renderMoneyFlowCard(activeMoneyFlowView, activeMoneyFlowReveal, true)
      if (activeFlowView) renderFlowCard(activeFlowView, activeFlowReveal, true)
    })
  })
}

function renderStaticRoster(): void {
  $('townsfolk-grid').innerHTML = characters
    .map(
      character => `<article class="person-card">
        <span class="person-avatar" aria-hidden="true">${esc(initials(character.displayName))}</span>
        <div class="person-copy">
          <h4>${esc(character.displayName)}</h4>
          <p class="person-role">${esc(character.archetype)}</p>
          <p class="person-line">${esc(character.line)}</p>
        </div>
      </article>`,
    )
    .join('')
}

/* ------------------------------------------------------------------ boot */

void boot()

async function boot(): Promise<void> {
  wireStaticEvents()
  renderStaticRoster()
  renderPriceCard(emptyPriceView('live'), 1, true)
  renderWealthCard([], 1, 'live')
  renderVolumeCard(emptyVolumeView('live'), 0)
  renderMoneyFlowCard(
    {
      mode: 'live',
      points: [],
      ariaLabel: 'Town cash split with no recorded days yet.',
      emptyText: 'Waiting for the town’s cash history…',
    },
    0,
    true,
  )
  renderFlowCard(
    {
      mode: 'live',
      points: [],
      ariaLabel: 'External cash flows with no recorded days yet.',
      emptyText: 'Waiting for the first closed day…',
    },
    0,
    true,
  )
  renderHeatmapPlaceholder('Waiting for merchant quotes…', true)

  try {
    const created = await createFeed()
    feed = created.feed
    demoNotice = created.fallbackReason ?? null
    config = feed.config
    renderModeBadge()
  } catch (cause) {
    showBootError(cause)
    return
  }

  try {
    proof = await feed.proof()
  } catch {
    proof = config ? buildProofPayload(config, {}) : null
  }
  renderProof()

  let unsubscribe = () => undefined
  try {
    unsubscribe = feed.subscribe(onStreamMessage)
    window.addEventListener('beforeunload', unsubscribe)
  } catch {
    /* The page still works with the one-shot snapshot below. */
  }

  try {
    snapshot = await feed.getSnapshot()
    mergeEvents(snapshot.recentEvents)
    seedPriceHistory()
    renderLiveAll()
  } catch (cause) {
    showBootError(cause)
  }
}

function onStreamMessage(message: MarketStreamMessage): void {
  if (message.kind === 'snapshot' && message.snapshot) {
    snapshot = message.snapshot
    mergeEvents(snapshot.recentEvents)
    seedPriceHistory()
    if (viewMode === 'live') renderLiveAll()
    return
  }
  if (message.kind === 'events' && message.events?.length) {
    mergeEvents(message.events)
    updatePriceHistoryFromEvents(message.events)
    if (viewMode === 'live') renderLiveAll()
  }
}

function showBootError(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause)
  $('town-status').textContent = 'The market feed is reconnecting.'
  $('town-summary').textContent =
    'The live town did not answer yet. The 7-day preview still works offline — or try reloading in a moment.'
  $('story-empty').hidden = false
  $('story-empty').textContent = `No market feed yet (${message}).`
  const note = $('connection-note')
  note.hidden = false
  note.textContent = `Connection: ${message}`
}

/* ------------------------------------------------------------------ mode + clock */

function renderModeBadge(): void {
  if (!feed) return
  const badge = $('mode-badge')
  const live = feed.mode === 'live'
  const previewing = viewMode === 'week'
  badge.classList.toggle('live', live && !previewing)
  badge.classList.toggle('demo', !live && !previewing)
  badge.classList.toggle('preview', previewing)
  $('mode-text').textContent = previewing ? 'PREVIEW' : live ? 'LIVE' : 'DEMO'
  badge.title = previewing
    ? 'Simulated 7-day preview · live town unchanged, result not saved'
    : live
      ? 'Connected to the running economy service'
      : demoNotice ?? 'Deterministic local replay — no live service'
  badge.setAttribute(
    'aria-label',
    previewing
      ? 'Preview: simulated seven-day forecast, live town unchanged and result not saved'
      : live
        ? 'Live: connected to the running economy service'
        : 'Demo replay: deterministic local simulation, not a live service',
  )

  const note = $('connection-note')
  if (!live && demoNotice) {
    note.hidden = false
    note.textContent = demoNotice
  } else {
    note.hidden = true
  }
  $('footer-mode').textContent = previewing ? 'Simulated preview' : live ? 'Live feed' : 'Local demo replay'
}

function renderClock(day: number, preview = false): void {
  const chip = $('clock-chip')
  chip.textContent = `Day ${day}`
  chip.classList.toggle('is-preview', preview)
  chip.title = preview
    ? `Simulated preview · town day ${day} — live town unchanged, result not saved`
    : 'Current day in the live town'
}

/* ------------------------------------------------------------------ live view */

function renderLiveAll(): void {
  if (!snapshot || !config) return
  if (viewMode === 'week' && weekRun) return
  viewMode = 'live'
  const current = snapshot
  const open = openStalls(current)
  const cash = townCash(current)
  const status = liveStatus(current, open)

  $('hero-context').textContent = liveContextLabel()
  $('view-live').hidden = true
  $('clock-chip').classList.remove('is-preview')
  renderClock(current.day)
  renderHero({
    title: status.title,
    tone: status.tone,
    day: current.day,
    daySub: `live world · ${timeLabel(current.time)}`,
    open,
    openSub: `of ${current.merchants.length} merchant stalls`,
    cash,
    cashSub: 'stall tills + traveler wallets',
    volume: lastWeekVolume(current),
    volumeSub: 'units · last 7 days',
  })
  renderPriceCard(buildLivePriceView(current), 1)
  renderWealthCard(buildLiveWealthRows(current), 1, 'live')
  const volume = buildLiveVolumeView(current)
  renderVolumeCard(volume, volume.points.length)
  const moneyFlow = buildLiveMoneyFlowView(current)
  renderMoneyFlowCard(moneyFlow, moneyFlow.points.length)
  const flows = buildLiveFlowView(current)
  renderFlowCard(flows, flows.points.length)
  renderHeatmapCard(buildLiveHeatmapView(current), true)
  setActivityCopy('live')
  renderStoryFeed(buildLiveStory())
  renderBotActivity(eventBuffer)
  renderMerchantCards()
  renderTape()
  renderEventStream()
  renderNewspaper(buildRecap(current, config), false)
  renderRunProof()
}

interface HeroView {
  title: string
  tone: StoryTone
  day: number
  daySub: string
  open: number
  openSub: string
  cash: number
  cashSub: string
  volume: number
  volumeSub: string
}

function renderHero(view: HeroView): void {
  const title = $('town-status')
  title.textContent = view.title
  title.dataset.tone = view.tone
  $('stat-day').textContent = String(view.day)
  $('stat-day').title = view.daySub
  $('stat-stalls').textContent = String(view.open)
  $('stat-stalls').title = view.openSub
  $('stat-cash').textContent = money0(view.cash)
  $('stat-cash').title = view.cashSub
  $('stat-volume').textContent = units(view.volume)
  $('stat-volume').title = view.volumeSub
  $('hero-glance').setAttribute(
    'aria-label',
    `Day ${view.day}. ${view.open} stalls open. ${money0(view.cash)} cash in town. ${units(view.volume)} units traded.`,
  )
}

function liveStatus(current: PublicSnapshot, open: number): { title: string; tone: StoryTone } {
  const closed = current.merchants.length - open
  if (closed > 0 || current.daily.bankruptcies.length > 0) {
    return {
      title: closed === 1 ? 'The market is under pressure.' : 'Some stalls are dark.',
      tone: 'risk',
    }
  }
  if (current.day === 1 && current.daily.trades.volume === 0) {
    return { title: 'The market is opening.', tone: 'neutral' }
  }
  const recent = current.summaries.filter(summary => summary.day < current.day).slice(-7)
  const average = recent.length > 0 ? sum(recent.map(summary => summary.trades.volume)) / recent.length : 0
  const today = current.daily.trades.volume
  if (average > 0 && today >= average * 1.2 && today > 0) {
    return { title: 'The market is thriving.', tone: 'good' }
  }
  if (average > 0 && today > 0 && today <= average * 0.55) {
    return { title: 'The town is quiet.', tone: 'neutral' }
  }
  return { title: 'The market is steady.', tone: 'neutral' }
}

/* ------------------------------------------------------------------ market data views */

function averageAskByItem(current: PublicSnapshot): Map<ItemId, number> {
  const prices = new Map<ItemId, number[]>()
  for (const merchant of current.merchants) {
    for (const [itemId, ask] of Object.entries(merchant.askPrices)) {
      if (!Number.isFinite(ask) || ask <= 0) continue
      const list = prices.get(itemId as ItemId) ?? []
      list.push(ask)
      prices.set(itemId as ItemId, list)
    }
  }
  const averages = new Map<ItemId, number>()
  for (const [itemId, list] of prices) {
    if (list.length > 0) averages.set(itemId, sum(list) / list.length)
  }
  return averages
}

function moverAverages(movers: Mover[], field: 'open' | 'close'): Map<ItemId, number> {
  const prices = new Map<ItemId, number[]>()
  for (const mover of movers) {
    const price = mover[field]
    if (!Number.isFinite(price) || price <= 0) continue
    const list = prices.get(mover.itemId) ?? []
    list.push(price)
    prices.set(mover.itemId, list)
  }
  const averages = new Map<ItemId, number>()
  for (const [itemId, list] of prices) {
    if (list.length > 0) averages.set(itemId, sum(list) / list.length)
  }
  return averages
}

/**
 * Daily closes reconstructed from the payload's day summaries.
 *
 * A summary's top-mover `close` is a real end-of-day quote. Its `open` is the
 * next morning's quote for the previous close, so it can fill the preceding
 * day when the item was not itself a top mover. Nothing is interpolated.
 */
function collectDailyCloses(
  summaries: FastForwardClonePayload['summaries'],
  startDay: number,
  days: number,
): Map<ItemId, Map<number, number>> {
  const daily = new Map<ItemId, Map<number, number>>()
  const set = (itemId: ItemId, day: number, price: number): void => {
    if (day < 1 || day > days || !Number.isFinite(price) || price <= 0) return
    const itemDays = daily.get(itemId) ?? new Map<number, number>()
    if (!itemDays.has(day)) itemDays.set(day, price)
    daily.set(itemId, itemDays)
  }

  for (const summary of summaries) {
    const day = summary.day - startDay + 1
    if (day < 1 || day > days) continue
    for (const [itemId, price] of moverAverages(summary.topMovers, 'close')) set(itemId, day, price)
    for (const [itemId, price] of moverAverages(summary.topMovers, 'open')) set(itemId, day - 1, price)
  }
  return daily
}

/** Fill missing item-days with the last recorded ask in the sampled events. */
function addEventCloses(
  daily: Map<ItemId, Map<number, number>>,
  events: SequencedMarketEvent[],
  fromTime: number,
  days: number,
): void {
  const latest = new Map<string, { time: number; itemId: ItemId; day: number; price: number }>()
  for (const event of events) {
    if (!event.item) continue
    const price = event.after.ask ?? event.before.ask
    if (price === null || !Number.isFinite(price) || price <= 0) continue
    const day = clamp(Math.ceil((event.time - fromTime) / 86400), 1, days)
    const key = `${event.item}|${day}`
    const previous = latest.get(key)
    if (!previous || event.time > previous.time) latest.set(key, { time: event.time, itemId: event.item, day, price })
  }
  for (const observation of latest.values()) {
    const itemDays = daily.get(observation.itemId) ?? new Map<number, number>()
    if (!itemDays.has(observation.day)) itemDays.set(observation.day, observation.price)
    daily.set(observation.itemId, itemDays)
  }
}

function addRecapCloses(
  daily: Map<ItemId, Map<number, number>>,
  recap: FastForwardClonePayload['recap'],
  days: number,
): void {
  for (const [itemId, price] of moverAverages(recap.topMovers ?? [], 'close')) {
    const itemDays = daily.get(itemId) ?? new Map<number, number>()
    if (!itemDays.has(days)) itemDays.set(days, price)
    daily.set(itemId, itemDays)
  }
}

function finalizePriceView(
  mode: 'live' | 'week',
  labels: string[],
  candidates: Array<{ id: ItemId; base: number; points: PricePointView[]; score: number }>,
  emptyText: string,
): PriceView {
  const chosen = candidates.slice(0, 4)
  const items: PriceItemView[] = chosen.map((candidate, index) => ({
    id: candidate.id,
    label: itemLabel(candidate.id),
    color: PRICE_COLORS[index % PRICE_COLORS.length],
    base: candidate.base,
    points: candidate.points,
  }))
  const key = `${mode}|${labels.join('|')}|${items
    .map(item => `${item.id}:${item.points.map(point => `${point.x},${point.price.toFixed(4)}`).join(',')}`)
    .join(';')}`
  const names = items.map(item => item.label)
  const ariaLabel =
    names.length > 0
      ? `Price chart for ${names.join(', ')}. Each line is indexed to its first recorded quote over ${Math.max(
          1,
          labels.length - 1,
        )} recorded days. Hover or focus a day for exact prices.`
      : 'Price chart with no recorded item quotes yet.'
  const sourceNote =
    names.length > 0
      ? `Showing the ${names.length} items with the most recorded quotes and biggest moves. Dashed spans are gaps in the sample.`
      : 'Recorded merchant quotes only. Dashed spans mean no quote was sampled that day.'
  return { mode, labels, items, key, ariaLabel, emptyText, sourceNote }
}

function emptyPriceView(mode: 'live' | 'week'): PriceView {
  return finalizePriceView(
    mode,
    ['Open', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'],
    [],
    mode === 'live'
      ? 'Run the 7-day preview to draw the town’s price lines.'
      : 'No item quotes were recorded in this week.',
  )
}

function buildWeekPriceView(payload: FastForwardClonePayload, startSnapshot: PublicSnapshot | null): PriceView {
  const days = Math.max(1, payload.days)
  const labels = ['Open', ...Array.from({ length: days }, (_, index) => `D${index + 1}`)]
  const startPrices = startSnapshot ? averageAskByItem(startSnapshot) : new Map<ItemId, number>()
  const daily = collectDailyCloses(payload.summaries, payload.startDay, days)
  addEventCloses(daily, payload.events, payload.fromTime, days)
  addRecapCloses(daily, payload.recap, days)

  const candidates: Array<{ id: ItemId; base: number; points: PricePointView[]; score: number }> = []
  for (const [itemId, itemDays] of daily) {
    const base = startPrices.get(itemId)
    if (!base) continue
    const closes = [...itemDays.entries()].filter(([day]) => day >= 1 && day <= days).sort((left, right) => left[0] - right[0])
    if (closes.length === 0) continue
    const points: PricePointView[] = [{ x: 0, y: 100, price: base, label: 'Week open' }]
    for (const [day, price] of closes) {
      points.push({ x: day, y: (price / base) * 100, price, label: `Day ${day} close` })
    }
    const last = closes[closes.length - 1][1]
    const changePct = ((last - base) / base) * 100
    const values = [base, ...closes.map(([, price]) => price)]
    const rangePct = ((Math.max(...values) - Math.min(...values)) / base) * 100
    const score = closes.length * 10 + Math.min(100, Math.abs(changePct)) / 2 + Math.min(40, rangePct) / 3
    candidates.push({ id: itemId, base, points, score })
  }
  candidates.sort((left, right) => right.score - left.score)
  return finalizePriceView('week', labels, candidates, 'No item quotes were recorded in this week.')
}

function buildLivePriceView(current: PublicSnapshot): PriceView {
  const summaries = current.summaries.slice(-7)
  if (summaries.length === 0) return emptyPriceView('live')
  const startDay = summaries[0].day
  const days = summaries.length
  const daily = collectDailyCloses(summaries, startDay, days)
  const currentPrices = averageAskByItem(current)
  const labels = [...summaries.map(summary => `D${summary.day}`), 'Now']

  const candidates: Array<{ id: ItemId; base: number; points: PricePointView[]; score: number }> = []
  for (const [itemId, itemDays] of daily) {
    const closes = [...itemDays.entries()].filter(([day]) => day >= 1 && day <= days).sort((left, right) => left[0] - right[0])
    if (closes.length === 0) continue
    const base = closes[0][1]
    if (!base) continue
    const points: PricePointView[] = closes.map(([day, price]) => ({
      x: day - 1,
      y: (price / base) * 100,
      price,
      label: `Day ${startDay + day - 1} close`,
    }))
    const now = currentPrices.get(itemId)
    if (now !== undefined && Number.isFinite(now) && now > 0) {
      points.push({ x: days, y: (now / base) * 100, price: now, label: 'Now' })
    }
    if (points.length < 2) continue
    const last = points[points.length - 1].price
    const changePct = ((last - base) / base) * 100
    const values = points.map(point => point.price)
    const rangePct = ((Math.max(...values) - Math.min(...values)) / base) * 100
    const score = closes.length * 10 + Math.min(100, Math.abs(changePct)) / 2 + Math.min(40, rangePct) / 3
    candidates.push({ id: itemId, base, points, score })
  }
  candidates.sort((left, right) => right.score - left.score)
  return finalizePriceView(
    'live',
    labels,
    candidates,
    'Run the 7-day preview to draw a full week of prices.',
  )
}

function buildWeekVolumeView(payload: FastForwardClonePayload): VolumeView {
  const points: VolumePointView[] = weekSeries(payload).map((point, index) => ({
    label: `D${index + 1}`,
    volume: Math.max(0, point.tradeVolume),
    note: point.bankruptcies > 0 ? `${point.bankruptcies} stall${point.bankruptcies === 1 ? '' : 's'} closed` : undefined,
  }))
  return {
    mode: 'week',
    points,
    ariaLabel: 'Daily trade volume for the simulated week.',
    emptyText: 'No daily trade volume was recorded.',
  }
}

function buildLiveVolumeView(current: PublicSnapshot): VolumeView {
  const summaries = current.summaries.slice(-7)
  const points: VolumePointView[] = summaries.map(summary => ({
    label: `D${summary.day}`,
    volume: Math.max(0, summary.trades.volume),
    note: summary.bankruptcies.length > 0
      ? `${summary.bankruptcies.length} stall${summary.bankruptcies.length === 1 ? '' : 's'} closed`
      : undefined,
  }))
  if (summaries.length > 0 || current.daily.trades.volume > 0) {
    points.push({
      label: 'Today',
      volume: Math.max(0, current.daily.trades.volume),
      note: current.daily.bankruptcies.length > 0
        ? `${current.daily.bankruptcies.length} stall${current.daily.bankruptcies.length === 1 ? '' : 's'} closed`
        : undefined,
    })
  }
  return {
    mode: 'live',
    points,
    ariaLabel:
      points.length > 0
        ? `Daily trade volume for ${points.map(point => point.label).join(', ')}.`
        : 'Daily trade volume with no recorded days yet.',
    emptyText: summaries.length === 0 ? 'Run the 7-day preview to fill the trade bars.' : 'No trades yet today.',
  }
}

function emptyVolumeView(mode: 'live' | 'week'): VolumeView {
  return {
    mode,
    points: [],
    ariaLabel: 'Daily trade volume with no recorded days yet.',
    emptyText: mode === 'live' ? 'Run the 7-day preview to fill the trade bars.' : 'No daily trade volume was recorded.',
  }
}

/* ------------------------------------------------------------------ cash + flow views */

type FlowTotals = Pick<PublicSnapshot['daily'], 'caravan' | 'sinks' | 'orders' | 'investments'>

function moneyFlowPoint(label: string, merchant: number, traveler: number): MoneyFlowPoint {
  return {
    label,
    merchant: Math.max(0, merchant),
    traveler: Math.max(0, traveler),
  }
}

function flowPoint(label: string, totals: FlowTotals): FlowPoint {
  const orders = Math.max(0, totals.orders.payouts)
  const caravanOut = Math.max(0, totals.caravan.cashOut)
  const investments = Math.max(0, totals.investments.amount)
  const caravanIn = Math.max(0, totals.caravan.cashIn)
  const sinks = Math.max(0, totals.sinks.total)
  const inflow = orders + caravanOut + investments
  const outflow = caravanIn + sinks
  return {
    label,
    inflow,
    outflow,
    net: inflow - outflow,
    orders,
    caravanIn,
    caravanOut,
    investments,
    sinks,
  }
}

function buildLiveMoneyFlowView(current: PublicSnapshot): MoneyFlowView {
  const points = current.summaries
    .slice(-7)
    .map(summary => moneyFlowPoint(`D${summary.day}`, summary.totalMerchantCash, summary.totalPlayerCash))
  points.push(
    moneyFlowPoint(
      'Now',
      sum(current.merchants.map(merchant => merchant.cash)),
      current.travelers.totalCash,
    ),
  )
  return {
    mode: 'live',
    points,
    ariaLabel: `Town cash split for ${points.map(point => point.label).join(', ')}. Stacked bars show merchant tills and traveler wallets.`,
    emptyText: 'Cash history appears as the town records days.',
  }
}

function buildWeekMoneyFlowView(payload: FastForwardClonePayload): MoneyFlowView {
  const points = weekSeries(payload).map((point, index) =>
    moneyFlowPoint(`D${index + 1}`, point.totalMerchantCash, point.totalPlayerCash),
  )
  return {
    mode: 'week',
    points,
    ariaLabel: 'Simulated town cash split for the seven-day preview. Stacked bars show merchant tills and traveler wallets.',
    emptyText: 'No cash history was recorded in this preview.',
  }
}

function buildLiveFlowView(current: PublicSnapshot): FlowView {
  const points = current.summaries
    .slice(-7)
    .map(summary => flowPoint(`D${summary.day}`, summary))
  points.push(flowPoint('Today', current.daily))
  return {
    mode: 'live',
    points,
    ariaLabel: `External cash inflows and drains for ${points.map(point => point.label).join(', ')}.`,
    emptyText: 'External cash flows appear as days close.',
  }
}

function buildWeekFlowView(payload: FastForwardClonePayload): FlowView {
  const points = (payload.summaries ?? []).map((summary, index) => flowPoint(`D${index + 1}`, summary))
  return {
    mode: 'week',
    points,
    ariaLabel: 'Simulated external cash inflows and drains for the seven-day preview.',
    emptyText: 'No daily cash flows were recorded in this preview.',
  }
}

/* ------------------------------------------------------------------ market map */

type BaselineLookup = (merchant: PublicMerchant, item: ItemId) => number | null

function heatmapColumns(merchants: PublicMerchant[]): HeatmapColumn[] {
  const seen = new Set<string>()
  for (const merchant of merchants) {
    for (const itemId of Object.keys(merchant.askPrices)) seen.add(itemId)
    for (const itemId of Object.keys(merchant.bidPrices)) seen.add(itemId)
    for (const itemId of Object.keys(merchant.targetStock)) seen.add(itemId)
  }
  const ordered = config ? Object.keys(config.items) : []
  const ids = [
    ...ordered.filter(itemId => seen.has(itemId)),
    ...[...seen].filter(itemId => !ordered.includes(itemId)).sort(),
  ]
  return ids.map(itemId => ({ id: itemId, label: itemLabel(itemId) }))
}

function buildPriceHeatmapBoard(
  merchants: PublicMerchant[],
  columns: HeatmapColumn[],
  baseline: BaselineLookup,
  baselineLabel: string,
  mode: 'live' | 'week',
): HeatmapBoard {
  let up = 0
  let down = 0
  let flat = 0
  let compared = 0
  let absolute = 0
  const movers: Array<{ merchant: string; item: string; pct: number }> = []

  const rows: HeatmapRow[] = merchants.map(merchant => {
    const cells: Record<string, HeatmapCell> = {}
    for (const column of columns) {
      const itemId = column.id as ItemId
      const current = merchant.askPrices[itemId] ?? merchant.bidPrices[itemId]
      if (!Number.isFinite(current) || current <= 0) continue
      const open = baseline(merchant, itemId)
      if (open !== null && Number.isFinite(open) && open > 0) {
        const pct = ((current - open) / open) * 100
        compared += 1
        const tone: HeatmapTone = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat'
        if (tone === 'up') up += 1
        else if (tone === 'down') down += 1
        else flat += 1
        cells[column.id] = {
          label: signedPercent(pct),
          title: `${merchant.displayName} · ${column.label}: ${money(current)} now vs ${money(
            open,
          )} ${baselineLabel} (${signedPercent(pct)})`,
          tone,
          strength: clamp(Math.abs(pct) / 20, 0, 1),
        }
        movers.push({ merchant: merchant.displayName, item: column.label, pct })
      } else {
        absolute += 1
        cells[column.id] = {
          label: money0(current),
          title: `${merchant.displayName} · ${column.label}: ${money(current)}. No ${baselineLabel} baseline was recorded.`,
          tone: 'flat',
        }
      }
    }
    return { id: merchant.id, label: merchant.displayName, cells }
  })

  let caption: string
  if (compared === 0 && absolute === 0) {
    caption = 'No merchant quotes are available yet.'
  } else if (compared === 0) {
    caption = `${absolute} quotes shown at absolute ask; no ${baselineLabel} baseline was recorded.`
  } else {
    const parts: string[] = []
    if (up > 0) parts.push(`${up} dearer`)
    if (down > 0) parts.push(`${down} cheaper`)
    if (flat > 0) parts.push(`${flat} flat`)
    caption = `${compared} quotes vs ${baselineLabel}: ${parts.join(', ')}.`
    const biggest = movers.sort((left, right) => Math.abs(right.pct) - Math.abs(left.pct))[0]
    if (biggest) {
      caption += ` Biggest move: ${biggest.merchant} ${biggest.item} ${signedPercent(biggest.pct)}.`
    }
  }
  if (mode === 'week' && compared + absolute > 0) {
    caption += ' Final simulated close; the live town is unchanged.'
  }

  return {
    columns,
    rows,
    sub: `${mode === 'week' ? 'Final ask' : 'Current ask'} vs ${baselineLabel}. Green is dearer, blue is cheaper.`,
    caption,
    ariaLabel: `Price movement heatmap for ${merchants.length} merchants across ${columns.length} goods. ${caption}`,
    emptyText: mode === 'week' ? 'The final market map was not included in this preview.' : 'Waiting for merchant quotes…',
  }
}

function buildStockHeatmapBoard(
  merchants: PublicMerchant[],
  columns: HeatmapColumn[],
  mode: 'live' | 'week',
): HeatmapBoard {
  let observed = 0
  let low = 0
  let full = 0
  let over = 0
  let coverTotal = 0

  const rows: HeatmapRow[] = merchants.map(merchant => {
    const cells: Record<string, HeatmapCell> = {}
    for (const column of columns) {
      const itemId = column.id as ItemId
      const stock = Math.max(0, merchant.stock[itemId] ?? 0)
      const target = Math.max(0, merchant.targetStock[itemId] ?? 0)
      if (stock <= 0 && target <= 0) continue
      const coverage = target > 0 ? stock / target : null
      if (coverage !== null) {
        observed += 1
        coverTotal += coverage
        if (coverage < 0.35) low += 1
        if (coverage >= 0.8) full += 1
        if (coverage > 1.2) over += 1
      }
      const tone: HeatmapTone =
        coverage === null ? 'flat' : coverage < 0.35 ? 'low' : coverage < 0.8 ? 'mid' : 'high'
      cells[column.id] = {
        label: coverage === null ? units(stock) : `${Math.round(coverage * 100)}%`,
        title: `${merchant.displayName} · ${column.label}: ${units(stock)} of ${units(
          target,
        )} target stock${coverage === null ? '' : ` (${Math.round(coverage * 100)}% cover)`}.`,
        tone,
        strength: coverage === null ? 0.2 : coverage < 0.35 ? 1 - coverage / 0.35 : clamp(coverage, 0, 1),
      }
    }
    return { id: merchant.id, label: merchant.displayName, cells }
  })

  let caption: string
  if (observed === 0) {
    caption = mode === 'week' ? 'No final stock was recorded in this preview.' : 'No stock observations yet.'
  } else {
    const average = Math.round((coverTotal / observed) * 100)
    caption = `${observed} stall-goods tracked: ${low} below 35% of target, ${full} at 80% or better, ${over} over 120%; average cover ${average}%.`
    if (mode === 'week') caption += ' Final simulated stock; the live town is unchanged.'
  }

  return {
    columns,
    rows,
    sub:
      mode === 'week'
        ? "Final stock on hand vs each stall's target. Red is low, green is full."
        : "Stock on hand vs each stall's target. Red is low, green is full.",
    caption,
    ariaLabel: `Stock coverage heatmap for ${merchants.length} merchants across ${columns.length} goods. ${caption}`,
    emptyText: mode === 'week' ? 'The final stock map was not included in this preview.' : 'Waiting for merchant stock…',
  }
}

function buildLiveHeatmapView(current: PublicSnapshot): HeatmapView {
  const columns = heatmapColumns(current.merchants)
  const dayOpen: BaselineLookup = (merchant, itemId) => {
    const quote = current.daily.priceSnapshot[`${merchant.id}:${itemId}`]
    return quote?.ask ?? quote?.bid ?? null
  }
  const baseValue: BaselineLookup = (_merchant, itemId) => config?.items[itemId]?.baseValue ?? null
  return {
    mode: 'live',
    price: buildPriceHeatmapBoard(current.merchants, columns, dayOpen, 'day open', 'live'),
    usual: buildPriceHeatmapBoard(current.merchants, columns, baseValue, 'base value', 'live'),
    stock: buildStockHeatmapBoard(current.merchants, columns, 'live'),
  }
}

function buildWeekHeatmapView(payload: FastForwardClonePayload, startSnapshot: PublicSnapshot | null): HeatmapView {
  const finalMerchants = Array.isArray(payload.finalMerchants) ? payload.finalMerchants : []
  const startMerchants = new Map((startSnapshot?.merchants ?? []).map(merchant => [merchant.id, merchant]))
  const columns = heatmapColumns([...finalMerchants, ...(startSnapshot?.merchants ?? [])])
  const weekOpen: BaselineLookup = (merchant, itemId) => {
    const start = startMerchants.get(merchant.id)
    if (!start) return null
    return start.askPrices[itemId] ?? start.bidPrices[itemId] ?? null
  }
  const baseValue: BaselineLookup = (_merchant, itemId) => config?.items[itemId]?.baseValue ?? null
  return {
    mode: 'week',
    price: buildPriceHeatmapBoard(finalMerchants, columns, weekOpen, 'week open', 'week'),
    usual: buildPriceHeatmapBoard(finalMerchants, columns, baseValue, 'base value', 'week'),
    stock: buildStockHeatmapBoard(finalMerchants, columns, 'week'),
  }
}

/* ------------------------------------------------------------------ cash + flow rendering */

function moneyFlowChartSize(): { width: number; height: number } {
  const width = Math.max(240, Math.round($('money-chart').clientWidth || 480))
  return { width, height: Math.round(Math.max(200, Math.min(310, width * 0.56))) }
}

function flowChartSize(): { width: number; height: number } {
  const width = Math.max(240, Math.round($('flow-chart').clientWidth || 480))
  return { width, height: Math.round(Math.max(200, Math.min(310, width * 0.56))) }
}

function moneyFlowCaption(view: MoneyFlowView, revealCount: number): string {
  const revealed = view.points.slice(0, revealCount)
  if (revealed.length === 0) {
    return view.mode === 'week' ? 'The preview is unfolding — cash bars appear as each day closes.' : view.emptyText
  }
  const last = revealed[revealed.length - 1]
  const total = last.merchant + last.traveler
  const prefix = view.mode === 'week' ? (revealCount < view.points.length ? 'So far' : 'Week close') : 'Now'
  let text = `${prefix}: ${money0(last.merchant)} in merchant tills and ${money0(
    last.traveler,
  )} with travelers (${money0(total)} total).`
  if (revealed.length > 1) {
    const first = revealed[0]
    const change = total - (first.merchant + first.traveler)
    if (Math.abs(change) >= 0.5) {
      text += ` Total ${change > 0 ? 'up' : 'down'} ${money0(Math.abs(change))} since ${first.label}.`
    }
  }
  return text
}

function renderMoneyFlowCard(view: MoneyFlowView, revealCount: number, force = false): void {
  if (!force && activeMoneyFlowView === view && activeMoneyFlowReveal === revealCount) return
  activeMoneyFlowView = view
  activeMoneyFlowReveal = revealCount
  const size = moneyFlowChartSize()
  $('money-chart').innerHTML = renderMoneyFlowSvg(view.points, {
    width: size.width,
    height: size.height,
    revealCount,
    ariaLabel: view.ariaLabel,
    emptyText: view.emptyText,
    valueFormat: value => moneyCompact(value),
  })
  $('money-caption').textContent = moneyFlowCaption(view, revealCount)
}

function flowCaption(view: FlowView, revealCount: number): string {
  const revealed = view.points.slice(0, revealCount)
  if (revealed.length === 0) {
    return view.mode === 'week' ? 'The preview is unfolding — flow bars appear as each day closes.' : view.emptyText
  }
  const inflow = sum(revealed.map(point => point.inflow))
  const outflow = sum(revealed.map(point => point.outflow))
  const orders = sum(revealed.map(point => point.orders))
  const caravanIn = sum(revealed.map(point => point.caravanIn))
  const caravanOut = sum(revealed.map(point => point.caravanOut))
  const sinks = sum(revealed.map(point => point.sinks))
  const investments = sum(revealed.map(point => point.investments))
  const net = inflow - outflow
  const windowLabel = view.mode === 'week' ? (revealCount < view.points.length ? 'So far' : 'This week') : 'On record'
  let text = `${windowLabel}: ${money0(inflow)} entered and ${money0(outflow)} drained, net ${
    net >= 0 ? '+' : '−'
  }${money0(Math.abs(net))}.`
  text += ` Orders paid ${money0(orders)}; caravan sales ${money0(caravanOut)} in and ${money0(
    caravanIn,
  )} out; rent, tax, repairs and shocks ${money0(sinks)}.`
  if (investments > 0) text += ` Investments added ${money0(investments)}.`
  return text
}

function renderFlowCard(view: FlowView, revealCount: number, force = false): void {
  if (!force && activeFlowView === view && activeFlowReveal === revealCount) return
  activeFlowView = view
  activeFlowReveal = revealCount
  const size = flowChartSize()
  $('flow-chart').innerHTML = renderFlowSvg(view.points, {
    width: size.width,
    height: size.height,
    revealCount,
    ariaLabel: view.ariaLabel,
    emptyText: view.emptyText,
    valueFormat: value => moneyCompact(value),
  })
  $('flow-caption').textContent = flowCaption(view, revealCount)
}

/* ------------------------------------------------------------------ market map rendering */

function updateHeatmapToggle(): void {
  const toggle = $('heatmap-toggle')
  for (const button of toggle.querySelectorAll<HTMLButtonElement>('[data-heatmap]')) {
    const active = button.dataset.heatmap === heatmapMode
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', String(active))
  }
}

function nextHeatmapMode(mode: HeatmapMode): void {
  if (heatmapMode === mode) return
  heatmapMode = mode
  if (activeHeatmapView) {
    renderHeatmapCard(activeHeatmapView, true)
    return
  }
  updateHeatmapToggle()
  $('heatmap-legend').innerHTML = heatmapLegend(heatmapMode)
  if (viewMode === 'week' && weekRun) {
    renderHeatmapPlaceholder('The final market map appears when the preview finishes.', true)
  }
}

function heatmapLegend(mode: HeatmapMode): string {
  if (mode !== 'stock') {
    return `<span class="heat-legend-item"><i class="heat-swatch down"></i>Cheaper</span>
      <span class="heat-legend-item"><i class="heat-swatch flat"></i>Flat</span>
      <span class="heat-legend-item"><i class="heat-swatch up"></i>Dearer</span>`
  }
  return `<span class="heat-legend-item"><i class="heat-swatch low"></i>Low</span>
    <span class="heat-legend-item"><i class="heat-swatch mid"></i>Thin</span>
    <span class="heat-legend-item"><i class="heat-swatch high"></i>Full</span>`
}

function renderHeatmapCard(view: HeatmapView, force = false): void {
  const board = view[heatmapMode]
  const cells = board.rows
    .map(row => Object.values(row.cells).map(cell => `${cell.label}:${cell.tone}`).join(','))
    .join('|')
  const key = `${view.mode}|${heatmapMode}|${board.columns.length}|${board.rows.length}|${board.caption}|${cells}`
  if (!force && key === activeHeatmapKey) return
  activeHeatmapView = view
  activeHeatmapKey = key
  updateHeatmapToggle()
  $('heatmap-sub').textContent = board.sub
  $('heatmap-legend').innerHTML = heatmapLegend(heatmapMode)
  $('heatmap-chart').innerHTML = renderHeatmap({
    ariaLabel: board.ariaLabel,
    columns: board.columns,
    rows: board.rows,
    emptyText: board.emptyText,
  })
  $('heatmap-caption').textContent = board.caption
}

function renderHeatmapPlaceholder(text: string, force = false): void {
  if (!force && activeHeatmapKey === 'placeholder') return
  activeHeatmapView = null
  activeHeatmapKey = 'placeholder'
  updateHeatmapToggle()
  $('heatmap-sub').textContent =
    viewMode === 'week'
      ? 'Final simulated market state · the live town is unchanged.'
      : 'Every traded good by merchant; empty cells mean no quote or stock.'
  $('heatmap-legend').innerHTML = heatmapLegend(heatmapMode)
  $('heatmap-chart').innerHTML = `<p class="empty-note">${esc(text)}</p>`
  $('heatmap-caption').textContent =
    viewMode === 'week'
      ? 'This is a preview only; nothing here is applied or saved to the live town.'
      : 'Waiting for merchant quotes…'
}

function buildWeekWealthRows(payload: FastForwardClonePayload, startSnapshot: PublicSnapshot | null): WealthRowView[] {
  const startCash = new Map<MerchantId, number>(
    (startSnapshot?.merchants ?? []).map(merchant => [merchant.id, merchant.cash]),
  )
  const finalReserve = new Map<MerchantId, number>(
    (payload.finalMerchants ?? []).map(merchant => [merchant.id, merchant.reserve]),
  )
  const startReserve = new Map<MerchantId, number>(
    (startSnapshot?.merchants ?? []).map(merchant => [merchant.id, merchant.reserve]),
  )
  return (payload.recap.standings ?? [])
    .map(standing => ({
      id: standing.merchantId,
      name: standing.displayName,
      cash: standing.cash,
      reserve: finalReserve.get(standing.merchantId) ?? startReserve.get(standing.merchantId) ?? 0,
      delta: standing.cash - (startCash.get(standing.merchantId) ?? standing.cash),
      history: [
        ...(payload.summaries ?? []).map(summary => summary.merchantCash[standing.merchantId] ?? 0),
        standing.cash,
      ],
      open: standing.open,
      bankrupt: standing.bankrupt,
    }))
    .sort((left, right) => right.cash - left.cash)
}

function buildLiveWealthRows(current: PublicSnapshot): WealthRowView[] {
  return current.merchants
    .map(merchant => ({
      id: merchant.id,
      name: merchant.displayName,
      cash: merchant.cash,
      reserve: merchant.reserve,
      delta: merchant.cash - (current.daily.merchantCashStart[merchant.id] ?? merchant.cash),
      history: [
        ...current.summaries.slice(-7).map(summary => summary.merchantCash[merchant.id] ?? 0),
        merchant.cash,
      ],
      open: merchant.open,
      bankrupt: merchant.bankrupt,
    }))
    .sort((left, right) => right.cash - left.cash)
}

/* ------------------------------------------------------------------ market data rendering */

function signedPercent(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.round(value)
  if (rounded === 0) return '0%'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`
}

function visiblePriceItems(view: PriceView): PriceItemView[] {
  return view.items.filter(item => !hiddenPriceItems.has(item.id) && item.points.length > 0)
}

function priceChartSize(): { width: number; height: number } {
  const width = Math.max(280, Math.round($('price-chart-wrap').clientWidth || 900))
  const ratio = width < 560 ? 0.78 : 0.46
  const height = Math.round(Math.max(240, Math.min(560, width * ratio)))
  return { width, height }
}

function volumeChartSize(): { width: number; height: number } {
  const width = Math.max(220, Math.round($('volume-chart').clientWidth || 420))
  const height = Math.round(Math.max(190, Math.min(280, width * 0.68)))
  return { width, height }
}

function priceRevealBucket(view: PriceView, reveal: number): number {
  return clamp(Math.floor(clamp(reveal, 0, 1) * (view.labels.length - 1) + 1e-6), 0, view.labels.length - 1)
}

function priceCaption(view: PriceView, visible: PriceItemView[], reveal: number): string {
  if (view.items.length === 0) return view.emptyText
  if (visible.length === 0) return 'All price lines are hidden — choose an item above to bring one back.'
  const bucket = priceRevealBucket(view, reveal)
  const changes: Array<{ item: PriceItemView; first: PricePointView; last: PricePointView; change: number }> = []
  for (const item of visible) {
    const first = item.points[0]
    const revealed = item.points.filter(point => point.x <= bucket + 1e-6)
    const last = revealed[revealed.length - 1]
    if (!first || !last || last.x <= first.x) continue
    changes.push({ item, first, last, change: ((last.price - first.price) / first.price) * 100 })
  }
  if (changes.length === 0) {
    return view.mode === 'week'
      ? 'The week is unfolding — the first price line appears as the day closes.'
      : 'Waiting for enough recorded quotes to show a change.'
  }
  changes.sort((left, right) => Math.abs(right.change) - Math.abs(left.change))
  const biggest = changes[0]
  const second = changes[1]
  const percent = Math.max(1, Math.round(Math.abs(biggest.change)))
  const direction = biggest.change < 0 ? 'cheaper' : 'more expensive'
  const when =
    biggest.last.x >= view.labels.length - 1
      ? view.mode === 'week'
        ? 'over the week'
        : 'over the recorded days'
      : `by ${biggest.last.label.replace(/ close$/, '')}`
  let caption = `${biggest.item.label} got ${percent}% ${direction} ${when}.`
  if (second) {
    const secondPct = Math.max(1, Math.round(Math.abs(second.change)))
    if (secondPct >= 8) {
      if (Math.sign(second.change) === Math.sign(biggest.change)) {
        caption += ` ${second.item.label} also ${second.change < 0 ? 'fell' : 'rose'} ${secondPct}%.`
      } else {
        caption += ` ${second.item.label} moved ${second.change < 0 ? 'down' : 'up'} ${secondPct}%.`
      }
    } else {
      caption += ` ${second.item.label} barely moved.`
    }
  }
  return caption
}

function priceDayAria(view: PriceView, x: number, visible: PriceItemView[]): string {
  const label = view.labels[x] ?? 'Day'
  if (visible.length === 0) return `${label}: no price lines selected`
  const rows = visible.map(item => {
    const point = item.points.find(candidate => candidate.x === x)
    if (!point) return `${item.label}: no quote`
    if (x === 0 && view.mode === 'week') return `${item.label}: ${money(point.price)}, week opening ask`
    const change = ((point.price - item.base) / item.base) * 100
    return `${item.label}: ${money(point.price)}, ${signedPercent(change)} from its first quote`
  })
  return `${label}. ${rows.join('. ')}.`
}

function renderPriceLegend(view: PriceView): void {
  const legend = $('price-legend')
  if (view.items.length === 0) {
    legend.innerHTML = '<span class="legend-empty">No recorded item quotes yet.</span>'
    return
  }
  legend.innerHTML = view.items
    .map(item => {
      const shown = !hiddenPriceItems.has(item.id)
      return `<button class="price-key${shown ? '' : ' is-off'}" type="button" data-price-item="${esc(
        item.id,
      )}" aria-pressed="${shown}" aria-label="${esc(item.label)} — ${shown ? 'shown' : 'hidden'}. Click to ${
        shown ? 'hide' : 'show'
      }." style="--series-color:${item.color}">
        <span class="price-key-swatch" aria-hidden="true"></span>
        <span class="price-key-name">${esc(item.label)}</span>
      </button>`
    })
    .join('')
}

function renderPriceCard(view: PriceView, reveal: number, force = false): void {
  const known = new Set(view.items.map(item => item.id as string))
  for (const itemId of [...hiddenPriceItems]) {
    if (!known.has(itemId)) hiddenPriceItems.delete(itemId)
  }
  const signature = `${view.key}|${[...hiddenPriceItems].sort().join(',')}`
  if (force || signature !== activePriceSignature) {
    activePriceView = view
    activePriceReveal = reveal
    activePriceSignature = signature
    activeCaptionKey = ''
    renderPriceLegend(view)
    const visible = visiblePriceItems(view)
    const series: PriceSeries[] = visible.map(item => ({
      id: item.id,
      label: item.label,
      color: item.color,
      points: item.points.map(point => ({
        x: point.x,
        y: point.y,
        price: point.price,
        label: point.label,
      })),
    }))
    const size = priceChartSize()
    $('price-chart').innerHTML = renderPriceSvg(series, {
      width: size.width,
      height: size.height,
      labels: view.labels,
      reveal,
      ariaLabel: view.ariaLabel,
      emptyText:
        visible.length === 0 && view.items.length > 0
          ? 'All price lines are hidden — choose an item above.'
          : view.emptyText,
      valueFormat: value => money(value),
      dayAriaLabel: x => priceDayAria(view, x, visible),
    })
    $('price-range').textContent = view.mode === 'week' ? 'Seven simulated days' : 'Recorded market history'
    $('price-sub').textContent =
      view.mode === 'week'
        ? 'Each line starts at its week-opening ask. Hover or focus a day for exact prices.'
        : 'Each line starts at its first recorded ask. Hover or focus a day for exact prices.'
    $('price-source').textContent = view.sourceNote
  } else {
    activePriceView = view
    activePriceReveal = reveal
  }

  updatePriceReveal(reveal)
  const bucket = priceRevealBucket(view, reveal)
  const captionKey = `${signature}|${bucket}`
  if (captionKey !== activeCaptionKey) {
    activeCaptionKey = captionKey
    $('price-caption').textContent = priceCaption(view, visiblePriceItems(view), reveal)
  }
}

function updatePriceReveal(reveal: number): void {
  const chart = $('price-chart')
  const svg = chart.querySelector<SVGSVGElement>('svg')
  if (!svg) return
  const plotLeft = Number(svg.dataset.plotLeft)
  const plotWidth = Number(svg.dataset.plotWidth)
  if (!Number.isFinite(plotLeft) || !Number.isFinite(plotWidth)) return
  const fraction = clamp(reveal, 0, 1)
  const rect = svg.querySelector<SVGRectElement>('.price-clip-rect')
  if (rect) rect.setAttribute('width', (plotWidth * fraction).toFixed(1))
  const playhead = svg.querySelector<SVGLineElement>('.price-playhead')
  if (playhead) {
    const x = plotLeft + plotWidth * fraction
    playhead.setAttribute('x1', x.toFixed(1))
    playhead.setAttribute('x2', x.toFixed(1))
    playhead.style.opacity = fraction > 0 && fraction < 1 ? '1' : '0'
  }
  svg.classList.toggle('is-complete', fraction >= 1)
}

function showPriceTooltip(x: number, clientX: number, clientY: number): void {
  const view = activePriceView
  const tooltip = $('price-tooltip')
  const wrap = $('price-chart-wrap')
  if (!view || !view.labels[x]) return
  const visible = visiblePriceItems(view)
  const bucket = priceRevealBucket(view, activePriceReveal)
  const future = view.mode === 'week' && x > bucket + 1e-6
  const label = view.labels[x]
  const heading =
    future
      ? `${label} · still unfolding`
      : x === 0 && view.mode === 'week'
        ? `${label} · week opening ask`
        : `${label} · recorded quote`
  const rows =
    visible.length === 0
      ? '<p class="price-tip-empty">No price lines selected.</p>'
      : visible
          .map(item => {
            const point = future ? undefined : item.points.find(candidate => candidate.x === x)
            if (!point) {
              return `<div class="price-tip-row is-empty">
                <span class="price-tip-name"><span class="price-tip-swatch" style="--series-color:${item.color}" aria-hidden="true"></span>${esc(
                  item.label,
                )}</span>
                <span class="price-tip-value">${future ? 'not yet' : 'no quote'}</span>
              </div>`
            }
            const change = ((point.price - item.base) / item.base) * 100
            return `<div class="price-tip-row">
              <span class="price-tip-name"><span class="price-tip-swatch" style="--series-color:${item.color}" aria-hidden="true"></span>${esc(
                item.label,
              )}</span>
              <span class="price-tip-value"><b>${money(point.price)}</b><small>${signedPercent(
                change,
              )} vs first</small></span>
            </div>`
          })
          .join('')
  tooltip.innerHTML = `<div class="price-tip-head">${esc(heading)}</div>${rows}`
  tooltip.hidden = false
  const rect = wrap.getBoundingClientRect()
  const pointerX = clamp(clientX - rect.left, 0, rect.width)
  const width = tooltip.offsetWidth
  const half = Math.min(width / 2, Math.max(0, (rect.width - 16) / 2))
  const left = clamp(pointerX, 8 + half, Math.max(8 + half, rect.width - 8 - half))
  tooltip.style.left = `${left.toFixed(1)}px`
  tooltip.style.top = '10px'
  void clientY
}

function hidePriceTooltip(): void {
  const tooltip = $('price-tooltip')
  tooltip.hidden = true
  tooltip.innerHTML = ''
}

function wealthCaption(rows: WealthRowView[], mode: 'live' | 'week'): string {
  if (rows.length === 0) return 'Waiting for the merchant tills…'
  const gainers = rows.filter(row => row.delta > 0.5).length
  const losers = rows.filter(row => row.delta < -0.5).length
  const flat = rows.length - gainers - losers
  if (mode === 'week') {
    if (gainers === 0 && losers === 0) return 'Every till ended the week roughly where it started.'
    if (gainers === 0) return `${losers} till${losers === 1 ? '' : 's'} ended the week lighter; none ended richer.`
    if (losers === 0) return `${gainers} till${gainers === 1 ? '' : 's'} ended the week richer; none ended lighter.`
    return `${gainers} till${gainers === 1 ? '' : 's'} ended richer; ${losers} ended lighter${flat > 0 ? `; ${flat} held steady` : ''}.`
  }
  if (gainers === 0 && losers === 0) return 'No tills have moved yet today.'
  return `${gainers} till${gainers === 1 ? '' : 's'} up today; ${losers} down${flat > 0 ? `; ${flat} flat` : ''}.`
}

function updateWealthReveal(reveal: number): void {
  $('wealth-chart').style.setProperty('--reveal', String(clamp(reveal, 0, 1)))
}

function renderWealthCard(rows: WealthRowView[], reveal: number, mode: 'live' | 'week'): void {
  const chart = $('wealth-chart')
  chart.style.setProperty('--reveal', String(clamp(reveal, 0, 1)))
  $('wealth-sub').textContent =
    mode === 'week'
      ? 'Final cash · colour = change from week open · tick = reserve. Stock is in the market map.'
      : 'Cash now · colour = change today · tick = reserve. Stock is in the market map.'
  $('wealth-caption').textContent = wealthCaption(rows, mode)
  if (rows.length === 0) {
    chart.innerHTML = '<p class="empty-note">Waiting for the merchant tills…</p>'
    return
  }
  const maxCash = Math.max(1, ...rows.map(row => row.cash))
  chart.innerHTML = `<ul class="wealth-list">${rows
    .map(row => {
      const width = clamp((row.cash / maxCash) * 100, 0, 100)
      const reserve = clamp((row.reserve / maxCash) * 100, 0, 100)
      const tone = row.bankrupt ? 'closed' : row.delta > 0.5 ? 'up' : row.delta < -0.5 ? 'down' : 'flat'
      const delta =
        Math.abs(row.delta) < 0.5
          ? 'no change'
          : `${row.delta > 0 ? '+' : '−'}${moneyCompact(Math.abs(row.delta))}`
      const spark =
        row.history.length > 1
          ? `<span class="wealth-spark" title="${esc(
              row.history.map(value => money0(value)).join(' → '),
            )}">${renderSparkline(
              row.history.map((value, index) => ({ x: index, y: value })),
              { width: 58, height: 18, color: row.delta < -0.5 ? '#e07a6b' : '#9ad7b0' },
            )}</span>`
          : ''
      return `<li class="wealth-row${row.bankrupt ? ' is-closed' : ''}">
        <div class="wealth-top">
          <span class="wealth-name">${esc(row.name)}</span>
          <span class="wealth-figure">${spark}${money0(row.cash)} <em class="wealth-delta ${tone}">${esc(delta)}</em></span>
        </div>
        <div class="wealth-track"><span class="wealth-fill ${tone}" style="width:${width.toFixed(1)}%"></span><span class="wealth-reserve" style="left:${reserve.toFixed(
          1,
        )}%" title="Reserve floor: ${money0(row.reserve)}"></span></div>
      </li>`
    })
    .join('')}</ul>`
}

function volumeCaption(view: VolumeView, revealCount: number): string {
  if (view.points.length === 0) return view.emptyText
  const revealed = view.points.slice(0, revealCount)
  if (revealed.length === 0) return 'The week is unfolding — bars appear as each day closes.'
  const peak = revealed.reduce((best, point) => (point.volume > best.volume ? point : best), revealed[0])
  if (peak.volume <= 0) return 'No units have traded yet.'
  const label = peak.label === 'Today' ? 'Today' : peak.label
  const complete = revealCount >= view.points.length
  return complete
    ? `${label} was the busiest day with ${units(peak.volume)} units traded.`
    : `${label} is the busiest so far with ${units(peak.volume)} units.`
}

function renderVolumeCard(view: VolumeView, revealCount: number, force = false): void {
  if (!force && activeVolumeView === view && activeVolumeCount === revealCount) return
  activeVolumeView = view
  activeVolumeCount = revealCount
  $('volume-sub').textContent =
    view.mode === 'week'
      ? 'Units traded each day as the preview runs.'
      : 'Units traded each day; today is in progress.'
  const size = volumeChartSize()
  $('volume-chart').innerHTML = renderVolumeSvg(view.points, {
    width: size.width,
    height: size.height,
    revealCount,
    ariaLabel: view.ariaLabel,
    emptyText: view.emptyText,
    valueFormat: value => formatNumber(value),
  })
  $('volume-caption').textContent = volumeCaption(view, revealCount)
}

/* ------------------------------------------------------------------ bot activity chart */

interface BotActivityRow {
  id: string
  name: string
  trade: number
  gather: number
  order: number
  total: number
}

const isBotAction = (event: SequencedMarketEvent): boolean =>
  event.actor.type === 'bot' &&
  (event.type === 'bot.trade' || event.type === 'bot.gather' || event.type === 'order.fulfilled')

let activeActivitySignature = ''

function buildBotActivityRows(events: readonly SequencedMarketEvent[]): BotActivityRow[] {
  const rows = new Map<string, BotActivityRow>()
  for (const event of events) {
    if (!isBotAction(event)) continue
    const id = event.actor.id
    let row = rows.get(id)
    if (!row) {
      row = {
        id,
        name: event.actor.displayName ?? id,
        trade: 0,
        gather: 0,
        order: 0,
        total: 0,
      }
      rows.set(id, row)
    }
    if (event.type === 'bot.trade') row.trade += 1
    else if (event.type === 'bot.gather') row.gather += 1
    else row.order += 1
    row.total += 1
  }
  if (rows.size > 0) {
    characters.forEach((character, index) => {
      const id = botIdForIndex(index)
      if (rows.has(id)) return
      rows.set(id, {
        id,
        name: character.displayName,
        trade: 0,
        gather: 0,
        order: 0,
        total: 0,
      })
    })
  }
  return [...rows.values()].sort((left, right) => right.total - left.total || left.name.localeCompare(right.name))
}

function setActivityCopy(mode: 'live' | 'week'): void {
  $('activity-title').textContent = 'Bot activity'
  $('activity-sub').textContent =
    mode === 'week'
      ? 'Sampled actions from the preview; the daily volume bars count every trade.'
      : 'Trades, gathers and deliveries by the eight townsfolk.'
  const hint = $('activity-hint')
  hint.textContent = mode === 'week' ? 'Preview sample' : 'Session actions'
  hint.title =
    mode === 'week'
      ? 'The fast-forward payload samples events; daily summaries carry every trade.'
      : 'Only actions recorded in this browser session are shown.'
}

function renderBotActivity(events: readonly SequencedMarketEvent[], force = false): void {
  const relevant = events.filter(isBotAction)
  const rows = buildBotActivityRows(relevant)
  const latest = relevant[relevant.length - 1]
  const signature = `${viewMode}|${rows.map(row => `${row.id}:${row.trade}:${row.gather}:${row.order}`).join('|')}|${latest?.id ?? ''}`
  if (!force && signature === activeActivitySignature) return
  activeActivitySignature = signature

  const chart = $('activity-chart')
  const caption = $('activity-caption')
  const latestEl = $('activity-latest')

  if (rows.length === 0) {
    chart.innerHTML = '<p class="activity-empty">No bot actions in the feed yet. The townsfolk start trading as the market moves.</p>'
    caption.textContent = 'No bot actions recorded yet.'
    latestEl.textContent = 'Waiting for the townsfolk…'
    latestEl.title = ''
    return
  }

  const max = Math.max(...rows.map(row => row.total), 1)
  const tradeValue = relevant.reduce((sum, event) => {
    if (event.type !== 'bot.trade') return sum
    return sum + (event.price ?? 0) * (event.quantity ?? 0)
  }, 0)
  const trades = rows.reduce((sum, row) => sum + row.trade, 0)
  const gathers = rows.reduce((sum, row) => sum + row.gather, 0)
  const orders = rows.reduce((sum, row) => sum + row.order, 0)

  chart.innerHTML = `<ul class="activity-list">${rows
    .map(row => {
      const segment = (count: number, kind: string): string => {
        if (count === 0) return ''
        const label =
          kind === 'order'
            ? countLabel(count, 'delivery', 'deliveries')
            : countLabel(count, kind)
        return `<span class="activity-seg ${kind}" style="width:${((count / max) * 100).toFixed(1)}%" title="${label}"></span>`
      }
      return `<li class="activity-row" title="${esc(
        `${row.name}: ${countLabel(row.trade, 'trade')} · ${countLabel(row.gather, 'gather')} · ${countLabel(row.order, 'delivery', 'deliveries')}`,
      )}">
        <span class="activity-name">${esc(row.name)}</span>
        <span class="activity-track">${segment(row.trade, 'trade')}${segment(row.gather, 'gather')}${segment(row.order, 'order')}</span>
        <span class="activity-total">${row.total}</span>
      </li>`
    })
    .join('')}</ul>
    <div class="activity-legend" aria-hidden="true">
      <span class="activity-legend-item"><i class="activity-swatch trade"></i>${countLabel(trades, 'trade')}</span>
      <span class="activity-legend-item"><i class="activity-swatch gather"></i>${countLabel(gathers, 'gather')}</span>
      <span class="activity-legend-item"><i class="activity-swatch order"></i>${countLabel(orders, 'delivery', 'deliveries')}</span>
    </div>`

  caption.textContent =
    viewMode === 'week'
      ? `${countLabel(relevant.length, 'sampled action')} · preview events are sampled; daily summaries count every trade.`
      : `${countLabel(relevant.length, 'recorded action')} · ${money0(tradeValue)} moved in bot trades.`
  latestEl.innerHTML = `<span class="activity-dot" aria-hidden="true"></span>${esc(latest?.message ?? '')}`
  latestEl.title = latest?.message ?? ''
}

/* ------------------------------------------------------------------ live story feed */

function buildLiveStory(): StoryItem[] {
  if (!snapshot) return []
  const current = snapshot
  const stories: StoryItem[] = [todayStory(current)]

  const events = eventBuffer.filter(isStoryEvent).slice(-18)
  for (const event of events) {
    stories.push(eventStory(event))
  }

  if (events.length === 0 && current.tape.length > 0) {
    current.tape.slice(0, 12).forEach((trade, index) => {
      stories.push(tapeStory(trade, index))
    })
  }

  return dedupeStories(stories).sort((left, right) => right.time - left.time)
}

function todayStory(current: PublicSnapshot): StoryItem {
  const open = openStalls(current)
  const cash = townCash(current)
  const closures = current.daily.bankruptcies.length
  const title =
    closures > 0
      ? `Day ${current.day} so far: ${closures} stall${closures === 1 ? '' : 's'} closed`
      : `Day ${current.day} so far: ${units(current.daily.trades.volume)} units traded`
  const detailHtml = `<div class="mini-stats">
    <div><span>Cash in town</span><b>${money0(cash)}</b></div>
    <div><span>Stalls open</span><b>${open} of ${current.merchants.length}</b></div>
    <div><span>Townsfolk trades</span><b>${units(current.daily.botTrades)}</b></div>
    <div><span>Caravans</span><b>${current.daily.caravan.arrivals}</b></div>
  </div>
  <p class="story-meta-line">Snapshot at ${timeLabel(current.time)} · ${units(current.daily.trades.volume)} units traded today.</p>`

  return {
    id: `today:${current.day}`,
    time: current.time,
    day: current.day,
    kind: 'Today',
    tone: closures > 0 ? 'risk' : 'day',
    title,
    detailHtml,
  }
}

function tapeStory(
  trade: { time: number; day: number; side: 'buy' | 'sell'; traderName: string; merchantName: string | null; item: ItemId; quantity: number; unitPrice: number },
  index: number,
): StoryItem {
  const title = `${trade.traderName} ${trade.side === 'buy' ? 'bought' : 'sold'} ${trade.quantity} ${itemLabel(
    trade.item,
  )} ${trade.side === 'buy' ? 'from' : 'to'} ${trade.merchantName ?? 'a stall'}`
  const detailHtml = `<div class="mini-stats">
    <div><span>Unit price</span><b>${money(trade.unitPrice)}</b></div>
    <div><span>Quantity</span><b>${trade.quantity}</b></div>
    <div><span>Total</span><b>${money(trade.unitPrice * trade.quantity)}</b></div>
  </div>`
  return {
    id: `tape:${trade.day}:${index}`,
    time: trade.time,
    day: trade.day,
    kind: 'Trade',
    tone: 'trade',
    title,
    detailHtml,
  }
}

/* ------------------------------------------------------------------ week story feed */

function buildWeekStory(payload: FastForwardClonePayload): StoryItem[] {
  const series = weekSeries(payload)
  const annotations = payload.annotations ?? []
  const events = payload.events ?? []
  const eventById = new Map(events.map(event => [event.id, event]))
  const annotationEventIds = new Set<string>()

  const selected: StoryItem[] = series.map(point => seriesStory(point))
  const selectedIds = new Set(selected.map(item => item.id))
  const candidates: StoryCandidate[] = []

  for (const annotation of annotations) {
    if (annotation.kind === 'day-close' || annotation.kind === 'summary') continue
    if (annotation.eventId) annotationEventIds.add(annotation.eventId)
    const event = annotation.eventId ? eventById.get(annotation.eventId) : undefined
    candidates.push({
      item: annotationStory(annotation, event),
      priority: annotationPriority(annotation.kind),
    })
  }

  for (const event of events) {
    if (annotationEventIds.has(event.id) || !isStoryEvent(event)) continue
    candidates.push({ item: eventStory(event), priority: eventPriority(event.type) })
  }

  const byDay = new Map<number, StoryCandidate[]>()
  for (const candidate of candidates) {
    const list = byDay.get(candidate.item.day) ?? []
    list.push(candidate)
    byDay.set(candidate.item.day, list)
  }

  for (const list of byDay.values()) {
    list.sort((left, right) => left.priority - right.priority || left.item.time - right.item.time)
    for (const candidate of list.slice(0, 2)) {
      if (selectedIds.has(candidate.item.id)) continue
      selected.push(candidate.item)
      selectedIds.add(candidate.item.id)
    }
  }

  const leftovers = candidates
    .filter(candidate => !selectedIds.has(candidate.item.id))
    .sort((left, right) => left.priority - right.priority || left.item.time - right.item.time)
  while (selected.length < 15 && leftovers.length > 0) {
    const next = leftovers.shift()
    if (!next) break
    selected.push(next.item)
    selectedIds.add(next.item.id)
  }

  selected.push(weekCompleteStory(payload))

  while (selected.length > 20) {
    let dropAt = -1
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const item = selected[index]
      if (!item.id.startsWith('day:') && item.id !== 'week-complete') {
        dropAt = index
        break
      }
    }
    if (dropAt < 0) break
    selected.splice(dropAt, 1)
  }

  return selected.sort((left, right) => left.time - right.time || left.id.localeCompare(right.id))
}

function seriesStory(point: {
  day: number
  endedAt: number
  totalMerchantCash: number
  totalPlayerCash: number
  tradeVolume: number
  tradeValue: number
  bankruptcies: number
  caravanArrivals: number
  sinkTotal: number
}): StoryItem {
  const cash = point.totalMerchantCash + point.totalPlayerCash
  const closures = point.bankruptcies
  const title =
    closures > 0
      ? `Day ${point.day} closed with ${closures} stall${closures === 1 ? '' : 's'} shut`
      : `Day ${point.day} closed after ${units(point.tradeVolume)} units changed hands`
  const detailHtml = `<div class="mini-stats">
    <div><span>Cash in town</span><b>${money0(cash)}</b></div>
    <div><span>Traded</span><b>${units(point.tradeVolume)} units</b></div>
    <div><span>Trade value</span><b>${money0(point.tradeValue)}</b></div>
    <div><span>Caravans</span><b>${point.caravanArrivals}</b></div>
    <div><span>Rent + tax</span><b>${money0(point.sinkTotal)}</b></div>
    <div><span>Closures</span><b>${closures}</b></div>
  </div>
  <p class="story-meta-line">Day ${point.day} summary · ${timeLabel(point.endedAt)} · end-of-day totals.</p>`

  return {
    id: `day:${point.day}`,
    time: point.endedAt,
    day: point.day,
    kind: 'Day close',
    tone: closures > 0 ? 'risk' : 'day',
    title,
    detailHtml,
  }
}

function weekCompleteStory(payload: FastForwardClonePayload): StoryItem {
  const recap = payload.recap
  const series = weekSeries(payload)
  const last = series[series.length - 1]
  const closures = sum(series.map(point => point.bankruptcies))
  const story = (recap.story ?? []).slice(0, 4).map(line => `<li>${esc(line)}</li>`).join('')
  const detailHtml = `<ul class="week-story">${story}</ul>
    <div class="mini-stats">
      <div><span>Cash in town</span><b>${money0(last ? last.totalMerchantCash + last.totalPlayerCash : recap.cashInCirculation)}</b></div>
      <div><span>Units traded</span><b>${units(recap.trades.volume)}</b></div>
      <div><span>Stall closures</span><b>${closures}</b></div>
      <div><span>Caravan arrivals</span><b>${recap.caravan.totalArrivals}</b></div>
    </div>
    <p class="story-meta-line">Throwaway 7-day clone · seed ${esc(payload.seed)} · result not saved</p>`

  return {
    id: 'week-complete',
    time: payload.toTime + 1,
    day: payload.endDay,
    kind: 'Preview complete',
    tone: closures > 0 ? 'risk' : 'good',
    title: `Seven days later — ${recap.headline}`,
    detailHtml,
  }
}

function annotationStory(annotation: FastForwardAnnotation, event?: SequencedMarketEvent): StoryItem {
  const detail = `<p class="story-why-text">${esc(annotation.chain)}</p>${event ? eventDetailHtml(event) : ''}`
  return {
    id: `annotation:${annotation.kind}:${annotation.sequence}:${annotation.time}`,
    time: annotation.time,
    day: annotation.day || dayOf(annotation.time),
    kind: annotationKindLabel(annotation.kind),
    tone: annotationTone(annotation.kind),
    title: annotation.title,
    detailHtml: detail,
  }
}

function eventStory(event: SequencedMarketEvent): StoryItem {
  return {
    id: `event:${event.id}`,
    time: event.time,
    day: dayOf(event.time),
    kind: eventKindLabel(event.type),
    tone: eventTone(event.type),
    title: event.message,
    detailHtml: eventDetailHtml(event),
  }
}

function eventDetailHtml(event: SequencedMarketEvent): string {
  const reasons = event.reasons
    .slice(0, 4)
    .map(reason => {
      const effect =
        Number.isFinite(reason.effect) && reason.effect !== 0
          ? `<span class="reason-effect ${reason.effect > 0 ? 'up' : 'down'}">${reason.effect > 0 ? '+' : '−'}${money(
              Math.abs(reason.effect),
            )}</span>`
          : ''
      const detail = reason.detail ? `<small>${esc(reason.detail)}</small>` : ''
      return `<li><span>${esc(reason.label)}</span>${effect}${detail}</li>`
    })
    .join('')

  const rows: string[] = []
  const snapRow = (label: string, before: number | null, after: number | null, format: (value: number) => string): void => {
    if (before === null && after === null) return
    const left = before === null ? '—' : format(before)
    const right = after === null ? '—' : format(after)
    rows.push(`<div><span>${esc(label)}</span><b>${esc(left)} → ${esc(right)}</b></div>`)
  }
  snapRow('Cash', event.before.cash, event.after.cash, value => money(value))
  snapRow('Stock', event.before.stock, event.after.stock, value => `${units(value)} units`)
  snapRow('Ask', event.before.ask, event.after.ask, value => money(value))
  snapRow('Bid', event.before.bid, event.after.bid, value => money(value))

  return `<div class="story-detail-grid">
      <div>
        <h4>Why it moved</h4>
        ${reasons ? `<ul class="why-list">${reasons}</ul>` : '<p class="story-note">No causal breakdown was recorded for this event.</p>'}
      </div>
      <div>
        <h4>Snapshot</h4>
        ${rows.length > 0 ? `<div class="snapshot-list">${rows.join('')}</div>` : '<p class="story-note">No price or stock snapshot.</p>'}
      </div>
    </div>
    <p class="story-meta-line">${esc(event.type)} · sequence ${event.sequence}</p>`
}

function dedupeStories(stories: StoryItem[]): StoryItem[] {
  const byId = new Map<string, StoryItem>()
  for (const story of stories) byId.set(story.id, story)
  return [...byId.values()]
}

function renderStoryFeed(items: StoryItem[], newIds = new Set<string>()): void {
  const list = $('story-feed')
  const empty = $('story-empty')
  const sorted = [...items].sort((left, right) => right.time - left.time || right.id.localeCompare(left.id))
  if (sorted.length === 0) {
    list.innerHTML = ''
    empty.hidden = false
    empty.textContent =
      viewMode === 'week'
        ? 'The first simulated day is still unfolding…'
        : 'No market events yet. Run a week to see the town in motion.'
    return
  }
  empty.hidden = true
  list.innerHTML = sorted
    .map((item, index) => {
      const open = item.id === selectedStoryId
      return `<li class="story-item tone-${item.tone}${newIds.has(item.id) ? ' is-new' : ''}${open ? ' open' : ''}">
        <button class="story-row" type="button" data-story-toggle data-story-id="${esc(item.id)}" data-story-index="${index}" aria-expanded="${open}" aria-controls="story-detail-${index}">
          <span class="story-mark" aria-hidden="true"></span>
          <span class="story-copy">
            <span class="story-meta"><span class="story-kind">${esc(item.kind)}</span><span class="story-time">Day ${item.day} · ${timeLabel(item.time)}</span></span>
            <span class="story-title">${esc(item.title)}</span>
          </span>
          <span class="story-chev" aria-hidden="true">⌄</span>
        </button>
        <div class="story-detail" id="story-detail-${index}" ${open ? '' : 'hidden'}>${item.detailHtml}</div>
      </li>`
    })
    .join('')
}

/* ------------------------------------------------------------------ event labels + priority */

const STORY_SKIP = new Set<MarketEventType>([
  'merchant.restock',
  'merchant.price',
  'sink.rent',
  'sink.tax',
  'player.gather',
  'player.craft',
  'player.repair',
  'player.use',
  'player.withdraw',
  'bot.gather',
  'system.configuration',
])

const isStoryEvent = (event: SequencedMarketEvent): boolean => !STORY_SKIP.has(event.type)

function eventPriority(type: MarketEventType): number {
  if (type === 'merchant.bankrupt' || type === 'merchant.reopen') return 0
  if (
    type === 'merchant.investment' ||
    type === 'merchant.distribution' ||
    type === 'merchant.recovery' ||
    type === 'system.shock' ||
    type === 'order.created' ||
    type === 'order.accepted' ||
    type === 'order.fulfilled' ||
    type === 'order.expired'
  ) {
    return 1
  }
  if (type === 'caravan.arrival') return 2
  if (type === 'trade.buy' || type === 'trade.sell' || type === 'bot.trade') return 3
  return 4
}

function annotationPriority(kind: FastForwardAnnotation['kind']): number {
  if (kind === 'bankruptcy' || kind === 'reopen') return 0
  if (kind === 'recovery' || kind === 'distribution' || kind === 'order-expired') return 1
  if (kind === 'caravan') return 2
  if (kind === 'rent') return 3
  return 4
}

function eventKindLabel(type: MarketEventType): string {
  if (type === 'trade.buy' || type === 'trade.sell') return 'Player trade'
  if (type === 'bot.trade') return 'Townsfolk trade'
  if (type === 'merchant.bankrupt') return 'Stall closed'
  if (type === 'merchant.reopen') return 'Stall reopened'
  if (type === 'merchant.investment') return 'Investment'
  if (type === 'merchant.distribution') return 'Profit share'
  if (type === 'merchant.recovery') return 'Recovery'
  if (type === 'caravan.arrival') return 'Caravan'
  if (type.startsWith('order.')) return 'Order board'
  if (type === 'player.join') return 'Traveler'
  if (type === 'system.shock') return 'Market shock'
  if (type === 'system.fast-forward') return 'Preview'
  return 'Market'
}

function eventTone(type: MarketEventType): StoryTone {
  if (type === 'merchant.bankrupt' || type === 'system.shock') return 'risk'
  if (
    type === 'merchant.reopen' ||
    type === 'merchant.investment' ||
    type === 'merchant.distribution' ||
    type === 'merchant.recovery'
  ) {
    return 'good'
  }
  if (type === 'caravan.arrival' || type.startsWith('order.')) return 'money'
  if (type === 'trade.buy' || type === 'trade.sell' || type === 'bot.trade') return 'trade'
  return 'neutral'
}

function annotationKindLabel(kind: FastForwardAnnotation['kind']): string {
  if (kind === 'bankruptcy') return 'Stall closed'
  if (kind === 'reopen') return 'Stall reopened'
  if (kind === 'caravan') return 'Caravan'
  if (kind === 'rent') return 'Rent'
  if (kind === 'recovery') return 'Recovery'
  if (kind === 'distribution') return 'Profit share'
  if (kind === 'order-expired') return 'Order expired'
  return 'Market beat'
}

function annotationTone(kind: FastForwardAnnotation['kind']): StoryTone {
  if (kind === 'bankruptcy') return 'risk'
  if (kind === 'reopen' || kind === 'recovery' || kind === 'distribution') return 'good'
  if (kind === 'caravan') return 'money'
  if (kind === 'rent') return 'day'
  return 'neutral'
}

/* ------------------------------------------------------------------ fast-forward */

async function startFastForward(): Promise<void> {
  if (!feed || runningRequest) return
  const token = ++fastForwardToken
  runningRequest = true
  const button = $('ff-run') as HTMLButtonElement
  const skip = $('ff-skip') as HTMLButtonElement
  button.disabled = true
  button.textContent = 'Simulating…'
  skip.hidden = true
  showRunStrip('Cloning the town and running seven days…')
  setProgress(0, 'Starting the preview')

  let started = false
  try {
    const payload = await withTimeout(
      feed.runFastForward(7),
      20_000,
      'The simulation took longer than 20 seconds.',
    )
    if (token !== fastForwardToken) return
    if (!payload || payload.ok !== true) throw new Error('The server did not return a completed week.')
    lastFastForward = payload
    weekRun?.playback?.destroy()
    startWeekRun(payload)
    started = true
  } catch (cause) {
    if (token === fastForwardToken) showRunError(cause)
  } finally {
    if (token === fastForwardToken) {
      runningRequest = false
      if (!started) {
        button.disabled = false
        button.textContent = 'Try again'
      }
    }
  }
}

function startWeekRun(payload: FastForwardClonePayload): void {
  const startSnapshot = snapshot
  const startCash = startSnapshot ? townCash(startSnapshot) : 0
  const startOpen = startSnapshot ? openStalls(startSnapshot) : recapOpenStalls(payload.recap)
  const state: WeekRun = {
    payload,
    series: weekSeries(payload),
    playback: null,
    story: buildWeekStory(payload),
    startCash,
    startOpen,
    startPrices: startSnapshot ? averageAskByItem(startSnapshot) : new Map(),
    startMerchantCash: new Map((startSnapshot?.merchants ?? []).map(merchant => [merchant.id, merchant.cash])),
    priceView: buildWeekPriceView(payload, startSnapshot),
    volumeView: buildWeekVolumeView(payload),
    moneyFlowView: buildWeekMoneyFlowView(payload),
    flowView: buildWeekFlowView(payload),
    heatmapView: buildWeekHeatmapView(payload, startSnapshot),
    wealthRows: buildWeekWealthRows(payload, startSnapshot),
    reopenCount: 0,
    mirror: new Map(),
    renderedDay: -1,
    renderedOpen: -1,
    revealedStoryCount: 0,
    renderedVolumeDays: -1,
  }
  weekRun = state
  viewMode = 'week'
  renderModeBadge()
  setActivityCopy('week')
  selectedStoryId = null
  activePriceView = null
  activePriceSignature = ''
  activePriceReveal = 0
  activeCaptionKey = ''
  activeVolumeView = null
  activeVolumeCount = -1
  activeMoneyFlowView = null
  activeMoneyFlowReveal = -1
  activeFlowView = null
  activeFlowReveal = -1
  activeHeatmapView = null
  activeHeatmapKey = ''
  renderWealthCard(state.wealthRows, 0, 'week')

  $('hero-context').textContent = 'Simulated 7-day preview · not saved'
  $('view-live').hidden = false
  $('ff-strip').hidden = false
  $('ff-strip').classList.remove('is-error')
  $('ff-run').disabled = true
  $('ff-run').textContent = 'Playing preview…'
  $('ff-skip').hidden = false
  setProgress(0, `Preview day 1 of ${payload.days}`)
  setRunStatus(`Preview day 1 of ${payload.days} · live town not changed or saved.`)
  renderWeekFrame(state, payload.fromTime, false, true)

  const playback = new FastForwardPlayback(
    payload,
    {
      onReveal(item: PlaybackItem) {
        if (weekRun !== state) return
        if (item.kind === 'event' && item.event) {
          applyMirror(item.event, state.mirror)
          if (item.event.type === 'merchant.reopen') state.reopenCount += 1
        }
      },
      onProgress(progress: PlaybackProgress) {
        if (weekRun !== state) return
        const dayLabel = progress.phase === 'done' ? 'Preview complete' : progressLabel(state, progress.simTime)
        setProgress(progress.percent, dayLabel)
        setRunStatus(progress.phase === 'done' ? `${dayLabel} · live town unchanged · not saved.` : `${dayLabel} · not saved.`)
        renderWeekFrame(state, progress.simTime, progress.phase === 'done', false)
      },
      onDone() {
        if (weekRun !== state) return
        finishWeekRun(state)
      },
    },
    { wallSeconds: 7 },
  )
  state.playback = playback
  playback.start()
}

function progressLabel(state: WeekRun, simTime: number): string {
  return `Preview day ${previewDayOf(state, simTime)} of ${state.payload.days}`
}

function previewDayOf(state: WeekRun, simTime: number): number {
  const elapsed = Math.max(0, simTime - state.payload.fromTime)
  return clamp(Math.floor(elapsed / 86400) + 1, 1, state.payload.days)
}

function dayForWeek(state: WeekRun, simTime: number): number {
  return clamp(dayOf(simTime), state.payload.startDay, state.payload.endDay)
}

function renderWeekFrame(state: WeekRun, simTime: number, complete: boolean, force = false): void {
  const payload = state.payload
  const series = state.series
  const revealed = complete ? series : series.filter(point => point.endedAt <= simTime + 1e-6)
  const day = complete ? payload.endDay : dayForWeek(state, simTime)
  const preview = complete ? payload.days : previewDayOf(state, simTime)
  const closures = sum(revealed.map(point => point.bankruptcies))
  const totalStalls = payload.recap.standings.length
  const open = complete
    ? recapOpenStalls(payload.recap)
    : clamp(state.startOpen - closures + state.reopenCount, 0, totalStalls)
  const last = revealed[revealed.length - 1]
  const cash = last ? last.totalMerchantCash + last.totalPlayerCash : state.startCash
  const traded = sum(revealed.map(point => point.tradeVolume))
  const revealedStory = complete
    ? state.story
    : state.story.filter(item => item.time <= simTime + 1e-6)
  const revealedActivity = complete
    ? payload.events ?? []
    : (payload.events ?? []).filter(event => event.time <= simTime + 1e-6)
  renderBotActivity(revealedActivity, force)

  const changed =
    force ||
    day !== state.renderedDay ||
    open !== state.renderedOpen ||
    revealedStory.length !== state.revealedStoryCount

  const elapsed = Math.max(0, simTime - payload.fromTime)
  const duration = Math.max(1, payload.toTime - payload.fromTime)
  const smoothReveal = complete ? 1 : clamp(elapsed / duration, 0, 1)
  const stepReveal = complete ? 1 : clamp(revealed.length / Math.max(1, payload.days), 0, 1)
  const chartReveal = reducedMotionQuery.matches ? stepReveal : smoothReveal
  renderPriceCard(state.priceView, chartReveal)
  renderVolumeCard(state.volumeView, complete ? state.volumeView.points.length : revealed.length)
  renderMoneyFlowCard(state.moneyFlowView, complete ? state.moneyFlowView.points.length : revealed.length)
  renderFlowCard(state.flowView, complete ? state.flowView.points.length : revealed.length)
  if (complete) renderHeatmapCard(state.heatmapView, force)
  else renderHeatmapPlaceholder('The final market map appears when the preview finishes.')
  updateWealthReveal(chartReveal)

  if (!changed) return

  const status = weekStatus(state, revealed, cash, open, complete)
  renderClock(day, true)
  renderHero({
    title: status.title,
    tone: status.tone,
    day,
    daySub: complete ? `${payload.days} simulated days · town day ${day} · not saved` : `preview day ${preview} of ${payload.days}`,
    open,
    openSub: `of ${totalStalls} merchant stalls`,
    cash,
    cashSub: 'stall tills + traveler wallets',
    volume: traded,
    volumeSub: complete ? 'units this week' : 'units so far',
  })
  const newIds = new Set(revealedStory.slice(state.revealedStoryCount).map(item => item.id))
  if (newIds.size > 0 || complete || force) {
    renderStoryFeed(revealedStory, newIds)
  }

  state.renderedDay = day
  state.renderedOpen = open
  state.revealedStoryCount = revealedStory.length
  const wrap = $('ff-progress-wrap')
  wrap.setAttribute('aria-valuetext', complete ? 'Preview complete · not saved' : `Preview day ${preview} of ${payload.days}`)
}

function weekStatus(
  state: WeekRun,
  revealed: WeekSeriesPoint[],
  cash: number,
  open: number,
  complete: boolean,
): { title: string; tone: StoryTone } {
  const closures = sum(state.series.map(point => point.bankruptcies))
  if (complete) {
    if (closures > 0 && cash < state.startCash) {
      return { title: 'The week took its toll.', tone: 'risk' }
    }
    if (cash > state.startCash * 1.02) {
      return { title: 'The week ends richer.', tone: 'good' }
    }
    if (closures > 0) {
      return { title: 'The week ends with scars.', tone: 'risk' }
    }
    return { title: 'The week ends quietly.', tone: 'neutral' }
  }
  if (open < state.payload.recap.standings.length) {
    return { title: 'The market is under pressure.', tone: 'risk' }
  }
  const last = revealed[revealed.length - 1]
  if (last && last.bankruptcies === 0 && last.tradeVolume > 0) {
    return { title: 'The market is thriving.', tone: 'good' }
  }
  return { title: 'Seven days are unfolding.', tone: 'neutral' }
}

function finishWeekRun(state: WeekRun): void {
  if (weekRun !== state) return
  const payload = state.payload
  renderWeekFrame(state, payload.toTime, true, true)
  setProgress(100, 'Preview complete · not saved')
  $('ff-status').textContent = payload.live?.unchanged
    ? 'Preview complete · live town unchanged · result not saved.'
    : 'Preview complete · live world changed while the clone ran · result not saved.'
  $('ff-run').disabled = false
  $('ff-run').textContent = 'Preview 7 days'
  $('ff-skip').hidden = true
  $('ff-strip').classList.remove('is-error')
  renderMerchantCards(merchantOverridesFromRecap(payload.recap))
  renderNewspaper(payload.recap, true)
  renderRunProof()
}

function applyMirror(event: SequencedMarketEvent, mirror: Map<MerchantId, MerchantMirror>): void {
  if (event.type !== 'trade.buy' && event.type !== 'trade.sell' && event.type !== 'bot.trade') {
    if (event.type === 'merchant.bankrupt') {
      mirror.set(event.actor.id, { ...mirror.get(event.actor.id), open: false, bankrupt: true, cash: event.after.cash ?? 0 })
    } else if (event.type === 'merchant.reopen') {
      mirror.set(event.actor.id, { ...mirror.get(event.actor.id), open: true, bankrupt: false })
    }
    return
  }
  const merchantId = merchantOfEvent(event)
  if (!merchantId) return
  mirror.set(merchantId, {
    ...mirror.get(merchantId),
    cash: event.after.cash ?? mirror.get(merchantId)?.cash,
  })
}

function merchantOfEvent(event: SequencedMarketEvent): MerchantId | null {
  if (!config) return null
  const tape = buildTape([event], NO_ALIASES, config)
  return tape[0]?.merchantId ?? null
}

function merchantOverridesFromRecap(recap: Recap): Map<MerchantId, MerchantMirror> {
  const overrides = new Map<MerchantId, MerchantMirror>()
  for (const standing of recap.standings ?? []) {
    overrides.set(standing.merchantId, {
      cash: standing.cash,
      open: standing.open,
      bankrupt: standing.bankrupt,
    })
  }
  return overrides
}

function showRunStrip(text: string): void {
  $('ff-strip').hidden = false
  $('ff-strip').classList.remove('is-error')
  setRunStatus(text)
}

function setRunStatus(text: string): void {
  const status = $('ff-status')
  if (status.textContent !== text) status.textContent = text
}

function showRunError(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause)
  $('ff-strip').hidden = false
  $('ff-strip').classList.add('is-error')
  $('ff-status').textContent = `The week could not run: ${message} The page is still usable — try again when ready.`
  setProgress(0, 'Not started')
  $('ff-skip').hidden = true
  $('ff-run').disabled = false
  $('ff-run').textContent = 'Try again'
}

function setProgress(percent: number, valueText?: string): void {
  const value = clamp(percent, 0, 100)
  const fill = $('ff-progress')
  fill.style.width = `${value.toFixed(1)}%`
  const wrap = $('ff-progress-wrap')
  wrap.setAttribute('aria-valuenow', String(Math.round(value)))
  if (valueText) wrap.setAttribute('aria-valuetext', valueText)
}

function returnToLive(): void {
  fastForwardToken += 1
  runningRequest = false
  weekRun?.playback?.destroy()
  weekRun = null
  viewMode = 'live'
  renderModeBadge()
  selectedStoryId = null
  activePriceView = null
  activePriceSignature = ''
  activePriceReveal = 1
  activeCaptionKey = ''
  activeVolumeView = null
  activeVolumeCount = -1
  activeMoneyFlowView = null
  activeMoneyFlowReveal = -1
  activeFlowView = null
  activeFlowReveal = -1
  activeHeatmapView = null
  activeHeatmapKey = ''
  $('ff-strip').hidden = true
  $('ff-strip').classList.remove('is-error')
  $('ff-status').textContent = 'Ready.'
  $('ff-skip').hidden = true
  $('ff-run').disabled = false
  $('ff-run').textContent = 'Preview 7 days'
  $('view-live').hidden = true
  $('hero-context').textContent = liveContextLabel()
  $('clock-chip').classList.remove('is-preview')
  setProgress(0, 'Ready')
  if (snapshot && config) renderLiveAll()
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
  if (series.length > 240) series.splice(0, series.length - 240)
  priceHistory.set(key, series)
}

function updatePriceHistoryFromEvents(events: SequencedMarketEvent[]): void {
  for (const event of events) {
    if (event.type !== 'trade.buy' && event.type !== 'trade.sell' && event.type !== 'bot.trade') continue
    const merchantId = merchantOfEvent(event)
    if (!merchantId) continue
    if (event.after.ask !== null && event.item) {
      pushPricePoint(merchantId, event.item, event.time, event.after.ask)
    }
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

/* ------------------------------------------------------------------ merchant cards */

function renderMerchantCards(overrides?: Map<MerchantId, MerchantMirror>): void {
  if (!snapshot || !config) return
  const current = snapshot
  const colors = ['#eab35e', '#8fb8d8', '#9ec9a3', '#c9a3c9', '#d8a48f', '#a9b6cc', '#b8c99e', '#d0b48a']
  const cards = current.merchants.map((merchant, index) => {
    const override = overrides?.get(merchant.id)
    const cash = override?.cash ?? merchant.cash
    const open = override?.open ?? merchant.open
    const bankrupt = override?.bankrupt ?? merchant.bankrupt
    const state = bankrupt ? 'bankrupt' : open ? 'open' : 'closed'
    const change = cash - (current.daily.merchantCashStart[merchant.id] ?? cash)
    const reserveRatio = Math.max(0, Math.min(1, cash / Math.max(1e-6, merchant.reserve * 1.8)))
    const keyItem = config.merchants[merchant.id]?.sells?.[0]
    const ask = keyItem ? merchant.askPrices[keyItem] : undefined
    const spark = keyItem ? priceHistory.get(`${merchant.id}|${keyItem}`) ?? [] : []
    const stock = sum(Object.values(merchant.stock).filter(quantity => quantity > 0))

    return `<article class="mcard ${state === 'closed' || state === 'bankrupt' ? 'closed' : ''}" data-merchant="${esc(merchant.id)}">
      <div class="mcard-head">
        <span class="mname">${esc(merchant.displayName)}</span>
        <span class="mstate ${state}">${state}</span>
      </div>
      <p class="mpersonality">${esc(merchant.personality)}</p>
      <div class="mcash">${money0(cash)} <span class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : '−'}${money0(
        Math.abs(change),
      )} today</span></div>
      <div class="mbar ${reserveRatio < 0.5 ? 'low' : ''}"><span style="width:${(reserveRatio * 100).toFixed(0)}%"></span></div>
      <div class="mmeta"><span>reserve ${money0(merchant.reserve)}</span><span>${formatNumber(stock)} units in stock</span></div>
      ${ask !== undefined ? `<div class="mquote">${esc(itemLabel(keyItem))} ask <b>${money(ask)}</b></div>` : ''}
      ${spark.length > 1 ? renderSparkline(spark, { color: colors[index % colors.length] }) : ''}
    </article>`
  })
  $('merchant-grid').innerHTML = cards.join('')
}

/* ------------------------------------------------------------------ tape + raw feed */

function renderTape(): void {
  if (!snapshot || !config) return
  const current = snapshot
  const tape = buildTape(eventBuffer, NO_ALIASES, config)
  const rows = tape.length > 0 ? tape : current.tape
  const list = $('tape-list')
  if (rows.length === 0) {
    list.innerHTML = '<li class="loading-note">No trades yet this session.</li>'
    return
  }
  list.innerHTML = rows
    .slice(0, 20)
    .map(
      trade => `<li class="tape-row">
        <span class="tape-time">D${dayOf(trade.time)} ${timeLabel(trade.time)}</span>
        <span class="side-badge ${trade.side}">${trade.side === 'buy' ? 'BUY' : 'SELL'}</span>
        <span class="tape-desc"><b>${esc(trade.traderName)}</b> ${trade.quantity}× ${esc(itemLabel(trade.item))} <span>@ ${esc(
          trade.merchantName ?? '?',
        )}</span></span>
        <span class="tape-price">${money(trade.unitPrice)}</span>
      </li>`,
    )
    .join('')
}

const EVENT_GROUPS: Record<string, MarketEventType[]> = {
  trades: ['trade.buy', 'trade.sell', 'bot.trade'],
  merchants: [
    'merchant.restock',
    'merchant.bankrupt',
    'merchant.investment',
    'merchant.price',
    'merchant.reopen',
    'merchant.recovery',
    'merchant.distribution',
  ],
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

function renderEventStream(): void {
  if (!snapshot) return
  const current = snapshot
  const list = $('event-list')
  const merchantSelect = $('filter-merchant') as HTMLSelectElement
  if (merchantSelect.options.length <= 1) {
    const options = current.merchants
      .map(merchant => `<option value="${esc(merchant.id)}">${esc(merchant.displayName)}</option>`)
      .join('')
    merchantSelect.innerHTML = `<option value="all">all merchants</option>${options}`
  }

  const events = eventBuffer.filter(eventVisible).slice(-200).reverse()
  if (events.length === 0) {
    list.innerHTML = '<li class="loading-note">No events match these filters yet.</li>'
    renderSelectedEvent()
    return
  }

  list.innerHTML = events
    .map(
      event => `<li><button class="event-row ${event.id === selectedEventId ? 'selected' : ''}" type="button" data-event="${esc(
        event.id,
      )}">
        <span class="event-time">D${dayOf(event.time)} ${timeLabel(event.time)}</span>
        <span class="event-type">${esc(event.type)}</span>
        <span class="event-message">${esc(event.message)}</span>
      </button></li>`,
    )
    .join('')
  renderSelectedEvent()
}

function renderSelectedEvent(): void {
  const detail = $('event-detail')
  if (!selectedEventId) {
    detail.innerHTML = ''
    return
  }
  const event = eventBuffer.find(candidate => candidate.id === selectedEventId)
  if (!event) {
    detail.innerHTML = ''
    return
  }
  detail.innerHTML = `<div class="event-detail">${eventDetailHtml(event)}</div>`
}

/* ------------------------------------------------------------------ newspaper + proof */

function renderNewspaper(recap: Recap, preview: boolean): void {
  const movers = (recap.topMovers ?? [])
    .slice(0, 5)
    .map(
      mover => `<li>
        <span>${esc(itemLabel(mover.itemId))} at ${esc(
          config?.merchants[mover.merchantId]?.displayName ?? mover.merchantId,
        )}</span>
        <b class="${mover.changePct >= 0 ? 'up' : 'down'}">${mover.changePct >= 0 ? '+' : '−'}${Math.abs(mover.changePct).toFixed(1)}%</b>
      </li>`,
    )
    .join('')

  const best = recap.best
  const worst = recap.worst
  $('newspaper').innerHTML = `
    <div class="recap-mast"><span>Ironblock daily</span><span>Day ${recap.day}${preview ? ' · preview' : ''}</span></div>
    <p class="recap-headline">${esc(recap.headline)}</p>
    <ul class="recap-story">${(recap.story ?? []).slice(0, 5).map(line => `<li>${esc(line)}</li>`).join('')}</ul>
    ${movers ? `<div class="recap-movers"><h4>Biggest price moves</h4><ul>${movers}</ul></div>` : ''}
    ${
      best && worst && best.merchantId !== worst.merchantId
        ? `<p class="recap-footnote">Strongest: ${esc(best.displayName)} (${money(best.cashChange)}). Weakest: ${esc(
            worst.displayName,
          )} (${money(worst.cashChange)}).</p>`
        : ''
    }
    <p class="recap-footnote">${
      preview
        ? 'Deterministic seven-day clone recap — the same starting state and seed reproduce every number.'
        : 'Live economy recap, updated as the town runs.'
    }</p>`
}

function renderProof(): void {
  if (!config) return
  const payload = proof ?? buildProofPayload(config, {})
  $('proof-panel-body').innerHTML = `
    <div class="proof-title">
      <span>${esc(payload.contractId)}</span><span class="testnet-badge">TESTNET</span>
    </div>
    <dl class="kv">
      <dt>network</dt><dd>${esc(payload.network)}</dd>
      <dt>contract</dt><dd><a href="${esc(payload.explorerUrls.contract)}" target="_blank" rel="noreferrer noopener">${esc(
        payload.explorerUrls.contract,
      )}</a></dd>
      <dt>treasury</dt><dd><a href="${esc(payload.explorerUrls.treasury)}" target="_blank" rel="noreferrer noopener">${esc(
        payload.explorerUrls.treasury,
      )}</a></dd>
      <dt>tokens</dt><dd>${payload.tokenCount} NEP-245 item types</dd>
      <dt>genesis supply</dt><dd>${formatNumber(payload.genesisSupply.units)} units</dd>
    </dl>
    <p class="proof-note">${esc(payload.note)}</p>
    <p class="proof-note">Read-only testnet record. The spectator page never asks for a wallet or signs a transaction.</p>`
}

function renderRunProof(): void {
  const container = $('run-proof')
  if (!lastFastForward) {
    container.innerHTML =
      '<p class="proof-note">Run a 7-day preview to record a deterministic clone proof here. The preview never advances or saves the live town.</p>'
    return
  }
  const run = lastFastForward
  const live = run.live
  const unchanged = live?.unchanged ?? true
  container.innerHTML = `
    <div class="proof-grid">
      <div><span>mode</span><b>${esc(run.mode)}</b></div>
      <div><span>days</span><b>${run.days}</b></div>
      <div><span>seed</span><b class="mono">${esc(run.seed)}</b></div>
      <div><span>final sequence</span><b class="mono">${run.finalSequence}</b></div>
      <div><span>live sequence</span><b class="mono">${live?.sequenceBefore ?? '—'} → ${live?.sequenceAfter ?? '—'}</b></div>
      <div><span>live world</span><b class="${unchanged ? 'up' : 'down'}">${unchanged ? 'unchanged' : 'changed'}</b></div>
      <div><span>simulation time</span><b>${run.timing.totalMs} ms</b></div>
      <div><span>beats</span><b>${run.timing.eventCount} events</b></div>
    </div>
    <p class="proof-note">${
      unchanged
        ? 'The seven days ran on a throwaway clone. The live economy sequence and clock did not move, and the result was not saved.'
        : 'The live world changed while the clone was running; the preview itself still ran on a clone.'
    }</p>`
}
