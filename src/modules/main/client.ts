import { defineModule, type RpgClient } from '@rpgjs/client'
import { createEconomyRuntime } from '../../client/economy'
import { resolveWorldSpritesheet } from '../../client/world-sprites'
import { economy } from '../../config/economy'
import {
  merchantIdFromEventName,
  resourceSpecFromEventName,
  world,
} from '../../config/world'
import { mountIronblockUI, type IronblockUI } from '../../ui/ui'
import type { ResourceNodeConfig } from '../../shared/types'

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

const merchantLookup = economy.merchants as Record<
  string,
  (typeof economy.merchants)[keyof typeof economy.merchants] | undefined
>
const resourceLookup = economy.resources.nodes as Record<string, ResourceNodeConfig | undefined>

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

const scanNearby = (engine: import('@rpgjs/client').RpgClientEngine): void => {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (now - lastScanAt < 90) return
  lastScanAt = now
  if (!ui) return

  if (ui.isPanelOpen()) {
    if (nearby) {
      ui.setPrompt(null)
      lastPromptKey = ''
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
  if (!ui || !nearby || !mountedClient) return
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
  if (!ui || ui.isPanelOpen() || !nearby) return
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

      const runtime = createEconomyRuntime()
      mountedClient = runtime.client
      ui = mountIronblockUI({
        client: runtime.client,
        note: runtime.note,
        fellBackToMock: runtime.fellBackToMock,
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
