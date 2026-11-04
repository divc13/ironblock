import { z } from 'zod'
import { priceBoundsFor } from './price-bounds'
import type { EconomyConfig } from './types'

/* -------------------------------------------------------------------------- */
/* Zod schema: shape, types and numeric safety                                */
/* -------------------------------------------------------------------------- */

const finite = z.number().finite()
const positive = finite.positive()
const nonNegative = finite.nonnegative()
const id = z.string().min(1)
const quantityMap = z.record(id, positive)
const nonNegativeQuantityMap = z.record(id, nonNegative)
const ratio = finite.min(0).max(1)

const toolKindSchema = z.enum(['pickaxe', 'hoe', 'axe'])

const tokenSchema = z
  .object({
    standard: z.literal('nep-245'),
    contract: id,
    tokenId: id,
    symbol: id,
    decimals: z.number().int().min(0).max(18),
    icon: id,
    reference: id,
  })
  .strict()

const itemUseSchema = z
  .object({
    kind: z.enum(['ingredient', 'tool', 'consumable', 'wearable']),
    toolKind: toolKindSchema.optional(),
    staminaRestore: nonNegative.optional(),
  })
  .strict()

const toolSchema = z
  .object({
    kind: toolKindSchema,
    maxDurability: positive,
    gatherSpeedMultiplier: positive,
  })
  .strict()

const itemSchema = z
  .object({
    id,
    displayName: id,
    description: id,
    category: z.enum([
      'ore',
      'metal',
      'grain',
      'food',
      'timber',
      'wood',
      'fiber',
      'textile',
      'tool',
      'clothing',
    ]),
    baseValue: positive,
    weight: positive,
    icon: id,
    token: tokenSchema,
    use: itemUseSchema,
    tool: toolSchema.optional(),
  })
  .strict()

const yieldRangeSchema = z
  .object({
    min: positive,
    max: positive,
  })
  .strict()

const resourceNodeSchema = z
  .object({
    id,
    displayName: id,
    itemId: id,
    nodeCount: z.number().int().positive(),
    yieldRange: yieldRangeSchema,
    respawnSeconds: positive,
    staminaCost: nonNegative,
    requiredTool: toolKindSchema.optional(),
  })
  .strict()

const resourcesSchema = z
  .object({
    nodes: z.record(id, resourceNodeSchema),
  })
  .strict()

const recipeSchema = z
  .object({
    id,
    displayName: id,
    category: z.enum([
      'smelting',
      'milling',
      'sawing',
      'weaving',
      'cooking',
      'smithing',
      'tailoring',
    ]),
    inputs: quantityMap,
    outputs: quantityMap,
    staminaCost: nonNegative,
    durationSeconds: positive,
  })
  .strict()

const personalitySchema = z
  .object({
    stockSensitivity: nonNegative,
    demandSensitivity: nonNegative,
    cashBidSensitivity: nonNegative,
    cashAskSensitivity: nonNegative,
    rivalSensitivity: nonNegative,
    buyMarginMultiplier: positive,
    sellMarginMultiplier: positive,
    spreadMultiplier: positive,
  })
  .strict()

const marginsSchema = z
  .object({
    buy: nonNegative.lt(1),
    sell: nonNegative.lt(1),
  })
  .strict()

const restockRateSchema = z
  .object({
    intervalSeconds: positive,
    unitsPerTick: positive,
    targetRatio: positive,
  })
  .strict()

const supplyChainSchema = z
  .object({
    inputs: quantityMap,
    outputs: quantityMap,
    batchesPerRestock: positive,
  })
  .strict()

const merchantSchema = z
  .object({
    id,
    displayName: id,
    stallSlot: z.number().int().positive(),
    personality: id,
    cash: positive,
    reserve: positive,
    targetStock: quantityMap,
    buys: z.array(id).min(1),
    sells: z.array(id).min(1),
    margins: marginsSchema,
    restockRate: restockRateSchema,
    supplyChain: supplyChainSchema.optional(),
  })
  .strict()

