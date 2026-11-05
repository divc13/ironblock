/**
 * Tiny dependency-free SVG chart builders for the standalone spectator page.
 *
 * The page leads with a multi-line price chart, then two supporting market
 * visuals: merchant wealth (rendered as HTML/CSS in main.ts) and daily trade
 * volume. Every coordinate is derived from data already present in the
 * observability payload; the builders never invent missing observations.
 */

export interface Point {
  x: number
  y: number
}

export interface TrendChartOptions {
  width?: number
  height?: number
  /** Accessible name for the rendered image. */
  ariaLabel?: string
  /** Formatter used for Y-axis labels and point tooltips. */
  yFormat?: (value: number) => string
  /** Text shown when there is no series yet. */
  emptyText?: string
}

export interface SparklineOptions {
  width?: number
  height?: number
  color?: string
}

export interface PricePoint {
  /** Position on the day axis. 0 is the opening quote, 1..n are day closes. */
  x: number
  /** Normalised value: 100 = the item's first recorded quote. */
  y: number
  /** The exact recorded price, shown in tooltips and accessible labels. */
  price: number
  /** Human label such as "Week open" or "Day 3 close". */
  label: string
}

export interface PriceSeries {
  id: string
  label: string
  color: string
  points: PricePoint[]
}

export type PriceMarkerTone = 'shock' | 'closure' | 'reopen' | 'neutral'

/** A causal beat drawn over a price path (shock, closure, reopen). */
export interface PriceMarker {
  /** Position on the day axis, matching the chart's point x positions. */
  x: number
  label: string
  title: string
  tone: PriceMarkerTone
  /** Draw a soft band across the day as well as a marker. */
  band?: boolean
}

export interface PriceChartOptions {
  width?: number
  height?: number
  /** Axis labels, left to right. */
  labels: string[]
  /** Causal beats drawn behind the lines. */
  markers?: PriceMarker[]
  /** Value at the 0% line. Defaults to 100. */
  baseline?: number
  ariaLabel?: string
  emptyText?: string
  /** 0..1, used to wipe the lines in during the seven-second playback. */
  reveal?: number
  /** Accessible description for one focusable day column. */
  dayAriaLabel?: (index: number) => string
  /** Formatter for exact values inside native dot titles. */
  valueFormat?: (value: number) => string
}

export interface VolumePoint {
  label: string
  volume: number
  /** Optional short note shown as a native tooltip. */
  note?: string
}

export interface VolumeChartOptions {
  width?: number
  height?: number
  ariaLabel?: string
  emptyText?: string
  /** How many day bars are currently revealed. */
  revealCount?: number
  valueFormat?: (value: number) => string
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const dayLabel = (time: number): string => `D${Math.floor(time / 86400) + 1}`

const timeLabel = (time: number): string => {
  const seconds = ((time % 86400) + 86400) % 86400
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${dayLabel(time)} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

const sortedUnique = (points: Point[]): Point[] => {
  const byX = new Map<number, Point>()
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    byX.set(point.x, point)
  }
  return [...byX.values()].sort((left, right) => left.x - right.x)
}

const compact = (value: number): string => {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (abs >= 10_000) return `${(value / 1000).toFixed(0)}k`
  if (abs >= 1_000) return `${(value / 1000).toFixed(1)}k`
  if (abs >= 100) return value.toFixed(0)
  return value.toFixed(1)
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value))

const niceStep = (raw: number): number => {
  if (!Number.isFinite(raw) || raw <= 0) return 10
  const exponent = Math.floor(Math.log10(raw))
  const base = 10 ** exponent
  const fraction = raw / base
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return nice * base
}

const indexLabel = (value: number, baseline: number): string => {
  const delta = Math.round(value - baseline)
  if (delta === 0) return '0%'
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`
}

/**
 * One clean area-line chart. The chart uses a 720x340 viewBox so it scales to
 * the card width without a resize observer. Kept for the small merchant
 * sparklines and as a generic fallback.
 */
export function renderTrendChart(points: Point[], options: TrendChartOptions = {}): string {
  const width = options.width ?? 720
  const height = options.height ?? 340
  const pad = { top: 22, right: 22, bottom: 36, left: 58 }
  const plotW = Math.max(10, width - pad.left - pad.right)
  const plotH = Math.max(10, height - pad.top - pad.bottom)
  const formatY = options.yFormat ?? compact
  const data = sortedUnique(points)

  if (data.length < 2) {
    return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
      options.ariaLabel ?? 'Trend chart with no data yet',
    )}">
      <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.015)"/>
      <text x="${width / 2}" y="${height / 2}" fill="#77849a" font-size="13" text-anchor="middle">${esc(
        options.emptyText ?? 'Collecting the first day…',
      )}</text>
    </svg>`
  }

  const values = data.map(point => point.y)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const rawRange = maxValue - minValue
  const range = Math.max(1, rawRange)
  const loY = Math.max(0, minValue - range * 0.24)
  const hiY = maxValue + range * 0.24
  const minX = data[0].x
  const maxX = data[data.length - 1].x
  const spanX = Math.max(1, maxX - minX)

  const scaleX = (x: number): number => pad.left + ((x - minX) / spanX) * plotW
  const scaleY = (y: number): number => pad.top + plotH - ((y - loY) / Math.max(1e-6, hiY - loY)) * plotH

  let grid = ''
  const gridLines = 4
  for (let index = 0; index <= gridLines; index += 1) {
    const y = pad.top + (plotH * index) / gridLines
    const value = hiY - ((hiY - loY) * index) / gridLines
    grid +=
      `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.055)" stroke-width="1"/>` +
      `<text class="chart-axis-label" x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" fill="#77849a" font-size="11" text-anchor="end">${esc(
        formatY(value),
      )}</text>`
  }

  const labelIndexes = new Set<number>()
  if (data.length <= 9) {
    data.forEach((_, index) => labelIndexes.add(index))
  } else {
    for (let index = 0; index < 5; index += 1) {
      labelIndexes.add(Math.round((index * (data.length - 1)) / 4))
    }
    labelIndexes.add(data.length - 1)
  }
  const xLabels = [...labelIndexes]
    .sort((left, right) => left - right)
    .map(index => {
      const point = data[index]
      return `<text class="chart-axis-label" x="${scaleX(point.x).toFixed(1)}" y="${height - 12}" fill="#77849a" font-size="11" text-anchor="middle">${esc(
        dayLabel(point.x),
      )}</text>`
    })
    .join('')

  const line = data
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${scaleX(point.x).toFixed(1)},${scaleY(point.y).toFixed(1)}`)
    .join(' ')
  const area = `${line} L${scaleX(maxX).toFixed(1)},${(pad.top + plotH).toFixed(1)} L${scaleX(minX).toFixed(1)},${(
    pad.top + plotH
  ).toFixed(1)} Z`

  const dots = data
    .map(
      point =>
        `<circle cx="${scaleX(point.x).toFixed(1)}" cy="${scaleY(point.y).toFixed(1)}" r="3" fill="#0d1118" stroke="#eab35e" stroke-width="2"><title>${esc(
          `${timeLabel(point.x)} · ${formatY(point.y)}`,
        )}</title></circle>`,
    )
    .join('')

  const last = data[data.length - 1]
  const lastX = scaleX(last.x)
  const lastY = scaleY(last.y)
  const summary = `${timeLabel(data[0].x)} to ${timeLabel(last.x)}; ${formatY(last.y)} at the end.`

  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    options.ariaLabel ?? `Town cash trend. ${summary}`,
  )}">
    <title>${esc(options.ariaLabel ?? 'Town cash trend')}</title>
    <desc>${esc(summary)}</desc>
    <defs>
      <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#eab35e" stop-opacity="0.24"/>
        <stop offset="100%" stop-color="#eab35e" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="12" fill="rgba(255,255,255,0.014)"/>
    ${grid}${xLabels}
    <path d="${area}" fill="url(#trend-fill)"/>
    <path d="${line}" fill="none" stroke="#eab35e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="5.5" fill="#eab35e" opacity="0.18"/>
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.4" fill="#eab35e"/>
  </svg>`
}

