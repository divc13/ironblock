import { defineModule, type RpgClient, type RpgClientEngine } from '@rpgjs/client'
import { createEconomyRuntime } from '../../client/economy'
import { HttpEconomyClient } from '../../client/economy/http'
import { readAuthSession } from '../../client/auth/session'
import { resolveWorldSpritesheet } from '../../client/world-sprites'
import { charactersWithMap } from '../../config/characters'
import { economy } from '../../config/economy'
import {
  merchantIdFromEventName,
  resourceArea,
  resourceSpecFromEventName,
  stallPositionForSlot,
  townsfolkEventName,
  world,
} from '../../config/world'
import { mountIronblockUI, type IronblockUI } from '../../ui/ui'
import {
  compassDirection,
  distanceInPaces,
  type GuideTarget,
  type GuideWaypoint,
} from '../../ui/guide'
import type { MarketEvent, ResourceNodeConfig } from '../../shared/types'

/**
 * Client bridge between the RPGJS scene and the HTML overlay.
 *
 * - registers generated market sprites with the spritesheet resolver
 * - mounts the HUD/panels once
 * - scans nearby merchant/resource events and turns E/Space into UI actions
 * - intercepts game keys while a panel is open so movement keeps working
 *   normally the rest of the time
 */

type InteractionTarget =
  | { kind: 'merchant'; merchantId: string; distance: number }
  | { kind: 'resource'; resourceId: string; distance: number }

let ui: IronblockUI | null = null
let lastScanAt = 0
let nearby: InteractionTarget | null = null
let lastPromptKey = ''
let mountedClient: ReturnType<typeof createEconomyRuntime>['client'] | null = null
let activeEngine: RpgClientEngine | null = null
let guideTarget: GuideTarget | null = null

const botActorIds = new Set(charactersWithMap().map(character => character.id))
interface ActorBubble {
  element: HTMLDivElement
  until: number
}
const actorBubbles = new Map<string, ActorBubble>()
let actorBubbleLayer: HTMLDivElement | null = null
let actorBubbleFrame: number | null = null

type BubbleTone = 'buy' | 'sell' | 'gather' | 'order' | 'trade'

function actorBubbleLayerElement(): HTMLDivElement | null {
  if (actorBubbleLayer?.isConnected) return actorBubbleLayer
  const root = document.getElementById('ironblock-ui')
  if (!root) return null
  const layer = document.createElement('div')
  layer.className = 'ib-actor-layer'
  layer.setAttribute('aria-hidden', 'true')
  root.append(layer)
  actorBubbleLayer = layer
  return layer
}

function actorScreenPoint(botId: string): { x: number; y: number } | null {
  const engine = activeEngine
  if (!engine) return null
  try {
    const map = engine.scene
    const event = map?.events?.()[townsfolkEventName(botId)]
    if (!event) return null
    const x = event.x()
    const y = event.y()
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const viewport = (engine as unknown as {
      findViewportInstance?: () => { toScreen?: (x: number, y: number) => { x: number; y: number } }
    }).findViewportInstance?.()
    if (!viewport || typeof viewport.toScreen !== 'function') return null
    const point = viewport.toScreen(x, y)
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
    const canvas = document.querySelector('canvas')
    const rect = canvas?.getBoundingClientRect()
    return {
      x: point.x + (rect?.left ?? 0),
      y: point.y + (rect?.top ?? 0),
    }
  } catch {
    return null
  }
}

function positionActorBubbles(): void {
  const now = Date.now()
  for (const [botId, bubble] of [...actorBubbles]) {
    if (!bubble.element.isConnected || now >= bubble.until) {
      bubble.element.remove()
      actorBubbles.delete(botId)
      continue
    }
    const point = actorScreenPoint(botId)
    if (!point) {
      bubble.element.hidden = true
      continue
    }
    bubble.element.hidden = false
    bubble.element.style.left = `${Math.round(point.x)}px`
    bubble.element.style.top = `${Math.round(point.y - 58)}px`
  }
}

function ensureActorBubbleLoop(): void {
  if (actorBubbleFrame !== null) return
  const frame = () => {
    actorBubbleFrame = null
    positionActorBubbles()
    if (actorBubbles.size > 0) {
      actorBubbleFrame = window.requestAnimationFrame(frame)
    }
  }
  actorBubbleFrame = window.requestAnimationFrame(frame)
}

