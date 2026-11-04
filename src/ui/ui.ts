import { economy } from '../config/economy'
import type {
  EconomyClient,
  EconomySnapshot,
  FastForwardState,
  MerchantView,
  SessionRecap,
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
  eventTypeLabel,
  explainQuote,
  formatDayClock,
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
} from './format'

export interface InteractionPrompt {
  key: string
  label: string
  hint?: string
}

export interface IronblockUI {
  openMerchant(id: MerchantId): Promise<void>
  openInventory(): void
  openFastForward(): void
  openRecap(): Promise<void>
  openOrders(): void
  openEvent(event: MarketEvent): void
  closePanel(): void
  isPanelOpen(): boolean
  setPrompt(prompt: InteractionPrompt | null): void
  toast(message: string, tone?: 'neutral' | 'good' | 'bad'): void
  refresh(): Promise<void>
  destroy(): void
}

interface MountOptions {
  client: EconomyClient
  /** Shown in the HUD mode chip and a banner when the real client fell back. */
  note?: string
  fellBackToMock?: boolean
}

type PanelSize = 'default' | 'narrow' | 'wide'
type PanelKind = 'merchant' | 'inventory' | 'fastforward' | 'recap' | 'orders' | 'event'

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

  const brand = $('div', 'ib-brand')
  brand.append($('strong', undefined, 'IRONBLOCK'), $('span', undefined, 'Market Square'))

  const stats = $('div', 'ib-stats')
  const stat = (label: string) => {
    const box = $('div', 'ib-stat')
    const title = $('b', undefined, label)
    const value = $('span', undefined, '—')
    const sub = $('small')
    box.append(title, value, sub)
    stats.append(box)
    return { box, value, sub }
  }

  const cashStat = stat('Cash')
  const weightStat = stat('Carry')
  const staminaStat = stat('Stamina')
  const clockStat = stat('Day')
  const townStat = stat('Town')

  const cashBar = $('div', 'ib-bar')
  const cashFill = $('i')
  cashBar.append(cashFill)
  weightStat.box.append(weightStat.sub, cashBar)

  const staminaBar = $('div', 'ib-bar')
  const staminaFill = $('i')
  staminaBar.append(staminaFill)
  staminaStat.box.append(staminaStat.sub, staminaBar)

  const actions = $('div', 'ib-actions')
  const hudButton = (label: string, key: string, onClick: () => void) => {
    const element = button(label, onClick, { className: 'ib-hud-button' })
    const kbd = $('kbd', undefined, key)
    element.append(kbd)
    actions.append(element)
    return element
  }
  hudButton('Bag', 'I', () => ui.openInventory())
  hudButton('Orders', 'O', () => ui.openOrders())
  hudButton('Week', 'F', () => ui.openFastForward())
  hudButton('Recap', 'R', () => void ui.openRecap())

  hud.append(brand, stats, actions)

  const ticker = $('aside', 'ib-ticker')
  ticker.setAttribute('aria-label', 'Recent market events')
  const tickerHeader = $('header')
  tickerHeader.append($('h2', undefined, 'Market Wire'))
  const tickerCount = $('span', 'ib-muted', 'live')
  tickerCount.style.color = '#b9a985'
  tickerHeader.append(tickerCount)
  const tickerList = $('ol')
  tickerList.setAttribute('aria-live', 'polite')
  ticker.append(tickerHeader, tickerList)

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

  const modeChip = $('span', 'ib-chip', client.mode === 'server' ? 'Live market' : 'Mock market')

  root.append(hud, ticker, prompt, toasts, scrim, panel, tooltip, banner)
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
  let destroyed = false

  const keyFor = (merchantId: MerchantId, side: TradeSide, itemId: ItemId) =>
    `${merchantId}:${side}:${itemId}`

  /* ------------------------------- HUD ----------------------------------- */

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

    if (!modeChip.isConnected) {
      townStat.sub.append(' ', modeChip)
    }

    renderTicker(next.recentEvents)
    if (activePanelBody) void refreshActivePanel()
  }

  const renderTicker = (events: MarketEvent[]) => {
    tickerList.replaceChildren()
    const recent = [...events].slice(0, 9)
    tickerCount.textContent = recent.length > 0 ? `${events.length} recent` : 'quiet'
    if (recent.length === 0) {
      const empty = $('li', 'ib-empty', 'No trades yet. Talk to a merchant or gather at the edge of town.')
      tickerList.append(empty)
      return
    }
    for (const event of recent) {
      const line = describeEvent(event, event.item ? itemName(event.item) : undefined)
      const li = $('li')
      const row = button('', () => ui.openEvent(event), { className: 'ib-ticker-row' })
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
    hideTooltip()
    if (lastFocused?.isConnected) lastFocused.focus({ preventScroll: true })
    lastFocused = null
    document.dispatchEvent(new CustomEvent('ironblock:panel-closed'))
  }

  const showPanel = (kind: PanelKind, shell: PanelShell): HTMLElement => {
    if (!lastFocused) lastFocused = document.activeElement as HTMLElement | null
    activeKind = kind
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
      const price = $('span', 'ib-price', formatMoney(quote.unitPrice, economy.currency.symbol))
      price.append($('small', undefined, `base ${formatMoney(quote.basePrice, economy.currency.symbol, 0)}`))
      priceCell.append(price)
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
        const priceNode = $('span', 'ib-price', formatMoney(current.unitPrice, economy.currency.symbol))
        priceNode.append($('small', undefined, `base ${formatMoney(current.basePrice, economy.currency.symbol, 0)}`))
        priceCell.append(priceNode)
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
      ui.toast(result.message, result.ok ? 'good' : 'bad')
      if (result.ok) {
        quantities[keyFor(merchantId, side, itemId)] = 1
        await ui.refresh()
      }
      await renderMerchant(merchantId, false)
    } finally {
      busy = false
    }
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
    body.append(craftHeading, $('p', 'ib-muted', 'Recipes run instantly in the mock. Inputs are consumed and stamina is spent.'))

    const recipeGrid = $('div', 'ib-grid cols-2')
    for (const recipe of Object.values(economy.recipes)) {
      const card = $('div', 'ib-card')
      const title = $('h3', undefined, recipe.displayName)
      card.append(title)
      const inputs = Object.entries(recipe.inputs)
        .map(([itemId, need]) => {
          const have = player.inventory.find(line => line.itemId === itemId)?.quantity ?? 0
          return `${need}× ${itemName(itemId)} (${have})`
        })
        .join(' · ')
      card.append($('p', 'ib-muted', inputs))
      const outputs = Object.entries(recipe.outputs)
        .map(([itemId, count]) => `${count}× ${itemName(itemId)}`)
        .join(', ')
      card.append($('p', undefined, `→ ${outputs} · stamina −${recipe.staminaCost}`))
      const missing = Object.entries(recipe.inputs).some(
        ([itemId, need]) => (player.inventory.find(line => line.itemId === itemId)?.quantity ?? 0) < need,
      )
      const craft = button(
        missing ? 'Missing inputs' : `Craft ${recipe.displayName}`,
        async () => {
          if (busy) return
          busy = true
          const result = await client.craft(recipe.id)
          busy = false
          ui.toast(result.message, result.ok ? 'good' : 'bad')
          await ui.refresh()
          await renderInventory()
        },
        { className: 'ib-button is-small', disabled: missing || player.stamina < recipe.staminaCost },
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

  /* -------------------------- fast-forward panel ------------------------- */

  const renderFastForward = (): void => {
    const state = client.fastForward.getState()
    const body = $('div', 'ib-panel-body')

    const intro = $('p', 'ib-muted')
    intro.textContent =
      'Simulate seven days of town trade. The mock timeline is deterministic: bots trade, caravans restock, rent is paid, and stalls can close.'
    body.append(intro)

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
        `${state.day} / ${state.totalDays || economy.fastForward.days} days · ${Math.round(state.progress * 100)}%`,
      ),
    )

    const controls = $('div', 'ib-controls')
    const runButton = button(
      state.status === 'running' ? 'Running…' : `Run ${economy.fastForward.days} days`,
      () => {
        void client.fastForward.start(economy.fastForward.days).then(() => {
          void ui.refresh()
          if (activeKind === 'fastforward') renderFastForward()
        })
      },
      { className: 'ib-button is-primary', disabled: state.status === 'running' },
    )
    const pauseButton = button(
      'Pause',
      () => {
        client.fastForward.pause()
        renderFastForward()
      },
      { className: 'ib-button', disabled: state.status !== 'running' },
    )
    const resumeButton = button(
      'Resume',
      () => {
        void client.fastForward.resume()
      },
      { className: 'ib-button', disabled: state.status !== 'paused' },
    )
    const stepButton = button(
      'Step 1 day',
      () => {
        void client.fastForward.step().then(next => {
          if (next.status === 'done') {
            void ui.refresh().then(() => {
              if (activeKind === 'fastforward') renderFastForward()
            })
          }
        })
      },
      { className: 'ib-button' },
    )
    controls.append(runButton, pauseButton, resumeButton, stepButton)
    if (state.recap) {
      controls.append(
        button('Read the recap', () => void ui.openRecap(), { className: 'ib-button' }),
      )
    }
    body.append(controls)
    body.append($('div', 'ib-status-line', state.message))

    if (state.days.length > 0) {
      const dayGrid = $('div', 'ib-grid cols-3')
      for (const day of state.days.slice(-3)) {
        const card = $('div', 'ib-card')
        card.append($('h3', undefined, `Day ${day.day}`))
        card.append($('strong', undefined, `${day.merchantsOpen} open`))
        card.append(
          $('p', 'ib-muted', `${day.bankruptcies} closed · ${day.tradeVolume} units traded`),
        )
        dayGrid.append(card)
      }
      body.append(dayGrid)
    }

    const stream = $('ol', 'ib-day-stream')
    const events = [...state.events].slice(-46).reverse()
    if (events.length === 0) {
      stream.append($('li', 'ib-empty', 'The event stream appears here while the week runs.'))
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
      subtitle: `Seven days in about ${economy.fastForward.durationSeconds}s · ${economy.fastForward.stepSeconds}s ticks`,
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
    // Repaint only when the day or status changes to avoid stealing focus.
    const marker = `${state.status}:${state.day}:${state.events.length}`
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
    if (event.key === 'Escape') {
      if (!tooltip.hidden) {
        hideTooltip()
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
    } else if (key === 'o') {
      event.preventDefault()
      ui.openOrders()
    } else if (key === 'f') {
      event.preventDefault()
      ui.openFastForward()
    } else if (key === 'r') {
      event.preventDefault()
      void ui.openRecap()
    }
  }

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('resize', hideTooltip)

  const onScrimClick = () => closePanel()
  scrim.addEventListener('click', onScrimClick)

  /* -------------------------------- api ---------------------------------- */

  const refresh = async (): Promise<void> => {
    if (destroyed) return
    const next = await client.getSnapshot()
    renderHud(next)
  }

  const unsubscribe = client.subscribe(() => {
    void refresh()
  })

  const ui: IronblockUI = {
    async openMerchant(id) {
      activeTab = 'buy'
      quantities = {}
      await renderMerchant(id, true)
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
      scrim.removeEventListener('click', onScrimClick)
      fastForwardUnsub?.()
      unsubscribe()
      root.remove()
    },
  }

  void refresh()

  // Announce the interaction keys once so the demo is self-explanatory.
  window.setTimeout(() => {
    ui.toast('Walk with arrow keys. Press E or Space near a stall to trade.', 'neutral')
  }, 900)

  return ui
}
