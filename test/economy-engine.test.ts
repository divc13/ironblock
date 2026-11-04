import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import { EconomyEngine } from '../src/shared/economy'
import type { EconomyWorldState, TradeActionData } from '../src/shared/economy'
import { quote } from '../src/shared/pricing'
import type { EconomyConfig, MerchantConfig } from '../src/shared/types'

const cloneConfig = (): EconomyConfig => structuredClone(economy)

const quietConfig = (): EconomyConfig => {
  const config = cloneConfig()
  config.bots.count = 0
  config.caravan.intervalSeconds = 365 * 86400
  config.scenario = {
    id: 'test-quiet',
    description: 'Isolated test economy without demo story beats.',
    shocks: [],
  }
  return config
}

const merchantWithBuy = (config: EconomyConfig): MerchantConfig =>
  Object.values(config.merchants).find(merchant => merchant.buys.length > 0) as MerchantConfig

const merchantWithSell = (config: EconomyConfig): MerchantConfig =>
  Object.values(config.merchants).find(merchant => merchant.sells.length > 0) as MerchantConfig

const makeEngine = (
  config: EconomyConfig = cloneConfig(),
  mutate?: (state: EconomyWorldState) => void,
): EconomyEngine => {
  const engine = new EconomyEngine(config)
  const player = engine.createPlayer('player-1', 'Ada')
  assert.equal(player.success, true)
  if (!mutate) return engine
  const state = engine.snapshot()
  mutate(state)
  return new EconomyEngine(config, { state })
}

const findTrade = (
  engine: EconomyEngine,
  side: 'buy' | 'sell',
  playerId = 'player-1',
): { merchantId: string; itemId: string; quantity: number } => {
  const state = engine.snapshot()
  const config = engine.config
  for (const merchant of Object.values(state.merchants)) {
    const merchantConfig = config.merchants[merchant.id]
    const items = side === 'buy' ? merchantConfig.sells : merchantConfig.buys
    for (const itemId of items) {
      const preview = engine.preview(playerId, merchant.id, itemId, side, 1)
      if (preview?.canTrade) return { merchantId: merchant.id, itemId, quantity: 1 }
    }
  }
  throw new Error(`no ${side} trade available`)
}

test('initial state is config-driven and includes every economic subsystem', () => {
  const config = cloneConfig()
  const template = Object.values(config.merchants)[0]
  config.merchants.extra_stall = {
    ...structuredClone(template),
    id: 'extra_stall',
    displayName: 'Extra Stall',
    stallSlot: 99,
    cash: 1000,
    reserve: 100,
  }

  const engine = new EconomyEngine(config)
  const state = engine.snapshot()

  assert.equal(Object.keys(state.merchants).length, Object.keys(config.merchants).length)
  assert.ok(state.merchants.extra_stall)
  assert.equal(state.bots.length, config.bots.count)
  assert.deepEqual(
    Object.keys(state.resources).sort(),
    Object.keys(config.resources.nodes).sort(),
  )
  assert.equal(state.time, 0)
  assert.equal(state.day, 1)
  assert.ok(state.sequence > 0, 'initial configuration event should be recorded')
  assert.ok(state.orders.length > 0)
  assert.ok(state.orders.length <= config.orders.maxActive)
  assert.equal(state.stats.bankruptcies, 0)
  assert.equal(state.summaries.length, 0)
  for (const merchant of Object.values(state.merchants)) {
    assert.equal(merchant.open, true)
    assert.equal(merchant.bankrupt, false)
    assert.ok(merchant.cash > merchant.reserve)
    assert.ok(state.orders.every(order => config.items[order.itemId]))
  }
})

