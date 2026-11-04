import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import { createMarketEvent } from '../src/shared/market-events'
import type { CreateMarketEventInput } from '../src/shared/market-events'
import {
  isMerchantBankrupt,
  quote,
  selectRivalMerchants,
} from '../src/shared/pricing'
import { stableCompare } from '../src/shared/stable-hash'
import type {
  EconomyConfig,
  MarketState,
  MerchantConfig,
  MerchantState,
  PlayerEconomyState,
} from '../src/shared/types'

const ferroConfig = Object.values(economy.merchants).find(
  merchant => merchant.buys.includes('iron_ore') && merchant.sells.includes('iron_ingot'),
) as MerchantConfig

const makeMerchantState = (
  merchantConfig: MerchantConfig,
  overrides: Partial<MerchantState> = {},
): MerchantState => {
  const stock = Object.fromEntries(
    Object.entries(merchantConfig.targetStock).map(([itemId, quantity]) => [
      itemId,
      quantity,
    ]),
  )
  return {
    id: merchantConfig.id,
    displayName: merchantConfig.displayName,
    personality: merchantConfig.personality,
    cash: merchantConfig.cash,
    reserve: merchantConfig.reserve,
    stock,
    targetStock: { ...merchantConfig.targetStock },
    demandEma: Object.fromEntries(Object.keys(merchantConfig.targetStock).map(itemId => [itemId, 0])),
    open: true,
    ...overrides,
  }
}

const makeMarket = (
  merchants: MerchantState[],
  player?: PlayerEconomyState,
): MarketState => ({
  time: 0,
  day: 0,
  seed: economy.meta.seed,
  merchants: Object.fromEntries(merchants.map(merchant => [merchant.id, merchant])),
  player,
})

const makePlayer = (overrides: Partial<PlayerEconomyState> = {}): PlayerEconomyState => ({
  id: 'player-1',
  cash: 500,
  inventory: { iron_ore: 50 },
  stamina: 100,
  maxStamina: 100,
  equippedTool: economy.player.startingTool,
  ...overrides,
})

const cashThatNaivelyOvershoots = (
  unitPrice: number,
): { quantity: number; cash: number } => {
  for (let quantity = 3; quantity < 20; quantity += 1) {
    const target = quantity * unitPrice
    if (!Number.isInteger(target)) {
      return {
        quantity,
        cash: target + (Math.ceil(target) - target) / 2,
      }
    }
  }
  throw new Error('expected a non-integer rounded total')
}

const makeEventInput = (
  overrides: Partial<CreateMarketEventInput> = {},
): CreateMarketEventInput => ({
  time: 120,
  type: 'trade.sell',
  actor: { type: 'player', id: 'player-1', displayName: 'Ada' },
  item: 'iron_ore',
  quantity: 2,
  price: 5.25,
  before: { stock: 30, cash: 200, bid: 5.5, ask: 7.2 },
  after: { stock: 32, cash: 189.5, bid: 5.1, ask: 7.1 },
  reasons: [
    {
      code: 'stock',
      label: 'Excess stock',
      value: -0.25,
      effect: -0.4,
    },
  ],
  cause: 'trade',
  causeId: 'trade-1',
  ...overrides,
})

test('flooding iron lowers Ferro\'s bid', () => {
  const target = ferroConfig.targetStock.iron_ore
  const normal = makeMerchantState(ferroConfig)
  const flooded = makeMerchantState(ferroConfig, {
    stock: { ...normal.stock, iron_ore: target * 2 },
  })

  const normalQuote = quote(normal, 'iron_ore', 'sell', 1, makeMarket([normal]), economy)
  const floodedQuote = quote(flooded, 'iron_ore', 'sell', 1, makeMarket([flooded]), economy)

  assert.ok(normalQuote.unitPrice > 0)
  assert.ok(
    floodedQuote.unitPrice < normalQuote.unitPrice,
    `expected flooded bid ${floodedQuote.unitPrice} below normal bid ${normalQuote.unitPrice}`,
  )
  assert.equal(floodedQuote.reasons.find(reason => reason.code === 'stock')?.label, 'Excess stock')
})

