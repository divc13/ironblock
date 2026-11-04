import { economy } from '../config/economy'
import {
  merchantStallPosition,
  merchantsInStallOrder,
  resourceArea,
} from '../config/world'
import type {
  MerchantConfig,
  MerchantId,
  ResourceId,
  ResourceNodeConfig,
} from '../shared/types'

const merchantLookup = economy.merchants as Record<string, MerchantConfig | undefined>
const nodeLookup = economy.resources.nodes as Record<string, ResourceNodeConfig | undefined>

/**
 * Client-side generated sprites for market props.
 *
 * The starter project only ships two character spritesheets, so stalls, signs
 * and resource nodes are painted onto canvases at runtime and returned through
 * the RPGJS `spritesheetResolver`. Nothing is fetched from the network, and the
 * assets stay sharp at any resolution because they are drawn from data.
 *
 * Sprite ids are `ironblock:<kind>:<key>`; the server places matching events.
 */

export const WORLD_SPRITE_PREFIX = 'ironblock:'

type Frame = { time: number; frameX: number; frameY: number }

interface WorldSheet {
  id: string
  image: string
  framesWidth: number
  framesHeight: number
  textures: {
    stand: { animations: () => Frame[][] }
    walk: { animations: () => Frame[][] }
  }
}

const staticFrame: Frame = { time: 0, frameX: 0, frameY: 0 }
const staticAnimation = (): Frame[][] => [[staticFrame]]

const cache = new Map<string, WorldSheet>()

const makeCanvas = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const toSheet = (id: string, canvas: HTMLCanvasElement): WorldSheet => ({
  id,
  image: canvas.toDataURL('image/png'),
  framesWidth: 1,
  framesHeight: 1,
  textures: {
    stand: { animations: staticAnimation },
    walk: { animations: staticAnimation },
  },
})

const roundedRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void => {
  const r = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + r, y)
  context.arcTo(x + width, y, x + width, y + height, r)
  context.arcTo(x + width, y + height, x, y + height, r)
  context.arcTo(x, y + height, x, y, r)
  context.arcTo(x, y, x + width, y, r)
  context.closePath()
}

const drawStall = (merchantId: MerchantId): HTMLCanvasElement => {
  const merchant = merchantLookup[merchantId]
  const stall = merchant ? merchantStallPosition(merchant) : { color: '#c85d4a' }
  const color = stall.color ?? '#c85d4a'
  const dark = '#5b3b22'
  const wood = '#8a5a34'
  const woodLight = '#b07b4b'

  const canvas = makeCanvas(96, 80)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  // Ground shadow.
  ctx.fillStyle = 'rgba(20, 14, 8, 0.28)'
  ctx.beginPath()
  ctx.ellipse(48, 74, 42, 6, 0, 0, Math.PI * 2)
  ctx.fill()

  // Posts.
  ctx.fillStyle = dark
  ctx.fillRect(6, 22, 7, 48)
  ctx.fillRect(83, 22, 7, 48)

  // Canopy.
  const stripeWidth = 12
  for (let x = 2, index = 0; x < 94; x += stripeWidth, index += 1) {
    ctx.fillStyle = index % 2 === 0 ? color : '#f1e2c3'
    ctx.fillRect(x, 4, Math.min(stripeWidth, 94 - x), 20)
  }
  // Scalloped canopy edge.
  ctx.fillStyle = '#f1e2c3'
  for (let x = 4; x < 92; x += 12) {
    ctx.beginPath()
    ctx.arc(x + 4, 25, 4, 0, Math.PI)
    ctx.fill()
  }
  ctx.fillStyle = 'rgba(20, 14, 8, 0.3)'
  ctx.fillRect(2, 23, 92, 3)

  // Counter.
  ctx.fillStyle = wood
  roundedRect(ctx, 10, 48, 76, 20, 3)
  ctx.fill()
  ctx.fillStyle = woodLight
  ctx.fillRect(12, 50, 72, 5)
  ctx.strokeStyle = dark
  ctx.lineWidth = 2
  roundedRect(ctx, 10, 48, 76, 20, 3)
  ctx.stroke()
  // Counter grain.
  ctx.strokeStyle = 'rgba(60, 36, 18, 0.35)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(18, 61)
  ctx.lineTo(78, 61)
  ctx.moveTo(18, 65)
  ctx.lineTo(58, 65)
  ctx.stroke()

  // Goods on the counter: crate, sack and bottles.
  ctx.fillStyle = '#c79a5b'
  ctx.fillRect(20, 34, 18, 14)
  ctx.strokeStyle = dark
  ctx.strokeRect(20, 34, 18, 14)
  ctx.beginPath()
  ctx.moveTo(20, 40)
  ctx.lineTo(38, 40)
  ctx.moveTo(29, 34)
  ctx.lineTo(29, 48)
  ctx.stroke()
  ctx.fillStyle = '#e8d9b6'
  ctx.beginPath()
  ctx.ellipse(56, 45, 9, 11, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#a58f68'
  ctx.stroke()
  ctx.fillStyle = color
  ctx.fillRect(70, 33, 5, 15)
  ctx.fillRect(78, 36, 5, 12)
  ctx.fillStyle = '#d9c9a4'
  ctx.fillRect(70, 33, 5, 3)
  ctx.fillRect(78, 36, 5, 3)

  return canvas
}

const fitFont = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  weight = 700,
  family = 'Georgia, "Times New Roman", serif',
): number => {
  let size = startSize
  while (size > 9) {
    ctx.font = `${weight} ${size}px ${family}`
    if (ctx.measureText(text).width <= maxWidth) break
    size -= 1
  }
  return size
}