function showActorBubble(botId: string, text: string, tone: BubbleTone, title: string): void {
  const layer = actorBubbleLayerElement()
  if (!layer) return
  const existing = actorBubbles.get(botId)
  if (existing) {
    existing.element.remove()
    actorBubbles.delete(botId)
  }
  const element = document.createElement('div')
  element.className = 'ib-actor-bubble'
  element.dataset.tone = tone
  element.textContent = text
  element.title = title
  layer.append(element)
  actorBubbles.set(botId, { element, until: Date.now() + 6_000 })
  ensureActorBubbleLoop()
}

function botActivityCopy(event: MarketEvent): { text: string; tone: BubbleTone } | null {
  if (event.type !== 'bot.trade' && event.type !== 'bot.gather' && event.type !== 'order.fulfilled') {
    return null
  }
  const actor = event.actor.displayName ?? event.actor.id
  const message = event.message.replace(/\s+/g, ' ').trim().replace(/\.$/, '')
  const body = message.startsWith(actor) ? message.slice(actor.length).trim() : message

  if (event.type === 'bot.trade') {
    const match = /^(bought|sold)\s+([\d,.]+)\s+(.+?)\s+(?:from|to)\s+.+?\s+for\s+(.+)$/i.exec(body)
    if (match) {
      const bought = match[1].toLowerCase() === 'bought'
      return {
        text: `${bought ? 'Bought' : 'Sold'} ${match[2]} ${match[3]} · ${bought ? '−' : '+'}${match[4]}`,
        tone: bought ? 'buy' : 'sell',
      }
    }
    return { text: body, tone: 'trade' }
  }

  if (event.type === 'bot.gather') {
    const match = /gathered\s+([\d,.]+)\s+(.+)$/i.exec(body)
    return {
      text: match ? `Gathered ${match[1]} ${match[2]}` : body,
      tone: 'gather',
    }
  }

  const match = /delivered\s+([\d,.]+)\s+(.+?)\s+to\s+.+?(?:\s+for\s+(.+))?$/i.exec(body)
  return {
    text: match
      ? `Delivered ${match[1]} ${match[2]}${match[3] ? ` · +${match[3]}` : ''}`
      : body,
    tone: 'order',
  }
}

/** Show one live economic action over the bot that performed it. */
function showLiveBotActions(events: readonly MarketEvent[]): void {
  for (const event of [...events].reverse()) {
    if (!botActorIds.has(event.actor.id)) continue
    const copy = botActivityCopy(event)
    if (!copy) continue
    showActorBubble(event.actor.id, copy.text, copy.tone, event.message)
  }
}

const merchantLookup = economy.merchants as Record<
  string,
  (typeof economy.merchants)[keyof typeof economy.merchants] | undefined
>
const resourceLookup = economy.resources.nodes as Record<string, ResourceNodeConfig | undefined>

const waypointFor = (
  engine: RpgClientEngine,
  target: GuideTarget,
): GuideWaypoint | null => {
  const map = engine.scene
  const player = engine.getCurrentPlayer() ?? map?.getCurrentPlayer()
  if (!map || !player) return null

  let point: { x: number; y: number } | null = null
  if (target.kind === 'merchant') {
    const merchant = merchantLookup[target.id]
    if (merchant) point = stallPositionForSlot(merchant.stallSlot)
  } else {
    const area = resourceArea(target.id)
    if (area) point = { x: area.x, y: area.y }
  }
  if (!point) return null

  const dx = point.x - player.x()
  const dy = point.y - player.y()
  const distancePx = Math.hypot(dx, dy)
  return {
    targetId: target.id,
    label: target.label,
    direction: compassDirection(dx, dy),
    distance: distanceInPaces(distancePx),
    arrived: distancePx <= world.interactionRadius,
  }
}

const updateWaypoint = (): void => {
  if (!ui) return
  if (!guideTarget || !activeEngine) {
    ui.setWaypoint(null)
    return
  }
  ui.setWaypoint(waypointFor(activeEngine, guideTarget))
}