test('low stock raises the ask', () => {
  const target = ferroConfig.targetStock.iron_ingot
  const stocked = makeMerchantState(ferroConfig)
  const nearlyEmpty = makeMerchantState(ferroConfig, {
    stock: { ...stocked.stock, iron_ingot: 1 },
  })

  const stockedQuote = quote(stocked, 'iron_ingot', 'buy', 1, makeMarket([stocked]), economy)
  const emptyQuote = quote(nearlyEmpty, 'iron_ingot', 'buy', 1, makeMarket([nearlyEmpty]), economy)

  assert.ok(
    emptyQuote.unitPrice > stockedQuote.unitPrice,
    `expected low-stock ask ${emptyQuote.unitPrice} above stocked ask ${stockedQuote.unitPrice}`,
  )
  assert.equal(emptyQuote.reasons.find(reason => reason.code === 'stock')?.label, 'Low stock')
  assert.equal(nearlyEmpty.stock.iron_ingot, 1)
  assert.ok(target > 1)
})

test('cash pressure lowers bids and lifts asks', () => {
  const comfortableCash = ferroConfig.reserve * (1 + economy.pricing.cash.comfortMultiple) + 1
  const comfortable = makeMerchantState(ferroConfig, { cash: comfortableCash })
  const thin = makeMerchantState(ferroConfig, { cash: ferroConfig.reserve + 1 })

  const comfortableBid = quote(comfortable, 'iron_ore', 'sell', 1, makeMarket([comfortable]), economy)
  const thinBid = quote(thin, 'iron_ore', 'sell', 1, makeMarket([thin]), economy)
  const comfortableAsk = quote(comfortable, 'iron_ingot', 'buy', 1, makeMarket([comfortable]), economy)
  const thinAsk = quote(thin, 'iron_ingot', 'buy', 1, makeMarket([thin]), economy)

  assert.equal(thinBid.merchantBankrupt, false)
  assert.ok(thinBid.unitPrice < comfortableBid.unitPrice)
  assert.ok(thinAsk.unitPrice > comfortableAsk.unitPrice)
  assert.ok(
    (thinBid.reasons.find(reason => reason.code === 'cash')?.value ?? 0) >
      (comfortableBid.reasons.find(reason => reason.code === 'cash')?.value ?? 0),
  )
})

test('personality parameters produce different quotes', () => {
  const aggressive = makeMerchantState(ferroConfig, { personality: 'aggressive' })
  const premium = makeMerchantState(ferroConfig, { personality: 'premium' })

  const aggressiveQuote = quote(aggressive, 'iron_ingot', 'buy', 1, makeMarket([aggressive]), economy)
  const premiumQuote = quote(premium, 'iron_ingot', 'buy', 1, makeMarket([premium]), economy)

  assert.ok(
    premiumQuote.unitPrice > aggressiveQuote.unitPrice,
    `expected premium ask ${premiumQuote.unitPrice} above aggressive ask ${aggressiveQuote.unitPrice}`,
  )
  assert.notEqual(
    premiumQuote.reasons.find(reason => reason.code === 'margin')?.value,
    aggressiveQuote.reasons.find(reason => reason.code === 'margin')?.value,
  )
})

test('bankruptcy threshold is detected and blocks trading', () => {
  const bankrupt = makeMerchantState(ferroConfig, { cash: ferroConfig.reserve })
  const healthy = makeMerchantState(ferroConfig, { cash: ferroConfig.reserve + 0.01 })

  assert.equal(isMerchantBankrupt(bankrupt, economy), true)
  assert.equal(isMerchantBankrupt(healthy, economy), false)

  const bankruptQuote = quote(bankrupt, 'iron_ore', 'sell', 1, makeMarket([bankrupt]), economy)
  assert.equal(bankruptQuote.canTrade, false)
  assert.equal(bankruptQuote.blockedReason, 'merchant_below_reserve')
  assert.equal(bankruptQuote.merchantBankrupt, true)
})

test('reasons explain the price and their signed effects add up', () => {
  const merchant = makeMerchantState(ferroConfig, {
    cash: ferroConfig.reserve + 1,
    demandEma: { iron_ingot: 18 },
  })
  const result = quote(merchant, 'iron_ingot', 'buy', 1, makeMarket([merchant]), economy)
  const codes = result.reasons.map(reason => reason.code)
  const effectTotal = result.reasons.reduce((sum, reason) => sum + reason.effect, 0)

  assert.ok(result.reasons.length >= 6)
  assert.ok(codes.includes('stock'))
  assert.ok(codes.includes('demand'))
  assert.ok(codes.includes('cash'))
  assert.ok(codes.includes('margin'))
  assert.ok(codes.includes('spread'))
  assert.ok(codes.includes('clamp'))
  assert.ok(codes.includes('rounding'))
  assert.ok(result.reasons.every(reason => reason.label.length > 0))
  assert.ok(
    Math.abs(effectTotal - (result.unitPrice - result.basePrice)) < 0.000001,
    `reason effects ${effectTotal} should equal price change ${result.unitPrice - result.basePrice}`,
  )
})