const drawSign = (
  main: string,
  sub: string,
  tone: 'merchant' | 'area' = 'merchant',
): HTMLCanvasElement => {
  const maxWidth = 250
  const canvas = makeCanvas(280, 62)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  const mainSize = fitFont(ctx, main, maxWidth - 26, 20)
  ctx.font = `700 ${mainSize}px Georgia, "Times New Roman", serif`
  const mainWidth = ctx.measureText(main).width
  ctx.font = `600 10px "Segoe UI", Helvetica, Arial, sans-serif`
  const subWidth = ctx.measureText(sub.toUpperCase()).width
  const width = Math.max(126, Math.ceil(Math.max(mainWidth + 30, subWidth + 34, 150)))
  const height = 48
  canvas.width = width
  canvas.height = height

  // Re-acquire context after resizing (state is reset).
  const paint = canvas.getContext('2d')
  if (!paint) return canvas

  const parchment = tone === 'area' ? '#e9d6ad' : '#f4e7c8'
  paint.fillStyle = 'rgba(20, 14, 8, 0.3)'
  roundedRect(paint, 2, 5, width - 2, height - 3, 5)
  paint.fill()
  paint.fillStyle = parchment
  roundedRect(paint, 0, 0, width - 4, height - 5, 5)
  paint.fill()
  paint.strokeStyle = '#6f5430'
  paint.lineWidth = 2
  roundedRect(paint, 1, 1, width - 6, height - 7, 5)
  paint.stroke()
  paint.strokeStyle = 'rgba(111, 84, 48, 0.4)'
  paint.lineWidth = 1
  roundedRect(paint, 5, 5, width - 14, height - 15, 3)
  paint.stroke()

  paint.textAlign = 'center'
  paint.textBaseline = 'middle'
  paint.fillStyle = '#241d12'
  paint.font = `700 ${mainSize}px Georgia, "Times New Roman", serif`
  paint.fillText(main, (width - 4) / 2, 19)
  paint.fillStyle = tone === 'area' ? '#5c4a2d' : '#7a5a33'
  paint.font = '600 9px "Segoe UI", Helvetica, Arial, sans-serif'
  paint.fillText(sub.toUpperCase(), (width - 4) / 2, 34)

  return canvas
}