test('buy and sell conserve cash and inventory when tax is disabled', () => {
  const config = quietConfig()
  config.sinks.salesTax.rate = 0
  config.caravan.intervalSeconds = 365 * 86400
  const engine = makeEngine(config, state => {
    state.players['player-1'].cash = 5000
    state.players['player-1'].inventory = {}
  })
  const { merchantId, itemId } = findTrade(engine, 'buy')
  const before = engine.snapshot()
  const result = engine.buy('player-1', merchantId, itemId, 2)

  assert.equal(result.success, true)
  const data = result.data as TradeActionData
  assert.equal(result.events.length >= 1, true)
  assert.ok(data.filled > 0)
  const after = engine.snapshot()
  const playerBefore = before.players['player-1']
  const playerAfter = after.players['player-1']
  const merchantBefore = before.merchants[merchantId]
  const merchantAfter = after.merchants[merchantId]

  assert.equal(
    (playerAfter.inventory[itemId] ?? 0) - (playerBefore.inventory[itemId] ?? 0),
    data.filled,
  )
  assert.equal(merchantBefore.stock[itemId] - merchantAfter.stock[itemId], data.filled)
  const totalCash = (state: EconomyWorldState): number =>
    state.players['player-1'].cash +
    Object.values(state.merchants).reduce((sum, merchant) => sum + merchant.cash, 0)
  assert.equal(totalCash(before), totalCash(after))

  const buyer = Object.values(after.merchants).find(merchant => {
    const config = engine.config.merchants[merchant.id]
    return config.buys.includes(itemId) && merchant.open
  })
  assert.ok(buyer)
  const sell = engine.sell('player-1', buyer.id, itemId, data.filled)
  assert.equal(sell.success, true, sell.error?.message)
  const sold = sell.data as TradeActionData
  const final = engine.snapshot()
  assert.equal(totalCash(after), totalCash(final))
  assert.ok(sold.filled > 0)
})

test('trade actions enforce stock, cash, reserve, carry and trade-size fill limits', () => {
  const config = quietConfig()
  config.player.carryCapacity = 5
  const engine = makeEngine(config, state => {
    state.players['player-1'].cash = 100000
    state.players['player-1'].inventory = { [Object.keys(config.items)[0]]: 0 }
    const merchant = Object.values(state.merchants)[0]
    merchant.cash = merchant.reserve + 100
    merchant.stock[Object.keys(merchant.stock)[0]] = 1000
  })
  const merchant = Object.values(engine.snapshot().merchants).find(
    candidate => candidate.cash === candidate.reserve + 100,
  )
  assert.ok(merchant)
  const merchantConfig = config.merchants[merchant.id]

  const sellItem = merchantConfig.buys[0]
  const sellState = engine.snapshot()
  sellState.players['player-1'].inventory[sellItem] = 100
  const sellEngine = new EconomyEngine(config, { state: sellState })
  const sellPreview = sellEngine.preview('player-1', merchant.id, sellItem, 'sell', 100)
  assert.ok(sellPreview)
  assert.ok((sellPreview.constraints.maxByMerchantCash ?? 0) > 0)
  assert.equal(sellPreview.fillQuantity, sellPreview.constraints.maxByMerchantCash)
  const sell = sellEngine.sell('player-1', merchant.id, sellItem, 100)
  assert.equal(sell.success, true)
  const afterSell = sellEngine.snapshot()
  assert.ok(afterSell.merchants[merchant.id].cash >= afterSell.merchants[merchant.id].reserve)
  assert.ok((sell.data as TradeActionData).filled <= 100)

  const buyItem = merchantConfig.sells[0]
  const item = config.items[buyItem]
  const buyState = engine.snapshot()
  buyState.players['player-1'].inventory = { [buyItem]: 0 }
  const buyEngine = new EconomyEngine(config, { state: buyState })
  const limit = Math.max(1, Math.floor(config.player.carryCapacity / item.weight))
  const preview = buyEngine.preview('player-1', merchant.id, buyItem, 'buy', 100)
  assert.ok(preview)
  assert.ok((preview.constraints.maxByCarry ?? 0) <= limit)
  const buy = buyEngine.buy('player-1', merchant.id, buyItem, 100)
  assert.equal(buy.success, true)
  const bought = buy.data as TradeActionData
  assert.ok(bought.filled <= config.pricing.trade.maxQuantityPerTrade)
  assert.ok(bought.filled <= limit)
  assert.equal(bought.partial, bought.filled < bought.requested)
})