const pricingSchema = z
  .object({
    stock: z
      .object({
        elasticity: nonNegative,
        minFactor: positive,
        maxFactor: positive,
        fallbackTargetStock: positive,
      })
      .strict(),
    demand: z
      .object({
        windowSeconds: positive,
        weight: nonNegative,
        emaAlpha: positive.max(1),
        maxPressure: positive,
      })
      .strict(),
    cash: z
      .object({
        weight: nonNegative,
        bidWeight: nonNegative,
        askWeight: nonNegative,
        comfortMultiple: positive,
        bankruptcyRatio: nonNegative,
        minFactor: positive,
        maxFactor: positive,
      })
      .strict(),
    rival: z
      .object({
        weight: nonNegative,
        maxAdjustment: ratio,
        maxRivals: z.number().int().nonnegative(),
        rotationSeconds: positive,
      })
      .strict(),
    spread: z
      .object({
        base: positive,
        min: positive,
        max: positive,
      })
      .strict(),
    clamps: z
      .object({
        minMultiplier: positive,
        maxMultiplier: positive,
        minUnitPrice: positive,
        maxUnitPrice: positive,
      })
      .strict(),
    rounding: z
      .object({
        decimals: z.number().int().min(0).max(12),
        mode: z.enum(['nearest', 'floor', 'ceil']),
      })
      .strict(),
    trade: z
      .object({
        maxQuantityPerTrade: z.number().int().positive(),
        maxStockMultiple: positive,
        allowPartialFills: z.boolean(),
      })
      .strict(),
  })
  .strict()

const playerSchema = z
  .object({
    carryCapacity: positive,
    stamina: z
      .object({
        max: positive,
        regenerationPerSecond: nonNegative,
      })
      .strict(),
    gatherDurationSeconds: positive,
    startingCash: nonNegative,
    startingTool: id,
    startingInventory: nonNegativeQuantityMap,
  })
  .strict()

const botsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    behavior: z
      .object({
        cadenceSeconds: positive,
        jitterSeconds: nonNegative,
        maxTradeQuantity: z.number().int().positive(),
        maxTradeAttempts: z.number().int().positive(),
        buyProbability: ratio,
        sellProbability: ratio,
      })
      .strict(),
    startingCash: z
      .object({
        min: positive,
        max: positive,
      })
      .strict(),
    startingInventory: z
      .object({
        chance: ratio,
        quantityRange: yieldRangeSchema,
        fallbackQuantityRange: yieldRangeSchema,
      })
      .strict(),
  })
  .strict()

const caravanSchema = z
  .object({
    intervalSeconds: positive,
    goods: z
      .array(
        z
          .object({
            itemId: id,
            quantityRange: yieldRangeSchema,
          })
          .strict(),
      )
      .min(1),
    priceBias: z
      .object({
        bid: positive,
        ask: positive,
      })
      .strict(),
  })
  .strict()

const sinksSchema = z
  .object({
    stallRent: z
      .object({
        amountPerDay: nonNegative,
        graceDays: z.number().int().nonnegative(),
      })
      .strict(),
    salesTax: z
      .object({
        rate: ratio,
        appliesTo: z.enum(['player', 'merchant']),
      })
      .strict(),
    toolDurability: z
      .object({
        lossPerGather: nonNegative,
        repairCostPerPoint: nonNegative,
        repairThresholdRatio: ratio,
      })
      .strict(),
  })
  .strict()

const cashRecoverySchema = z
  .object({
    dailyRate: ratio,
    targetReserveMultiple: positive,
  })
  .strict()

const investmentsSchema = z
  .object({
    profitShareRate: ratio,
    minDistribution: nonNegative,
  })
  .strict()

const orderTemplateSchema = z
  .object({
    id,
    issuer: id,
    itemId: id,
    quantityRange: yieldRangeSchema,
  })
  .strict()

