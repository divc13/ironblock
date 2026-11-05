/**
 * Shared day cursor for the spectator charts.
 *
 * Charts are plain SVG strings rebuilt on every SSE tick, so the cursor is a
 * DOM overlay that lives beside each SVG and is never destroyed by a render.
 * The shared state is a day identity (`open`, `day:12`, `now`), not a slot
 * index: price includes an opening point while the flow charts do not.
 */

type DayKind = 'open' | 'day' | 'now' | 'label'

interface DayIdentity {
  kind: DayKind
  value: number | string
  label: string
}

interface ChartEntry {
  id: string
  element: HTMLElement
  labels: string[]
  maxIndex: number
  overlay: HTMLDivElement
  labelEl: HTMLSpanElement
  cleanup: Array<() => void>
}

const entries = new Map<string, ChartEntry>()
let activeDay: DayIdentity | null = null
let activeSource: string | null = null
let initialized = false
let pointerFrame = 0
let pendingPointer: { id: string; clientX: number; clientY: number } | null = null
let resizeFrame = 0
let statusEl: HTMLParagraphElement | null = null

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value))

function parseLabel(label: string): DayIdentity {
  if (/^open$/i.test(label)) return { kind: 'open', value: 'open', label: 'Open' }
  if (/^(now|today)$/i.test(label)) return { kind: 'now', value: 'now', label: 'Now' }
  const day = /^D(\d+)$/i.exec(label)
  if (day) {
    const value = Number(day[1])
    return { kind: 'day', value, label: `Day ${value}` }
  }
  return { kind: 'label', value: label, label }
}

const identityKey = (day: DayIdentity): string => `${day.kind}:${day.value}`

function dayForIndex(entry: ChartEntry, index: number): DayIdentity | null {
  const label = entry.labels[index]
  return label ? parseLabel(label) : null
}

function indexForDay(entry: ChartEntry, day: DayIdentity): number | null {
  const key = identityKey(day)
  const index = entry.labels.findIndex(label => identityKey(parseLabel(label)) === key)
  if (index < 0 || index > entry.maxIndex) return null
  return index
}

function setStatus(day: DayIdentity | null): void {
  if (!statusEl) return
  statusEl.textContent = day
    ? `${day.label} selected on every chart. Use the chart table for exact values.`
    : ''
}

function positionOverlay(entry: ChartEntry, index: number): void {
  const svg = entry.element.querySelector<SVGSVGElement>('svg')
  if (!svg) {
    entry.overlay.hidden = true
    return
  }
  const svgRect = svg.getBoundingClientRect()
  const elementRect = entry.element.getBoundingClientRect()
  if (svgRect.width <= 0 || elementRect.width <= 0) {
    entry.overlay.hidden = true
    return
  }
  const viewBox = svg.viewBox.baseVal
  const viewWidth = viewBox && viewBox.width > 0 ? viewBox.width : svgRect.width
  const plotLeft = Number(svg.dataset.plotLeft)
  const plotWidth = Number(svg.dataset.plotWidth)
  const kind = svg.dataset.plotKind
  if (!Number.isFinite(plotLeft) || !Number.isFinite(plotWidth) || plotWidth <= 0) {
    entry.overlay.hidden = true
    return
  }
  const count = Math.max(1, entry.labels.length)
  const viewX =
    kind === 'bars'
      ? plotLeft + ((index + 0.5) / count) * plotWidth
      : count <= 1
        ? plotLeft + plotWidth / 2
        : plotLeft + (index / (count - 1)) * plotWidth
  const left = svgRect.left - elementRect.left + (viewX / viewWidth) * svgRect.width
  entry.overlay.style.left = `${left.toFixed(1)}px`
  entry.overlay.hidden = false
  entry.overlay.dataset.day = entry.labels[index] ?? ''
  entry.labelEl.textContent = entry.labels[index] ?? ''
}

function apply(): void {
  for (const entry of entries.values()) {
    if (!entry.overlay.isConnected) entry.element.append(entry.overlay)
    if (!activeDay) {
      entry.overlay.hidden = true
      continue
    }
    const index = indexForDay(entry, activeDay)
    if (index === null) {
      entry.overlay.hidden = true
      continue
    }
    positionOverlay(entry, index)
  }
  setStatus(activeDay)
}

function setDay(day: DayIdentity | null, source: string | null): void {
  activeDay = day
  activeSource = source
  apply()
}

function slotFromPointer(entry: ChartEntry, clientX: number): number | null {
  const svg = entry.element.querySelector<SVGSVGElement>('svg')
  if (!svg) return null
  const rect = svg.getBoundingClientRect()
  if (rect.width <= 0) return null
  const viewWidth = svg.viewBox.baseVal?.width || rect.width
  const viewX = ((clientX - rect.left) / rect.width) * viewWidth
  const plotLeft = Number(svg.dataset.plotLeft)
  const plotWidth = Number(svg.dataset.plotWidth)
  const kind = svg.dataset.plotKind
  if (!Number.isFinite(plotLeft) || !Number.isFinite(plotWidth) || plotWidth <= 0) return null
  const count = Math.max(1, entry.labels.length)
  const raw =
    kind === 'bars'
      ? Math.floor(((viewX - plotLeft) / plotWidth) * count)
      : Math.round(((viewX - plotLeft) / plotWidth) * (count - 1))
  return clamp(raw, 0, entry.maxIndex)
}

