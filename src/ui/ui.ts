import { characters } from '../config/characters'
import { economy } from '../config/economy'
import { readNearAuthSession } from '../client/auth/near-auth'
import { FAST_FORWARD_PLAYBACK_MS } from '../shared/economy/fast-forward'
import {
  mountWithdrawPanel,
  type WithdrawPanel,
} from '../client/settlement/withdraw-panel'
import type {
  EconomyClient,
  EconomySnapshot,
  FastForwardState,
  MerchantView,
  SessionRecap,
  TownHealth,
} from '../client/economy/types'
import type {
  ItemConfig,
  ItemId,
  MarketEvent,
  MerchantConfig,
  MerchantId,
  PriceReason,
  Quote,
  ResourceId,
  TradeSide,
} from '../shared/types'
import {
  blockedReasonLabel,
  describeEvent,
  describeLiveEvent,
  eventTypeLabel,
  explainQuote,
  formatEventTime,
  formatMoney,
  formatNumber,
  formatStamina,
  formatWeight,
  percentOf,
  pluralize,
  signedEffect,
  signedPercent,
  summarizeReasons,
  townHealthLabel,
  tradeFollowUp,
} from './format'
import {
  guidePercent,
  selectFirstDayGuide,
  type FirstDayGuide,
  type GuideBuyer,
  type GuideTarget,
  type GuideWaypoint,
} from './guide'
import {
  buildBestPriceIndex,
  buildMarketBoard,
  buildMarketRoutes,
  findBestBuyer,
  loadMarketQuotes,
  type ItemBestPrices,
  type MarketQuoteEntry,
  type MarketRoute,
  type MarketSide,
} from './market-board'
import {
  renderMarketPriceLadder,
  renderMerchantCashChart,
  renderTownCashChart,
  renderTradeVolumeChart,
} from './economy-charts'

export interface InteractionPrompt {
  key: string
  label: string
  hint?: string
}

export interface IronblockUI {
  openMerchant(id: MerchantId): Promise<void>
  openMarket(): Promise<void>
  openInventory(): void
  openFastForward(): void
  openRecap(): Promise<void>
  openOrders(): void
  openTownsfolk(): void
  openEvent(event: MarketEvent): void
  closePanel(): void
  isPanelOpen(): boolean
  setPrompt(prompt: InteractionPrompt | null): void
  /** Show or hide the live first-day direction cue; kept in sync by the game client. */
  setWaypoint(waypoint: GuideWaypoint | null): void
  /** Reopen the first-day objective after it was dismissed. */
  showGuide(): void
  toast(message: string, tone?: 'neutral' | 'good' | 'bad'): void
  /** True while a fast-forward reveal/world playback is in progress. */
  isFastForwarding(): boolean
  refresh(): Promise<void>
  destroy(): void
}

interface MountOptions {
  client: EconomyClient
  /** Shown in the HUD mode chip and a banner when the real client fell back. */
  note?: string
  fellBackToMock?: boolean
  /** Called by "Show me" / "Go there" actions so the world can set or clear a waypoint. */
  onNavigate?: (target: GuideTarget | null) => void
  /** Called once per refresh with market events the overlay has not seen yet. */
  onLiveEvents?: (events: MarketEvent[]) => void
}

type PanelSize = 'default' | 'narrow' | 'wide'
type PanelKind =
  | 'merchant'
  | 'market'
  | 'inventory'
  | 'fastforward'
  | 'recap'
  | 'orders'
  | 'townsfolk'
  | 'help'
  | 'event'

interface PanelShell {
  title: string
  subtitle?: string
  size?: PanelSize
  meta?: HTMLElement[]
  body: HTMLElement
  footer?: HTMLElement
}

const $ = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

const button = (
  label: string,
  onClick: () => void,
  options: { className?: string; disabled?: boolean; title?: string } = {},
): HTMLButtonElement => {
  const element = $('button', options.className ?? 'ib-button', label)
  element.type = 'button'
  if (options.title) element.title = options.title
  element.disabled = Boolean(options.disabled)
  element.addEventListener('click', event => {
    event.preventDefault()
    onClick()
  })
  return element
}

const itemLookup = economy.items as Record<string, ItemConfig | undefined>
const merchantLookup = economy.merchants as Record<string, MerchantConfig | undefined>

const itemName = (itemId: ItemId): string =>
  itemLookup[itemId]?.displayName ?? itemId


const personalityLabel = (id: string): string =>
  id.charAt(0).toUpperCase() + id.slice(1)

const stalenessLabel = (quote: Quote): string => {
  if (quote.canTrade) return quote.partialFill ? `Partial fill · max ${quote.maxQuantity}` : 'Ready'
  return blockedReasonLabel(quote.blockedReason)
}

const FIRST_DAY_DISMISSED_KEY = 'ironblock:first-day-goal-dismissed:v1'