test('quotes enforce player cash, inventory and carry constraints', () => {
  const merchant = makeMerchantState(ferroConfig)
  const poorPlayer = makePlayer({ cash: 25, inventory: {} })
  const richPlayer = makePlayer({ cash: 1000, inventory: { iron_ore: 3 } })

  const buyQuote = quote(
    merchant,
    'iron_ingot',
    'buy',
    10,
    makeMarket([merchant], poorPlayer),
    economy,
  )
  const sellQuote = quote(
    merchant,
    'iron_ore',
    'sell',
    10,
    makeMarket([merchant], richPlayer),
    economy,
  )

  assert.equal(buyQuote.canTrade, true)
  assert.ok(buyQuote.fillQuantity < 10)
  assert.equal(buyQuote.partialFill, true)
  assert.ok(buyQuote.constraints.maxByPlayerCash !== null)
  assert.equal(sellQuote.canTrade, true)
  assert.ok(sellQuote.constraints.maxByPlayerInventory !== null)
  assert.ok(sellQuote.constraints.maxByMerchantCash !== null)
})

test('rival discovery rotates a stable codepoint sample when candidates exceed maxRivals', () => {
  const config: EconomyConfig = structuredClone(economy)
  config.pricing.rival.maxRivals = 3
  config.pricing.rival.rotationSeconds = 60

  const rivalIds = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']
  rivalIds.forEach((id, index) => {
    config.merchants[id] = {
      ...structuredClone(ferroConfig),
      id,
      displayName: id,
      stallSlot: 20 + index,
      buys: ['iron_ore'],
      sells: ['iron_ingot'],
      targetStock: { iron_ore: 40, iron_ingot: 24 },
    }
  })

  const states = [
    makeMerchantState(config.merchants.ferro),
    ...rivalIds.map(id => makeMerchantState(config.merchants[id])),
  ]
  const baseMarket = makeMarket(states)
  baseMarket.seed = 'rival-selection-test'

  const selectedAt = (time: number): string[] =>
    selectRivalMerchants(
      baseMarket.merchants.ferro,
      'iron_ingot',
      'buy',
      { ...baseMarket, time },
      config,
    ).map(merchant => merchant.id)

  const first = selectedAt(0)
  assert.deepEqual(selectedAt(0), first)
  assert.equal(first.length, 3)
  assert.equal(new Set(first).size, 3)
  assert.ok(first.every(id => rivalIds.includes(id)))

  const sorted = [...rivalIds].sort(stableCompare)
  const isRotation = sorted.some((_, start) => {
    const rotated = [...sorted.slice(start), ...sorted.slice(0, start)].slice(
      0,
      first.length,
    )
    return rotated.join('|') === first.join('|')
  })
  assert.equal(isRotation, true)

  const selectedSets = new Set<string>()
  for (let bucket = 0; bucket < 12; bucket += 1) {
    selectedSets.add(selectedAt(bucket * 60).sort(stableCompare).join(','))
  }
  assert.ok(selectedSets.size > 1, 'rival sample should rotate over time')
})

test('bid/ask crossing is guarded to a non-negative spread', () => {
  const config: EconomyConfig = structuredClone(economy)
  config.merchants.ferro.margins.buy = -0.5
  config.merchants.ferro.margins.sell = 0.1

  const merchant = makeMerchantState(config.merchants.ferro)
  const market = makeMarket([merchant])
  const buy = quote(merchant, 'iron_ore', 'buy', 1, market, config)
  const sell = quote(merchant, 'iron_ore', 'sell', 1, market, config)

  assert.ok(buy.unitPrice >= sell.unitPrice)
  assert.ok(buy.reasons.some(reason => reason.code === 'spread-guard'))
  assert.ok(sell.reasons.some(reason => reason.code === 'spread-guard'))
})

test('stock and trade limits cap fills', () => {
  const base = makeMerchantState(ferroConfig)
  const limitedStock = makeMerchantState(ferroConfig, {
    stock: { ...base.stock, iron_ore: 5 },
  })
  const buy = quote(
    limitedStock,
    'iron_ore',
    'buy',
    10,
    makeMarket([limitedStock], makePlayer({ cash: 1000, inventory: {} })),
    economy,
  )
  assert.equal(buy.constraints.maxByStock, 5)
  assert.equal(buy.fillQuantity, 5)

  const deepStock = makeMerchantState(ferroConfig, {
    cash: 100000,
    stock: { ...base.stock, iron_ore: 100 },
  })
  const sell = quote(
    deepStock,
    'iron_ore',
    'sell',
    50,
    makeMarket(
      [deepStock],
      makePlayer({ cash: 1000, inventory: { iron_ore: 50 } }),
    ),
    economy,
  )
  assert.equal(sell.constraints.maxByStock, 20)
  assert.equal(sell.fillQuantity, 20)
})

