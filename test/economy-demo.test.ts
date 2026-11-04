import assert from 'node:assert/strict'
import { test } from 'node:test'
import { economy } from '../src/config/economy'
import { validateEconomyConfig } from '../src/shared/config-validation'
import { EconomyEngine } from '../src/shared/economy'
import type { TradeActionData } from '../src/shared/economy'
import type { EconomyConfig } from '../src/shared/types'
import { priceBoundsFor } from '../src/shared/price-bounds'

const demoConfig = (): EconomyConfig => validateEconomyConfig(structuredClone(economy))

const runDemoWeek = (): { config: EconomyConfig; engine: EconomyEngine } => {
  const config = demoConfig()
  const engine = new EconomyEngine(config)
  const player = engine.createPlayer('player-1', 'Demo Player')
  assert.equal(player.success, true)
  const run = engine.fastForward(config.fastForward.days)
  assert.equal(run.success, true, run.error?.message)
  return { config, engine }
}

test('demo seven-day run includes a shock, a bankruptcy, a rescue investment and order deliveries', () => {
  const { config, engine } = runDemoWeek()
  const state = engine.snapshot()
  const events = engine.eventsSince(0)
  const shockIds = new Set(config.scenario.shocks.map(shock => shock.id))
  const shocks = events.filter(event => event.type === 'system.shock')
  const bankruptcies = events.filter(event => event.type === 'merchant.bankrupt')
  const investments = events.filter(event => event.type === 'merchant.investment')
  const reopens = events.filter(event => event.type === 'merchant.reopen')
  const orderDeliveries = events.filter(event => event.type === 'order.fulfilled')

  assert.ok(state.stats.bankruptcies >= 1, 'expected at least one bankruptcy')
  assert.ok(state.stats.investments >= 1, 'expected at least one investment')
  assert.ok(state.stats.investmentAmount > 0)
  assert.ok(state.stats.ordersCreated > 0, 'expected the order board to be active')
  assert.ok(state.stats.ordersFulfilled > 0, 'expected bot order activity')
  assert.ok(state.stats.orderUnits > 0, 'expected delivered order units')

  assert.ok(shocks.length >= 1, 'expected a scenario shock event')
  assert.ok(shocks.every(event => shockIds.has(event.causeId)))
  assert.ok(shocks.every(event => event.cause === 'shock'))
  assert.ok(shocks.every(event => event.message.length > 0))

  assert.ok(bankruptcies.length >= 1)
  assert.ok(investments.length >= 1)
  assert.ok(reopens.length >= 1)
  assert.ok(orderDeliveries.length >= 1)

  const bankruptMerchantIds = new Set(
    bankruptcies.map(event => event.actor.id),
  )
  const investment = state.investments.find(record => record.status === 'active')
  assert.ok(investment)
  assert.ok(
    bankruptMerchantIds.has(investment.merchantId),
    'the rescue investment should target a merchant that went bankrupt',
  )
  assert.ok(investment.receipt.includes('reopened'))
  assert.equal(state.merchants[investment.merchantId].open, true)
  assert.equal(state.merchants[investment.merchantId].bankrupt, false)

  assert.ok(
    state.investments.some(record => record.totalDistributed > 0),
    'reopened merchant should pay a configured profit share during the run',
  )
  assert.ok(
    events.some(
      event =>
        event.type === 'merchant.distribution' &&
        event.cause === 'investment',
    ),
  )
})

test('a player can reopen the remaining closed merchant and receive future profit share', () => {
  const { engine } = runDemoWeek()
  const before = engine.snapshot()
  const closed = Object.values(before.merchants).find(
    merchant => merchant.bankrupt && !merchant.open,
  )
  assert.ok(closed, 'the demo should leave one stall closed for the player')
  const player = before.players['player-1']
  const amount = closed.reserve + 10
  assert.ok(player.cash >= amount, 'demo player needs enough cash for the rescue')

  const invest = engine.invest('player-1', closed.id, amount)
  assert.equal(invest.success, true, invest.error?.message)
  const afterInvest = engine.snapshot()
  assert.equal(afterInvest.merchants[closed.id].open, true)
  assert.equal(afterInvest.merchants[closed.id].bankrupt, false)
  assert.ok(afterInvest.merchants[closed.id].cash > afterInvest.merchants[closed.id].reserve)
  assert.equal(afterInvest.players['player-1'].cash, player.cash - amount)
  assert.ok(invest.events.some(event => event.type === 'merchant.investment'))
  assert.ok(invest.events.some(event => event.type === 'merchant.reopen'))

  const record = afterInvest.investments.find(
    candidate => candidate.playerId === 'player-1' && candidate.merchantId === closed.id,
  )
  assert.ok(record)
  assert.ok(record.receipt.includes('reopened'))

  const cashAfterInvest = afterInvest.players['player-1'].cash
  const tick = engine.tick(86400)
  assert.equal(tick.success, true)
  const final = engine.snapshot()
  const settled = final.investments.find(candidate => candidate.id === record.id)
  assert.ok(settled)
  assert.ok(settled.totalDistributed > 0)
  assert.ok(final.players['player-1'].cash > cashAfterInvest)
})