const readFirstDayDismissed = (): boolean => {
  try {
    return window.localStorage.getItem(FIRST_DAY_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

const rememberFirstDayDismissed = (): void => {
  try {
    window.localStorage.setItem(FIRST_DAY_DISMISSED_KEY, '1')
  } catch {
    // Private browsing or storage denial: the card still dismisses for this session.
  }
}

const forgetFirstDayDismissed = (): void => {
  try {
    window.localStorage.removeItem(FIRST_DAY_DISMISSED_KEY)
  } catch {
    // The card still reopens for this session.
  }
}

const helpSteps = [
  ['Move', 'Walk with WASD or the arrow keys.'],
  ['Interact', 'Press E or Space near a stall or resource.'],
  ['Trade', 'Buy low at one stall, then sell high to another.'],
  ['Market', 'Press M for every best bid and ask, plus a profitable route.'],
  ['Gather', 'Work ore, fields, grove or pasture to stock your bag.'],
  ['Fast-forward', 'Run the week with F when you want the market to move.'],
] as const

const healthFromOpenStalls = (open: number, total: number): TownHealth => {
  const ratio = open / Math.max(1, total)
  if (ratio >= 1) return 'thriving'
  if (ratio >= 0.75) return 'stable'
  if (ratio >= 0.4) return 'strained'
  return 'critical'
}

export function mountIronblockUI(options: MountOptions): IronblockUI {
  const { client } = options
  if (document.getElementById('ironblock-ui')) {
    throw new Error('Ironblock overlay is already mounted')
  }

  const root = $('div')
  root.id = 'ironblock-ui'

  /* ------------------------------- chrome -------------------------------- */

  const hud = $('header', 'ib-hud')
  hud.setAttribute('role', 'banner')

  const modeChip = $('span', 'ib-chip ib-brand-chip', client.mode === 'server' ? 'Live market' : 'Mock market')

  const brand = $('div', 'ib-brand')
  brand.append($('strong', undefined, 'IRONBLOCK'), $('span', undefined, 'Market Square'), modeChip)

  const stats = $('div', 'ib-stats')
  const stat = (label: string, className = '') => {
    const box = $('div', `ib-stat${className ? ` ${className}` : ''}`)
    const title = $('b', undefined, label)
    const value = $('span', undefined, '—')
    const sub = $('small')
    box.append(title, value, sub)
    stats.append(box)
    return { box, value, sub }
  }

  const cashStat = stat('Cash')
  const clockStat = stat('Day', 'is-day')
  const weightStat = stat('Carry')
  const staminaStat = stat('Stamina')
  const townStat = stat('Town', 'is-town')

  const cashBar = $('div', 'ib-bar')
  const cashFill = $('i')
  cashBar.append(cashFill)
  weightStat.box.append(weightStat.sub, cashBar)

  const staminaBar = $('div', 'ib-bar')
  const staminaFill = $('i')
  staminaBar.append(staminaFill)
  staminaStat.box.append(staminaStat.sub, staminaBar)

  const ffChip = $('span', 'ib-ff-chip')
  ffChip.hidden = true
  ffChip.setAttribute('aria-live', 'polite')

  const actions = $('div', 'ib-actions')
  const hudButton = (
    label: string,
    key: string,
    onClick: () => void,
    className = 'ib-hud-button',
  ) => {
    const element = button(label, onClick, { className })
    const kbd = $('kbd', undefined, key)
    element.append(kbd)
    actions.append(element)
    return element
  }
  hudButton('Bag', 'I', () => ui.openInventory())
  hudButton('Market', 'M', () => void ui.openMarket())
  hudButton('Orders', 'O', () => ui.openOrders())
  hudButton('Week', 'F', () => ui.openFastForward(), 'ib-hud-button is-primary')

  const moreButton = button('More', () => toggleMoreMenu(), {
    className: 'ib-hud-button ib-more-button',
  })
  moreButton.setAttribute('aria-haspopup', 'menu')
  moreButton.setAttribute('aria-expanded', 'false')
  moreButton.setAttribute('aria-controls', 'ib-more-menu')
  actions.append(moreButton)

  const moreMenu = $('div', 'ib-more-menu')
  moreMenu.id = 'ib-more-menu'
  moreMenu.hidden = true
  moreMenu.setAttribute('role', 'menu')
  moreMenu.setAttribute('aria-label', 'More actions')

  const menuAction = (label: string, onClick: () => void, key?: string) => {
    const item = button(label, () => {
      closeMoreMenu()
      onClick()
    }, { className: 'ib-more-item' })
    item.setAttribute('role', 'menuitem')
    if (key) item.append($('kbd', undefined, key))
    moreMenu.append(item)
    return item
  }

  menuAction('Recap', () => void ui.openRecap(), 'R')
  menuAction('Townsfolk', () => ui.openTownsfolk(), 'T')
  menuAction('First-day goal', () => openGuide())
  menuAction('Withdraw to NEAR', openWithdraw)
  menuAction('How to play', () => renderHelp())

  const spectatorLink = document.createElement('a')
  spectatorLink.className = 'ib-more-item'
  spectatorLink.href = `${(import.meta.env.BASE_URL || '/').replace(/\/$/, '')}/spectator`
  spectatorLink.target = '_blank'
  spectatorLink.rel = 'noopener noreferrer'
  spectatorLink.textContent = 'Spectator ↗'
  spectatorLink.title = 'Open the read-only market spectator dashboard'
  spectatorLink.setAttribute('role', 'menuitem')
  spectatorLink.addEventListener('click', () => closeMoreMenu())
  moreMenu.append(spectatorLink)
  actions.append(moreMenu)

  hud.append(brand, stats, ffChip, actions)

  const ticker = $('aside', 'ib-ticker')
  ticker.id = 'ib-market-wire'
  ticker.hidden = true
  ticker.setAttribute('aria-label', 'Recent market events')
  const tickerHeader = $('header')
  tickerHeader.append($('h2', undefined, 'Market Wire'))
  const tickerCount = $('span', 'ib-muted', 'live')
  tickerHeader.append(tickerCount)
  const tickerClose = button('×', () => setWireOpen(false), {
    className: 'ib-close ib-wire-close',
    title: 'Close Market Wire',
  })
  tickerClose.setAttribute('aria-label', 'Close Market Wire')
  tickerHeader.append(tickerClose)
  const tickerList = $('ol')
  tickerList.setAttribute('aria-live', 'polite')
  ticker.append(tickerHeader, tickerList)

  const wireToggle = button('Wire · 0', () => setWireOpen(!wireOpen), {
    className: 'ib-wire-toggle',
  })
  wireToggle.setAttribute('aria-controls', 'ib-market-wire')
  wireToggle.setAttribute('aria-expanded', 'false')
  wireToggle.title = 'Open the recent market events drawer'

  const live = button('', () => setWireOpen(true), {
    className: 'ib-live',
  })
  live.hidden = true
  live.title = 'Open the Market Wire'
  const liveTag = $('span', 'ib-live-tag', 'Live')
  const liveText = $('span', 'ib-live-text')
  live.append(liveTag, liveText)

  const prompt = $('div', 'ib-prompt')
  prompt.hidden = true
  const promptKey = $('span', 'ib-key', 'E')
  const promptLabel = $('span')
  const promptHint = $('small')
  prompt.append(promptKey, promptLabel, promptHint)

  const toasts = $('div', 'ib-toasts')
  toasts.setAttribute('aria-live', 'polite')

  const scrim = $('div', 'ib-scrim')
  scrim.hidden = true

  const panel = $('section', 'ib-panel')
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'false')
  panel.setAttribute('aria-labelledby', 'ib-panel-title')

  const tooltip = $('div', 'ib-tooltip')
  tooltip.hidden = true
  tooltip.setAttribute('role', 'tooltip')
  tooltip.id = 'ib-reason-tooltip'

  const banner = $('div', 'ib-banner')
  banner.hidden = true

  const withdrawOverlay = $('div', 'ib-withdraw-overlay')
  withdrawOverlay.hidden = true
  withdrawOverlay.setAttribute('role', 'dialog')
  withdrawOverlay.setAttribute('aria-modal', 'true')
  withdrawOverlay.setAttribute('aria-label', 'Withdraw to NEAR')

  const withdrawCard = $('section', 'ib-withdraw-card')
  const withdrawHead = $('div', 'ib-withdraw-head')
  const withdrawTitle = $('h2', undefined, 'Withdraw to NEAR')
  const withdrawClose = button('×', closeWithdraw, {
    className: 'ib-close',
    title: 'Close withdraw panel',
  })
  withdrawClose.setAttribute('aria-label', 'Close withdraw panel')
  withdrawHead.append(withdrawTitle, withdrawClose)
  const withdrawBody = $('div', 'ib-withdraw-body')
  withdrawCard.append(withdrawHead, withdrawBody)
  withdrawOverlay.append(withdrawCard)

  const guide = $('section', 'ib-guide')
  guide.setAttribute('aria-label', 'First day objective')
  guide.hidden = readFirstDayDismissed()
  const guideHead = $('div', 'ib-guide-head')
  guideHead.append($('strong', undefined, 'First day'))
  const guideCount = $('span', 'ib-guide-count', '1 / 4')
  const guideClose = button('×', () => dismissGuide(), {
    className: 'ib-close ib-guide-close',
    title: 'Dismiss the first-day objective',
  })
  guideClose.setAttribute('aria-label', 'Dismiss the first-day objective')
  guideHead.append(guideCount, guideClose)

  const guideIntro = $('p', 'ib-guide-intro')
  const guideObjective = $('b', 'ib-guide-objective', 'Reading the market…')
  const guideDetail = $('p', 'ib-guide-detail')
  const guideProgress = $('div', 'ib-guide-progress')
  guideProgress.setAttribute('role', 'progressbar')
  guideProgress.setAttribute('aria-valuemin', '0')
  guideProgress.setAttribute('aria-valuemax', '1')
  guideProgress.setAttribute('aria-valuenow', '0')
  guideProgress.setAttribute('aria-label', 'First-day goal progress')
  const guideFill = $('i')
  guideProgress.append(guideFill)
  const guideMeta = $('div', 'ib-guide-meta')
  const guideProgressLabel = $('span', 'ib-guide-progress-label', '0 / 0')
  const guideAction = button('Show me', () => performGuideAction(), {
    className: 'ib-button is-small is-primary',
  })
  guideAction.title = 'Close overlays and show the way to this goal'
  const guideHelp = button('?', () => renderHelp(), {
    className: 'ib-button is-small is-quiet ib-guide-help',
  })
  guideHelp.title = 'Open the full How to Play panel'
  guideHelp.setAttribute('aria-label', 'How to play')
  guideMeta.append(guideProgressLabel, guideAction, guideHelp)
  const guideWaypoint = $('p', 'ib-guide-waypoint')
  guideWaypoint.hidden = true
  guideWaypoint.setAttribute('aria-live', 'polite')
  guide.append(
    guideHead,
    guideIntro,
    guideObjective,
    guideDetail,
    guideProgress,
    guideMeta,
    guideWaypoint,
  )

  root.append(
    hud,
    wireToggle,
    live,
    ticker,
    prompt,
    toasts,
    scrim,
    panel,
    tooltip,
    banner,
    withdrawOverlay,
    guide,
  )
  document.body.append(root)

  if (options.fellBackToMock && options.note) {
    banner.textContent = options.note
    banner.hidden = false
  }

  /* -------------------------------- state -------------------------------- */

  let snapshot: EconomySnapshot | null = null
  let activeKind: PanelKind | null = null
  let activeMerchantId: MerchantId | null = null
  let activeTab: TradeSide = 'buy'
  let quantities: Record<string, number> = {}
  let busy = false
  let lastFocused: HTMLElement | null = null
  let fastForwardUnsub: (() => void) | null = null
  let fastForwardHudUnsub: (() => void) | null = null
  let wireOpen = false
  let moreOpen = false
  let weekCompleteTimer: number | null = null
  let destroyed = false
  let guideState: FirstDayGuide | null = null
  let guideRenderToken = 0
  let guideBuyer: GuideBuyer | null = null
  let guideBuyerFetchedAt = 0
  let guideStepId: FirstDayGuide['step']['id'] | null = null
  let guidedTarget: GuideTarget | null = null
  let guidedTargetFollowsStep = false
  let currentWaypoint: GuideWaypoint | null = null
  let quoteCache: { entries: MarketQuoteEntry[]; at: number } | null = null
  let quoteRequest: Promise<MarketQuoteEntry[]> | null = null
  let marketRenderToken = 0
  let reportedEventIds = new Set<string>()
  let liveEventsPrimed = false
  let refreshInFlight = false
  let livePollTimer: number | null = null

  const QUOTE_CACHE_MS = 15_000

  const keyFor = (merchantId: MerchantId, side: TradeSide, itemId: ItemId) =>
    `${merchantId}:${side}:${itemId}`

  function setWireOpen(open: boolean): void {
    if (wireOpen === open) return
    wireOpen = open
    ticker.hidden = !open
    wireToggle.setAttribute('aria-expanded', String(open))
    wireToggle.classList.toggle('is-open', open)
    if (open) {
      setMoreMenuOpen(false)
      tickerClose.focus({ preventScroll: true })
    } else if (ticker.contains(document.activeElement)) {
      wireToggle.focus({ preventScroll: true })
    }
  }

  function setMoreMenuOpen(open: boolean): void {
    if (moreOpen === open) return
    moreOpen = open
    moreMenu.hidden = !open
    moreButton.setAttribute('aria-expanded', String(open))
    moreButton.classList.toggle('is-open', open)
    if (open) {
      setWireOpen(false)
      const first = moreMenu.querySelector<HTMLElement>('[role="menuitem"]')
      first?.focus({ preventScroll: true })
    } else if (moreMenu.contains(document.activeElement)) {
      moreButton.focus({ preventScroll: true })
    }
  }

  function toggleMoreMenu(): void {
    setMoreMenuOpen(!moreOpen)
  }

  function closeMoreMenu(): void {
    setMoreMenuOpen(false)
  }

  function dismissGuide(): void {
    guide.hidden = true
    rememberFirstDayDismissed()
  }

  function openGuide(): void {
    guide.hidden = false
    forgetFirstDayDismissed()
    if (snapshot) void renderGuide(snapshot)
  }

  function renderWaypoint(): void {
    if (!currentWaypoint) {
      guideWaypoint.hidden = true
      return
    }
    guideWaypoint.hidden = false
    guideWaypoint.textContent = currentWaypoint.arrived
      ? `You are at ${currentWaypoint.label} — press E.`
      : `${currentWaypoint.label} · ${currentWaypoint.direction} · ${currentWaypoint.distance} paces`
  }

  function clearNavigation(): void {
    if (!guidedTarget) return
    guidedTarget = null
    guidedTargetFollowsStep = false
    currentWaypoint = null
    renderWaypoint()
    options.onNavigate?.(null)
  }

  function startNavigation(target: GuideTarget, followsStep: boolean): void {
    guidedTarget = target
    guidedTargetFollowsStep = followsStep
    currentWaypoint = null
    renderWaypoint()
    if (options.onNavigate) {
      options.onNavigate(target)
    } else {
      ui.toast(`Head to ${target.label}.`, 'neutral')
    }
  }

  function performGuideAction(): void {
    const step = guideState?.step
    if (!step) return
    if (step.target) {
      closePanel()
      startNavigation(step.target, true)
      return
    }
    if (step.panel === 'bag') {
      closePanel()
      ui.openInventory()
    } else if (step.panel === 'market') {
      closePanel()
      void ui.openMarket()
    } else if (step.panel === 'week') {
      ui.openFastForward()
    }
  }

  const invalidateMarketQuotes = (): void => {
    quoteCache = null
    quoteRequest = null
    guideBuyerFetchedAt = 0
  }

  async function marketQuotes(
    data: EconomySnapshot,
    force = false,
  ): Promise<MarketQuoteEntry[]> {
    if (!force && quoteCache && Date.now() - quoteCache.at < QUOTE_CACHE_MS) {
      return quoteCache.entries
    }
    if (quoteRequest) return quoteRequest
    const request = loadMarketQuotes(client, data)
      .then(entries => {
        quoteCache = { entries, at: Date.now() }
        return entries
      })
      .finally(() => {
        if (quoteRequest === request) quoteRequest = null
      })
    quoteRequest = request
    return request
  }

  async function renderGuide(data: EconomySnapshot): Promise<void> {
    const token = ++guideRenderToken
    const inventory = data.player.inventory.map(line => ({
      itemId: line.itemId,
      quantity: line.quantity,
    }))
    const baseInput = {
      day: data.day,
      cash: data.player.cash,
      inventory,
      events: data.recentEvents,
    }

    let nextGuide = selectFirstDayGuide(baseInput)
    if (nextGuide.step.id === 'sell') {
      if (!guideBuyer || Date.now() - guideBuyerFetchedAt > QUOTE_CACHE_MS) {
        try {
          const best = await findBestBuyer(client, data, 'iron_ingot')
          guideBuyer = best
            ? {
                merchantId: best.merchantId,
                displayName: best.merchantName,
                unitPrice: best.unitPrice,
              }
            : null
          guideBuyerFetchedAt = Date.now()
        } catch {
          guideBuyer = null
        }
      }
      if (token !== guideRenderToken || destroyed) return
      nextGuide = selectFirstDayGuide({ ...baseInput, bestIngotBuyer: guideBuyer })
    }

    if (guidedTarget) {
      const stepChanged = guideStepId !== null && nextGuide.step.id !== guideStepId
      const guideTargetChanged =
        guidedTargetFollowsStep && nextGuide.step.target?.id !== guidedTarget.id
      if (stepChanged || guideTargetChanged) clearNavigation()
    }
    guideStepId = nextGuide.step.id

    guideState = nextGuide
    const { step, intro } = nextGuide
    guideCount.textContent = `${step.index} / ${step.total}`
    guideIntro.textContent = intro
    guideIntro.hidden = step.id === 'sell' || step.id === 'week' || step.id === 'done'
    guideObjective.textContent = step.title
    guideObjective.title = step.detail
    guideDetail.textContent = step.detail
    // Keep the first gathering step as a slim strip; "Show me" carries the
    // location detail, so the card does not sit on top of nearby nameplates.
    guideDetail.hidden = step.id === 'gather'
    guideProgressLabel.textContent = step.progress.label
    guideProgress.setAttribute('aria-valuemax', String(Math.max(1, step.progress.target)))
    guideProgress.setAttribute('aria-valuenow', String(step.progress.current))
    guideProgress.setAttribute('aria-label', `First-day goal progress: ${step.progress.label}`)
    guideFill.style.width = `${guidePercent(step.progress)}%`
    guideAction.textContent = step.actionLabel
    guideAction.disabled = false
    guideAction.title = step.completed
      ? 'Open the market board'
      : step.target
        ? `Close overlays and show the way to ${step.target.label}`
        : step.panel
          ? step.actionLabel
          : 'Continue the first-day goal'
    if (!guide.hidden) renderWaypoint()
  }

  async function bestPriceIndex(): Promise<Map<ItemId, ItemBestPrices>> {
    if (!snapshot) return new Map()
    try {
      const entries = await marketQuotes(snapshot)
      return buildBestPriceIndex(entries)
    } catch {
      return new Map()
    }
  }

  /* ------------------------------- HUD ----------------------------------- */

  const publishLiveEvents = (events: MarketEvent[]): void => {
    if (!options.onLiveEvents) return
    const fresh = events.filter(event => !reportedEventIds.has(event.id))
    for (const event of events) reportedEventIds.add(event.id)
    if (reportedEventIds.size > 600) {
      const keep = new Set(events.map(event => event.id))
      reportedEventIds = new Set([...reportedEventIds].filter(id => keep.has(id)))
    }
    if (!liveEventsPrimed) {
      liveEventsPrimed = true
      return
    }
    if (fresh.length > 0) options.onLiveEvents(fresh)
  }

  const renderHud = (next: EconomySnapshot) => {
    snapshot = next
    cashStat.value.textContent = formatMoney(next.player.cash, economy.currency.symbol)
    cashStat.sub.textContent = `${next.openMerchants}/${next.merchants.length} stalls open`

    weightStat.value.textContent = formatWeight(next.player.weight, next.player.carryCapacity)
    weightStat.sub.textContent = next.player.weight > next.player.carryCapacity * 0.9 ? 'Nearly full' : 'Free capacity'
    cashFill.style.width = `${percentOf(next.player.weight, next.player.carryCapacity)}%`
    cashBar.classList.toggle(
      'is-low',
      next.player.weight > next.player.carryCapacity * 0.9,
    )

    staminaStat.value.textContent = formatStamina(next.player.stamina, next.player.maxStamina)
    staminaStat.sub.textContent = 'Regenerates while walking'
    staminaFill.style.width = `${percentOf(next.player.stamina, next.player.maxStamina)}%`
    staminaBar.classList.toggle('is-low', next.player.stamina < next.player.maxStamina * 0.25)
    staminaBar.classList.toggle('is-good', next.player.stamina > next.player.maxStamina * 0.7)

    clockStat.value.textContent = next.clock
    clockStat.sub.textContent = next.bankruptcies > 0 ? `${pluralize(next.bankruptcies, 'stall')} closed` : 'All stalls trading'

    townStat.value.textContent = townHealthLabel(next.townHealth)
    townStat.value.className = 'ib-health'
    townStat.value.dataset.health = next.townHealth
    townStat.sub.textContent = `Day ${next.day} · ${next.openMerchants}/${next.merchants.length} open`

    renderTicker(next.recentEvents)
    publishLiveEvents(next.recentEvents)
    void renderGuide(next)
    if (activePanelBody) void refreshActivePanel()
  }

  const renderTicker = (events: MarketEvent[]) => {
    tickerList.replaceChildren()
    const recent = [...events].slice(0, 9)
    tickerCount.textContent = recent.length > 0 ? `${events.length} recent` : 'quiet'
    wireToggle.textContent = `Wire · ${events.length}`
    if (events.length === 0) {
      live.hidden = true
    } else {
      const latest = events[0]
      const line = describeLiveEvent(
        latest,
        latest.item ? itemName(latest.item) : undefined,
      )
      live.hidden = false
      live.dataset.tone = line.tone
      liveText.textContent = line.headline
      live.setAttribute(
        'aria-label',
        `Latest market event: ${line.headline}. Open the Market Wire.`,
      )
    }
    if (recent.length === 0) {
      const empty = $('li', 'ib-empty', 'No trades yet. Talk to a merchant or gather at the edge of town.')
      tickerList.append(empty)
      return
    }
    for (const event of recent) {
      const line = describeEvent(event, event.item ? itemName(event.item) : undefined)
      const li = $('li')
      const row = button('', () => {
        setWireOpen(false)
        ui.openEvent(event)
      }, { className: 'ib-ticker-row' })
      row.dataset.tone = line.tone
      const time = $('time', undefined, formatEventTime(event.time))
      const copy = $('div')
      copy.append(
        $('strong', undefined, `${line.actor} ${line.headline}`),
        $('span', undefined, line.detail),
      )
      row.append(time, copy)
      row.setAttribute(
        'aria-label',
        `${formatEventTime(event.time)} ${eventTypeLabel(event.type)}: ${line.actor} ${line.headline}`,
      )
      li.append(row)
      tickerList.append(li)
    }
  }

  const applyFastForwardHud = (state: FastForwardState): void => {
    const active = state.status === 'running' || state.status === 'paused'
    hud.classList.toggle('is-fast-forwarding', active)
    if (weekCompleteTimer !== null) {
      window.clearTimeout(weekCompleteTimer)
      weekCompleteTimer = null
    }

    if (active) {
      const total = state.totalDays || economy.fastForward.days
      const shownDay =
        state.startDay > 0
          ? Math.min(state.endDay || state.startDay + total, state.startDay + state.day)
          : state.day
      ffChip.hidden = false
      ffChip.textContent =
        state.status === 'paused'
          ? `Paused · ${state.day}/${total}`
          : `Fast-forwarding · ${state.day}/${total}`
      ffChip.title = state.message
      clockStat.value.textContent = `Day ${Math.max(1, shownDay)}`
      clockStat.sub.textContent = `${Math.round(state.progress * 100)}% of the week`
      const latest = state.days[state.days.length - 1]
      if (latest) {
        const totalMerchants =
          snapshot?.merchants.length ?? Object.keys(economy.merchants).length
        const health = healthFromOpenStalls(latest.merchantsOpen, totalMerchants)
        townStat.value.textContent = townHealthLabel(health)
        townStat.value.dataset.health = health
        townStat.sub.textContent = `Day ${latest.day} · ${latest.merchantsOpen}/${totalMerchants} open`
      }
      return
    }

    if (state.status === 'done') {
      ffChip.hidden = false
      ffChip.textContent = 'Week complete'
      ffChip.title = state.message
      weekCompleteTimer = window.setTimeout(() => {
        ffChip.hidden = true
        weekCompleteTimer = null
      }, 4_000)
      return
    }

    ffChip.hidden = true
  }

  /* ------------------------------ panel shell ---------------------------- */

  let activePanelBody: HTMLElement | null = null

  const closePanel = (): void => {
    if (panel.hidden) return
    panel.hidden = true
    panel.replaceChildren()
    scrim.hidden = true
    activeKind = null
    activeMerchantId = null
    activePanelBody = null
    guide.hidden = readFirstDayDismissed()
    hideTooltip()
    if (lastFocused?.isConnected) lastFocused.focus({ preventScroll: true })
    lastFocused = null
    document.dispatchEvent(new CustomEvent('ironblock:panel-closed'))
  }

  /* --------------------------- withdraw overlay -------------------------- */

  let withdrawPanel: WithdrawPanel | null = null

  function closeWithdraw(): void {
    if (withdrawOverlay.hidden) return
    withdrawPanel?.destroy()
    withdrawPanel = null
    withdrawBody.replaceChildren()
    withdrawOverlay.hidden = true
  }

  function openWithdraw(): void {
    if (!withdrawOverlay.hidden) {
      void withdrawPanel?.refresh()
      return
    }
    withdrawOverlay.hidden = false
    withdrawPanel = mountWithdrawPanel({
      container: withdrawBody,
      // Same base as the game, so subpath builds hit the right API.
      apiBase: import.meta.env.BASE_URL,
      getSessionToken: () => readNearAuthSession()?.sessionToken,
      onSessionNeeded: () =>
        ui.toast('Sign in with NEAR Auth to withdraw items.', 'bad'),
    })
    // Pull the current on-chain/ledger state whenever the action is opened.
    void withdrawPanel.refresh()
  }

  const showPanel = (kind: PanelKind, shell: PanelShell): HTMLElement => {
    setMoreMenuOpen(false)
    setWireOpen(false)
    if (!lastFocused) lastFocused = document.activeElement as HTMLElement | null
    activeKind = kind
    guide.hidden = true
    panel.hidden = false
    scrim.hidden = false
    panel.dataset.size = shell.size ?? 'default'
    panel.replaceChildren()

    const head = $('div', 'ib-panel-head')
    const titleWrap = $('div')
    const heading = $('h2', undefined, shell.title)
    heading.id = 'ib-panel-title'
    titleWrap.append(heading)
    if (shell.subtitle) titleWrap.append($('p', undefined, shell.subtitle))
    if (shell.meta && shell.meta.length > 0) {
      const meta = $('div', 'ib-head-meta')
      meta.append(...shell.meta)
      titleWrap.append(meta)
    }

    const close = button('×', closePanel, { className: 'ib-close', title: 'Close (Escape)' })
    close.setAttribute('aria-label', 'Close panel')
    head.append(titleWrap, close)

    panel.append(head, shell.body)
    if (shell.footer) panel.append(shell.footer)

    activePanelBody = shell.body
    close.focus({ preventScroll: true })
    return shell.body
  }

  const refreshActivePanel = async (): Promise<void> => {
    if (busy || !activeKind) return
    if (activeKind === 'merchant' && activeMerchantId) {
      await renderMerchant(activeMerchantId, false)
    } else if (activeKind === 'market') {
      await renderMarket()
    } else if (!panel.hidden && activeKind === 'inventory') {
      await renderInventory()
    } else if (activeKind === 'recap') {
      await renderRecap()
    }
  }

  /* ------------------------------ tooltip -------------------------------- */

  const hideTooltip = (): void => {
    tooltip.hidden = true
    tooltip.replaceChildren()
  }

  const showReasonTooltip = (anchor: HTMLElement, reasons: PriceReason[], basePrice: number): void => {
    const summary = summarizeReasons(reasons)
    tooltip.replaceChildren()
    tooltip.append($('h4', undefined, 'Price breakdown'))
    tooltip.append($('p', 'ib-tooltip-summary', summary.summary))
    const table = $('table')
    const thead = $('thead')
    const headRow = $('tr')
    for (const label of ['Reason', 'Input', 'Effect']) {
      headRow.append($('th', undefined, label))
    }
    thead.append(headRow)
    const tbody = $('tbody')
    for (const row of summary.rows) {
      const tr = $('tr')
      const label = $('td')
      label.append($('div', undefined, row.label))
      if (row.detail) label.append($('small', undefined, row.detail))
      const value = $('td', 'is-num', row.value)
      const effect = $('td', 'is-num', row.effect)
      effect.className = `is-num ${row.direction === 'up' ? 'ib-effect-up' : row.direction === 'down' ? 'ib-effect-down' : ''}`
      tr.append(label, value, effect)
      tbody.append(tr)
    }
    const total = $('tr')
    total.append(
      $('td', undefined, 'Base price'),
      $('td', 'is-num', formatMoney(basePrice, economy.currency.symbol)),
      $('td', 'is-num', ''),
    )
    tbody.append(total)
    table.append(thead, tbody)
    tooltip.append(table)
    tooltip.hidden = false

    const rect = anchor.getBoundingClientRect()
    const width = Math.min(360, window.innerWidth - 24)
    let left = rect.right - width
    if (left < 12) left = 12
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12
    let top = rect.bottom + 8
    const estimatedHeight = 260
    if (top + estimatedHeight > window.innerHeight - 12) {
      top = Math.max(12, rect.top - estimatedHeight - 8)
    }
    tooltip.style.left = `${left}px`
    tooltip.style.top = `${top}px`
    tooltip.style.width = `${width}px`
  }

  const wireReasonButton = (
    target: HTMLElement,
    reasons: PriceReason[],
    basePrice: number,
    itemLabel: string,
  ): void => {
    const reasonButton = button('?', () => undefined, {
      className: 'ib-reason-button',
      title: `Why ${itemLabel} costs this`,
    })
    reasonButton.setAttribute('aria-label', `Price reasons for ${itemLabel}`)
    reasonButton.setAttribute('aria-describedby', tooltip.id)
    const show = () => showReasonTooltip(reasonButton, reasons, basePrice)
    reasonButton.addEventListener('mouseenter', show)
    reasonButton.addEventListener('focus', show)
    reasonButton.addEventListener('mouseleave', hideTooltip)
    reasonButton.addEventListener('blur', hideTooltip)
    target.append(reasonButton)
  }

  /* --------------------------- merchant panel ---------------------------- */

  const renderMerchant = async (merchantId: MerchantId, resetTab = true): Promise<void> => {
    const merchant = await client.getMerchant(merchantId)
    if (!merchant) {
      ui.toast('That merchant is no longer trading.', 'bad')
      return
    }
    if (resetTab && activeMerchantId !== merchantId) {
      activeTab = 'buy'
      quantities = {}
    }
    activeMerchantId = merchantId

    if (!snapshot) snapshot = await client.getSnapshot()
    const bestPrices = await bestPriceIndex()

    const meta: HTMLElement[] = [
      $('span', `ib-chip ${merchant.open ? 'is-open' : 'is-closed'}`, merchant.open ? 'Open' : 'Closed'),
      $('span', 'ib-chip', personalityLabel(merchant.personality)),
      $('span', 'ib-chip', `Cash ${formatMoney(merchant.cash, economy.currency.symbol)}`),
    ]
    if (merchant.bankrupt) {
      meta.push($('span', 'ib-chip is-closed', 'Below reserve'))
    }

    const body = $('div', 'ib-panel-body')
    const shell: PanelShell = {
      title: merchant.displayName,
      subtitle: `Stall ${merchantLookup[merchantId]?.stallSlot ?? '—'} · buys ${merchant.buys.length} goods · sells ${merchant.sells.length}`,
      meta,
      body,
      footer: (() => {
        const foot = $('div', 'ib-panel-foot')
        foot.append(
          $('span', undefined, `Reserve ${formatMoney(merchant.reserve, economy.currency.symbol)} · ${merchant.stockUnits} units in stock`),
          $('span', undefined, 'Prices come from the market service.'),
        )
        return foot
      })(),
    }

    if (panel.hidden || activeKind !== 'merchant' || activeMerchantId !== merchantId) {
      showPanel('merchant', shell)
    } else {
      activePanelBody = body
      panel.replaceChildren()
      const keepHead = $('div', 'ib-panel-head')
      const titleWrap = $('div')
      const heading = $('h2', undefined, merchant.displayName)
      heading.id = 'ib-panel-title'
      titleWrap.append(
        heading,
        $('p', undefined, shell.subtitle ?? ''),
      )
      const metaWrap = $('div', 'ib-head-meta')
      metaWrap.append(...meta)
      titleWrap.append(metaWrap)
      const close = button('×', closePanel, { className: 'ib-close', title: 'Close (Escape)' })
      close.setAttribute('aria-label', 'Close panel')
      keepHead.append(titleWrap, close)
      panel.append(keepHead, body)
      if (shell.footer) panel.append(shell.footer)
    }

    if (merchant.bankrupt) {
      body.append(investmentBlock(merchant))
    }

    const tabs = $('div', 'ib-tabs')
    tabs.setAttribute('role', 'tablist')
    const buyTab = $('button', 'ib-tab', `Buy from ${merchant.displayName}`)
    buyTab.type = 'button'
    buyTab.role = 'tab'
    buyTab.setAttribute('aria-selected', String(activeTab === 'buy'))
    const sellTab = $('button', 'ib-tab', 'Sell to merchant')
    sellTab.type = 'button'
    sellTab.role = 'tab'
    sellTab.setAttribute('aria-selected', String(activeTab === 'sell'))
    buyTab.addEventListener('click', () => {
      activeTab = 'buy'
      void renderMerchant(merchantId, false)
    })
    sellTab.addEventListener('click', () => {
      activeTab = 'sell'
      void renderMerchant(merchantId, false)
    })
    tabs.append(buyTab, sellTab)
    body.append(tabs)

    const items = activeTab === 'buy' ? merchant.sells : merchant.buys
    if (items.length === 0) {
      body.append($('p', 'ib-muted', 'This merchant has nothing on this side of the counter.'))
      return
    }

    const table = $('table', 'ib-table')
    const thead = $('thead')
    const headRow = $('tr')
    for (const label of [
      'Item',
      activeTab === 'buy' ? 'Stock' : 'In bag',
      'Unit price',
      'Qty',
      'Total',
      '',
    ]) {
      headRow.append($('th', undefined, label))
    }
    thead.append(headRow)
    const tbody = $('tbody')
    table.append(thead, tbody)

    const notes = $('div', 'ib-trade-note')
    notes.hidden = true
    notes.setAttribute('aria-live', 'polite')

    const appendPrice = (target: HTMLElement, current: Quote, itemId: ItemId): void => {
      const price = $('span', 'ib-price', formatMoney(current.unitPrice, economy.currency.symbol))
      price.append(
        $('small', undefined, `base ${formatMoney(current.basePrice, economy.currency.symbol, 0)}`),
      )
      const best = bestPrices.get(itemId)
      const isBest =
        activeTab === 'buy'
          ? best?.buy?.merchantId === merchantId
          : best?.sell?.merchantId === merchantId
      if (isBest) {
        const tag = $('span', 'ib-best-tag', '★ Best in town')
        tag.title =
          activeTab === 'buy'
            ? `Lowest ask for ${itemName(itemId)} in the square`
            : `Highest bid for ${itemName(itemId)} in the square`
        price.append(tag)
      }
      target.append(price)
    }

    for (const itemId of items) {
      const quote = await client.getQuote(merchantId, itemId, activeTab, quantityFor(merchantId, itemId))
      if (!quote) continue
      const row = $('tr')
      const nameCell = $('td')
      const name = $('div', 'ib-item-name')
      name.append(document.createTextNode(itemName(itemId)), $('small', undefined, `${itemLookup[itemId]?.weight ?? 0} kg`))
      nameCell.append(name)
      const stockCell = $('td', 'is-num')
      stockCell.textContent =
        activeTab === 'buy'
          ? formatNumber(quote.constraints.stock)
          : formatNumber(quote.constraints.playerInventory ?? 0)

      const priceCell = $('td', 'is-num')
      appendPrice(priceCell, quote, itemId)
      wireReasonButton(priceCell, quote.reasons, quote.basePrice, itemName(itemId))

      const qtyCell = $('td')
      const stepper = buildStepper(quote, value => {
        quantities[keyFor(merchantId, activeTab, itemId)] = value
        void refreshRowQuote()
      })
      qtyCell.append(stepper)

      const totalCell = $('td', 'is-num ib-price')
      totalCell.textContent = formatMoney(quote.total, economy.currency.symbol)

      const actionCell = $('td', 'is-num')
      const action = button(activeTab === 'buy' ? 'Buy' : 'Sell', () => void doTrade(merchantId, itemId, activeTab), {
        className: 'ib-button is-primary is-small',
        disabled: !quote.canTrade,
      })
      if (!quote.canTrade) {
        action.title = explainQuote(quote, itemName(itemId))
        action.setAttribute('aria-describedby', 'ib-merchant-note')
      }
      actionCell.append(action)

      row.append(nameCell, stockCell, priceCell, qtyCell, totalCell, actionCell)
      tbody.append(row)

      const updateRow = async () => {
        const qty = quantityFor(merchantId, itemId)
        const current = await client.getQuote(merchantId, itemId, activeTab, qty)
        priceCell.replaceChildren()
        appendPrice(priceCell, current, itemId)
        wireReasonButton(priceCell, current.reasons, current.basePrice, itemName(itemId))
        stepper.dataset.max = String(current.maxQuantity)
        const stepperInput = stepper.querySelector('input')
        if (stepperInput) stepperInput.max = String(Math.max(1, current.maxQuantity))
        totalCell.textContent = formatMoney(current.total, economy.currency.symbol)
        action.disabled = !current.canTrade
        action.title = current.canTrade ? '' : explainQuote(current, itemName(itemId))
        showNote(current)
      }

      const refreshRowQuote = async () => {
        await updateRow()
      }

      const showNote = (current: Quote) => {
        if (current.canTrade) {
          notes.hidden = false
          notes.dataset.tone = 'good'
          notes.textContent = explainQuote(current, itemName(itemId))
        } else {
          notes.hidden = false
          notes.dataset.tone = 'bad'
          notes.textContent = explainQuote(current, itemName(itemId))
        }
        notes.id = 'ib-merchant-note'
      }

      const stepperMax = Math.max(1, quote.maxQuantity)
      stepper.dataset.max = String(stepperMax)
    }

    body.append(table, notes)
  }

  const quantityFor = (merchantId: MerchantId, itemId: ItemId): number =>
    quantities[keyFor(merchantId, activeTab, itemId)] ?? 1

  const buildStepper = (quote: Quote, onChange: (value: number) => void): HTMLElement => {
    const wrap = $('div', 'ib-qty')
    const max = Math.max(1, quote.maxQuantity)
    const input = $('input')
    input.type = 'number'
    input.min = '1'
    input.max = String(max)
    input.value = String(Math.min(quantityFor(quote.merchantId, quote.itemId), max))
    input.setAttribute('aria-label', `Quantity of ${itemName(quote.itemId)}`)

    const clampValue = (value: number) => Math.max(1, Math.min(max, Math.floor(value) || 1))
    const decrease = button('−', () => {
      input.value = String(clampValue(Number(input.value) - 1))
      onChange(Number(input.value))
    }, { className: 'ib-qty-button' })
    decrease.style.border = '0'
    decrease.style.background = 'transparent'
    decrease.style.width = '26px'
    decrease.style.height = '28px'
    decrease.style.fontWeight = '700'
    const increase = button('+', () => {
      input.value = String(clampValue(Number(input.value) + 1))
      onChange(Number(input.value))
    }, { className: 'ib-qty-button' })
    increase.style.border = '0'
    increase.style.background = 'transparent'
    increase.style.width = '26px'
    increase.style.height = '28px'
    increase.style.fontWeight = '700'

    input.addEventListener('change', () => {
      input.value = String(clampValue(Number(input.value)))
      onChange(Number(input.value))
    })
    wrap.append(decrease, input, increase)
    return wrap
  }

  const investmentBlock = (merchant: MerchantView): HTMLElement => {
    const card = $('div', 'ib-card')
    card.style.marginBottom = '12px'
    card.append($('h3', undefined, 'Bankruptcy — cash injection required'))
    const required = merchant.requiredInvestment
    card.append(
      $(
        'p',
        undefined,
        `${merchant.displayName} is ${formatMoney(merchant.cash, economy.currency.symbol)} against a reserve of ` +
          `${formatMoney(merchant.reserve, economy.currency.symbol)}. Inject ` +
          `${formatMoney(required, economy.currency.symbol)} to reopen the stall.`,
      ),
    )
    const row = $('div', 'ib-controls')
    const status = $('span', 'ib-muted')
    const investButton = button(
      `Reopen stall — ${formatMoney(required, economy.currency.symbol)}`,
      async () => {
        if (busy) return
        busy = true
        const result = await client.invest(merchant.id, required)
        busy = false
        ui.toast(result.message, result.ok ? 'good' : 'bad')
        await ui.refresh()
        await renderMerchant(merchant.id, false)
      },
      { className: 'ib-button is-primary' },
    )
    if (snapshot && snapshot.player.cash < required) {
      investButton.disabled = true
      status.textContent = `You have ${formatMoney(snapshot.player.cash, economy.currency.symbol)}.`
    }
    row.append(investButton, status)
    card.append(row)
    return card
  }

  const doTrade = async (merchantId: MerchantId, itemId: ItemId, side: TradeSide): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const quantity = quantityFor(merchantId, itemId)
      const result =
        side === 'buy'
          ? await client.buy({ merchantId, itemId, quantity })
          : await client.sell({ merchantId, itemId, quantity })
      if (result.ok) {
        invalidateMarketQuotes()
        const merchant = await client.getMerchant(merchantId)
        const followUp = tradeFollowUp({
          side,
          merchantName: merchant?.displayName ?? merchantId,
          itemName: itemName(itemId),
          stockAfter: merchant?.stock[itemId] ?? 0,
        })
        ui.toast(`${result.message.replace(/\s*\.\s*$/, '')}. ${followUp}`, 'good')
        quantities[keyFor(merchantId, side, itemId)] = 1
        await ui.refresh()
      } else {
        ui.toast(result.message, 'bad')
      }
      await renderMerchant(merchantId, false)
    } finally {
      busy = false
    }
  }

  /* ----------------------------- market panel ---------------------------- */

  const navigateToMerchant = (merchantId: MerchantId, label: string): void => {
    closePanel()
    guide.hidden = false
    startNavigation({ kind: 'merchant', id: merchantId, label }, false)
  }

  const renderMarket = async (force = false): Promise<void> => {
    const data = snapshot ?? (await client.getSnapshot())
    snapshot = data
    const token = ++marketRenderToken
    const body = $('div', 'ib-panel-body')
    body.append($('p', 'ib-muted', 'Reading prices, tills and trade volume…'))

    const shell: PanelShell = {
      title: 'Market Board',
      subtitle: 'Prices, cash and volume at a glance — every number comes from the same stall quotes.',
      size: 'wide',
      body,
    }
    if (!panel.hidden && activeKind === 'market') {
      activePanelBody = body
      panel.replaceChildren()
      const keepHead = $('div', 'ib-panel-head')
      const titleWrap = $('div')
      const heading = $('h2', undefined, shell.title)
      heading.id = 'ib-panel-title'
      titleWrap.append(heading, $('p', undefined, shell.subtitle ?? ''))
      const close = button('×', closePanel, { className: 'ib-close', title: 'Close (Escape)' })
      close.setAttribute('aria-label', 'Close panel')
      keepHead.append(titleWrap, close)
      panel.append(keepHead, body)
    } else {
      showPanel('market', shell)
    }

    let entries: MarketQuoteEntry[]
    try {
      entries = await marketQuotes(data, force)
    } catch {
      if (token !== marketRenderToken || activeKind !== 'market') return
      body.replaceChildren(
        $('p', 'ib-muted', 'The live quotes could not be read. Close the panel and try again.'),
      )
      return
    }
    if (token !== marketRenderToken || activeKind !== 'market' || destroyed) return

    body.replaceChildren()
    body.append(
      $(
        'p',
        'ib-market-intro',
        'Ask is what you pay. Bid is what a stall pays you. Charts use the same live quotes as the counters.',
      ),
    )

    if (entries.length === 0) {
      body.append($('p', 'ib-muted', 'No stalls are quoting right now.'))
      return
    }

    const rows = buildMarketBoard(entries)
    const routes = buildMarketRoutes(entries, rows, 3)
    const currentMerchantCash = data.merchants.reduce((sum, merchant) => sum + merchant.cash, 0)

    const charts = $('div', 'ib-market-charts')
    charts.append(
      renderMarketPriceLadder(rows, entries),
      renderMerchantCashChart(data.merchants, data.today.merchantCashStart),
      renderTownCashChart(data.summaries, currentMerchantCash, data.today),
      renderTradeVolumeChart(data.summaries, data.today),
    )
    body.append(charts)

    if (routes.length > 0) {
      body.append($('h3', 'ib-market-heading', 'Best moves now'))
      const dealGrid = $('div', 'ib-deal-grid')
      for (const route of routes) {
        dealGrid.append(marketDealCard(route))
      }
      body.append(dealGrid)
    }

    const scroll = $('div', 'ib-market-scroll')
    const table = $('table', 'ib-table ib-market-table')
    const thead = $('thead')
    const headRow = $('tr')
    for (const label of ['Item', 'Where to get it', 'Best buy (ask)', 'Best sell (bid)', 'Spread', '']) {
      headRow.append($('th', undefined, label))
    }
    thead.append(headRow)
    const tbody = $('tbody')

    for (const row of rows) {
      const tr = $('tr')
      const nameCell = $('td')
      const name = $('div', 'ib-item-name')
      name.append(document.createTextNode(row.displayName), $('small', undefined, row.category))
      nameCell.append(name)
      nameCell.append($('small', 'ib-market-item-copy', row.description))
      const whereCell = $('td', 'ib-market-where', row.where)
      const buyCell = marketSideCell(row.bestBuy)
      const sellCell = marketSideCell(row.bestSell)
      const spreadCell = $('td', 'is-num')
      const spread = $(
        'span',
        row.profitable ? 'ib-spread-up' : 'ib-spread-down',
        `${row.spread > 0.005 ? '+' : ''}${formatMoney(row.spread, economy.currency.symbol)}`,
      )
      spreadCell.append(
        spread,
        $('small', 'ib-market-spread-pct', signedPercent(row.spreadPct)),
      )
      const actionCell = $('td', 'is-num')
      const destination = row.bestSell ?? row.bestBuy
      if (destination) {
        const go = button('Go', () => navigateToMerchant(destination.merchantId, destination.merchantName), {
          className: 'ib-button is-small',
          title: `Close the board and show the way to ${destination.merchantName}`,
        })
        go.setAttribute('aria-label', `Go to ${destination.merchantName} for ${row.displayName}`)
        actionCell.append(go)
      }
      tr.append(nameCell, whereCell, buyCell, sellCell, spreadCell, actionCell)
      tbody.append(tr)
    }

    table.append(thead, tbody)
    scroll.append(table)

    const details = $('details', 'ib-market-table-details')
    const detailsSummary = $('summary')
    const detailsCopy = $('span', 'ib-market-table-copy')
    detailsCopy.append(
      $('strong', undefined, 'Full quote table'),
      $('small', undefined, `${rows.length} items · ${entries.length} live quotes`),
    )
    detailsSummary.append(detailsCopy, $('span', 'ib-market-table-chevron', '+'))
    details.append(detailsSummary, scroll)
    body.append(details)

    body.append(
      $(
        'p',
        'ib-market-foot',
        'Prices move with stock, demand and merchant cash. Reopen Market (M) for fresh quotes.',
      ),
    )
  }

  const marketDealCard = (route: MarketRoute): HTMLElement => {
    const card = $('article', 'ib-deal')
    card.dataset.kind = route.kind
    const head = $('div', 'ib-deal-head')
    const kind = $(
      'span',
      'ib-deal-kind',
      route.kind === 'trade' ? 'Spread' : route.kind === 'craft' ? 'Craft' : 'Gather & sell',
    )
    head.append(kind, $('span', 'ib-deal-profit', route.profitLabel))
    card.append(
      head,
      $('h4', undefined, route.title),
      $('p', undefined, route.detail),
      button(
        route.actionLabel,
        () => navigateToMerchant(route.target.merchantId, route.target.merchantName),
        {
          className: 'ib-button is-small is-primary',
          title: `Close the board and show the way to ${route.target.merchantName}`,
        },
      ),
    )
    return card
  }

  const marketSideCell = (side: MarketSide | null): HTMLElement => {
    const cell = $('td', 'ib-market-side')
    if (!side) {
      cell.append($('span', 'ib-muted', '—'))
      return cell
    }
    cell.append(
      $('strong', undefined, side.merchantName),
      $('small', undefined, formatMoney(side.unitPrice, economy.currency.symbol)),
    )
    return cell
  }

  /* --------------------------- inventory panel --------------------------- */

  const renderInventory = async (): Promise<void> => {
    const data = snapshot ?? (await client.getSnapshot())
    snapshot = data
    const player = data.player
    const body = $('div', 'ib-panel-body')

    const head = $('div', 'ib-grid cols-3')
    const staminaCard = $('div', 'ib-card')
    staminaCard.append($('h3', undefined, 'Stamina'))
    staminaCard.append($('strong', undefined, formatStamina(player.stamina, player.maxStamina)))
    staminaCard.append(
      $('p', 'ib-muted', player.stamina < 25 ? 'Eat bread before gathering.' : 'Gathering and crafting spend stamina.'),
    )
    const bagCard = $('div', 'ib-card')
    bagCard.append($('h3', undefined, 'Carry'))
    bagCard.append($('strong', undefined, formatWeight(player.weight, player.carryCapacity)))
    bagCard.append($('p', 'ib-muted', `${formatNumber(player.carryCapacity - player.weight)} kg free`))
    const toolCard = $('div', 'ib-card')
    toolCard.append($('h3', undefined, 'Equipped tool'))
    const equipped = player.equippedTool ? itemLookup[player.equippedTool] : undefined
    toolCard.append($('strong', undefined, equipped?.displayName ?? 'None'))
    const durability = player.equippedTool
      ? player.toolDurability[player.equippedTool] ?? 0
      : 0
    toolCard.append(
      $('p', 'ib-muted', equipped?.tool ? `${formatNumber(durability)} / ${equipped.tool.maxDurability} durability` : 'Tools must be equipped to gather.'),
    )
    head.append(staminaCard, bagCard, toolCard)
    body.append(head)

    body.append($('h3', 'ib-card', 'Bag')) // heading styled as card? use simple heading below
    const bagHeading = body.lastElementChild as HTMLElement
    bagHeading.style.border = '0'
    bagHeading.style.background = 'transparent'
    bagHeading.style.padding = '14px 0 6px'
    bagHeading.style.fontSize = '1rem'
    bagHeading.style.fontFamily = 'var(--ib-serif)'

    const bagTable = $('table', 'ib-table')
    const bagHead = $('thead')
    const bagHeadRow = $('tr')
    for (const label of ['Item', 'Qty', 'Weight', 'Actions']) {
      bagHeadRow.append($('th', undefined, label))
    }
    bagHead.append(bagHeadRow)
    const bagBody = $('tbody')
    bagTable.append(bagHead, bagBody)

    if (player.inventory.length === 0) {
      const empty = $('tr')
      const cell = $('td', 'ib-muted', 'Your bag is empty. Gather at the ore, fields, grove or pasture.')
      cell.colSpan = 4
      empty.append(cell)
      bagBody.append(empty)
    }

    for (const line of player.inventory) {
      const item = itemLookup[line.itemId]
      if (!item) continue
      const row = $('tr')
      const nameCell = $('td')
      const name = $('div', 'ib-item-name')
      name.append(document.createTextNode(item.displayName))
      if (line.equipped) name.append($('small', undefined, 'equipped'))
      nameCell.append(name)
      const qty = $('td', 'is-num', formatNumber(line.quantity))
      const weight = $('td', 'is-num', `${formatNumber(line.totalWeight)} kg`)
      const actionsCell = $('td')

      if (item.tool && line.tool) {
        const low = line.tool.durability <= item.tool.maxDurability * economy.sinks.toolDurability.repairThresholdRatio
        const repair = button(
          `Repair ${formatMoney((item.tool.maxDurability - line.tool.durability) * economy.sinks.toolDurability.repairCostPerPoint, economy.currency.symbol)}`,
          async () => {
            if (busy) return
            busy = true
            const result = await client.repair(line.itemId)
            busy = false
            ui.toast(result.message, result.ok ? 'good' : 'bad')
            await ui.refresh()
            await renderInventory()
          },
          { className: `ib-button is-small ${low ? 'is-danger' : 'is-quiet'}`, disabled: line.tool.durability >= item.tool.maxDurability },
        )
        actionsCell.append(repair)
        if (line.equipped) {
          actionsCell.append($('span', 'ib-muted', ' · equipped'))
        }
        if (low) {
          actionsCell.append($('div', 'ib-muted', 'Worn — repair before gathering.'))
        }
      } else if (item.use.kind === 'consumable') {
        const eat = button('Eat', async () => {
          if (busy) return
          busy = true
          const result = await client.eat(line.itemId)
          busy = false
          ui.toast(result.message, result.ok ? 'good' : 'bad')
          await ui.refresh()
          await renderInventory()
        }, { className: 'ib-button is-small' })
        actionsCell.append(eat)
      } else {
        actionsCell.append($('span', 'ib-muted', item.use.kind === 'wearable' ? 'Wearable' : 'Ingredient'))
      }

      row.append(nameCell, qty, weight, actionsCell)
      bagBody.append(row)
    }
    body.append(bagTable)

    const craftHeading = $('h3', undefined, 'Workshop')
    craftHeading.style.border = '0'
    craftHeading.style.background = 'transparent'
    craftHeading.style.padding = '18px 0 6px'
    craftHeading.style.fontSize = '1rem'
    craftHeading.style.fontFamily = 'var(--ib-serif)'
    body.append(craftHeading, $('p', 'ib-muted', 'Recipes run instantly. Inputs are consumed and stamina is spent.'))

    const recipeGrid = $('div', 'ib-recipe-grid')
    for (const recipe of Object.values(economy.recipes)) {
      const card = $('div', 'ib-recipe')
      const outputs = Object.entries(recipe.outputs)
        .map(([itemId, count]) => `${count}× ${itemName(itemId)}`)
        .join(', ')
      const head = $('div', 'ib-recipe-head')
      head.append(
        $('strong', 'ib-recipe-title', recipe.displayName),
        $('span', 'ib-recipe-output', `→ ${outputs}`),
      )
      card.append(head)

      const inputs = $('div', 'ib-recipe-inputs')
      let missing = false
      for (const [itemId, need] of Object.entries(recipe.inputs)) {
        const have = player.inventory.find(line => line.itemId === itemId)?.quantity ?? 0
        const short = have < need
        missing = missing || short
        const chip = $('span', `ib-recipe-input${short ? ' is-missing' : ''}`)
        chip.append(
          $('b', undefined, `${have}/${need}`),
          document.createTextNode(` ${itemName(itemId)}`),
        )
        chip.title = short
          ? `Need ${need} ${itemName(itemId)}, you have ${have}`
          : `${have} ${itemName(itemId)} ready`
        inputs.append(chip)
      }
      card.append(inputs, $('span', 'ib-recipe-meta', `${recipe.staminaCost} stamina`))

      const tired = player.stamina < recipe.staminaCost
      const label = missing ? 'Missing inputs' : tired ? 'Rest first' : 'Craft'
      const craft = button(
        label,
        async () => {
          if (busy) return
          busy = true
          const result = await client.craft(recipe.id)
          busy = false
          ui.toast(result.message, result.ok ? 'good' : 'bad')
          await ui.refresh()
          await renderInventory()
        },
        {
          className: 'ib-button is-small is-primary',
          disabled: missing || tired,
          title: missing
            ? `Missing inputs for ${recipe.displayName}`
            : tired
              ? `Need ${recipe.staminaCost} stamina`
              : `Craft ${recipe.displayName}`,
        },
      )
      card.append(craft)
      recipeGrid.append(card)
    }
    body.append(recipeGrid)

    const shell: PanelShell = {
      title: 'Bag & Workshop',
      subtitle: 'Gather, repair, eat and craft. Tools wear down with every gather.',
      body,
    }
    if (!panel.hidden && activeKind === 'inventory') {
      activePanelBody = body
      panel.replaceChildren()
      const keepHead = $('div', 'ib-panel-head')
      const titleWrap = $('div')
      const heading = $('h2', undefined, shell.title)
      heading.id = 'ib-panel-title'
      titleWrap.append(heading, $('p', undefined, shell.subtitle ?? ''))
      const close = button('×', closePanel, { className: 'ib-close', title: 'Close (Escape)' })
      close.setAttribute('aria-label', 'Close panel')
      keepHead.append(titleWrap, close)
      panel.append(keepHead, body)
    } else {
      showPanel('inventory', shell)
    }
  }

  /* ---------------------------- townsfolk panel --------------------------- */

  const renderTownsfolk = (): void => {
    const body = $('div', 'ib-panel-body')
    body.append(
      $(
        'p',
        'ib-muted',
        'Eight regulars keep the square moving. Their names appear on the Market Wire whenever they trade, gather or deliver to a guild order.',
      ),
    )

    const grid = $('div', 'ib-grid cols-2')
    for (const character of characters) {
      const card = $('div', 'ib-card ib-townsfolk-card')
      card.dataset.character = character.id
      card.append($('h3', undefined, character.displayName))
      card.append($('span', 'ib-chip', character.archetype))
      card.append($('p', 'ib-muted', character.line))
      if (character.map) {
        card.append($('small', 'ib-muted', 'Often found in the market square.'))
      }
      grid.append(card)
    }
    body.append(grid)

    showPanel('townsfolk', {
      title: 'Townsfolk',
      subtitle: 'The faces behind the townsfolk trades on the Market Wire.',
      body,
    })
  }

  /* ------------------------------- help panel ---------------------------- */

  const renderHelp = (): void => {
    const body = $('div', 'ib-panel-body')
    body.append(
      $(
        'p',
        'ib-muted',
        'You run a trader in a small market town. The stalls trade while you are away, so a quiet week can change every price.',
      ),
    )

    const steps = $('ol', 'ib-help-steps')
    for (const [label, copy] of helpSteps) {
      const item = $('li')
      item.append($('strong', undefined, label), $('span', undefined, copy))
      steps.append(item)
    }
    body.append(steps)

    const grid = $('div', 'ib-grid cols-2')
    const keys = $('div', 'ib-card')
    keys.append($('h3', undefined, 'Controls'))
    const keyList = $('ul', 'ib-list')
    for (const [key, action] of [
      ['WASD / arrows', 'Move around the square'],
      ['E / Space', 'Interact with a stall or resource'],
      ['I', 'Open your bag and workshop'],
      ['M', 'Open the market board and best deals'],
      ['O', 'Open the guild order board'],
      ['T', 'Meet the townsfolk'],
      ['F', `Run the ${economy.fastForward.days}-day fast-forward`],
      ['R', 'Read the town recap'],
      ['Esc', 'Close a panel or drawer'],
    ]) {
      const li = $('li')
      li.append($('span', undefined, action), $('kbd', undefined, key))
      keyList.append(li)
    }
    keys.append(keyList)

    const goal = $('div', 'ib-card')
    goal.append($('h3', undefined, 'Your goal'))
    goal.append(
      $(
        'p',
        undefined,
        'Buy goods where they are cheap, sell where they are dear, gather raw materials, and keep an eye on the town as stalls run short of cash. The First day card tracks one next step; Market (M) compares every stall for you.',
      ),
    )
    goal.append(
      $(
        'p',
        'ib-muted',
        'Fast-forwarding moves the actual townsfolk on the server map, so every player sees the same week play out.',
      ),
    )
    grid.append(keys, goal)
    body.append(grid)

    showPanel('help', {
      title: 'How to Play',
      subtitle: 'A quick tour before your first trade.',
      body,
    })
  }

  /* -------------------------- fast-forward panel ------------------------- */

  const renderFastForward = (): void => {
    const state = client.fastForward.getState()
    const body = $('div', 'ib-panel-body ib-ff-panel')
    const totalDays = state.totalDays || economy.fastForward.days
    const active = state.status === 'running' || state.status === 'paused'
    const shownDay =
      state.startDay > 0
        ? Math.min(state.endDay || state.startDay + totalDays, state.startDay + state.day)
        : state.day

    const intro = $('p', 'ib-muted')
    intro.textContent =
      client.mode === 'server'
        ? `Run ${economy.fastForward.days} days on the authoritative server. Bots walk the square as the days reveal, then the live market resumes.`
        : `Run ${economy.fastForward.days} days in the local demo. The timeline is deterministic, but server map actors are unavailable in mock mode.`
    body.append(intro)

    const statusRow = $('div', 'ib-ff-status')
    statusRow.append(
      $('strong', 'ib-ff-day', `Day ${Math.max(1, shownDay)}`),
      $('span', 'ib-muted', state.message),
    )
    body.append(statusRow)

    const progress = $('div', 'ib-progress')
    progress.setAttribute('role', 'progressbar')
    progress.setAttribute('aria-valuemin', '0')
    progress.setAttribute('aria-valuemax', '100')
    progress.setAttribute('aria-valuenow', String(Math.round(state.progress * 100)))
    progress.setAttribute('aria-label', 'Fast-forward progress')
    const fill = $('i')
    fill.style.width = `${Math.round(state.progress * 100)}%`
    progress.append(fill)
    body.append(progress)
    body.append(
      $(
        'div',
        'ib-muted',
        `${state.day} / ${totalDays} days revealed · ${Math.round(state.progress * 100)}%`,
      ),
    )

    if (totalDays > 1) {
      const strip = $('ol', 'ib-ff-days')
      for (let index = 1; index <= totalDays; index += 1) {
        const item = $('li', index <= state.day ? 'is-done' : 'is-pending')
        item.textContent = `D${index + Math.max(0, state.startDay - 1)}`
        item.title = `Day ${index + Math.max(0, state.startDay - 1)}`
        strip.append(item)
      }
      body.append(strip)
    }

    const controls = $('div', 'ib-controls')
    if (active) {
      controls.append(
        button('Skip to end', () => client.fastForward.skip(), {
          className: 'ib-button is-primary',
        }),
      )
      if (client.mode === 'mock') {
        if (state.status === 'paused') {
          controls.append(
            button('Resume', () => {
              void client.fastForward.resume()
            }, { className: 'ib-button is-quiet' }),
          )
        } else {
          controls.append(
            button('Pause', () => client.fastForward.pause(), {
              className: 'ib-button is-quiet',
            }),
          )
        }
      }
    } else {
      controls.append(
        button(`Run ${economy.fastForward.days} days`, () => {
          // Close the panel so the map playback is visible. The HUD chip keeps
          // showing day/progress, and Week/F reopens this panel for Skip.
          closePanel()
          void client.fastForward
            .start(economy.fastForward.days)
            .then(() => ui.refresh())
        }, { className: 'ib-button is-primary' }),
        button('Step 1 day', () => {
          void client.fastForward.step().then(next => {
            if (next.status === 'done') void ui.refresh()
          })
        }, { className: 'ib-button is-small is-quiet' }),
      )
      if (state.recap && state.status === 'done') {
        controls.append(
          button('Read the recap', () => void ui.openRecap(), {
            className: 'ib-button is-quiet',
          }),
        )
      }
    }
    body.append(controls)
    body.append($('div', 'ib-status-line', state.message))

    const stream = $('ol', 'ib-day-stream')
    const events = [...state.events].slice(-12).reverse()
    if (events.length === 0) {
      stream.append(
        $('li', 'ib-empty', 'Events appear here as each day reveals.'),
      )
    }
    for (const entry of events) {
      const line = describeEvent(entry.event, entry.event.item ? itemName(entry.event.item) : undefined)
      const li = $('li')
      li.append(
        $('span', 'ib-day-badge', `D${entry.day}`),
        (() => {
          const wrap = $('div')
          wrap.append(
            $('strong', undefined, `${line.actor} ${line.headline}`),
            $('span', undefined, entry.annotation),
          )
          return wrap
        })(),
      )
      stream.append(li)
    }
    body.append(stream)

    const shell: PanelShell = {
      title: 'Fast-Forward the Week',
      subtitle:
        client.mode === 'server'
          ? `Seven days in about ${Math.round(FAST_FORWARD_PLAYBACK_MS / 1000)}s · live map playback`
          : 'Seven days in the local demo · map actors unavailable',
      size: 'wide',
      body,
    }

    if (!panel.hidden && activeKind === 'fastforward') {
      activePanelBody = body
      panel.replaceChildren()
      const keepHead = $('div', 'ib-panel-head')
      const titleWrap = $('div')
      const heading = $('h2', undefined, shell.title)
      heading.id = 'ib-panel-title'
      titleWrap.append(heading, $('p', undefined, shell.subtitle ?? ''))
      const close = button('×', closePanel, { className: 'ib-close', title: 'Close (Escape)' })
      close.setAttribute('aria-label', 'Close panel')
      keepHead.append(titleWrap, close)
      panel.append(keepHead, body)
    } else {
      showPanel('fastforward', shell)
    }
    fastForwardUnsub?.()
    fastForwardUnsub = client.fastForward.onChange(next => {
      if (activeKind === 'fastforward') {
        renderFastForwardFrom(next)
      }
    })
  }

  const renderFastForwardFrom = (state: FastForwardState): void => {
    if (activeKind !== 'fastforward') return
    // Repaint when a day, status or visible progress step changes. The panel is
    // only a readout during playback, so replacing it does not steal input.
    const marker = `${state.status}:${state.day}:${state.events.length}:${Math.round(state.progress * 20)}`
    if (panel.dataset.marker === marker) return
    panel.dataset.marker = marker
    renderFastForward()
  }

  /* ------------------------------- recap ---------------------------------- */

  const renderRecap = async (): Promise<void> => {
    const recap = await client.getRecap()
    const body = $('div', 'ib-panel-body')
    const paper = $('article', 'ib-newspaper')
    paper.append($('div', 'ib-masthead', 'The Ironblock Herald'))
    paper.append($('h3', undefined, recap.headline))
    paper.append($('p', 'ib-standfirst', recap.standfirst))
    paper.append(
      $(
        'div',
        'ib-byline',
        `Market square edition · generated after day ${recap.generatedAtDay} · price report from the exchange`,
      ),
    )

    const columns = $('div', 'ib-columns')
    const left = $('div')
    left.append($('h4', undefined, 'Top movers'))
    const movers = $('ul', 'ib-list')
    if (recap.topMovers.length === 0) {
      movers.append($('li', undefined, 'Prices held close to reference all week.'))
    }
    for (const mover of recap.topMovers) {
      const li = $('li')
      li.append(
        $('span', undefined, mover.displayName),
        $(
          'span',
          mover.changePct >= 0 ? 'ib-delta-up' : 'ib-delta-down',
          `${signedPercent(mover.changePct)} · ${formatMoney(mover.to, economy.currency.symbol)}`,
        ),
      )
      movers.append(li)
    }
    left.append(movers)

    left.append($('h4', undefined, 'Trade desk'))
    const trades = $('ul', 'ib-list')
    const tradeRow = (label: string, value: string) => {
      const li = $('li')
      li.append($('span', undefined, label), $('b', undefined, value))
      trades.append(li)
    }
    tradeRow('Player trades', `${recap.trades.count} (${recap.trades.buyCount} buy / ${recap.trades.sellCount} sell)`)
    tradeRow('Units traded', formatNumber(recap.trades.volume))
    tradeRow('Value moved', formatMoney(recap.trades.value, economy.currency.symbol))
    tradeRow('Stalls open', `${recap.merchants.open} / ${recap.merchants.total}`)
    trades.append(
      Object.assign($('li'), {
        textContent: `Town health: ${townHealthLabel(recap.merchants.health)}`,
      }),
    )
    left.append(trades)

    const right = $('div')
    right.append($('h4', undefined, 'Bankruptcies & investment'))
    const bankruptcies = $('ul', 'ib-list')
    if (recap.bankruptcies.length === 0) {
      bankruptcies.append($('li', undefined, 'No stalls closed below reserve.'))
    } else {
      for (const entry of recap.bankruptcies.slice(0, 5)) {
        const li = $('li')
        li.append($('span', undefined, entry), $('b', 'ib-delta-up', 'closed'))
        bankruptcies.append(li)
      }
    }
    right.append(bankruptcies)
    if (recap.investments.length > 0) {
      const investments = $('ul', 'ib-list')
      for (const entry of recap.investments.slice(0, 5)) {
        const li = $('li')
        li.append(
          $('span', undefined, entry.displayName),
          $('b', undefined, formatMoney(entry.amount, economy.currency.symbol)),
        )
        investments.append(li)
      }
      right.append($('h4', undefined, 'Cash injections'), investments)
    }

    right.append($('h4', undefined, 'Caravan & sinks'))
    const caravan = $('ul', 'ib-list')
    const caravanRow = (label: string, value: string) => {
      const li = $('li')
      li.append($('span', undefined, label), $('b', undefined, value))
      caravan.append(li)
    }
    caravanRow('Caravan arrivals', String(recap.caravan.arrivals))
    caravanRow('Rent paid', formatMoney(recap.sinks.rent, economy.currency.symbol))
    caravanRow('Sales tax', formatMoney(recap.sinks.tax, economy.currency.symbol))
    caravanRow('Tool repairs', formatMoney(recap.sinks.repairs, economy.currency.symbol))
    caravanRow('Total sinks', formatMoney(recap.sinks.total, economy.currency.symbol))
    right.append(caravan)
    right.append($('p', 'ib-muted', recap.caravan.note))

    columns.append(left, right)
    paper.append(columns)
    body.append(paper)

    const shell: PanelShell = {
      title: 'Town Recap',
      subtitle: 'A printable front page for the demo — generated from the event stream.',
      size: 'wide',
      body,
    }
    if (!panel.hidden && activeKind === 'recap') {
      activePanelBody = body
      panel.replaceChildren()
      const keepHead = $('div', 'ib-panel-head')
      const titleWrap = $('div')
      const heading = $('h2', undefined, shell.title)
      heading.id = 'ib-panel-title'
      titleWrap.append(heading, $('p', undefined, shell.subtitle ?? ''))
      const close = button('×', closePanel, { className: 'ib-close', title: 'Close (Escape)' })
      close.setAttribute('aria-label', 'Close panel')
      keepHead.append(titleWrap, close)
      panel.append(keepHead, body)
    } else {
      showPanel('recap', shell)
    }
  }

  /* ------------------------------- orders -------------------------------- */

  const renderOrders = async (): Promise<void> => {
    const entries = await client.getOrderBoard()
    const body = $('div', 'ib-panel-body')
    if (entries.length === 0) {
      const placeholder = $('div', 'ib-placeholder')
      if (client.mode === 'server') {
        placeholder.append($('h3', undefined, 'No open guild orders'))
        placeholder.append(
          $(
            'p',
            undefined,
            'The guild posts new work as the town trades. Check back after a few days of trade or a fast-forward.',
          ),
        )
      } else {
        placeholder.append($('h3', undefined, 'Order board not connected'))
        placeholder.append(
          $(
            'p',
            undefined,
            'The mock economy has no live order book. This panel is intentionally a placeholder: the integration agent can wire the exchange service and return OrderBoardEntry rows.',
          ),
        )
        placeholder.append(
          $('p', 'ib-muted', 'Contract: getOrderBoard(): Promise<OrderBoardEntry[]> — see src/client/economy/types.ts.'),
        )
      }
      body.append(placeholder)
    } else {
      const table = $('table', 'ib-table')
      const head = $('thead')
      const headRow = $('tr')
      for (const label of ['Side', 'Item', 'Merchant', 'Qty', 'Unit price']) {
        headRow.append($('th', undefined, label))
      }
      head.append(headRow)
      const tbody = $('tbody')
      for (const entry of entries) {
        const row = $('tr')
        row.append(
          $('td', undefined, entry.side === 'buy' ? 'Bid' : 'Ask'),
          $('td', undefined, itemName(entry.itemId)),
          $('td', undefined, entry.merchantName),
          $('td', 'is-num', formatNumber(entry.quantity)),
          $('td', 'is-num', formatMoney(entry.unitPrice, economy.currency.symbol)),
        )
        tbody.append(row)
      }
      table.append(head, tbody)
      body.append(table)
    }
    showPanel('orders', {
      title: 'Order Board',
      subtitle: 'Buy and sell listings beyond the merchant counters.',
      size: 'narrow',
      body,
    })
  }

  /* ----------------------------- event detail ---------------------------- */

  const renderEvent = (event: MarketEvent): void => {
    const line = describeEvent(event, event.item ? itemName(event.item) : undefined)
    const body = $('div', 'ib-panel-body')
    const summary = $('div', 'ib-card')
    summary.append($('h3', undefined, eventTypeLabel(event.type)))
    summary.append($('p', undefined, event.message))
    const meta = $('div', 'ib-head-meta')
    meta.append(
      $('span', 'ib-chip', event.actor.displayName ?? event.actor.id),
      $('span', 'ib-chip', formatEventTime(event.time)),
    )
    if (event.item) meta.append($('span', 'ib-chip', itemName(event.item)))
    if (event.quantity !== null) meta.append($('span', 'ib-chip', `× ${formatNumber(event.quantity)}`))
    if (event.price !== null) meta.append($('span', 'ib-chip', formatMoney(event.price, economy.currency.symbol)))
    summary.append(meta)
    body.append(summary)

    const snapshotTable = $('table', 'ib-table')
    const head = $('thead')
    const headRow = $('tr')
    for (const label of ['Field', 'Before', 'After']) headRow.append($('th', undefined, label))
    head.append(headRow)
    const tbody = $('tbody')
    const rows: Array<[string, number | null, number | null]> = [
      ['Stock', event.before.stock, event.after.stock],
      ['Cash', event.before.cash, event.after.cash],
      ['Bid', event.before.bid, event.after.bid],
      ['Ask', event.before.ask, event.after.ask],
    ]
    for (const [label, before, after] of rows) {
      if (before === null && after === null) continue
      const row = $('tr')
      row.append(
        $('td', undefined, label),
        $('td', 'is-num', before === null ? '—' : formatNumber(before)),
        $('td', 'is-num', after === null ? '—' : formatNumber(after)),
      )
      tbody.append(row)
    }
    snapshotTable.append(head, tbody)
    body.append(snapshotTable)

    if (event.reasons.length > 0) {
      const reasonSummary = summarizeReasons(event.reasons)
      const card = $('div', 'ib-card')
      card.append($('h3', undefined, 'Why the price moved'))
      card.append($('p', undefined, reasonSummary.summary))
      const table = $('table', 'ib-table')
      const thead = $('thead')
      const row = $('tr')
      for (const label of ['Reason', 'Input', 'Effect']) row.append($('th', undefined, label))
      thead.append(row)
      const reasonBody = $('tbody')
      for (const item of reasonSummary.rows) {
        const tr = $('tr')
        tr.append(
          $('td', undefined, item.label),
          $('td', undefined, item.value),
          $('td', 'is-num', item.effect),
        )
        reasonBody.append(tr)
      }
      table.append(thead, reasonBody)
      card.append(table)
      body.append(card)
    }

    showPanel('event', {
      title: `Event · ${line.actor}`,
      subtitle: line.headline,
      size: 'narrow',
      body,
    })
  }

  /* ---------------------------- global input ----------------------------- */

  const isTypingTarget = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null
    if (!element) return false
    const tag = element.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
  }

  const isGameKey = (event: KeyboardEvent): boolean => {
    if (['Escape', 'Tab'].includes(event.key)) return false
    const keys = [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      ' ',
      'Enter',
      'w',
      'a',
      's',
      'd',
      'e',
      'W',
      'A',
      'S',
      'D',
      'E',
    ]
    return keys.includes(event.key)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (!withdrawOverlay.hidden) {
      if (event.key === 'Escape') {
        closeWithdraw()
        event.preventDefault()
        event.stopImmediatePropagation()
      } else if (!isTypingTarget(event.target) && isGameKey(event)) {
        // Freeze movement/action keys while the withdrawal dialog is open.
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      return
    }
    if (event.key === 'Escape') {
      if (!tooltip.hidden) {
        hideTooltip()
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (moreOpen) {
        closeMoreMenu()
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (wireOpen) {
        setWireOpen(false)
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (!panel.hidden) {
        closePanel()
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      return
    }
    if (moreOpen) {
      if (!isTypingTarget(event.target) && isGameKey(event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      return
    }
    if (!panel.hidden) {
      const target = event.target as HTMLElement | null
      const activationKey = event.key === ' ' || event.key === 'Enter'
      const focusedControl = target?.closest?.('button, a, [role="tab"]')
      if (activationKey && focusedControl) {
        // Keyboard activation of the focused button must keep working.
        return
      }
      if (!isTypingTarget(event.target) && isGameKey(event)) {
        // Freeze movement and the action key while a panel is open. Tab and
        // Escape still work so the panel never traps focus.
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      return
    }
    if (isTypingTarget(event.target)) return
    const key = event.key.toLowerCase()
    if (key === 'i') {
      event.preventDefault()
      ui.openInventory()
    } else if (key === 'm') {
      event.preventDefault()
      void ui.openMarket()
    } else if (key === 'o') {
      event.preventDefault()
      ui.openOrders()
    } else if (key === 't') {
      event.preventDefault()
      ui.openTownsfolk()
    } else if (key === 'f') {
      event.preventDefault()
      ui.openFastForward()
    } else if (key === 'r') {
      event.preventDefault()
      void ui.openRecap()
    }
  }

  const onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target as Node | null
    if (
      moreOpen &&
      target &&
      !moreMenu.contains(target) &&
      !moreButton.contains(target)
    ) {
      setMoreMenuOpen(false)
    }
    if (
      wireOpen &&
      target &&
      !ticker.contains(target) &&
      !wireToggle.contains(target)
    ) {
      setWireOpen(false)
    }
  }

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('resize', hideTooltip)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)

  const onScrimClick = () => closePanel()
  scrim.addEventListener('click', onScrimClick)

  const onWithdrawOverlayClick = (event: MouseEvent) => {
    if (event.target === withdrawOverlay) closeWithdraw()
  }
  withdrawOverlay.addEventListener('click', onWithdrawOverlayClick)

  /* -------------------------------- api ---------------------------------- */

  const refresh = async (): Promise<void> => {
    if (destroyed || refreshInFlight) return
    refreshInFlight = true
    try {
      const next = await client.getSnapshot()
      renderHud(next)
      modeChip.textContent = client.mode === 'server' ? 'Live market' : 'Mock market'
      if (options.fellBackToMock && options.note) {
        banner.textContent = options.note
        banner.hidden = false
      } else {
        banner.hidden = true
      }
    } catch (error) {
      modeChip.textContent = client.mode === 'server' ? 'Market offline' : 'Mock market'
      if (client.mode === 'server') {
        banner.textContent = `The live market server is unavailable — ${
          error instanceof Error ? error.message : 'check the connection and try again.'
        }`
        banner.hidden = false
      }
    } finally {
      refreshInFlight = false
    }
  }

  const unsubscribe = client.subscribe(() => {
    void refresh()
  })

  // Keep the HUD and actor bubbles moving without disturbing an open panel.
  livePollTimer = window.setInterval(() => {
    if (
      destroyed ||
      refreshInFlight ||
      busy ||
      document.hidden ||
      !panel.hidden ||
      !withdrawOverlay.hidden
    ) {
      return
    }
    void refresh()
  }, 4_000)

  fastForwardHudUnsub = client.fastForward.onChange(applyFastForwardHud)
  applyFastForwardHud(client.fastForward.getState())

  const ui: IronblockUI = {
    async openMerchant(id) {
      activeTab = 'buy'
      quantities = {}
      await renderMerchant(id, true)
    },
    async openMarket() {
      activeKind = 'market'
      await renderMarket(true)
    },
    openInventory() {
      void renderInventory()
    },
    openFastForward() {
      panel.dataset.marker = ''
      renderFastForward()
    },
    async openRecap() {
      await renderRecap()
    },
    openOrders() {
      activeKind = 'orders'
      void renderOrders()
    },
    openTownsfolk() {
      renderTownsfolk()
    },
    openEvent(event) {
      renderEvent(event)
    },
    closePanel,
    isPanelOpen() {
      return !panel.hidden
    },
    setPrompt(promptData) {
      if (!promptData) {
        prompt.hidden = true
        return
      }
      prompt.hidden = false
      promptKey.textContent = promptData.key
      promptLabel.textContent = promptData.label
      promptHint.textContent = promptData.hint ?? ''
    },
    setWaypoint(waypoint) {
      currentWaypoint = waypoint
      renderWaypoint()
    },
    showGuide() {
      openGuide()
    },
    isFastForwarding() {
      const status = client.fastForward.getState().status
      return status === 'running' || status === 'paused'
    },
    toast(message, tone = 'neutral') {
      const toast = $('div', 'ib-toast', message)
      toast.dataset.tone = tone
      toast.setAttribute('role', 'status')
      toasts.append(toast)
      window.setTimeout(() => {
        toast.remove()
      }, 3600)
    },
    refresh,
    destroy() {
      destroyed = true
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', hideTooltip)
      document.removeEventListener('pointerdown', onDocumentPointerDown, true)
      scrim.removeEventListener('click', onScrimClick)
      withdrawOverlay.removeEventListener('click', onWithdrawOverlayClick)
      if (weekCompleteTimer !== null) window.clearTimeout(weekCompleteTimer)
      if (livePollTimer !== null) window.clearInterval(livePollTimer)
      closeWithdraw()
      fastForwardUnsub?.()
      fastForwardHudUnsub?.()
      unsubscribe()
      root.remove()
    },
  }

  void refresh()

  return ui
}