const ordersSchema = z
  .object({
    maxActive: z.number().int().positive(),
    cadenceDays: z.number().int().positive(),
    expiryDays: z.number().int().positive(),
    rewardMultiplier: yieldRangeSchema,
    templates: z.array(orderTemplateSchema).min(1),
  })
  .strict()

const reportingSchema = z
  .object({
    eventRetention: z.number().int().positive(),
    summaryRetentionDays: z.number().int().positive(),
    topMovers: z.number().int().positive(),
    eventSampleSize: z.number().int().positive(),
  })
  .strict()

const fastForwardSchema = z
  .object({
    days: z.number().int().positive(),
    stepSeconds: positive,
    durationSeconds: positive,
    maxDays: z.number().int().positive(),
    maxSteps: z.number().int().positive(),
    seedBehavior: z.enum(['reuse-config-seed', 'derive-per-run']),
  })
  .strict()

export const economyConfigSchema = z
  .object({
    meta: z
      .object({
        name: id,
        version: id,
        schemaVersion: z.number().int().positive(),
        seed: id,
        description: id,
      })
      .strict(),
    currency: z
      .object({
        code: id,
        symbol: id,
        decimals: z.number().int().min(0).max(18),
        startingPlayerBalance: nonNegative,
      })
      .strict(),
    items: z.record(id, itemSchema),
    resources: resourcesSchema,
    recipes: z.record(id, recipeSchema),
    personalities: z.record(id, personalitySchema),
    merchants: z.record(id, merchantSchema),
    pricing: pricingSchema,
    player: playerSchema,
    bots: botsSchema,
    caravan: caravanSchema,
    sinks: sinksSchema,
    cashRecovery: cashRecoverySchema,
    investments: investmentsSchema,
    orders: ordersSchema,
    reporting: reportingSchema,
    fastForward: fastForwardSchema,
  })
  .strict()

/* -------------------------------------------------------------------------- */
/* Cross-reference and invariant validation                                   */
/* -------------------------------------------------------------------------- */

export interface ConfigValidationIssue {
  path: string
  message: string
}

export class EconomyConfigError extends Error {
  readonly issues: ConfigValidationIssue[]