test('flooding stock lowers bids and low stock raises asks through engine actions', () => {
  const config = quietConfig()
  const merchantConfig = merchantWithBuy(config)
  const itemId = merchantConfig.buys[0]
  const engine = makeEngine(config, state => {
    state.players['player-1'].cash = 100000
    state.players['player-1'].inventory[itemId] = 500
    state.merchants[merchantConfig.id].cash = 100000
  })
  const before = engine.preview('player-1', merchantConfig.id, itemId, 'sell', 1)
  assert.ok(before)
  const sell = engine.sell('player-1', merchantConfig.id, itemId, 50)
  assert.equal(sell.success, true)
  const after = engine.preview('player-1', merchantConfig.id, itemId, 'sell', 1)
  assert.ok(after)
  assert.ok(after.unitPrice < before.unitPrice)
  assert.equal(after.reasons.find(reason => reason.code === 'stock')?.label, 'Excess stock')

  const seller = merchantWithSell(config)
  const sellItem = seller.sells.find(item => seller.targetStock[item] > 2) ?? seller.sells[0]
  const lowEngine = makeEngine(config, state => {
    state.players['player-1'].cash = 100000
    state.players['player-1'].inventory = {}
  })
  const lowBefore = lowEngine.preview('player-1', seller.id, sellItem, 'buy', 1)
  assert.ok(lowBefore)
  const lowBuy = lowEngine.buy('player-1', seller.id, sellItem, 100)
  assert.equal(lowBuy.success, true)
  const lowAfter = lowEngine.preview('player-1', seller.id, sellItem, 'buy', 1)
  assert.ok(lowAfter)
  assert.ok(lowAfter.unitPrice > lowBefore.unitPrice)
  assert.equal(lowAfter.reasons.find(reason => reason.code === 'stock')?.label, 'Low stock')
})

test('demand EMA updates on purchases and decays with simulated time', () => {
  const config = quietConfig()
  const engine = makeEngine(config, state => {
    state.players['player-1'].cash = 100000
    state.players['player-1'].inventory = {}
  })
  const { merchantId, itemId } = findTrade(engine, 'buy')
  const bought = engine.buy('player-1', merchantId, itemId, 2)
  assert.equal(bought.success, true)
  const afterBuy = engine.snapshot()
  const ema = afterBuy.merchants[merchantId].demandEma[itemId]
  assert.ok(ema > 0)

  const tick = engine.tick(config.pricing.demand.windowSeconds)
  assert.equal(tick.success, true)
  const afterTick = engine.snapshot()
  assert.ok(afterTick.merchants[merchantId].demandEma[itemId] < ema)
})

test('cash pressure changes quotes through the engine snapshot', () => {
  const config = quietConfig()
  const merchantConfig = merchantWithSell(config)
  const itemId = merchantConfig.sells[0]
  const base = makeEngine(config)
  const thinState = base.snapshot()
  thinState.merchants[merchantConfig.id].cash = thinState.merchants[merchantConfig.id].reserve + 1
  const comfortableState = base.snapshot()
  comfortableState.merchants[merchantConfig.id].cash =
    comfortableState.merchants[merchantConfig.id].reserve *
    (1 + config.pricing.cash.comfortMultiple)

  const thin = new EconomyEngine(config, { state: thinState })
  const comfortable = new EconomyEngine(config, { state: comfortableState })
  const thinQuote = thin.preview('player-1', merchantConfig.id, itemId, 'buy', 1)
  const comfortableQuote = comfortable.preview('player-1', merchantConfig.id, itemId, 'buy', 1)
  assert.ok(thinQuote && comfortableQuote)
  assert.ok(thinQuote.unitPrice > comfortableQuote.unitPrice)
  assert.ok(
    (thinQuote.reasons.find(reason => reason.code === 'cash')?.value ?? 0) >
      (comfortableQuote.reasons.find(reason => reason.code === 'cash')?.value ?? 0),
  )
})