const drawOreNode = (): HTMLCanvasElement => {
  const canvas = makeCanvas(48, 48)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = 'rgba(20, 14, 8, 0.25)'
  ctx.beginPath()
  ctx.ellipse(24, 43, 17, 4, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#5e5a55'
  ctx.beginPath()
  ctx.moveTo(8, 40)
  ctx.lineTo(13, 24)
  ctx.lineTo(25, 17)
  ctx.lineTo(38, 24)
  ctx.lineTo(43, 40)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#7a746c'
  ctx.beginPath()
  ctx.moveTo(13, 24)
  ctx.lineTo(25, 17)
  ctx.lineTo(30, 28)
  ctx.lineTo(18, 33)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = '#3d3934'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(8, 40)
  ctx.lineTo(13, 24)
  ctx.lineTo(25, 17)
  ctx.lineTo(38, 24)
  ctx.lineTo(43, 40)
  ctx.stroke()

  // Ore specks.
  const specks = [
    [20, 29, '#d98b4a'],
    [28, 35, '#e7b46b'],
    [31, 25, '#b8673c'],
    [17, 38, '#e0a45f'],
  ] as const
  for (const [x, y, color] of specks) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x, y, 2.2, 0, Math.PI * 2)
    ctx.fill()
  }
  return canvas
}