  constructor(issues: ConfigValidationIssue[]) {
    super(
      `Invalid economy configuration:\n${issues
        .map(issue => `- ${issue.path}: ${issue.message}`)
        .join('\n')}`,
    )
    this.name = 'EconomyConfigError'
    this.issues = issues
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export function collectEconomyConfigIssues(config: EconomyConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = []
  const add = (path: string, message: string) => issues.push({ path, message })

  const checkIdMap = <T extends { id: string }>(
    label: string,
    noun: string,
    map: Record<string, T>,
  ) => {
    const seen = new Map<string, string>()
    for (const [key, value] of Object.entries(map)) {
      if (value.id !== key) {
        add(`${label}.${key}.id`, `${noun} id "${value.id}" must match its key "${key}"`)
      }
      const previous = seen.get(value.id)
      if (previous) {
        add(
          `${label}.${key}.id`,
          `duplicate ${noun} id "${value.id}" (also used by ${label}.${previous})`,
        )
      } else {
        seen.set(value.id, key)
      }
    }
  }

  checkIdMap('items', 'item', config.items)
  checkIdMap('resources.nodes', 'resource', config.resources.nodes)
  checkIdMap('recipes', 'recipe', config.recipes)
  checkIdMap('merchants', 'merchant', config.merchants)

  const itemIds = new Set(Object.keys(config.items))
  const itemRef = (path: string, itemId: string) => {
    if (!itemIds.has(itemId)) add(path, `unknown item id "${itemId}"`)
  }

  const checkItemList = (path: string, list: string[]) => {
    const seen = new Set<string>()
    list.forEach((itemId, index) => {
      if (seen.has(itemId)) {
        add(`${path}[${index}]`, `duplicate item reference "${itemId}"`)
      }
      seen.add(itemId)
      itemRef(`${path}[${index}]`, itemId)
    })
  }

  const buyers = new Set<string>()
  for (const [merchantId, merchant] of Object.entries(config.merchants)) {
    const path = `merchants.${merchantId}`
    if (!config.personalities[merchant.personality]) {
      add(`${path}.personality`, `unknown personality id "${merchant.personality}"`)
    }
    const effectiveReserve = merchant.reserve * config.pricing.cash.bankruptcyRatio
    const startingThreshold = Math.max(merchant.reserve, effectiveReserve)
    if (merchant.cash <= startingThreshold) {
      add(
        `${path}.cash`,
        `merchant must start above its reserve and effective bankruptcy threshold ${startingThreshold}`,
      )
    }
    if (merchant.margins.sell <= merchant.margins.buy) {
      add(`${path}.margins`, 'sell margin must be greater than buy margin')
    }

    checkItemList(`${path}.buys`, merchant.buys)
    checkItemList(`${path}.sells`, merchant.sells)
    for (const itemId of merchant.buys) buyers.add(itemId)

    for (const itemId of Object.keys(merchant.targetStock)) {
      itemRef(`${path}.targetStock.${itemId}`, itemId)
    }
    for (const itemId of new Set([...merchant.buys, ...merchant.sells])) {
      if (!(itemId in merchant.targetStock)) {
        add(`${path}.targetStock`, `missing target stock for traded item "${itemId}"`)
      }
    }

    if (merchant.supplyChain) {
      for (const itemId of Object.keys(merchant.supplyChain.inputs)) {
        itemRef(`${path}.supplyChain.inputs.${itemId}`, itemId)
      }
      for (const itemId of Object.keys(merchant.supplyChain.outputs)) {
        itemRef(`${path}.supplyChain.outputs.${itemId}`, itemId)
      }
      if (Object.keys(merchant.supplyChain.inputs).length === 0) {
        add(`${path}.supplyChain.inputs`, 'supply chain needs at least one input')
      }
      if (Object.keys(merchant.supplyChain.outputs).length === 0) {
        add(`${path}.supplyChain.outputs`, 'supply chain needs at least one output')
      }
    }
  }

  const stalls = new Map<number, string>()
  for (const [merchantId, merchant] of Object.entries(config.merchants)) {
    const previous = stalls.get(merchant.stallSlot)
    if (previous) {
      add(
        `merchants.${merchantId}.stallSlot`,
        `stall ${merchant.stallSlot} is already assigned to "${previous}"`,
      )
    } else {
      stalls.set(merchant.stallSlot, merchantId)
    }
  }

  const resourceSources = new Set<string>()
  for (const [resourceId, node] of Object.entries(config.resources.nodes)) {
    const path = `resources.nodes.${resourceId}`
    itemRef(`${path}.itemId`, node.itemId)
    resourceSources.add(node.itemId)
    if (node.yieldRange.min > node.yieldRange.max) {
      add(`${path}.yieldRange`, 'yield minimum must not exceed maximum')
    }
  }

  const recipeOutputs = new Set<string>()
  const recipeInputs = new Set<string>()
  for (const [recipeId, recipe] of Object.entries(config.recipes)) {
    const path = `recipes.${recipeId}`
    if (Object.keys(recipe.inputs).length === 0) {
      add(`${path}.inputs`, 'recipe needs at least one input')
    }
    if (Object.keys(recipe.outputs).length === 0) {
      add(`${path}.outputs`, 'recipe needs at least one output')
    }
    for (const itemId of Object.keys(recipe.inputs)) {
      itemRef(`${path}.inputs.${itemId}`, itemId)
      recipeInputs.add(itemId)
    }
    for (const itemId of Object.keys(recipe.outputs)) {
      itemRef(`${path}.outputs.${itemId}`, itemId)
      recipeOutputs.add(itemId)
    }
  }

  const caravanSources = new Set<string>()
  const caravanItems = new Set<string>()
  config.caravan.goods.forEach((good, index) => {
    itemRef(`caravan.goods[${index}].itemId`, good.itemId)
    caravanSources.add(good.itemId)
    if (caravanItems.has(good.itemId)) {
      add(`caravan.goods[${index}].itemId`, `duplicate caravan good "${good.itemId}"`)
    }
    caravanItems.add(good.itemId)
    if (good.quantityRange.min > good.quantityRange.max) {
      add(`caravan.goods[${index}].quantityRange`, 'quantity minimum must not exceed maximum')
    }
  })

  const orderTemplateIds = new Set<string>()
  config.orders.templates.forEach((template, index) => {
    const path = `orders.templates[${index}]`
    itemRef(`${path}.itemId`, template.itemId)
    if (orderTemplateIds.has(template.id)) {
      add(`${path}.id`, `duplicate order template id "${template.id}"`)
    }
    orderTemplateIds.add(template.id)
    if (template.quantityRange.min > template.quantityRange.max) {
      add(`${path}.quantityRange`, 'quantity minimum must not exceed maximum')
    }
  })
  if (config.orders.rewardMultiplier.min > config.orders.rewardMultiplier.max) {
    add('orders.rewardMultiplier', 'reward multiplier minimum must not exceed maximum')
  }
  if (config.orders.maxActive > config.orders.templates.length) {
    add(
      'orders.maxActive',
      'maxActive cannot exceed the number of order templates',
    )
  }

  if (config.cashRecovery.targetReserveMultiple <= 1) {
    add(
      'cashRecovery.targetReserveMultiple',
      'recovery target must be above the reserve',
    )
  }

  for (const [itemId, item] of Object.entries(config.items)) {
    const path = `items.${itemId}`
    const hasSource =
      resourceSources.has(itemId) ||
      recipeOutputs.has(itemId) ||
      caravanSources.has(itemId)
    const hasUse =
      recipeInputs.has(itemId) ||
      item.use.kind !== 'ingredient' ||
      item.tool !== undefined
    const hasBuyer = buyers.has(itemId)

    if (!hasSource) add(path, 'item has no source (resource, recipe or caravan)')
    if (!hasUse) add(path, 'item has no use (recipe input, tool, consumable or wearable)')
    if (!hasBuyer) add(path, 'item has no merchant buyer')

    if (item.use.kind === 'tool') {
      if (!item.tool) add(`${path}.tool`, 'tool item must define tool properties')
      if (item.use.toolKind && item.tool && item.use.toolKind !== item.tool.kind) {
        add(`${path}.use.toolKind`, 'use tool kind must match tool properties')
      }
    } else if (item.tool) {
      add(`${path}.use.kind`, 'item with tool properties must use kind "tool"')
    }
  }

  const toolKinds = new Set(
    Object.values(config.items)
      .map(item => item.tool?.kind)
      .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind)),
  )
  for (const [resourceId, node] of Object.entries(config.resources.nodes)) {
    if (node.requiredTool && !toolKinds.has(node.requiredTool)) {
      add(
        `resources.nodes.${resourceId}.requiredTool`,
        `no tool item provides tool kind "${node.requiredTool}"`,
      )
    }
  }

