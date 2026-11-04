import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import { createMarketEvent } from '../src/shared/market-events'
import {
  isMerchantBankrupt,
  quote,
} from '../src/shared/pricing'
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

test('market event schema carries before/after values and an explanation', () => {
  const event = createMarketEvent({
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
  })

  assert.ok(event.id.startsWith('evt_'))
  assert.equal(event.item, 'iron_ore')
  assert.equal(event.actor.type, 'player')
  assert.deepEqual(event.before, { stock: 30, cash: 200, bid: 5.5, ask: 7.2 })
  assert.deepEqual(event.after, { stock: 32, cash: 189.5, bid: 5.1, ask: 7.1 })
  assert.equal(event.cause, 'trade')
  assert.equal(event.causeId, 'trade-1')
  assert.ok(event.message.length > 0)
  assert.equal(event.reasons[0].label, 'Excess stock')
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