test('bankruptcy closes a merchant and an investment reopens it with a receipt', () => {
  const config = quietConfig()
  config.fastForward.stepSeconds = 3600
  const engine = makeEngine(config, state => {
    const merchant = Object.values(state.merchants)[0]
    merchant.cash = merchant.reserve + 1
    state.players['player-1'].cash = 500
  })
  const merchantId = Object.values(engine.snapshot().merchants)[0].id
  const tick = engine.tick(2 * 86400)
  assert.equal(tick.success, true)
  const bankruptState = engine.snapshot()
  const bankrupt = bankruptState.merchants[merchantId]
  assert.equal(bankrupt.open, false)
  assert.equal(bankrupt.bankrupt, true)
  assert.ok(bankruptState.stats.bankruptcies >= 1)

  const cashBefore = bankruptState.players['player-1'].cash
  const invest = engine.invest('player-1', merchantId, 100)
  assert.equal(invest.success, true)
  const after = engine.snapshot()
  assert.equal(after.merchants[merchantId].open, true)
  assert.equal(after.merchants[merchantId].bankrupt, false)
  assert.equal(after.players['player-1'].cash, cashBefore - 100)
  assert.ok(after.merchants[merchantId].cash > after.merchants[merchantId].reserve)
  assert.equal(after.investments.length, 1)
  assert.equal(after.investments[0].merchantId, merchantId)
  assert.ok(after.investments[0].receipt.includes('reopened'))
  assert.ok(invest.events.some(event => event.type === 'merchant.investment'))
  assert.ok(invest.events.some(event => event.type === 'merchant.reopen'))
})

test('investment distributions pay a configured share of positive daily profit', () => {
  const config = quietConfig()
  config.fastForward.stepSeconds = 3600
  const engine = makeEngine(config, state => {
    const merchant = Object.values(state.merchants)[0]
    merchant.cash = merchant.reserve + 1
    state.players['player-1'].cash = 5000
  })
  const merchantId = Object.values(engine.snapshot().merchants)[0].id
  assert.equal(engine.tick(2 * 86400).success, true)
  assert.equal(engine.snapshot().merchants[merchantId].bankrupt, true)
  assert.equal(engine.invest('player-1', merchantId, 100).success, true)

  const itemId = config.merchants[merchantId].sells[0]
  const buy = engine.buy('player-1', merchantId, itemId, 10)
  assert.equal(buy.success, true, buy.error?.message)
  assert.ok(((buy.data as TradeActionData).filled ?? 0) > 0)
  const cashAfterBuy = engine.snapshot().players['player-1'].cash

  const tick = engine.tick(86400)
  assert.equal(tick.success, true)
  const after = engine.snapshot()
  assert.ok(after.investments[0].totalDistributed > 0)
  assert.ok(after.investments[0].distributions.length > 0)
  assert.ok(after.stats.investmentDistributions > 0)
  assert.ok(after.players['player-1'].cash > cashAfterBuy)
  assert.ok(tick.events.some(event => event.type === 'merchant.distribution'))
})