/**
 * Large multi-line price chart, indexed to each item's first recorded quote.
 *
 * Missing days are intentionally left as gaps. A dashed segment bridges the
 * gap so a reader can follow the line without mistaking it for a real daily
 * quote. The SVG always renders the full axis and y-domain; playback only
 * moves a clip rectangle, so the card never changes height or rescales.
 */
export function renderPriceChart(series: PriceSeries[], options: PriceChartOptions): string {
  const width = options.width ?? 900
  const height = options.height ?? 460
  const labels = options.labels.length > 0 ? options.labels : ['Now']
  const labelCount = labels.length
  const baseline = options.baseline ?? 100
  const reveal = clamp(options.reveal ?? 1, 0, 1)
  const formatValue = options.valueFormat ?? compact
  const pad = { top: 30, right: 38, bottom: 46, left: 64 }
  const plotLeft = pad.left
  const plotRight = width - pad.right
  const plotW = Math.max(10, plotRight - plotLeft)
  const plotH = Math.max(10, height - pad.top - pad.bottom)
  const plotBottom = pad.top + plotH
  const allPoints = series.flatMap(item => item.points).filter(
    point => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.price),
  )
  const hasPoints = allPoints.length > 0

  const rawValues = hasPoints ? [baseline, ...allPoints.map(point => point.y)] : [baseline - 20, baseline + 20]
  const rawMin = Math.min(...rawValues)
  const rawMax = Math.max(...rawValues)
  const padY = Math.max(8, (rawMax - rawMin) * 0.14)
  let lo = rawMin - padY
  let hi = rawMax + padY
  if (hi - lo < 24) {
    const middle = (lo + hi) / 2
    lo = middle - 12
    hi = middle + 12
  }
  const step = niceStep((hi - lo) / 4)
  lo = Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step

  const scaleX = (x: number): number =>
    labelCount <= 1 ? plotLeft + plotW / 2 : plotLeft + (clamp(x, 0, labelCount - 1) / (labelCount - 1)) * plotW
  const scaleY = (y: number): number => pad.top + plotH - ((y - lo) / Math.max(1e-6, hi - lo)) * plotH

  let grid = ''
  const yTicks = Math.max(1, Math.round((hi - lo) / step))
  for (let index = 0; index <= yTicks; index += 1) {
    const value = lo + step * index
    const y = scaleY(value)
    const isBaseline = Math.abs(value - baseline) < 1e-6
    grid +=
      `<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}" stroke="${
        isBaseline ? 'rgba(234,179,94,0.16)' : 'rgba(255,255,255,0.055)'
      }" stroke-width="1"${isBaseline ? ' stroke-dasharray="4 6"' : ''}/>` +
      `<text class="chart-axis-label price-y-label" x="${plotLeft - 10}" y="${(y + 4).toFixed(1)}" fill="${
        isBaseline ? '#a99068' : '#77849a'
      }" font-size="11" text-anchor="end">${esc(indexLabel(value, baseline))}</text>`
  }

  const xLabels = labels
    .map((label, index) => {
      const anchor = labelCount <= 1 ? 'middle' : index === 0 ? 'start' : index === labelCount - 1 ? 'end' : 'middle'
      const x = scaleX(index)
      const displayLabel = index === 0 && label === 'Open' && width < 430 ? 'D0' : label
      return `<text class="chart-axis-label price-x-label" x="${x.toFixed(1)}" y="${height - 14}" fill="#77849a" font-size="11" text-anchor="${anchor}">${esc(
        displayLabel,
      )}</text>`
    })
    .join('')

  const markerColors: Record<PriceMarkerTone, string> = {
    shock: '#e07a6b',
    closure: '#eab35e',
    reopen: '#76c79a',
    neutral: '#8aa4c8',
  }
  const markerBandWidth = Math.max(4, plotW / Math.max(1, labelCount - 1) * 0.62)
  const markers = (options.markers ?? [])
    .filter(marker => Number.isFinite(marker.x) && marker.x >= -0.001 && marker.x <= labelCount - 1 + 0.001)
    .map((marker, index) => {
      const x = scaleX(marker.x)
      const color = markerColors[marker.tone]
      const band =
        marker.band === false
          ? ''
          : `<rect class="price-marker-band" x="${(x - markerBandWidth / 2).toFixed(1)}" y="${pad.top}" width="${markerBandWidth.toFixed(
              1,
            )}" height="${plotH}" fill="${color}" opacity="0.065"/>`
      return `<g class="price-marker price-marker-${marker.tone}" data-marker-index="${index}">
        <title>${esc(`${marker.label} · ${marker.title}`)}</title>
        ${band}
        <line class="price-marker-line" x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${plotBottom}" stroke="${color}" stroke-width="1.2" stroke-dasharray="3 5" opacity="0.72"/>
        <path d="M${(x - 4.5).toFixed(1)},${(pad.top - 11).toFixed(1)} L${(x + 4.5).toFixed(1)},${(pad.top - 11).toFixed(
          1,
        )} L${x.toFixed(1)},${(pad.top - 4).toFixed(1)} Z" fill="${color}" opacity="0.92"/>
      </g>`
    })
    .join('')

  const priceSeries = series
    .map(item => {
      const points = [...item.points]
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.price))
        .sort((left, right) => left.x - right.x)
      if (points.length === 0) return ''

      const solidSegments: string[] = []
      const dashedSegments: string[] = []
      for (let index = 1; index < points.length; index += 1) {
        const left = points[index - 1]
        const right = points[index]
        const path = `M${scaleX(left.x).toFixed(1)},${scaleY(left.y).toFixed(1)} L${scaleX(right.x).toFixed(
          1,
        )},${scaleY(right.y).toFixed(1)}`
        if (right.x - left.x > 1.05) dashedSegments.push(path)
        else solidSegments.push(path)
      }

      const regularPoints = points.filter(point => point.x > 0)
      const dots = regularPoints
        .map(
          point =>
            `<circle class="price-dot" cx="${scaleX(point.x).toFixed(1)}" cy="${scaleY(point.y).toFixed(1)}" r="3.3" fill="${
              item.color
            }" stroke="#0b1018" stroke-width="1.5"><title>${esc(
              `${item.label} · ${point.label} · ${formatValue(point.price)}`,
            )}</title></circle>`,
        )
        .join('')

      const last = points[points.length - 1]
      const lastHalo =
        points.length > 1 && last.x > 0
          ? `<circle cx="${scaleX(last.x).toFixed(1)}" cy="${scaleY(last.y).toFixed(1)}" r="7" fill="${
              item.color
            }" opacity="0.16"/>`
          : ''

      return `<g class="price-series" data-price-series="${esc(item.id)}">
        <path d="${solidSegments.join(' ')}" fill="none" stroke="${item.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
        ${
          dashedSegments.length > 0
            ? `<path d="${dashedSegments.join(
                ' ',
              )}" fill="none" stroke="${item.color}" stroke-width="1.8" stroke-linecap="round" stroke-dasharray="4 7" opacity="0.38"/>`
            : ''
        }
        <g class="price-dots">${lastHalo}${dots}</g>
      </g>`
    })
    .join('')

  const startLayer = series
    .map(item =>
      item.points
        .filter(point => point.x === 0)
        .map(
          point =>
            `<circle class="price-start-dot" cx="${scaleX(point.x).toFixed(1)}" cy="${scaleY(point.y).toFixed(
              1,
            )}" r="4.2" fill="#0b1018" stroke="${item.color}" stroke-width="2.4"><title>${esc(
              `${item.label} · ${point.label} · ${formatValue(point.price)}`,
            )}</title></circle>` +
            `<circle cx="${scaleX(point.x).toFixed(1)}" cy="${scaleY(point.y).toFixed(1)}" r="7" fill="${
              item.color
            }" opacity="0.12"/>`,
        )
        .join(''),
    )
    .join('')

  const playheadX = plotLeft + plotW * reveal
  const playhead = `<line class="price-playhead" x1="${playheadX.toFixed(1)}" y1="${pad.top}" x2="${playheadX.toFixed(
    1,
  )}" y2="${plotBottom}" stroke="rgba(234,179,94,0.5)" stroke-width="1.2" stroke-dasharray="3 5" opacity="${
    reveal > 0 && reveal < 1 ? 1 : 0
  }"/>`
  const emptyText = hasPoints
    ? ''
    : `<text x="${width / 2}" y="${height / 2}" fill="#77849a" font-size="13" text-anchor="middle">${esc(
        options.emptyText ?? 'Waiting for recorded quotes…',
      )}</text>`

  const bands = labels
    .map((label, index) => {
      const left =
        labelCount <= 1
          ? plotLeft
          : plotLeft + (clamp(index - 0.5, 0, labelCount - 1) / (labelCount - 1)) * plotW
      const right =
        labelCount <= 1
          ? plotRight
          : plotLeft + (clamp(index + 0.5, 0, labelCount - 1) / (labelCount - 1)) * plotW
      const aria = options.dayAriaLabel?.(index) ?? label
      return `<rect class="price-day-band" x="${left.toFixed(1)}" y="${pad.top}" width="${Math.max(
        1,
        right - left,
      ).toFixed(1)}" height="${plotH}" data-price-x="${index}" tabindex="0" role="img" aria-label="${esc(
        aria,
      )}"><title>${esc(aria)}</title></rect>`
    })
    .join('')

  const summary =
    options.ariaLabel ??
    `Price chart indexed to each item's first recorded quote${hasPoints ? ` for ${series.length} items` : ''}.`

  return `<svg class="chart-svg price-svg" viewBox="0 0 ${width} ${height}" role="group" aria-label="${esc(
    summary,
  )}" data-plot-left="${plotLeft}" data-plot-width="${plotW.toFixed(1)}" data-plot-top="${pad.top}" data-plot-height="${plotH}" data-plot-kind="points">
    <title>${esc(summary)}</title>
    <desc>${esc(options.emptyText ?? 'Recorded merchant quotes across the week.')}</desc>
    <defs>
      <clipPath id="price-reveal-clip">
        <rect class="price-clip-rect" x="${plotLeft}" y="${pad.top - 12}" width="${(plotW * reveal).toFixed(
          1,
        )}" height="${plotH + 24}"/>
      </clipPath>
    </defs>
    <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="12" fill="rgba(255,255,255,0.012)"/>
    ${grid}${xLabels}${markers}
    <g clip-path="url(#price-reveal-clip)">${priceSeries}</g>
    <g class="price-start-layer">${startLayer}</g>
    ${playhead}
    ${bands}
    ${emptyText}
  </svg>`
}

