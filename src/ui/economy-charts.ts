import { economy } from '../config/economy'
import type {
  EconomyDaySummary,
  EconomyTodaySummary,
  MerchantSummary,
} from '../client/economy/types'
import type { MarketBoardRow, MarketQuoteEntry } from './market-board'

/**
 * Light-theme charts for the in-game market board.
 *
 * The spectator page is dark; the playable HUD sits on parchment. These
 * builders use the same dependency-free approach but keep the ink and grid
 * colours legible inside the parchment panel.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const svgEl = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value))
  }
  return node
}

const symbol = (): string => economy.currency.symbol

/** Compact money for chart axes and cash totals. */
const money = (value: number, maximumFractionDigits = 0): string => {
  const safe = Number.isFinite(value) ? value : 0
  const abs = Math.abs(safe)
  const sign = safe < 0 ? '−' : ''
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}m ${symbol()}`
  if (abs >= 10_000) return `${sign}${(abs / 1000).toFixed(1)}k ${symbol()}`
  if (abs >= 1_000) return `${sign}${(abs / 1000).toFixed(2)}k ${symbol()}`
  return `${sign}${abs.toLocaleString('en-US', { maximumFractionDigits })} ${symbol()}`
}

/** Prices keep cents so a one-unit spread is visible in the ladder. */
const price = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0
  const abs = Math.abs(safe)
  if (abs >= 1_000) return money(safe)
  return `${safe < 0 ? '−' : ''}${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${symbol()}`
}

const signedMoney = (value: number): string => {
  if (Math.abs(value) < 0.5) return 'flat today'
  return `${value > 0 ? '+' : '−'}${money(Math.abs(value))}`
}

const number = (value: number): string =>
  (Number.isFinite(value) ? value : 0).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })

const niceCeil = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalised = value / magnitude
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(candidate => normalised <= candidate) ?? 10
  return Math.max(1, step * magnitude)
}

function chartCard(
  title: string,
  subtitle: string,
  children: HTMLElement[],
  options: { wide?: boolean; kicker?: string; className?: string } = {},
): HTMLElement {
  const card = el('section', `ib-chart-card${options.wide ? ' is-wide' : ''}${options.className ? ` ${options.className}` : ''}`)
  const head = el('div', 'ib-chart-head')
  if (options.kicker) head.append(el('span', 'ib-chart-kicker', options.kicker))
  head.append(el('h3', 'ib-chart-title', title), el('p', 'ib-chart-sub', subtitle))
  card.append(head, ...children)
  return card
}

const emptyChart = (text: string): HTMLElement =>
  el('p', 'ib-chart-empty', text)

const legendItem = (label: string, tone: string): HTMLElement => {
  const item = el('span', 'ib-chart-legend-item')
  item.append(el('i', `ib-chart-swatch is-${tone}`), document.createTextNode(label))
  return item
}

/* ------------------------------------------------------------------ price ladder */

interface PriceLadderRow {
  row: MarketBoardRow
  minAsk: number
  maxAsk: number
  bestBid: number | null
  askCount: number
  bidCount: number
}

function priceLadderRows(
  rows: readonly MarketBoardRow[],
  entries: readonly MarketQuoteEntry[],
): PriceLadderRow[] {
  const result: PriceLadderRow[] = []
  for (const row of rows) {
    const asks = entries
      .filter(
        entry =>
          entry.itemId === row.itemId &&
          entry.side === 'buy' &&
          entry.quote.unitPrice > 0 &&
          entry.quote.merchantOpen &&
          !entry.quote.merchantBankrupt &&
          entry.quote.constraints.maxByStock > 0,
      )
      .map(entry => entry.quote.unitPrice)
      .filter(value => Number.isFinite(value) && value > 0)
    const bids = entries
      .filter(
        entry =>
          entry.itemId === row.itemId &&
          entry.side === 'sell' &&
          entry.quote.unitPrice > 0 &&
          entry.quote.merchantOpen &&
          !entry.quote.merchantBankrupt &&
          (entry.quote.constraints.maxByMerchantCash ?? 0) > 0,
      )
      .map(entry => entry.quote.unitPrice)
      .filter(value => Number.isFinite(value) && value > 0)
    if (asks.length === 0 && bids.length === 0) continue
    result.push({
      row,
      minAsk: asks.length > 0 ? Math.min(...asks) : 0,
      maxAsk: asks.length > 0 ? Math.max(...asks) : 0,
      bestBid: bids.length > 0 ? Math.max(...bids) : null,
      askCount: asks.length,
      bidCount: bids.length,
    })
  }
  return result
}

/** A shared-scale range chart: ask range across stalls plus the best bid. */
export function renderMarketPriceLadder(
  rows: readonly MarketBoardRow[],
  entries: readonly MarketQuoteEntry[],
): HTMLElement {
  const data = priceLadderRows(rows, entries)
  if (data.length === 0) {
    return chartCard(
      'Price ladder',
      'Live stall quotes',
      [emptyChart('No stalls are quoting yet.')],
      { wide: true, kicker: 'What things cost' },
    )
  }

  const max = niceCeil(
    Math.max(...data.flatMap(item => [item.maxAsk, item.bestBid ?? 0])) * 1.06,
  )
  const pct = (value: number): number => Math.min(100, Math.max(0, (value / max) * 100))

  const card = chartCard(
    'Price ladder',
    'Each bar spans the asks at every open stall. The dot is the best bid.',
    [],
    { wide: true, kicker: 'What things cost' },
  )
  const legend = el('div', 'ib-chart-legend')
  legend.append(
    legendItem('ask range', 'ask'),
    legendItem('best bid', 'bid'),
    legendItem('positive spread', 'spread'),
  )
  card.append(legend)

  const list = el('div', 'ib-range-list')
  for (const item of data) {
    const row = el('div', 'ib-range-row')
    row.dataset.spread = item.bestBid !== null && item.bestBid > item.minAsk ? 'positive' : 'normal'
    const name = el('div', 'ib-range-name')
    name.append(
      document.createTextNode(item.row.displayName),
      el('small', undefined, `${item.askCount} ask${item.askCount === 1 ? '' : 's'} · ${item.bidCount} bid${item.bidCount === 1 ? '' : 's'}`),
    )
    const track = el('div', 'ib-range-track')
    const ask = el('span', 'ib-range-ask')
    ask.style.left = `${pct(item.minAsk)}%`
    ask.style.width = `${Math.max(0.8, pct(item.maxAsk) - pct(item.minAsk))}%`
    ask.title = `Ask range ${price(item.minAsk)} to ${price(item.maxAsk)}`
    track.append(ask)
    if (item.bestBid !== null) {
      const bid = el('span', 'ib-range-bid')
      bid.style.left = `${pct(item.bestBid)}%`
      bid.title = `Best bid ${price(item.bestBid)}`
      track.append(bid)
    }
    const figures = el('div', 'ib-range-figures')
    figures.append(
      el('b', undefined, item.askCount > 0 ? `${price(item.minAsk)}–${price(item.maxAsk)}` : 'no ask'),
      el(
        'small',
        item.bestBid !== null ? 'is-bid' : 'is-muted',
        item.bestBid !== null ? `bid ${price(item.bestBid)}` : 'no bid',
      ),
    )
    row.append(name, track, figures)
    list.append(row)
  }

  const axis = el('div', 'ib-chart-axis')
  for (const value of [0, max / 2, max]) {
    axis.append(el('span', undefined, money(value)))
  }
  card.append(list, axis)
  card.append(
    el(
      'p',
      'ib-chart-foot',
      'Bars are asked prices, not sales. A green row means the best bid is above the cheapest ask.',
    ),
  )
  return card
}

/* ------------------------------------------------------------------ merchant tills */

/** Merchant cash now, with the move since the day opened. */
export function renderMerchantCashChart(
  merchants: readonly MerchantSummary[],
  cashStart: Readonly<Record<string, number>>,
): HTMLElement {
  if (merchants.length === 0) {
    return chartCard('Merchant tills', 'Cash on hand', [emptyChart('No merchant tills yet.')], {
      kicker: 'Who can keep buying',
    })
  }

  const sorted = [...merchants].sort((left, right) => right.cash - left.cash)
  const max = Math.max(1, ...sorted.map(merchant => merchant.cash))
  const total = sorted.reduce((sum, merchant) => sum + merchant.cash, 0)
  const card = chartCard(
    'Merchant tills',
    'Cash now · green/red is today’s move',
    [],
    { kicker: 'Who can keep buying' },
  )
  const list = el('ul', 'ib-cash-list')
  for (const merchant of sorted) {
    const start = cashStart[merchant.id] ?? merchant.cash
    const delta = merchant.cash - start
    const row = el('li', 'ib-cash-row')
    row.dataset.state = merchant.bankrupt ? 'bankrupt' : merchant.open ? 'open' : 'closed'
    const top = el('div', 'ib-cash-top')
    top.append(
      el('span', 'ib-cash-name', merchant.displayName),
      el('span', 'ib-cash-value', money(merchant.cash)),
      el(
        'span',
        `ib-cash-delta ${delta > 0.5 ? 'is-up' : delta < -0.5 ? 'is-down' : 'is-flat'}`,
        signedMoney(delta),
      ),
    )
    const track = el('div', 'ib-cash-track')
    const fill = el('span', 'ib-cash-fill')
    fill.style.width = `${Math.max(2, (merchant.cash / max) * 100)}%`
    track.append(fill)
    row.append(top, track)
    row.title = `${merchant.displayName}: ${money(merchant.cash)}, ${signedMoney(delta)}`
    list.append(row)
  }
  card.append(list)
  card.append(
    el('p', 'ib-chart-foot', `${money(total)} total across ${sorted.length} tills.`),
  )
  return card
}

/* ------------------------------------------------------------------ town cash line */

interface CashPoint {
  label: string
  merchant: number
  player: number
}

const linePath = (points: Array<{ x: number; y: number }>): string =>
  points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ')

/** Total merchant cash and traveler wallets across closed days, plus now. */
export function renderTownCashChart(
  summaries: readonly EconomyDaySummary[],
  currentMerchantCash: number,
  today: EconomyTodaySummary,
): HTMLElement {
  const closed = summaries.slice(-7)
  const points: CashPoint[] = closed.map(summary => ({
    label: `D${summary.day}`,
    merchant: summary.totalMerchantCash,
    player: summary.totalPlayerCash,
  }))
  points.push({
    label: 'Today',
    merchant: currentMerchantCash,
    player: today.totalPlayerCash,
  })

  const card = chartCard(
    'Money in town',
    `Merchant tills vs traveler wallets · day ${today.day}`,
    [],
    { kicker: 'The economy over time' },
  )
  const legend = el('div', 'ib-chart-legend')
  legend.append(legendItem('merchant tills', 'merchant'), legendItem('traveler wallets', 'player'))
  card.append(legend)

  const width = 320
  const height = 152
  const pad = { top: 12, right: 8, bottom: 24, left: 46 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const max = niceCeil(
    Math.max(1, ...points.flatMap(point => [point.merchant, point.player])) * 1.08,
  )
  const scaleY = (value: number): number =>
    pad.top + plotH - (Math.max(0, value) / max) * plotH
  const scaleX = (index: number): number =>
    points.length <= 1 ? pad.left + plotW / 2 : pad.left + (index / (points.length - 1)) * plotW

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `Town cash by day. Merchant tills ${money(currentMerchantCash)}, traveler wallets ${money(today.totalPlayerCash)} today.`,
  })
  const title = svgEl('title')
  title.textContent = 'Merchant tills and traveler wallets by day'
  svg.append(title)

  for (const fraction of [0, 0.5, 1]) {
    const y = pad.top + plotH - fraction * plotH
    svg.append(
      svgEl('line', {
        x1: pad.left,
        x2: width - pad.right,
        y1: y,
        y2: y,
        class: 'ib-chart-grid',
      }),
      Object.assign(svgEl('text', {
        x: pad.left - 5,
        y: y + 3,
        'text-anchor': 'end',
        class: 'ib-chart-label',
      }), { textContent: money(max * fraction) }),
    )
  }

  const step = points.length <= 4 ? 1 : Math.ceil(points.length / 4)
  points.forEach((point, index) => {
    if (index % step !== 0 && index !== points.length - 1) return
    const x = scaleX(index)
    const label = svgEl('text', {
      x,
      y: height - 7,
      'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
      class: 'ib-chart-label',
    })
    label.textContent = point.label
    svg.append(label)
  })

  const series: Array<{ key: 'merchant' | 'player'; className: string }> = [
    { key: 'merchant', className: 'ib-chart-line is-merchant' },
    { key: 'player', className: 'ib-chart-line is-player' },
  ]
  for (const item of series) {
    const coords = points.map((point, index) => ({
      x: scaleX(index),
      y: scaleY(point[item.key]),
    }))
    if (coords.length > 1) {
      svg.append(svgEl('path', { d: linePath(coords), class: item.className }))
    }
    for (const [index, coord] of coords.entries()) {
      const dot = svgEl('circle', {
        cx: coord.x,
        cy: coord.y,
        r: index === coords.length - 1 ? 3.2 : 2.4,
        class: `ib-chart-dot ${item.key === 'merchant' ? 'is-merchant' : 'is-player'}`,
      })
      dot.append(Object.assign(svgEl('title'), {
        textContent: `${points[index].label}: ${money(points[index][item.key])}`,
      }))
      svg.append(dot)
    }
  }

  card.append(svg)
  card.append(
    el(
      'p',
      'ib-chart-foot',
      `Today: ${money(currentMerchantCash)} in tills, ${money(today.totalPlayerCash)} with travelers.`,
    ),
  )
  return card
}

/* ------------------------------------------------------------------ trade volume */

interface VolumePoint {
  label: string
  volume: number
  value: number
  botTrades: number
  today: boolean
}

/** Units traded each day, with today's running bar highlighted. */
export function renderTradeVolumeChart(
  summaries: readonly EconomyDaySummary[],
  today: EconomyTodaySummary,
): HTMLElement {
  const closed = summaries.slice(-7)
  const points: VolumePoint[] = closed.map(summary => ({
    label: `D${summary.day}`,
    volume: summary.tradeVolume,
    value: summary.tradeValue,
    botTrades: summary.botTrades,
    today: false,
  }))
  points.push({
    label: 'Today',
    volume: today.tradeVolume,
    value: today.tradeValue,
    botTrades: today.botTrades,
    today: true,
  })

  const card = chartCard(
    'Trade pulse',
    'Units traded each day · today is still filling',
    [],
    { kicker: 'How much is moving' },
  )

  const width = 320
  const height = 152
  const pad = { top: 12, right: 8, bottom: 24, left: 46 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const max = niceCeil(Math.max(4, ...points.map(point => point.volume)))
  const scaleY = (value: number): number => pad.top + plotH - (Math.max(0, value) / max) * plotH
  const slot = plotW / points.length
  const barWidth = Math.max(6, slot * 0.58)

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `Units traded each day. Today ${number(today.tradeVolume)} units and ${number(today.botTrades)} bot trades.`,
  })
  const title = svgEl('title')
  title.textContent = 'Units traded each day'
  svg.append(title)

  for (const fraction of [0, 0.5, 1]) {
    const y = pad.top + plotH - fraction * plotH
    svg.append(
      svgEl('line', {
        x1: pad.left,
        x2: width - pad.right,
        y1: y,
        y2: y,
        class: 'ib-chart-grid',
      }),
      Object.assign(svgEl('text', {
        x: pad.left - 5,
        y: y + 3,
        'text-anchor': 'end',
        class: 'ib-chart-label',
      }), { textContent: number(max * fraction) }),
    )
  }

  points.forEach((point, index) => {
    const center = pad.left + slot * index + slot / 2
    const x = center - barWidth / 2
    const y = scaleY(point.volume)
    const bar = svgEl('rect', {
      x,
      y,
      width: barWidth,
      height: Math.max(1, pad.top + plotH - y),
      rx: 2.5,
      class: `ib-chart-bar${point.today ? ' is-today' : ''}`,
    })
    bar.append(Object.assign(svgEl('title'), {
      textContent: `${point.label}: ${number(point.volume)} units · ${money(point.value)} · ${number(point.botTrades)} bot trades`,
    }))
    svg.append(bar)
    const label = svgEl('text', {
      x: center,
      y: height - 7,
      'text-anchor': 'middle',
      class: `ib-chart-label${point.today ? ' is-today' : ''}`,
    })
    label.textContent = point.label
    svg.append(label)
  })

  card.append(svg)
  card.append(
    el(
      'p',
      'ib-chart-foot',
      `Today: ${number(today.tradeVolume)} units · ${number(today.botTrades)} bot trades · ${money(today.tradeValue)} moved.`,
    ),
  )
  return card
}