test('recipes, resource respawn, tool wear, repair and supply chains run from config', () => {
  const config = quietConfig()
  const toolId = config.player.startingTool
  const tool = config.items[toolId]
  assert.ok(tool?.tool)
  const resource = Object.values(config.resources.nodes).find(
    node => node.requiredTool === tool.tool?.kind,
  )
  assert.ok(resource)
  const recipe = Object.values(config.recipes).find(recipe => recipe.inputs[resource.itemId])
  assert.ok(recipe)
  const engine = makeEngine(config)
  const needed = recipe.inputs[resource.itemId]

  for (let guard = 0; guard < 20 && (engine.snapshot().players['player-1'].inventory[resource.itemId] ?? 0) < needed; guard += 1) {
    const gather = engine.gather('player-1', resource.id)
    assert.equal(gather.success, true, gather.error?.message)
    if (engine.snapshot().resources[resource.id].available === 0) {
      const respawn = engine.tick(resource.respawnSeconds + 1)
      assert.equal(respawn.success, true)
    }
  }

  const beforeCraft = engine.snapshot()
  const durabilityBefore = beforeCraft.players['player-1'].toolDurability?.[toolId] ?? 0
  assert.ok(durabilityBefore < tool.tool.maxDurability)
  const craft = engine.craft('player-1', recipe.id, 1)
  assert.equal(craft.success, true, craft.error?.message)
  const afterCraft = engine.snapshot()
  for (const [itemId, amount] of Object.entries(recipe.outputs)) {
    assert.ok((afterCraft.players['player-1'].inventory[itemId] ?? 0) >= amount)
  }

  const repair = engine.repair('player-1')
  assert.equal(repair.success, true, repair.error?.message)
  const afterRepair = engine.snapshot()
  assert.equal(
    afterRepair.players['player-1'].toolDurability?.[toolId],
    tool.tool.maxDurability,
  )
  assert.ok(afterRepair.stats.sinks.repairs > 0)
  assert.ok(afterRepair.players['player-1'].cash < beforeCraft.players['player-1'].cash)

  const supplyMerchant = Object.values(config.merchants).find(merchant => merchant.supplyChain)
  assert.ok(supplyMerchant)
  const outputId = Object.keys(supplyMerchant.supplyChain?.outputs ?? {})[0]
  const supplyEngine = makeEngine(config)
  const outputBefore = supplyEngine.snapshot().merchants[supplyMerchant.id].stock[outputId] ?? 0
  const restock = supplyEngine.tick(supplyMerchant.restockRate.intervalSeconds + 1)
  assert.equal(restock.success, true)
  const outputAfter = supplyEngine.snapshot().merchants[supplyMerchant.id].stock[outputId] ?? 0
  assert.ok(outputAfter > outputBefore)
  assert.ok(restock.events.some(event => event.type === 'merchant.restock'))
})

test('resource depletion schedules a deterministic respawn', () => {
  const config = quietConfig()
  const resource = Object.values(config.resources.nodes)[0]
  const engine = makeEngine(config)
  for (let index = 0; index < resource.nodeCount; index += 1) {
    const gather = engine.gather('player-1', resource.id)
    assert.equal(gather.success, true, gather.error?.message)
  }
  const depleted = engine.snapshot()
  assert.equal(depleted.resources[resource.id].available, 0)
  assert.ok(depleted.resources[resource.id].nextRespawnAt !== null)
  const respawn = engine.tick(resource.respawnSeconds + 1)
  assert.equal(respawn.success, true)
  const after = engine.snapshot()
  assert.ok(after.resources[resource.id].available > 0)
})

test('bots and caravans trade deterministically and leave events', () => {
  const config = cloneConfig()
  config.bots.count = 3
  config.bots.behavior.cadenceSeconds = 10
  config.bots.behavior.jitterSeconds = 0
  config.caravan.intervalSeconds = 300
  const engine = makeEngine(config)
  const before = engine.snapshot()
  const tick = engine.tick(900)
  assert.equal(tick.success, true)
  const after = engine.snapshot()
  assert.ok(after.stats.botTrades > 0)
  assert.ok(after.stats.caravanArrivals > 0)
  assert.ok(after.stats.botGathers >= 0)
  assert.ok(tick.events.some(event => event.type === 'bot.trade'))
  assert.ok(tick.events.some(event => event.type === 'caravan.arrival'))
  assert.ok(after.sequence > before.sequence)

  const twin = makeEngine(config)
  const twinTick = twin.tick(900)
  assert.equal(twinTick.success, true)
  assert.deepEqual(twin.snapshot(), after)
})

test('daily summaries capture cash, movers, bankruptcies, caravan and sinks', () => {
  const config = quietConfig()
  config.fastForward.stepSeconds = 3600
  const engine = makeEngine(config)
  const tick = engine.tick(86400)
  assert.equal(tick.success, true)
  const state = engine.snapshot()
  assert.equal(state.summaries.length, 1)
  const summary = state.summaries[0]
  assert.equal(summary.day, 1)
  assert.ok(summary.totalMerchantCash > 0)
  assert.ok(summary.totalPlayerCash > 0)
  assert.ok(summary.trades.volume >= 0)
  assert.ok(typeof summary.sinks.total === 'number')
  assert.ok(Array.isArray(summary.topMovers))
  assert.ok(summary.topMovers.length <= config.reporting.topMovers)
  if (summary.topMovers.length > 0) {
    assert.ok(summary.topMovers.every(mover => config.items[mover.itemId]))
  }
})