test('demo run is deterministic across two fresh engines with the same seed', () => {
  const first = runDemoWeek()
  const second = runDemoWeek()
  const firstState = first.engine.snapshot()
  const secondState = second.engine.snapshot()

  assert.deepEqual(first.engine.eventsSince(0), second.engine.eventsSince(0))
  assert.deepEqual(firstState.summaries, secondState.summaries)
  assert.deepEqual(firstState.stats, secondState.stats)
  assert.deepEqual(firstState.investments, secondState.investments)
  assert.deepEqual(firstState.orders, secondState.orders)
  assert.deepEqual(firstState.merchants, secondState.merchants)
  assert.equal(firstState.rngState, secondState.rngState)
  assert.equal(firstState.sequence, secondState.sequence)
})

test('demo has no mass bankruptcy and every quoted price stays inside clamps', () => {
  const { config, engine } = runDemoWeek()
  const state = engine.snapshot()
  const merchants = Object.values(state.merchants)
  const finalClosed = merchants.filter(merchant => !merchant.open)
  assert.ok(
    state.stats.bankruptcies < merchants.length / 2,
    `expected fewer than half the merchants to fail, got ${state.stats.bankruptcies}/${merchants.length}`,
  )
  assert.ok(finalClosed.length < merchants.length / 2)

  for (const merchant of merchants) {
    assert.ok(Number.isFinite(merchant.cash))
    assert.ok(merchant.cash >= 0)
    for (const stock of Object.values(merchant.stock)) {
      assert.ok(Number.isFinite(stock))
      assert.ok(stock >= 0)
    }
  }

  for (const event of engine.eventsSince(0)) {
    if (!event.item) continue
    const item = config.items[event.item]
    if (!item) continue
    const bounds = priceBoundsFor(item, config)
    for (const value of [
      event.before.bid,
      event.before.ask,
      event.after.bid,
      event.after.ask,
    ]) {
      if (value === null) continue
      assert.ok(Number.isFinite(value))
      assert.ok(
        value >= bounds.min - 1e-9 && value <= bounds.max + 1e-9,
        `${event.type} ${event.item} price ${value} outside ${bounds.min}-${bounds.max}`,
      )
    }
  }

  for (const order of state.orders) {
    const item = config.items[order.itemId]
    assert.ok(item)
    const bounds = priceBoundsFor(item, config)
    assert.ok(
      order.unitReward >= bounds.min - 1e-9 && order.unitReward <= bounds.max + 1e-9,
      `order reward ${order.unitReward} outside ${bounds.min}-${bounds.max}`,
    )
  }

  assert.ok(state.stats.botTrades > 0)
})

test('bot order deliveries never touch a player-accepted order', () => {
  const config = demoConfig()
  config.scenario = {
    id: 'test-orders',
    description: 'Order isolation scenario.',
    shocks: [],
  }
  const engine = new EconomyEngine(config)
  assert.equal(engine.createPlayer('player-1', 'Ada').success, true)
  const order = engine.snapshot().orders.find(candidate => candidate.status === 'open')
  assert.ok(order)
  const state = engine.snapshot()
  state.players['player-1'].inventory[order.itemId] = order.quantity
  const working = new EconomyEngine(config, { state })
  assert.equal(working.acceptOrder('player-1', order.id).success, true)
  const accepted = working.snapshot().orders.find(candidate => candidate.id === order.id)
  assert.ok(accepted)
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.acceptedBy, 'player-1')

  assert.equal(working.tick(900).success, true)
  const after = working.snapshot().orders.find(candidate => candidate.id === order.id)
  assert.ok(after)
  assert.equal(after.status, 'accepted')
  assert.equal(after.acceptedBy, 'player-1')
  assert.equal(after.remaining, accepted.remaining)
})

// Keep a tiny direct trade assertion so the demo story cannot hide a broken
// player trade path behind the automated fast-forward.
test('player trades still work after the demo scenario', () => {
  const { config, engine } = runDemoWeek()
  const player = engine.snapshot().players['player-1']
  let trade: { merchantId: string; itemId: string } | null = null
  for (const merchant of Object.values(engine.snapshot().merchants)) {
    for (const itemId of config.merchants[merchant.id].sells) {
      const preview = engine.preview('player-1', merchant.id, itemId, 'buy', 1)
      if (preview?.canTrade) {
        trade = { merchantId: merchant.id, itemId }
        break
      }
    }
    if (trade) break
  }
  assert.ok(trade, 'expected an affordable player trade after the demo run')
  const buy = engine.buy('player-1', trade.merchantId, trade.itemId, 1)
  assert.equal(buy.success, true, buy.error?.message)
  assert.ok(((buy.data as TradeActionData).filled ?? 0) > 0)
  assert.ok(engine.snapshot().players['player-1'].cash <= player.cash)
})