  itemRef('player.startingTool', config.player.startingTool)
  if (!config.items[config.player.startingTool]?.tool) {
    add('player.startingTool', 'starting tool must reference a tool item')
  }
  for (const itemId of Object.keys(config.player.startingInventory)) {
    itemRef(`player.startingInventory.${itemId}`, itemId)
  }
  if (config.player.startingCash !== config.currency.startingPlayerBalance) {
    add(
      'player.startingCash',
      'player starting cash must equal currency.startingPlayerBalance',
    )
  }

  if (config.bots.startingCash.min > config.bots.startingCash.max) {
    add('bots.startingCash', 'bot starting cash minimum must not exceed maximum')
  }
  if (
    config.bots.behavior.buyProbability + config.bots.behavior.sellProbability >
    1
  ) {
    add(
      'bots.behavior',
      'buy and sell probabilities must not add up to more than 1',
    )
  }
  for (const key of ['quantityRange', 'fallbackQuantityRange'] as const) {
    const range = config.bots.startingInventory[key]
    if (range.min > range.max) {
      add(`bots.startingInventory.${key}`, 'minimum must not exceed maximum')
    }
  }

  const pricing = config.pricing
  if (pricing.stock.minFactor > pricing.stock.maxFactor) {
    add('pricing.stock', 'minimum stock factor must not exceed maximum')
  }
  if (pricing.cash.minFactor > pricing.cash.maxFactor) {
    add('pricing.cash', 'minimum cash factor must not exceed maximum')
  }
  if (pricing.spread.min > pricing.spread.max) {
    add('pricing.spread', 'minimum spread must not exceed maximum')
  }
  if (pricing.spread.base < pricing.spread.min || pricing.spread.base > pricing.spread.max) {
    add('pricing.spread.base', 'base spread must be inside the configured spread range')
  }
  if (pricing.clamps.minMultiplier > pricing.clamps.maxMultiplier) {
    add('pricing.clamps', 'minimum multiplier must not exceed maximum')
  }
  if (pricing.clamps.minUnitPrice > pricing.clamps.maxUnitPrice) {
    add('pricing.clamps', 'minimum unit price must not exceed maximum')
  }
  if (config.currency.decimals < pricing.rounding.decimals) {
    add(
      'currency.decimals',
      `currency precision must be at least pricing.rounding.decimals (${pricing.rounding.decimals}) so rounded totals cannot exceed cash or reserve limits`,
    )
  }
  for (const [itemId, item] of Object.entries(config.items)) {
    if (!priceBoundsFor(item, config).valid) {
      add(
        `items.${itemId}.baseValue`,
        'item price cannot fit inside the configured price clamps',
      )
    }
  }