/** Small daily bar chart for trade volume. */
export function renderVolumeChart(points: VolumePoint[], options: VolumeChartOptions = {}): string {
  const width = options.width ?? 520
  const height = options.height ?? 300
  const pad = { top: 24, right: 18, bottom: 38, left: 46 }
  const plotLeft = pad.left
  const plotRight = width - pad.right
  const plotW = Math.max(10, plotRight - plotLeft)
  const plotH = Math.max(10, height - pad.top - pad.bottom)
  const plotBottom = pad.top + plotH
  const revealCount = clamp(options.revealCount ?? points.length, 0, points.length)
  const formatValue = options.valueFormat ?? compact
  const maxValue = Math.max(1, ...points.map(point => Math.max(0, point.volume)))
  const step = niceStep(maxValue / 3)
  const top = Math.max(step, Math.ceil(maxValue / step) * step)

  if (points.length === 0) {
    return `<svg class="chart-svg volume-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
      options.ariaLabel ?? 'Trade volume',
    )}">
      <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.014)"/>
      <text x="${width / 2}" y="${height / 2}" fill="#77849a" font-size="13" text-anchor="middle">${esc(
        options.emptyText ?? 'Trade volume appears as days close…',
      )}</text>
    </svg>`
  }

  const scaleY = (value: number): number => pad.top + plotH - (value / top) * plotH
  let grid = ''
  for (let index = 0; index <= 3; index += 1) {
    const value = (top * index) / 3
    const y = scaleY(value)
    grid +=
      `<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.055)" stroke-width="1"/>` +
      `<text class="chart-axis-label volume-y-label" x="${plotLeft - 9}" y="${(y + 4).toFixed(1)}" fill="#77849a" font-size="11" text-anchor="end">${esc(
        formatValue(value),
      )}</text>`
  }

  const stepX = plotW / Math.max(1, points.length)
  const barW = Math.min(42, stepX * 0.56)
  const bars = points
    .map((point, index) => {
      const center = plotLeft + stepX * (index + 0.5)
      const x = center - barW / 2
      const track = `<rect x="${x.toFixed(1)}" y="${pad.top}" width="${barW.toFixed(
        1,
      )}" height="${plotH}" rx="5" fill="rgba(255,255,255,0.032)"/>`
      if (index >= revealCount) return track
      const value = Math.max(0, point.volume)
      const barH = value > 0 ? Math.max(3, (value / top) * plotH) : 0
      const y = plotBottom - barH
      const latest = index === revealCount - 1
      return `${track}
        <rect class="volume-bar${latest ? ' is-new' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(
          1,
        )}" height="${barH.toFixed(1)}" rx="5" fill="#eab35e" opacity="0.82"><title>${esc(
          `${point.label}: ${formatValue(value)} units${point.note ? ` · ${point.note}` : ''}`,
        )}</title></rect>
        ${
          barH > 2
            ? `<rect class="volume-cap${latest ? ' is-new' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(
                1,
              )}" height="2" rx="1" fill="#ffd28a" opacity="0.9"/>`
            : ''
        }`
    })
    .join('')

  const xLabels = points
    .map((point, index) => {
      const center = plotLeft + stepX * (index + 0.5)
      return `<text class="chart-axis-label volume-x-label" x="${center.toFixed(1)}" y="${height - 14}" fill="#77849a" font-size="11" text-anchor="middle">${esc(
        point.label,
      )}</text>`
    })
    .join('')

  return `<svg class="chart-svg volume-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    options.ariaLabel ?? 'Daily trade volume',
  )}" data-plot-left="${plotLeft}" data-plot-width="${plotW.toFixed(1)}" data-plot-top="${pad.top}" data-plot-height="${plotH}" data-plot-kind="bars" data-slot-count="${points.length}">
    <title>${esc(options.ariaLabel ?? 'Daily trade volume')}</title>
    <desc>${esc(options.emptyText ?? 'Bars show units traded each day; empty slots are days not yet revealed.')}</desc>
    <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.012)"/>
    ${grid}${bars}${xLabels}
  </svg>`
}

/** Tiny line used inside merchant cards in the collapsed details section. */
export function renderSparkline(points: Point[], options: SparklineOptions = {}): string {
  const width = options.width ?? 200
  const height = options.height ?? 30
  const data = sortedUnique(points)
  if (data.length < 2) {
    return `<svg viewBox="0 0 ${width} ${height}" class="spark" aria-hidden="true"></svg>`
  }
  const minX = data[0].x
  const maxX = data[data.length - 1].x
  const minY = Math.min(...data.map(point => point.y))
  const maxY = Math.max(...data.map(point => point.y))
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const d = data
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${(((point.x - minX) / spanX) * (width - 4) + 2).toFixed(1)},${(
          height - 3 - ((point.y - minY) / spanY) * (height - 6)
        ).toFixed(1)}`,
    )
    .join(' ')
  return `<svg viewBox="0 0 ${width} ${height}" class="spark" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${options.color ?? '#eab35e'}" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`
}