const drawWheatNode = (): HTMLCanvasElement => {
  const canvas = makeCanvas(48, 48)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = 'rgba(20, 14, 8, 0.22)'
  ctx.beginPath()
  ctx.ellipse(24, 43, 16, 4, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#6b5130'
  ctx.fillRect(10, 38, 28, 5)
  for (const [x, lean, color] of [
    [16, -3, '#d9a93f'],
    [24, 0, '#e7b94e'],
    [32, 3, '#c99a36'],
  ] as const) {
    ctx.strokeStyle = '#8a6b2b'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x, 39)
    ctx.quadraticCurveTo(x + lean, 28, x + lean * 2, 14)
    ctx.stroke()
    ctx.fillStyle = color
    for (let step = 0; step < 4; step += 1) {
      const y = 15 + step * 5
      const ox = lean * 1.4
      ctx.beginPath()
      ctx.ellipse(x + ox - 3, y, 3.2, 2, -0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.ellipse(x + ox + 3, y + 2, 3.2, 2, 0.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  return canvas
}

const drawTimberNode = (): HTMLCanvasElement => {
  const canvas = makeCanvas(48, 48)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = 'rgba(20, 14, 8, 0.25)'
  ctx.beginPath()
  ctx.ellipse(24, 43, 17, 4, 0, 0, Math.PI * 2)
  ctx.fill()

  // Stacked logs.
  const log = (x: number, y: number, width: number, height: number) => {
    ctx.fillStyle = '#7a5231'
    roundedRect(ctx, x, y, width, height, height / 2)
    ctx.fill()
    ctx.strokeStyle = '#4f331d'
    ctx.lineWidth = 2
    roundedRect(ctx, x, y, width, height, height / 2)
    ctx.stroke()
    ctx.fillStyle = '#c99b62'
    ctx.beginPath()
    ctx.ellipse(x + width, y + height / 2, 3.5, height / 2 - 1, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#8a643c'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(x + width, y + height / 2, 1.6, 0, Math.PI * 2)
    ctx.stroke()
  }
  log(8, 32, 26, 9)
  log(14, 23, 26, 9)
  log(10, 14, 24, 8)
  // Leaf sprig.
  ctx.fillStyle = '#4f8f6a'
  ctx.beginPath()
  ctx.ellipse(34, 12, 7, 4, -0.5, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(27, 9, 5, 3, 0.4, 0, Math.PI * 2)
  ctx.fill()
  return canvas
}

const drawWoolNode = (): HTMLCanvasElement => {
  const canvas = makeCanvas(48, 48)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = 'rgba(20, 14, 8, 0.22)'
  ctx.beginPath()
  ctx.ellipse(24, 43, 16, 4, 0, 0, Math.PI * 2)
  ctx.fill()

  // Sheep body.
  ctx.fillStyle = '#f1ecdf'
  ctx.strokeStyle = '#b9b09c'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.ellipse(25, 28, 13, 10, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  // Wool curls.
  ctx.fillStyle = '#dcd4c1'
  for (const [x, y] of [
    [18, 24],
    [25, 21],
    [31, 25],
    [21, 31],
    [29, 31],
  ] as const) {
    ctx.beginPath()
    ctx.arc(x, y, 3.2, 0, Math.PI * 2)
    ctx.fill()
  }
  // Head and legs.
  ctx.fillStyle = '#3f3a34'
  ctx.beginPath()
  ctx.ellipse(38, 27, 5, 4.5, -0.2, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillRect(18, 36, 3, 6)
  ctx.fillRect(29, 36, 3, 6)
  return canvas
}

const drawNode = (resourceId: ResourceId): HTMLCanvasElement => {
  switch (resourceId) {
    case 'iron_vein':
      return drawOreNode()
    case 'wheat_field':
      return drawWheatNode()
    case 'timber_grove':
      return drawTimberNode()
    case 'wool_pasture':
      return drawWoolNode()
    default: {
      const canvas = makeCanvas(40, 40)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#7a6a52'
        ctx.beginPath()
        ctx.arc(20, 24, 10, 0, Math.PI * 2)
        ctx.fill()
      }
      return canvas
    }
  }
}

const merchantSubLabel = (merchantId: MerchantId): string => {
  const merchant = merchantLookup[merchantId]
  if (!merchant) return 'Market stall'
  return `${merchant.personality} · stall ${merchant.stallSlot}`
}

const areaSubLabel = (resourceId: ResourceId): string => {
  const node = nodeLookup[resourceId]
  if (!node) return 'Resource area'
  return `${node.displayName} · ${node.nodeCount} nodes`
}

const build = (id: string): WorldSheet | undefined => {
  if (!id.startsWith(WORLD_SPRITE_PREFIX)) return undefined
  const parts = id.slice(WORLD_SPRITE_PREFIX.length).split(':')
  const [kind, a, b] = parts

  if (kind === 'stall' && a && merchantLookup[a]) {
    return toSheet(id, drawStall(a))
  }

  if (kind === 'sign' && a === 'stall' && b && merchantLookup[b]) {
    const merchant = merchantLookup[b]
    return toSheet(id, drawSign(merchant.displayName, merchantSubLabel(b), 'merchant'))
  }

  if (kind === 'sign' && a === 'area' && b && nodeLookup[b]) {
    const area = resourceArea(b)
    return toSheet(id, drawSign(area?.label ?? b, areaSubLabel(b), 'area'))
  }

  if (kind === 'node' && a && nodeLookup[a]) {
    return toSheet(id, drawNode(a))
  }

  return undefined
}

/**
 * Spritesheet resolver entry point for the RPGJS client module.
 * Unknown ids return undefined so the engine keeps looking in its cache.
 */
export function resolveWorldSpritesheet(id: string): WorldSheet | undefined {
  if (typeof document === 'undefined') return undefined
  if (!id.startsWith(WORLD_SPRITE_PREFIX)) return undefined
  const cached = cache.get(id)
  if (cached) return cached
  const sheet = build(id)
  if (sheet) cache.set(id, sheet)
  return sheet
}

/** All ids the server will ask for; useful for smoke tests/assertions. */
export function worldSpritesheetIds(): string[] {
  const ids: string[] = []
  for (const merchant of merchantsInStallOrder()) {
    ids.push(`${WORLD_SPRITE_PREFIX}stall:${merchant.id}`)
    ids.push(`${WORLD_SPRITE_PREFIX}sign:stall:${merchant.id}`)
  }
  for (const resourceId of Object.keys(economy.resources.nodes)) {
    ids.push(`${WORLD_SPRITE_PREFIX}sign:area:${resourceId}`)
    ids.push(`${WORLD_SPRITE_PREFIX}node:${resourceId}`)
  }
  return ids
}

export default resolveWorldSpritesheet