test('order board supports accept and partial/full fulfillment', () => {
  const config = quietConfig()
  const engine = makeEngine(config)
  const order = engine.snapshot().orders.find(candidate => candidate.status === 'open')
  assert.ok(order)
  const state = engine.snapshot()
  state.players['player-1'].inventory[order.itemId] = order.quantity
  const working = new EconomyEngine(config, { state })

  const accepted = working.acceptOrder('player-1', order.id)
  assert.equal(accepted.success, true)
  assert.equal(working.snapshot().orders.find(candidate => candidate.id === order.id)?.status, 'accepted')

  const cashBefore = working.snapshot().players['player-1'].cash
  const partial = working.fulfillOrder('player-1', order.id, 1)
  assert.equal(partial.success, true)
  const afterPartial = working.snapshot()
  assert.equal(afterPartial.players['player-1'].cash, cashBefore + order.unitReward)
  const remaining = afterPartial.orders.find(candidate => candidate.id === order.id)
  assert.ok(remaining)
  assert.equal(remaining.remaining, order.quantity - 1)

  const final = working.fulfillOrder('player-1', order.id)
  assert.equal(final.success, true)
  const completed = working.snapshot()
  const done = completed.orders.find(candidate => candidate.id === order.id)
  assert.ok(done)
  assert.equal(done.status, 'fulfilled')
  assert.equal(done.remaining, 0)
  assert.equal(completed.stats.ordersFulfilled, order.quantity)
  assert.ok(completed.stats.orderPayouts > 0)
})

test('events carry sequence, actor, before/after values and reasons', () => {
  const config = quietConfig()
  const engine = makeEngine(config, state => {
    state.players['player-1'].cash = 5000
  })
  const { merchantId, itemId } = findTrade(engine, 'buy')
  const result = engine.buy('player-1', merchantId, itemId, 1)
  assert.equal(result.success, true)
  const event = result.events.find(candidate => candidate.type === 'trade.buy')
  assert.ok(event)
  assert.ok(event.sequence > 0)
  assert.equal(event.actor.type, 'player')
  assert.equal(event.actor.id, 'player-1')
  assert.equal(event.item, itemId)
  assert.ok(event.quantity && event.quantity > 0)
  assert.ok(typeof event.price === 'number')
  assert.equal(typeof event.before.stock, 'number')
  assert.equal(typeof event.after.stock, 'number')
  assert.notEqual(event.before.stock, event.after.stock)
  assert.equal(typeof event.before.cash, 'number')
  assert.equal(typeof event.after.cash, 'number')
  assert.ok(event.reasons.length > 0)
  assert.equal(event.cause, 'trade')
  assert.ok(event.causeId.length > 0)
  assert.ok(event.message.length > 0)

  const sincePrevious = engine.eventsSince(event.sequence - 1)
  assert.ok(sincePrevious.some(candidate => candidate.sequence === event.sequence))
  const sinceEvent = engine.eventsSince(event.sequence)
  assert.equal(sinceEvent.some(candidate => candidate.sequence === event.sequence), false)
  const sequences = engine.eventsSince(0).map(candidate => candidate.sequence)
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right))
})

test('seven-day fast-forward is deterministic, fast and returns a compact series', () => {
  const config = cloneConfig()
  const first = makeEngine(config)
  const second = makeEngine(config)
  const firstRun = first.fastForward(config.fastForward.days)
  const secondRun = second.fastForward(config.fastForward.days)

  assert.equal(firstRun.success, true)
  assert.equal(secondRun.success, true)
  assert.equal(firstRun.steps, (config.fastForward.days * 86400) / config.fastForward.stepSeconds)
  assert.ok(firstRun.summaries.length >= config.fastForward.days)
  assert.ok(firstRun.series.length === firstRun.summaries.length)
  assert.ok(firstRun.durationMs < 10000, `fast-forward took ${firstRun.durationMs}ms`)
  assert.deepEqual(firstRun.series, secondRun.series)
  assert.deepEqual(firstRun.summaries, secondRun.summaries)
  assert.equal(firstRun.finalSequence, secondRun.finalSequence)
  assert.deepEqual(first.snapshot(), second.snapshot())
  assert.ok(firstRun.events.some(event => event.type === 'system.fast-forward'))
  assert.ok(firstRun.events.length <= config.reporting.eventSampleSize)
})