function setFromSlot(entry: ChartEntry, slot: number): void {
  const day = dayForIndex(entry, slot)
  if (day) setDay(day, entry.id)
}

function schedulePointer(event: PointerEvent, entry: ChartEntry): void {
  pendingPointer = { id: entry.id, clientX: event.clientX, clientY: event.clientY }
  if (pointerFrame) return
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0
    const next = pendingPointer
    pendingPointer = null
    if (!next) return
    const target = entries.get(next.id)
    if (!target) return
    const slot = slotFromPointer(target, next.clientX)
    if (slot === null) return
    setFromSlot(target, slot)
  })
}

function keyboard(event: KeyboardEvent, entry: ChartEntry): void {
  if (entry.labels.length === 0) return
  let current = activeDay ? indexForDay(entry, activeDay) : null
  if (current === null) current = entry.maxIndex >= 0 ? 0 : -1
  let next = current
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = current + 1
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = current - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = entry.maxIndex
  else if (event.key === 'Escape') {
    event.preventDefault()
    setDay(null, null)
    return
  } else return
  event.preventDefault()
  next = clamp(next, 0, entry.maxIndex)
  setFromSlot(entry, next)
}

function ensureOverlay(entry: ChartEntry): void {
  const overlay = document.createElement('div')
  overlay.className = 'shared-day-cursor'
  overlay.hidden = true
  overlay.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'shared-day-label'
  overlay.append(label)
  entry.element.append(overlay)
  entry.overlay = overlay
  entry.labelEl = label
}

/**
 * Register one chart container once. Re-renders only call `updateChart` to
 * replace labels and the current reveal limit.
 */
export function registerChart(id: string, element: HTMLElement): void {
  if (entries.has(id)) return
  const entry: ChartEntry = {
    id,
    element,
    labels: [],
    maxIndex: 0,
    overlay: null as unknown as HTMLDivElement,
    labelEl: null as unknown as HTMLSpanElement,
    cleanup: [],
  }
  ensureOverlay(entry)
  element.classList.add('chart-mount')
  element.tabIndex = 0
  element.setAttribute('role', 'group')

  const onPointerMove = (event: PointerEvent): void => schedulePointer(event, entry)
  const onPointerLeave = (): void => {
    if (activeSource === entry.id) setDay(null, null)
  }
  const onFocus = (): void => {
    if (!activeDay && entry.labels.length > 0) setFromSlot(entry, 0)
  }
  const onKeyDown = (event: KeyboardEvent): void => keyboard(event, entry)
  element.addEventListener('pointermove', onPointerMove)
  element.addEventListener('pointerleave', onPointerLeave)
  element.addEventListener('focus', onFocus)
  element.addEventListener('keydown', onKeyDown)
  entry.cleanup.push(
    () => element.removeEventListener('pointermove', onPointerMove),
    () => element.removeEventListener('pointerleave', onPointerLeave),
    () => element.removeEventListener('focus', onFocus),
    () => element.removeEventListener('keydown', onKeyDown),
  )
  entries.set(id, entry)
}

/** Update labels after a render, and clamp the cursor to revealed points. */
export function updateChart(id: string, labels: string[], maxIndex?: number): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.labels = labels
  entry.maxIndex = Math.max(0, Math.min(labels.length - 1, maxIndex ?? labels.length - 1))
  const svg = entry.element.querySelector<SVGSVGElement>('svg')
  if (svg) {
    const aria = svg.getAttribute('aria-label')
    if (aria) {
      entry.element.setAttribute('aria-label', `${aria} Shared day cursor; use left and right arrow keys.`)
    }
  }
  apply()
}

/** Sync from an existing focusable price band or tooltip interaction. */
export function setFromIndex(id: string, index: number): void {
  const entry = entries.get(id)
  if (!entry) return
  const slot = clamp(index, 0, entry.maxIndex)
  setFromSlot(entry, slot)
}

export function refreshCrosshair(): void {
  apply()
}

export function resetCrosshair(): void {
  setDay(null, null)
}

export function initCrosshair(): void {
  if (initialized) return
  initialized = true
  statusEl = document.createElement('p')
  statusEl.className = 'visually-hidden'
  statusEl.id = 'crosshair-status'
  statusEl.setAttribute('aria-live', 'polite')
  document.body.append(statusEl)
  const onViewportChange = (): void => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => apply())
  }
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, { passive: true })
  const cleanup = (): void => {
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange)
  }
  for (const entry of entries.values()) entry.cleanup.push(cleanup)
}

export function destroyCrosshair(): void {
  if (pointerFrame) cancelAnimationFrame(pointerFrame)
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  pointerFrame = 0
  resizeFrame = 0
  pendingPointer = null
  for (const entry of entries.values()) {
    for (const cleanup of entry.cleanup) cleanup()
    entry.overlay.remove()
  }
  entries.clear()
  statusEl?.remove()
  statusEl = null
  activeDay = null
  activeSource = null
  initialized = false
}