  const fastForward = config.fastForward
  if (fastForward.days > fastForward.maxDays) {
    add('fastForward.days', 'days must not exceed maxDays')
  }
  const totalSteps = (fastForward.days * 86400) / fastForward.stepSeconds
  if (!Number.isFinite(totalSteps) || totalSteps > fastForward.maxSteps) {
    add(
      'fastForward',
      `fast-forward would run ${totalSteps} steps, above maxSteps ${fastForward.maxSteps}`,
    )
  }
  const maxDaysAtStepSize =
    (fastForward.maxDays * 86400) / fastForward.stepSeconds
  if (
    !Number.isFinite(maxDaysAtStepSize) ||
    maxDaysAtStepSize > fastForward.maxSteps
  ) {
    add(
      'fastForward.maxDays',
      `maxDays ${fastForward.maxDays} at ${fastForward.stepSeconds}s/step requires ${maxDaysAtStepSize} steps, above maxSteps ${fastForward.maxSteps}`,
    )
  }

  return issues
}

export type ConfigCheckResult =
  | { ok: true; config: EconomyConfig }
  | { ok: false; issues: ConfigValidationIssue[] }

/**
 * Parses and validates an economy config. Throws EconomyConfigError with a
 * complete issue list when anything is wrong.
 */
export function validateEconomyConfig(input: unknown): EconomyConfig {
  const parsed = economyConfigSchema.safeParse(input)
  if (!parsed.success) {
    throw new EconomyConfigError(
      parsed.error.issues.map(issue => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    )
  }

  const config = parsed.data as EconomyConfig
  const issues = collectEconomyConfigIssues(config)
  if (issues.length > 0) throw new EconomyConfigError(issues)
  return config
}

/** Non-throwing validation helper for tooling and tests. */
export function checkEconomyConfig(input: unknown): ConfigCheckResult {
  try {
    return { ok: true, config: validateEconomyConfig(input) }
  } catch (error) {
    if (error instanceof EconomyConfigError) {
      return { ok: false, issues: error.issues }
    }
    return {
      ok: false,
      issues: [
        {
          path: '(root)',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }
}