export const chartHints = { timeLabel, money: compact }

/* ------------------------------------------------------------------ money flow */

export interface MoneyFlowPoint {
  label: string
  merchant: number
  traveler: number
}

export interface MoneyFlowOptions {
  width?: number
  height?: number
  ariaLabel?: string
  emptyText?: string
  revealCount?: number
  valueFormat?: (value: number) => string
}

/**
 * Stacked daily cash bars: merchant tills at the bottom, traveler wallets on
 * top. The gold line is the town total, so the split and the total move
 * together in one glance.
 */
export function renderMoneyFlowChart(
  points: MoneyFlowPoint[],
  options: MoneyFlowOptions = {},
): string {
  const width = options.width ?? 560
  const height = options.height ?? 300
  const pad = { top: 24, right: 16, bottom: 38, left: 66 }
  const plotLeft = pad.left
  const plotRight = width - pad.right
  const plotW = Math.max(10, plotRight - plotLeft)
  const plotH = Math.max(10, height - pad.top - pad.bottom)
  const plotBottom = pad.top + plotH
  const revealCount = clamp(options.revealCount ?? points.length, 0, points.length)
  const formatValue = options.valueFormat ?? compact
  const maxValue = Math.max(
    1,
    ...points.map(point => Math.max(0, point.merchant) + Math.max(0, point.traveler)),
  )
  const step = niceStep(maxValue / 3)
  const top = Math.max(step, Math.ceil(maxValue / step) * step)

  if (points.length === 0) {
    return `<svg class="chart-svg money-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
      options.ariaLabel ?? 'Town cash split',
    )}">
      <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.014)"/>
      <text x="${width / 2}" y="${height / 2}" fill="#77849a" font-size="13" text-anchor="middle">${esc(
        options.emptyText ?? 'Cash history appears as days close…',
      )}</text>
    </svg>`
  }

  const scaleY = (value: number): number => pad.top + plotH - (value / top) * plotH
  let grid = ''
  for (let index = 0; index <= 3; index += 1) {
    const value = (top * index) / 3
    const y = scaleY(value)
    grid +=
      `<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.055)" stroke-width="1"/>` +
      `<text class="chart-axis-label" x="${plotLeft - 9}" y="${(y + 4).toFixed(1)}" fill="#77849a" font-size="11" text-anchor="end">${esc(
        formatValue(value),
      )}</text>`
  }

  const stepX = plotW / Math.max(1, points.length)
  const barW = Math.min(46, stepX * 0.58)
  const centers: Array<{ x: number; total: number }> = []
  const bars = points
    .map((point, index) => {
      const center = plotLeft + stepX * (index + 0.5)
      const merchant = Math.max(0, point.merchant)
      const traveler = Math.max(0, point.traveler)
      const total = merchant + traveler
      centers.push({ x: center, total })
      const x = center - barW / 2
      if (index >= revealCount) {
        return `<rect x="${x.toFixed(1)}" y="${pad.top}" width="${barW.toFixed(
          1,
        )}" height="${plotH}" rx="5" fill="rgba(255,255,255,0.025)"/>`
      }
      const merchantH = total > 0 ? (merchant / top) * plotH : 0
      const travelerH = total > 0 ? (traveler / top) * plotH : 0
      const merchantY = plotBottom - merchantH
      const travelerY = merchantY - travelerH
      return `<g><title>${esc(
        `${point.label}: ${formatValue(total)} total · ${formatValue(merchant)} in merchant tills · ${formatValue(
          traveler,
        )} in traveler wallets`,
      )}</title>
        <rect x="${x.toFixed(1)}" y="${merchantY.toFixed(1)}" width="${barW.toFixed(
          1,
        )}" height="${Math.max(0, merchantH).toFixed(1)}" rx="4" fill="#eab35e" opacity="0.9"/>
        <rect x="${x.toFixed(1)}" y="${travelerY.toFixed(1)}" width="${barW.toFixed(
          1,
        )}" height="${Math.max(0, travelerH).toFixed(1)}" rx="4" fill="#64b7a6" opacity="0.9"/>
      </g>`
    })
    .join('')

  const revealedCenters = centers.slice(0, revealCount)
  const totalPath = revealedCenters
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${scaleY(point.total).toFixed(1)}`,
    )
    .join(' ')
  const totalDots = revealedCenters
    .map(
      point =>
        `<circle cx="${point.x.toFixed(1)}" cy="${scaleY(point.total).toFixed(1)}" r="2.8" fill="#0d1118" stroke="#ffd28a" stroke-width="1.8"/>`,
    )
    .join('')
  const xLabels = points
    .map((point, index) => {
      const center = plotLeft + stepX * (index + 0.5)
      return `<text class="chart-axis-label" x="${center.toFixed(1)}" y="${height - 14}" fill="#77849a" font-size="11" text-anchor="middle">${esc(
        point.label,
      )}</text>`
    })
    .join('')

  return `<svg class="chart-svg money-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    options.ariaLabel ?? 'Town cash split by day',
  )}" data-plot-left="${plotLeft}" data-plot-width="${plotW.toFixed(1)}" data-plot-top="${pad.top}" data-plot-height="${plotH}" data-plot-kind="bars" data-slot-count="${points.length}">
    <title>${esc(options.ariaLabel ?? 'Town cash split by day')}</title>
    <desc>${esc(
      'Stacked bars show merchant tills and traveler wallets; the gold line is total cash in town.',
    )}</desc>
    <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.012)"/>
    ${grid}${bars}
    <path d="${totalPath}" fill="none" stroke="#ffd28a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
    ${totalDots}${xLabels}
  </svg>`
}

/* ------------------------------------------------------------------ flow balance */

export interface FlowPoint {
  label: string
  inflow: number
  outflow: number
  net: number
  orders: number
  caravanIn: number
  caravanOut: number
  investments: number
  sinks: number
}

export interface FlowChartOptions {
  width?: number
  height?: number
  ariaLabel?: string
  emptyText?: string
  revealCount?: number
  valueFormat?: (value: number) => string
}

/** Diverging daily bars: external inflows above zero, drains below. */
export function renderFlowChart(
  points: FlowPoint[],
  options: FlowChartOptions = {},
): string {
  const width = options.width ?? 560
  const height = options.height ?? 300
  const pad = { top: 24, right: 16, bottom: 38, left: 66 }
  const plotLeft = pad.left
  const plotRight = width - pad.right
  const plotW = Math.max(10, plotRight - plotLeft)
  const plotH = Math.max(10, height - pad.top - pad.bottom)
  const baseline = pad.top + plotH / 2
  const halfH = plotH / 2
  const revealCount = clamp(options.revealCount ?? points.length, 0, points.length)
  const formatValue = options.valueFormat ?? compact
  const maxAbs = Math.max(
    1,
    ...points.flatMap(point => [
      Math.max(0, point.inflow),
      Math.max(0, point.outflow),
      Math.abs(point.net),
    ]),
  )
  const step = niceStep(maxAbs)
  const top = Math.max(step, Math.ceil(maxAbs / step) * step)

  if (points.length === 0) {
    return `<svg class="chart-svg flow-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
      options.ariaLabel ?? 'External money flows',
    )}">
      <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.014)"/>
      <text x="${width / 2}" y="${height / 2}" fill="#77849a" font-size="13" text-anchor="middle">${esc(
        options.emptyText ?? 'Flows appear as days close…',
      )}</text>
    </svg>`
  }

  const scaleY = (value: number): number => baseline - (value / top) * halfH
  const grid = [top, 0, -top]
    .map(value => {
      const y = scaleY(value)
      const label = value === 0 ? '0' : value > 0 ? `+${formatValue(value)}` : `−${formatValue(-value)}`
      return `<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(
        1,
      )}" stroke="${value === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.055)'}" stroke-width="1"/>` +
        `<text class="chart-axis-label" x="${plotLeft - 9}" y="${(y + 4).toFixed(1)}" fill="#77849a" font-size="11" text-anchor="end">${esc(
          label,
        )}</text>`
    })
    .join('')

  const stepX = plotW / Math.max(1, points.length)
  const barW = Math.min(18, stepX * 0.27)
  const centers: Array<{ x: number; net: number }> = []
  const bars = points
    .map((point, index) => {
      const center = plotLeft + stepX * (index + 0.5)
      centers.push({ x: center, net: point.net })
      if (index >= revealCount) {
        return `<rect x="${(center - barW).toFixed(1)}" y="${pad.top}" width="${(barW * 2).toFixed(
          1,
        )}" height="${plotH}" rx="5" fill="rgba(255,255,255,0.02)"/>`
      }
      const inflow = Math.max(0, point.inflow)
      const outflow = Math.max(0, point.outflow)
      const inflowH = (inflow / top) * halfH
      const outflowH = (outflow / top) * halfH
      const inflowY = baseline - inflowH
      const outflowY = baseline
      return `<g><title>${esc(
        `${point.label}: +${formatValue(inflow)} in · −${formatValue(outflow)} out · net ${
          point.net >= 0 ? '+' : '−'
        }${formatValue(Math.abs(point.net))}\nOrders ${formatValue(point.orders)} · caravan in ${formatValue(
          point.caravanIn,
        )} · caravan out ${formatValue(point.caravanOut)} · investments ${formatValue(
          point.investments,
        )} · sinks ${formatValue(point.sinks)}`,
      )}</title>
        <rect x="${(center - barW).toFixed(1)}" y="${inflowY.toFixed(1)}" width="${barW.toFixed(
          1,
        )}" height="${Math.max(0, inflowH).toFixed(1)}" rx="3" fill="#76c79a" opacity="0.88"/>
        <rect x="${center.toFixed(1)}" y="${outflowY.toFixed(1)}" width="${barW.toFixed(
          1,
        )}" height="${Math.max(0, outflowH).toFixed(1)}" rx="3" fill="#e07a6b" opacity="0.88"/>
      </g>`
    })
    .join('')

  const netPath = centers
    .slice(0, revealCount)
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${scaleY(point.net).toFixed(1)}`)
    .join(' ')
  const netDots = centers
    .slice(0, revealCount)
    .map(
      point =>
        `<circle cx="${point.x.toFixed(1)}" cy="${scaleY(point.net).toFixed(1)}" r="2.8" fill="#0d1118" stroke="#eab35e" stroke-width="1.8"/>`,
    )
    .join('')
  const xLabels = points
    .map((point, index) => {
      const center = plotLeft + stepX * (index + 0.5)
      return `<text class="chart-axis-label" x="${center.toFixed(1)}" y="${height - 14}" fill="#77849a" font-size="11" text-anchor="middle">${esc(
        point.label,
      )}</text>`
    })
    .join('')

  return `<svg class="chart-svg flow-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    options.ariaLabel ?? 'External money flows by day',
  )}" data-plot-left="${plotLeft}" data-plot-width="${plotW.toFixed(1)}" data-plot-top="${pad.top}" data-plot-height="${plotH}" data-plot-kind="bars" data-slot-count="${points.length}">
    <title>${esc(options.ariaLabel ?? 'External money flows by day')}</title>
    <desc>${esc(
      'Green bars are external inflows; red bars are drains. The gold line is net flow. Trades inside town are excluded because they only move cash between tills and wallets.',
    )}</desc>
    <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.012)"/>
    ${grid}${bars}
    <path d="${netPath}" fill="none" stroke="#eab35e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
    ${netDots}${xLabels}
  </svg>`
}

/* ------------------------------------------------------------------ stall risk */

export interface RiskPoint {
  id: string
  label: string
  short: string
  cash: number
  reserve: number
  /** cash / reserve, already clamped by the caller only when displaying. */
  liquidity: number
  /** Average stock / target stock across the goods the stall carries. */
  stockCover: number
  /** Cash change since the start of the observed window. */
  delta: number
  open: boolean
  bankrupt: boolean
}

export interface RiskChartOptions {
  width?: number
  height?: number
  ariaLabel?: string
  emptyText?: string
  valueFormat?: (value: number) => string
}

/**
 * Liquidity x stock-cover map. Bubble size is the absolute per-stall cash
 * change, so one chart carries both risk and cash attribution.
 */
export function renderRiskScatter(points: RiskPoint[], options: RiskChartOptions = {}): string {
  const width = options.width ?? 560
  const height = options.height ?? 330
  const pad = { top: 34, right: 30, bottom: 48, left: 58 }
  const plotLeft = pad.left
  const plotRight = width - pad.right
  const plotW = Math.max(10, plotRight - plotLeft)
  const plotH = Math.max(10, height - pad.top - pad.bottom)
  const plotBottom = pad.top + plotH
  const formatValue = options.valueFormat ?? compact

  if (points.length === 0) {
    return `<svg class="chart-svg risk-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
      options.ariaLabel ?? 'Stall risk map',
    )}">
      <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="12" fill="rgba(255,255,255,0.014)"/>
      <text x="${width / 2}" y="${height / 2}" fill="#77849a" font-size="13" text-anchor="middle">${esc(
        options.emptyText ?? 'Stall risk appears when the market has closed a day.',
      )}</text>
    </svg>`
  }

  const rawXMax = Math.max(1.5, ...points.map(point => Math.max(0, point.liquidity) * 1.12))
  const xMax = Math.max(1.5, Math.min(7, Math.ceil(rawXMax * 2) / 2))
  const rawYMax = Math.max(1.2, ...points.map(point => Math.max(0, point.stockCover) * 1.12))
  const yMax = Math.max(1.2, Math.min(3.5, Math.ceil(rawYMax * 2) / 2))
  const xTicks = xMax <= 2 ? 4 : 5
  const yTicks = yMax <= 1.5 ? 3 : 4
  const scaleX = (value: number): number =>
    plotLeft + (clamp(value, 0, xMax) / xMax) * plotW
  const scaleY = (value: number): number =>
    pad.top + plotH - (clamp(value, 0, yMax) / yMax) * plotH
  const maxDelta = Math.max(1, ...points.map(point => Math.abs(point.delta)))

  let grid = ''
  for (let index = 0; index <= xTicks; index += 1) {
    const value = (xMax * index) / xTicks
    const x = scaleX(value)
    grid += `<line x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${plotBottom}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`
    if (index > 0) {
      grid += `<text class="chart-axis-label" x="${x.toFixed(1)}" y="${height - 15}" fill="#77849a" font-size="10.5" text-anchor="middle">${value.toFixed(1)}×</text>`
    }
  }
  for (let index = 0; index <= yTicks; index += 1) {
    const value = (yMax * index) / yTicks
    const y = scaleY(value)
    grid += `<line x1="${plotLeft}" y1="${y.toFixed(1)}" x2="${plotRight}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`
    grid += `<text class="chart-axis-label" x="${plotLeft - 9}" y="${(y + 4).toFixed(1)}" fill="#77849a" font-size="10.5" text-anchor="end">${Math.round(value * 100)}%</text>`
  }

  const reserveLine =
    xMax >= 1
      ? `<line class="risk-target-line" x1="${scaleX(1).toFixed(1)}" y1="${pad.top}" x2="${scaleX(1).toFixed(1)}" y2="${plotBottom}" stroke="rgba(234,179,94,0.42)" stroke-width="1.1" stroke-dasharray="4 6"/>
        <text class="risk-axis-note" x="${(scaleX(1) + 7).toFixed(1)}" y="${(pad.top + 13).toFixed(1)}" fill="#b79563" font-size="9.5" text-anchor="start">reserve</text>`
      : ''
  const targetLine =
    yMax >= 0.8
      ? `<line class="risk-target-line" x1="${plotLeft}" y1="${scaleY(0.8).toFixed(1)}" x2="${plotRight}" y2="${scaleY(0.8).toFixed(1)}" stroke="rgba(118,199,154,0.36)" stroke-width="1.1" stroke-dasharray="4 6"/>
        <text class="risk-axis-note" x="${(plotRight - 4).toFixed(1)}" y="${(scaleY(0.8) - 6).toFixed(1)}" fill="#82b59a" font-size="9.5" text-anchor="end">target stock</text>`
      : ''

  interface BubblePlacement {
    index: number
    x: number
    y: number
    radius: number
    tone: string
    color: string
    labelX: number
    labelY: number
    anchor: 'start' | 'middle' | 'end'
    leader: boolean
  }

  // Place the small number badges around overlapping bubbles. The scatter
  // position stays exact; only the label gets a leader line when needed.
  const placements: BubblePlacement[] = []
  const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = []
  for (const [index, point] of points.entries()) {
    const x = scaleX(point.liquidity)
    const y = scaleY(point.stockCover)
    const radius = 5 + Math.sqrt(Math.abs(point.delta) / maxDelta) * 10
    const tone =
      point.bankrupt || !point.open
        ? 'closed'
        : point.delta > 0.5
          ? 'up'
          : point.delta < -0.5
            ? 'down'
            : 'flat'
    const color =
      tone === 'closed' ? '#8a94a6' : tone === 'up' ? '#76c79a' : tone === 'down' ? '#e07a6b' : '#eab35e'
    const candidates: Array<{ x: number; y: number; anchor: 'start' | 'middle' | 'end' }> = [
      { x, y: y - radius - 8, anchor: 'middle' },
      { x: x + radius + 9, y: y + 3, anchor: 'start' },
      { x: x - radius - 9, y: y + 3, anchor: 'end' },
      { x, y: y + radius + 12, anchor: 'middle' },
    ]
    for (let step = 1; step <= 4; step += 1) {
      candidates.push({ x, y: y - radius - 8 - step * 12, anchor: 'middle' })
      candidates.push({ x, y: y + radius + 12 + step * 12, anchor: 'middle' })
    }
    let choice = candidates[0]
    for (const candidate of candidates) {
      const width = 9
      const height = 10
      const left =
        candidate.anchor === 'middle'
          ? candidate.x - width / 2
          : candidate.anchor === 'start'
            ? candidate.x
            : candidate.x - width
      const right = left + width
      const top = candidate.y - height / 2
      const bottom = top + height
      const outside =
        left < plotLeft + 1 || right > plotRight - 1 || top < pad.top + 1 || bottom > plotBottom - 1
      const overlaps = occupied.some(
        rect => left < rect.right + 2 && right > rect.left - 2 && top < rect.bottom + 1 && bottom > rect.top - 1,
      )
      if (!outside && !overlaps) {
        choice = candidate
        break
      }
    }
    const badgeWidth = 9
    const badgeHeight = 10
    const left =
      choice.anchor === 'middle'
        ? choice.x - badgeWidth / 2
        : choice.anchor === 'start'
          ? choice.x
          : choice.x - badgeWidth
    occupied.push({ left, right: left + badgeWidth, top: choice.y - badgeHeight / 2, bottom: choice.y + badgeHeight / 2 })
    placements.push({
      index,
      x,
      y,
      radius,
      tone,
      color,
      labelX: choice.x,
      labelY: choice.y,
      anchor: choice.anchor,
      leader: Math.hypot(choice.x - x, choice.y - y) > radius + 7,
    })
  }

  const bubbles = placements
    .map(placement => {
      const point = points[placement.index]
      const change = `${point.delta > 0.5 ? '+' : point.delta < -0.5 ? '−' : ''}${formatValue(Math.abs(point.delta))}`
      const leader = placement.leader
        ? `<line class="risk-label-leader" x1="${placement.x.toFixed(1)}" y1="${placement.y.toFixed(
            1,
          )}" x2="${placement.labelX.toFixed(1)}" y2="${placement.labelY.toFixed(
            1,
          )}" stroke="${placement.color}" stroke-width="0.8" opacity="0.46"/>`
        : ''
      return `<g class="risk-point risk-${placement.tone}">
        <title>${esc(
          `${point.label}: ${formatValue(point.cash)} cash · ${formatValue(point.reserve)} reserve (${point.liquidity.toFixed(
            2,
          )}×) · ${Math.round(point.stockCover * 100)}% stock cover · cash change ${change}${point.bankrupt ? ' · closed' : ''}`,
        )}</title>
        ${leader}
        <circle cx="${placement.x.toFixed(1)}" cy="${placement.y.toFixed(1)}" r="${placement.radius.toFixed(
          1,
        )}" fill="${placement.color}" fill-opacity="0.42" stroke="${placement.color}" stroke-width="1.5"/>
        <circle cx="${placement.x.toFixed(1)}" cy="${placement.y.toFixed(1)}" r="2.2" fill="${placement.color}"/>
        <text class="risk-point-label" x="${placement.labelX.toFixed(1)}" y="${(placement.labelY + 3).toFixed(
          1,
        )}" fill="#d7dfeb" font-size="8.5" font-weight="700" text-anchor="${placement.anchor}">${placement.index + 1}</text>
      </g>`
    })
    .join('')

  return `<svg class="chart-svg risk-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    options.ariaLabel ?? 'Stall liquidity and stock risk map',
  )}">
    <title>${esc(options.ariaLabel ?? 'Stall liquidity and stock risk map')}</title>
    <desc>${esc(
      'Horizontal axis: cash divided by reserve. Vertical axis: stock against target. Bubble size is the absolute cash change; green gained cash, red lost it.',
    )}</desc>
    <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="12" fill="rgba(255,255,255,0.012)"/>
    ${grid}${reserveLine}${targetLine}${bubbles}
    <text class="chart-axis-label" x="${(plotLeft + plotW / 2).toFixed(1)}" y="${height - 2}" fill="#77849a" font-size="10" text-anchor="middle">cash ÷ reserve</text>
    <text class="chart-axis-label" x="12" y="${(pad.top + plotH / 2).toFixed(1)}" fill="#77849a" font-size="10" text-anchor="middle" transform="rotate(-90 12 ${(pad.top + plotH / 2).toFixed(1)})">stock cover</text>
  </svg>`
}