const promptFor = (target: InteractionTarget): { key: string; label: string; hint: string } => {
  if (target.kind === 'merchant') {
    const merchant = merchantLookup[target.merchantId]
    return {
      key: 'E',
      label: `Trade with ${merchant?.displayName ?? target.merchantId}`,
      hint: 'Buy · sell · invest · Space also works',
    }
  }
  const node = resourceLookup[target.resourceId]
  const tool = node?.requiredTool ? `requires ${node.requiredTool}` : 'bare hands'
  return {
    key: 'E',
    label: `Gather ${node?.displayName ?? target.resourceId}`,
    hint: `${node?.staminaCost ?? 0} stamina · ${tool} · Space also works`,
  }
}

const scanNearby = (engine: RpgClientEngine): void => {
  activeEngine = engine
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (now - lastScanAt < 90) return
  lastScanAt = now
  updateWaypoint()
  if (!ui) return

  if (ui.isPanelOpen() || ui.isFastForwarding()) {
    if (nearby || lastPromptKey !== '') {
      ui.setPrompt(null)
      lastPromptKey = ''
      nearby = null
    }
    return
  }

  let best: InteractionTarget | null = null
  try {
    const map = engine.scene
    const player = engine.getCurrentPlayer() ?? map.getCurrentPlayer()
    if (!map || !player) return
    const events = map.events() ?? {}
    const playerX = player.x()
    const playerY = player.y()

    for (const event of Object.values(events)) {
      const name = typeof event.name === 'string' ? event.name : ''
      if (!name) continue
      const merchantId = merchantIdFromEventName(name)
      const resource = resourceSpecFromEventName(name)
      if (!merchantId && !resource) continue

      const distance = Math.hypot(event.x() - playerX, event.y() - playerY)
      if (distance > world.interactionRadius) continue
      if (best && distance >= best.distance) continue
      best = merchantId
        ? { kind: 'merchant', merchantId, distance }
        : { kind: 'resource', resourceId: resource!.resourceId, distance }
    }
  } catch {
    // The scene may not have finished loading; the next tick retries.
    return
  }

  nearby = best
  if (!best) {
    if (lastPromptKey !== '') {
      ui.setPrompt(null)
      lastPromptKey = ''
    }
    return
  }
  const prompt = promptFor(best)
  const key = `${best.kind}:${prompt.label}`
  if (key !== lastPromptKey) {
    ui.setPrompt(prompt)
    lastPromptKey = key
  }
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

const interact = async (): Promise<void> => {
  if (!ui || !nearby || !mountedClient || ui.isFastForwarding()) return
  const target = nearby
  if (target.kind === 'merchant') {
    await ui.openMerchant(target.merchantId)
    return
  }
  const result = await mountedClient.gather(target.resourceId)
  ui.toast(result.message, result.ok ? 'good' : 'bad')
  await ui.refresh()
}

const onActionKey = (event: KeyboardEvent): void => {
  if (event.defaultPrevented || event.repeat) return
  if (!ui || ui.isPanelOpen() || ui.isFastForwarding() || !nearby) return
  if (isTypingTarget(event.target)) return
  if (event.code !== 'KeyE' && event.code !== 'Space' && event.code !== 'Enter') return
  event.preventDefault()
  event.stopImmediatePropagation()
  void interact()
}

const onPanelClosed = (): void => {
  lastPromptKey = ''
  lastScanAt = 0
}

export default defineModule<RpgClient>({
  spritesheetResolver: (id: string | number) => resolveWorldSpritesheet(String(id)),

  engine: {
    onStart(engine) {
      if (typeof document === 'undefined') return false
      if (document.getElementById('ironblock-ui')) {
        // Another client module instance (e.g. HMR) already owns the overlay.
        return true
      }

      activeEngine = engine
      const session = readAuthSession()
      if (!session) {
        // The boot path only starts the game after authentication. Fail closed
        // if something else starts the client module directly.
        console.warn('[Ironblock] no authenticated session; refusing to mount the economy UI')
        return false
      }
      const serverClient = new HttpEconomyClient({ sessionToken: session.sessionToken })
      const runtime = createEconomyRuntime({ serverClient })
      mountedClient = runtime.client
      ui = mountIronblockUI({
        client: runtime.client,
        note: runtime.note,
        fellBackToMock: false,
        onNavigate: target => {
          guideTarget = target
          updateWaypoint()
        },
        onLiveEvents: events => {
          showLiveBotActions(events)
        },
      })

      window.addEventListener('keydown', onActionKey, true)
      document.addEventListener('ironblock:panel-closed', onPanelClosed)
      return true
    },

    onStep(engine) {
      scanNearby(engine)
    },
  },
})
