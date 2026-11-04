import type { PublicSnapshot, PublicSummary } from '../server/observability'

/**
 * Small dependency-free SVG chart builders for the spectator dashboard.
 *
 * All x-values are simulated world seconds and all y-values are currency or
 * unit quantities, so live points and fast-forward replay points can share one
 * axis. Series colors are deterministic per label.
 */

const PALETTE = [
  '#7cc4ff', '#5ee0a2', '#ffcf7a', '#ff8a8a', '#c3a6ff',
  '#6fd8e0', '#f2a3e0', '#a0e2a0', '#e8b56a', '#8fa8ff',
]

export const seriesColor = (label: string, index?: number): string => {
  if (typeof index === 'number') return PALETTE[index % PALETTE.length]
  let hash = 0
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

const fmtMoney = (value: number): string => {
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(1)}k`
  if (Math.abs(value) >= 1_000) return `${(value / 1000).toFixed(1)}k`
  return value.toFixed(Math.abs(value) >= 100 ? 0 : 1)
}

const dayLabel = (time: number): string => `D${Math.floor(time / 86400) + 1}`

const timeLabel = (time: number): string => {
  const seconds = ((time % 86400) + 86400) % 86400
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${dayLabel(time)} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export interface Point {
  x: number
  y: number
}

export interface MultiSeries {
  label: string
  points: Point[]
  color?: string
}

export interface LineChartOptions {
  width?: number
  height?: number
  yLabel?: string
  xHint?: (x: number) => string
  yHint?: (y: number) => string
  /** Merchant id -> color that must stay stable across charts. */
  colorOverrides?: Map<string, string>
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Multi-series line chart with axes, grid lines and hover <title> hints.
 * Rendered as inline SVG so it scales cleanly at 720p and 1080p.
 */
export function renderLineChart(series: MultiSeries[], options: LineChartOptions = {}): string {
  const width = options.width ?? 720
  const height = options.height ?? 260
  const pad = { top: 14, right: 14, bottom: 26, left: 52 }
  const plotW = Math.max(10, width - pad.left - pad.right)
  const plotH = Math.max(10, height - pad.top - pad.bottom)

  const points = series.flatMap(candidate => candidate.points)
  if (points.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="no data yet"><text x="${pad.left}" y="${pad.top + 20}" fill="#7e8ca6" font-size="12">collecting data…</text></svg>`
  }

  const minX = Math.min(...points.map(p => p.x))
  const maxX = Math.max(...points.map(p => p.x))
  const minY = Math.min(0, ...points.map(p => p.y))
  const maxY = Math.max(1e-6, ...points.map(p => p.y))
  const spanX = maxX - minX || 1
  const padY = (maxY - minY) * 0.08
  const loY = minY
  const hiY = maxY + padY

  const scaleX = (x: number): number => pad.left + ((x - minX) / spanX) * plotW
  const scaleY = (y: number): number => pad.top + plotH - ((y - loY) / (hiY - loY || 1)) * plotH

  const gridLines = 4
  let grid = ''
  for (let i = 0; i <= gridLines; i += 1) {
    const y = pad.top + (plotH * i) / gridLines
    const value = hiY - ((hiY - loY) * i) / gridLines
    grid += `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#232c3f" stroke-width="1"/>` +
      `<text x="${pad.left - 6}" y="${y + 4}" fill="#7e8ca6" font-size="10" text-anchor="end">${esc(fmtMoney(value))}</text>`
  }

  const xTicks = 5
  let axis = ''
  for (let i = 0; i < xTicks; i += 1) {
    const t = minX + (spanX * i) / (xTicks - 1)
    axis += `<text x="${scaleX(t)}" y="${height - 8}" fill="#7e8ca6" font-size="10" text-anchor="middle">${esc(dayLabel(t))}</text>`
  }

  let paths = ''
  for (const candidate of series) {
    const sorted = [...candidate.points].sort((a, b) => a.x - b.x)
    if (sorted.length === 0) continue
    const color = candidate.color ?? seriesColor(candidate.label)
    const d = sorted
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(p.x).toFixed(1)},${scaleY(p.y).toFixed(1)}`)
      .join(' ')
    const dots = sorted
      .map(
        p =>
          `<circle cx="${scaleX(p.x).toFixed(1)}" cy="${scaleY(p.y).toFixed(1)}" r="1.8" fill="${color}"><title>${esc(
            `${candidate.label} @ ${timeLabel(p.x)}: ${options.yHint ? options.yHint(p.y) : p.y}`,
          )}</title></circle>`,
      )
      .join('')
    paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>${dots}`
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(options.yLabel ?? 'chart')}">
    <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="#0e1420"/>
    ${grid}${axis}${paths}
    <text x="${(width - pad.right)}" y="${pad.top - 3}" fill="#7e8ca6" font-size="10" text-anchor="end">${esc(options.yLabel ?? '')}</text>
  </svg>`
}

export interface SparklineOptions {
  width?: number
  height?: number
  color?: string
}

/** Tiny line used inside merchant cards. */
export function renderSparkline(points: Point[], options: SparklineOptions = {}): string {
  const width = options.width ?? 200
  const height = options.height ?? 30
  if (points.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`
  }
  const minX = Math.min(...points.map(p => p.x))
  const maxX = Math.max(...points.map(p => p.x))
  const minY = Math.min(...points.map(p => p.y))
  const maxY = Math.max(...points.map(p => p.y))
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1
  const d = points
    .map(
      (p, index) =>
        `${index === 0 ? 'M' : 'L'}${(((p.x - minX) / spanX) * (width - 4) + 2).toFixed(1)},${(
          height - 3 - ((p.y - minY) / spanY) * (height - 6)
        ).toFixed(1)}`,
    )
    .join(' ')
  return `<svg viewBox="0 0 ${width} ${height}" class="spark" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${options.color ?? '#7cc4ff'}" stroke-width="1.6"/>
  </svg>`
}

/**
 * Weekly merchant cash lines (from closed day summaries) plus a trailing live
 * point for the day in progress.
 */
export function merchantCashSeries(
  snapshots: PublicSummary[],
  current: PublicSnapshot | null,
): MultiSeries[] {
  const merchants = new Map<string, { label: string; points: Point[] }>()
  for (const summary of snapshots) {
    for (const [merchantId, cash] of Object.entries(summary.merchantCash)) {
      const entry = merchants.get(merchantId) ?? { label: merchantId, points: [] }
      entry.points.push({ x: summary.endedAt, y: cash })
      merchants.set(merchantId, entry)
    }
  }
  if (current) {
    for (const merchant of current.merchants) {
      const entry = merchants.get(merchant.id)
      if (entry) entry.points.push({ x: current.time, y: merchant.cash })
    }
  }
  return [...merchants.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([merchantId, entry], index) => ({
      label: entry.label,
      points: entry.points.sort((a, b) => a.x - b.x),
      color: seriesColor(merchantId, index),
    }))
}

export function legendHtml(entries: { label: string; color: string }[]): string {
  return entries
    .map(
      entry =>
        `<span class="key"><span class="swatch" style="background:${entry.color}"></span>${esc(entry.label)}</span>`,
    )
    .join('')
}

export const chartHints = { timeLabel, money: fmtMoney }