test('snapshot and spectator snapshot are serializable and stable', () => {
  const config = quietConfig()
  const engine = makeEngine(config)
  const snapshot = engine.snapshot()
  const spectator = engine.spectatorSnapshot()
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
  assert.deepEqual(JSON.parse(JSON.stringify(spectator)), spectator)
  assert.equal(spectator.merchants.length, Object.keys(config.merchants).length)
  assert.equal(spectator.players['player-1'].id, 'player-1')
  assert.ok(spectator.recentEvents.length > 0)
  assert.equal(spectator.firstRetainedSequence, spectator.recentEvents[0].sequence)
})

test('invalid actions are rejected without mutating state', () => {
  const config = quietConfig()
  const engine = makeEngine(config)
  const before = engine.snapshot()
  const itemId = Object.keys(config.items)[0]
  const merchantId = Object.keys(config.merchants)[0]
  const orderId = engine.snapshot().orders[0].id

  const actions = [
    engine.buy('missing-player', merchantId, itemId, 1),
    engine.buy('player-1', 'missing-merchant', itemId, 1),
    engine.buy('player-1', merchantId, 'missing-item', 1),
    engine.buy('player-1', merchantId, itemId, 0),
    engine.buy('player-1', merchantId, itemId, -2),
    engine.buy('player-1', merchantId, itemId, 1.5),
    engine.sell('player-1', merchantId, itemId, 999),
    engine.craft('player-1', 'missing-recipe', 1),
    engine.gather('player-1', 'missing-resource'),
    engine.eat('player-1', itemId),
    engine.repair('player-1'),
    engine.invest('player-1', merchantId, 10),
    engine.fulfillOrder('player-1', orderId),
    engine.acceptOrder('player-1', 'missing-order'),
    engine.tick(1e-9),
  ]

  for (const result of actions) {
    assert.equal(result.success, false)
    assert.ok(result.error)
    assert.equal(result.events.length, 0)
    assert.equal(result.sequence, before.sequence)
  }
  assert.deepEqual(engine.snapshot(), before)
})

test('a rejected gather does not consume randomness, stamina or tool wear', () => {
  const config = quietConfig()
  const startingTool = config.items[config.player.startingTool]
  const resource = Object.entries(config.resources.nodes).find(
    ([, node]) => node.requiredTool && node.requiredTool === startingTool?.tool?.kind,
  )
  assert.ok(resource, 'config needs a gatherable resource for the starting tool')
  const [resourceId] = resource
  const fillItem = Object.values(config.items).find(item => item.weight > 0)
  assert.ok(fillItem)

  const engine = makeEngine(config, state => {
    state.players['player-1'].inventory = {
      [fillItem.id]: Math.ceil(config.player.carryCapacity / fillItem.weight),
    }
  })
  const before = engine.snapshot()
  const result = engine.gather('player-1', resourceId)

  assert.equal(result.success, false)
  assert.equal(result.error?.code, 'carry_capacity_exceeded')
  assert.equal(result.events.length, 0)
  assert.equal(result.sequence, before.sequence)
  assert.deepEqual(engine.snapshot(), before)
})

test('quote preview uses the same reserves and player constraints as actions', () => {
  const config = quietConfig()
  const engine = makeEngine(config)
  const { merchantId, itemId } = findTrade(engine, 'buy')
  const preview = engine.preview('player-1', merchantId, itemId, 'buy', 100)
  assert.ok(preview)
  const state = engine.snapshot()
  const merchant = state.merchants[merchantId]
  const direct = quote(
    merchant,
    itemId,
    'buy',
    100,
    {
      time: state.time,
      day: state.day,
      seed: state.seed,
      merchants: state.merchants,
      player: state.players['player-1'],
    },
    config,
  )
  assert.deepEqual(preview, direct)
})