test('merchant cash limits fills and totals never exceed available cash', () => {
  const base = makeMerchantState(ferroConfig)
  const available = 20
  const merchant = makeMerchantState(ferroConfig, {
    cash: ferroConfig.reserve + available,
    stock: { ...base.stock, iron_ore: 100 },
  })
  const result = quote(
    merchant,
    'iron_ore',
    'sell',
    100,
    makeMarket(
      [merchant],
      makePlayer({ cash: 1000, inventory: { iron_ore: 100 } }),
    ),
    economy,
  )

  assert.ok(result.constraints.maxByMerchantCash !== null)
  assert.ok((result.constraints.maxByMerchantCash ?? 0) > 0)
  assert.equal(result.fillQuantity, result.constraints.maxByMerchantCash)
  assert.ok(result.total <= available + 1e-9)
})

test('trade quantity limit caps fills', () => {
  const config: EconomyConfig = structuredClone(economy)
  config.pricing.trade.maxQuantityPerTrade = 3
  const base = makeMerchantState(config.merchants.ferro)
  const merchant = makeMerchantState(config.merchants.ferro, {
    cash: 100000,
    stock: { ...base.stock, iron_ore: 100 },
  })
  const result = quote(
    merchant,
    'iron_ore',
    'sell',
    10,
    makeMarket(
      [merchant],
      makePlayer({ cash: 1000, inventory: { iron_ore: 100 } }),
    ),
    config,
  )

  assert.equal(result.constraints.maxByTradeLimit, 3)
  assert.equal(result.fillQuantity, 3)
})

test('carry capacity limits fills', () => {
  const base = makeMerchantState(ferroConfig)
  const merchant = makeMerchantState(ferroConfig, {
    stock: { ...base.stock, iron_ore: 40 },
  })
  const result = quote(
    merchant,
    'iron_ore',
    'buy',
    10,
    makeMarket(
      [merchant],
      makePlayer({ cash: 1000, inventory: { grain: 110 } }),
    ),
    economy,
  )

  assert.equal(result.constraints.playerCarryFree, 10)
  assert.equal(result.constraints.maxByCarry, 5)
  assert.equal(result.fillQuantity, 5)
})

test('rounded buyer cash boundary cannot exceed player cash', () => {
  const config: EconomyConfig = structuredClone(economy)
  config.currency.decimals = 0
  config.pricing.rounding.decimals = 2
  config.pricing.rounding.mode = 'ceil'
  config.pricing.cash.weight = 0

  const merchant = makeMerchantState(config.merchants.ferro)
  const unitPrice = quote(
    merchant,
    'iron_ingot',
    'buy',
    1,
    makeMarket([merchant], makePlayer({ cash: 10000, inventory: {} })),
    config,
  ).unitPrice
  const { quantity, cash } = cashThatNaivelyOvershoots(unitPrice)
  const result = quote(
    merchant,
    'iron_ingot',
    'buy',
    10,
    makeMarket([merchant], makePlayer({ cash, inventory: {} })),
    config,
  )

  assert.ok(result.fillQuantity < quantity)
  assert.ok(result.total <= cash + 1e-9)
  assert.equal(result.constraints.maxByPlayerCash, result.fillQuantity)
  assert.equal(
    result.total,
    Math.ceil(result.fillQuantity * result.unitPrice),
  )
})

test('rounded merchant reserve boundary cannot exceed available cash', () => {
  const config: EconomyConfig = structuredClone(economy)
  config.currency.decimals = 0
  config.pricing.rounding.decimals = 2
  config.pricing.rounding.mode = 'ceil'
  config.pricing.cash.weight = 0

  const base = makeMerchantState(config.merchants.ferro)
  const richMerchant = makeMerchantState(config.merchants.ferro, {
    cash: 100000,
    stock: { ...base.stock, iron_ore: 100 },
  })
  const player = makePlayer({ cash: 1000, inventory: { iron_ore: 100 } })
  const unitPrice = quote(
    richMerchant,
    'iron_ore',
    'sell',
    1,
    makeMarket([richMerchant], player),
    config,
  ).unitPrice
  const { quantity, cash } = cashThatNaivelyOvershoots(unitPrice)
  const merchant = makeMerchantState(config.merchants.ferro, {
    cash: config.merchants.ferro.reserve + cash,
    stock: { ...base.stock, iron_ore: 100 },
  })
  const result = quote(
    merchant,
    'iron_ore',
    'sell',
    100,
    makeMarket([merchant], player),
    config,
  )

  assert.ok(result.fillQuantity < quantity)
  assert.ok(result.total <= cash + 1e-9)
  assert.equal(result.constraints.maxByMerchantCash, result.fillQuantity)
  assert.equal(
    result.total,
    Math.ceil(result.fillQuantity * result.unitPrice),
  )
})