/* ------------------------------------------------------------------ cash attribution */

export interface CashChangePoint {
  id: string
  label: string
  start: number
  end: number
  delta: number
  open: boolean
  bankrupt: boolean
}

export interface CashChangeOptions {
  width?: number
  height?: number
  ariaLabel?: string
  emptyText?: string
  valueFormat?: (value: number) => string
  windowLabel?: string
}

/** Horizontal diverging bars: one stall's cash change since the window start. */
export function renderCashChangeChart(
  points: CashChangePoint[],
  options: CashChangeOptions = {},
): string {
  const width = options.width ?? 560
  const height = options.height ?? 300
  const pad = { top: 24, right: 56, bottom: 22, left: 104 }
  const plotLeft = pad.left
  const plotRight = width - pad.right
  const plotW = Math.max(10, plotRight - plotLeft)
  const plotH = Math.max(10, height - pad.top - pad.bottom)
  const formatValue = options.valueFormat ?? compact
  const label = options.windowLabel ?? 'this window'

  if (points.length === 0) {
    return `<svg class="chart-svg cash-change-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
      options.ariaLabel ?? 'Per-stall cash change',
    )}">
      <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.014)"/>
      <text x="${width / 2}" y="${height / 2}" fill="#77849a" font-size="13" text-anchor="middle">${esc(
        options.emptyText ?? 'Cash changes appear when a day closes.',
      )}</text>
    </svg>`
  }

  const maxAbs = Math.max(1, ...points.map(point => Math.abs(point.delta)))
  const zeroX = plotLeft + plotW / 2
  const halfW = plotW * 0.44
  const rowH = plotH / points.length
  const barH = Math.min(18, rowH * 0.58)
  const rows = points
    .map((point, index) => {
      const y = pad.top + rowH * (index + 0.5)
      const length = (Math.abs(point.delta) / maxAbs) * halfW
      const positive = point.delta >= 0
      const x = positive ? zeroX : zeroX - length
      const tone = point.bankrupt || !point.open ? 'closed' : point.delta > 0.5 ? 'up' : point.delta < -0.5 ? 'down' : 'flat'
      const color = tone === 'closed' ? '#8a94a6' : tone === 'up' ? '#76c79a' : tone === 'down' ? '#e07a6b' : '#eab35e'
      const change = `${point.delta > 0.5 ? '+' : point.delta < -0.5 ? '−' : ''}${formatValue(Math.abs(point.delta))}`
      return `<g class="cash-change-row">
        <title>${esc(
          `${point.label}: ${formatValue(point.start)} at the start of ${label} → ${formatValue(point.end)} at the end (${change})${point.bankrupt ? ' · closed' : ''}`,
        )}</title>
        <text class="cash-change-label" x="${plotLeft - 10}" y="${(y + 4).toFixed(1)}" fill="#c4ccd9" font-size="11" text-anchor="end">${esc(
          point.label,
        )}</text>
        <rect x="${plotLeft}" y="${(y - barH / 2).toFixed(1)}" width="${plotW}" height="${barH.toFixed(1)}" rx="${(barH / 2).toFixed(1)}" fill="rgba(255,255,255,0.028)"/>
        <rect x="${x.toFixed(1)}" y="${(y - barH / 2).toFixed(1)}" width="${Math.max(1, length).toFixed(1)}" height="${barH.toFixed(1)}" rx="${(barH / 2).toFixed(1)}" fill="${color}" opacity="0.8"/>
        <text class="cash-change-value" x="${(positive ? zeroX + length + 7 : zeroX - length - 7).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="${color}" font-size="10.5" text-anchor="${positive ? 'start' : 'end'}">${esc(
          change,
        )}</text>
      </g>`
    })
    .join('')

  return `<svg class="chart-svg cash-change-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(
    options.ariaLabel ?? 'Per-stall cash change',
  )}">
    <title>${esc(options.ariaLabel ?? 'Per-stall cash change')}</title>
    <desc>${esc(
      `Horizontal bars show each stall's cash change from the start of ${label}; green gained, red lost, grey closed.`,
    )}</desc>
    <rect x="${plotLeft}" y="${pad.top}" width="${plotW}" height="${plotH}" rx="10" fill="rgba(255,255,255,0.012)"/>
    <line x1="${zeroX.toFixed(1)}" y1="${pad.top}" x2="${zeroX.toFixed(1)}" y2="${pad.top + plotH}" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>
    ${rows}
    <text class="chart-axis-label" x="${zeroX.toFixed(1)}" y="${height - 4}" fill="#77849a" font-size="9.5" text-anchor="middle">no change</text>
  </svg>`
}

/* ------------------------------------------------------------------ heatmap */

export type HeatmapTone = 'up' | 'down' | 'flat' | 'low' | 'mid' | 'high' | 'empty'

export interface HeatmapCell {
  label: string
  title: string
  tone: HeatmapTone
  strength?: number
}

export interface HeatmapColumn {
  id: string
  label: string
}

export interface HeatmapRow {
  id: string
  label: string
  cells: Record<string, HeatmapCell>
}

export interface HeatmapOptions {
  ariaLabel: string
  columns: HeatmapColumn[]
  rows: HeatmapRow[]
  emptyText?: string
}

const heatBackground = (tone: HeatmapTone, strength: number): string => {
  const alpha = 0.1 + Math.max(0, Math.min(1, strength)) * 0.32
  switch (tone) {
    case 'up':
      return `rgba(234,179,94,${alpha.toFixed(3)})`
    case 'down':
      return `rgba(96,165,250,${alpha.toFixed(3)})`
    case 'low':
      return `rgba(224,122,107,${alpha.toFixed(3)})`
    case 'mid':
      return `rgba(234,179,94,${alpha.toFixed(3)})`
    case 'high':
      return `rgba(118,199,154,${alpha.toFixed(3)})`
    case 'flat':
      return 'rgba(255,255,255,0.045)'
    default:
      return 'transparent'
  }
}

/** Compact table heatmap used for the all-merchant price/stock board. */
export function renderHeatmap(options: HeatmapOptions): string {
  if (options.rows.length === 0 || options.columns.length === 0) {
    return `<p class="empty-note">${esc(options.emptyText ?? 'No market observations yet.')}</p>`
  }
  const head = options.columns
    .map(column => `<th scope="col" title="${esc(column.label)}">${esc(column.label)}</th>`)
    .join('')
  const rows = options.rows
    .map(
      row =>
        `<tr><th scope="row">${esc(row.label)}</th>${options.columns
          .map(column => {
            const cell = row.cells[column.id]
            if (!cell || cell.tone === 'empty') {
              return '<td class="heat-cell is-empty" aria-label="No observation">·</td>'
            }
            const background = heatBackground(cell.tone, cell.strength ?? 0.45)
            return `<td class="heat-cell heat-${cell.tone}" style="background:${background}" title="${esc(
              cell.title,
            )}">${esc(cell.label)}</td>`
          })
          .join('')}</tr>`,
    )
    .join('')
  return `<div class="heatmap-scroll"><table class="heatmap-table" role="table" aria-label="${esc(
    options.ariaLabel,
  )}"><caption class="visually-hidden">${esc(options.ariaLabel)}</caption><thead><tr><th scope="col">Stall</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
}