test('market event schema carries before/after values and an explanation', () => {
  const event = createMarketEvent(makeEventInput())

  assert.match(event.id, /^evt_[0-9a-f]{16}$/)
  assert.equal(event.item, 'iron_ore')
  assert.equal(event.actor.type, 'player')
  assert.deepEqual(event.before, { stock: 30, cash: 200, bid: 5.5, ask: 7.2 })
  assert.deepEqual(event.after, { stock: 32, cash: 189.5, bid: 5.1, ask: 7.1 })
  assert.equal(event.cause, 'trade')
  assert.equal(event.causeId, 'trade-1')
  assert.ok(event.message.length > 0)
  assert.equal(event.reasons[0].label, 'Excess stock')
})

test('event ids are deterministic, strong and distinguish reasons/message', () => {
  const first = createMarketEvent(makeEventInput())
  const same = createMarketEvent(makeEventInput())
  const differentReason = createMarketEvent(
    makeEventInput({
      reasons: [
        {
          code: 'cash',
          label: 'Cash pressure',
          value: 0.5,
          effect: -0.2,
        },
      ],
    }),
  )
  const differentMessage = createMarketEvent(
    makeEventInput({ message: 'A different explanation' }),
  )

  assert.equal(first.id, same.id)
  assert.match(first.id, /^evt_[0-9a-f]{16}$/)
  assert.notEqual(first.id, differentReason.id)
  assert.notEqual(first.id, differentMessage.id)

  const ids = new Set(
    Array.from({ length: 100 }, (_, index) =>
      createMarketEvent(makeEventInput({ time: index })).id,
    ),
  )
  assert.equal(ids.size, 100)
})

test('event creation rejects missing snapshot fields instead of zero-filling', () => {
  const missingBefore = {
    ...makeEventInput(),
    before: { stock: 1, cash: 2, bid: 3 } as never,
  }
  const missingAfter = {
    ...makeEventInput(),
    after: undefined as never,
  }

  assert.throws(
    () => createMarketEvent(missingBefore),
    /before\.ask is required; use null/,
  )
  assert.throws(
    () => createMarketEvent(missingAfter),
    /after snapshot is required/,
  )

  const explicitNull = createMarketEvent(
    makeEventInput({
      before: { stock: null, cash: null, bid: null, ask: null },
    }),
  )
  assert.equal(explicitNull.before.stock, null)
})

test('all configured merchants produce finite, positive quotes for their lists', () => {
  const states = Object.values(economy.merchants).map(merchant =>
    makeMerchantState(merchant),
  )
  const market = makeMarket(states)

  for (const merchantConfig of Object.values(economy.merchants)) {
    const merchant = market.merchants[merchantConfig.id]
    for (const itemId of merchantConfig.sells) {
      const result = quote(merchant, itemId, 'buy', 1, market, economy)
      assert.ok(Number.isFinite(result.unitPrice), `${merchantConfig.id} ${itemId} ask is finite`)
      assert.ok(result.unitPrice > 0, `${merchantConfig.id} ${itemId} ask is positive`)
      assert.equal(result.canTrade, true, `${merchantConfig.id} should sell ${itemId}`)
      assert.ok(
        Math.abs(
          result.reasons.reduce((sum, reason) => sum + reason.effect, 0) -
            (result.unitPrice - result.basePrice),
        ) < 0.000001,
      )
    }
    for (const itemId of merchantConfig.buys) {
      const result = quote(merchant, itemId, 'sell', 1, market, economy)
      assert.ok(Number.isFinite(result.unitPrice), `${merchantConfig.id} ${itemId} bid is finite`)
      assert.ok(result.unitPrice > 0, `${merchantConfig.id} ${itemId} bid is positive`)
      assert.equal(result.canTrade, true, `${merchantConfig.id} should buy ${itemId}`)
    }
  }
})

test('config exposes the required merchant and item breadth', () => {
  const config: EconomyConfig = economy
  assert.ok(Object.keys(config.items).length >= 11)
  assert.ok(Object.keys(config.merchants).length >= 6)
  assert.ok(Object.values(config.merchants).every(merchant => merchant.stallSlot > 0))
  assert.ok(Object.values(config.items).every(item => item.token.standard === 'nep-245'))
})
