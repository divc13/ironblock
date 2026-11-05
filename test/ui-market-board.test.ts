import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MockEconomyClient } from '../src/client/economy/mock'
import { economy } from '../src/config/economy'
import {
  buildBestPriceIndex,
  buildMarketBoard,
  buildMarketRoutes,
  findBestBuyer,
  loadMarketQuotes,
} from '../src/ui/market-board'

const client = (): MockEconomyClient =>
  new MockEconomyClient({ fastForwardPaceMs: 0 })

test('market board best buy and sell quotes match the merchant quote endpoints', async () => {
  const mock = client()
  const snapshot = await mock.getSnapshot()
  const entries = await loadMarketQuotes(mock, snapshot)
  const rows = buildMarketBoard(entries)
  const index = buildBestPriceIndex(entries)

  assert.ok(rows.length > 0, 'expected tradable rows')
  assert.equal(index.size, rows.length)

  for (const row of rows) {
    const indexed = index.get(row.itemId)
    assert.ok(indexed)

    if (row.bestBuy) {
      const quote = await mock.getQuote(row.bestBuy.merchantId, row.itemId, 'buy', 1)
      assert.equal(row.bestBuy.unitPrice, quote.unitPrice)
      assert.equal(row.bestBuy.quote.unitPrice, quote.unitPrice)
      assert.equal(indexed.buy?.merchantId, row.bestBuy.merchantId)
      assert.equal(indexed.buy?.unitPrice, quote.unitPrice)
    }

    if (row.bestSell) {
      const quote = await mock.getQuote(row.bestSell.merchantId, row.itemId, 'sell', 1)
      assert.equal(row.bestSell.unitPrice, quote.unitPrice)
      assert.equal(row.bestSell.quote.unitPrice, quote.unitPrice)
      assert.equal(indexed.sell?.merchantId, row.bestSell.merchantId)
      assert.equal(indexed.sell?.unitPrice, quote.unitPrice)
    }
  }
})

test('best buyer helper agrees with the market board best sell side', async () => {
  const mock = client()
  const snapshot = await mock.getSnapshot()
  const entries = await loadMarketQuotes(mock, snapshot)
  const row = buildMarketBoard(entries).find(candidate => candidate.itemId === 'iron_ingot')
  const best = await findBestBuyer(mock, snapshot, 'iron_ingot')

  assert.ok(row?.bestSell)
  assert.ok(best)
  assert.equal(best.merchantId, row.bestSell.merchantId)
  assert.equal(best.unitPrice, row.bestSell.unitPrice)
})

test('market board offers at least one profitable gather or craft route on day one', async () => {
  const mock = client()
  const snapshot = await mock.getSnapshot()
  const entries = await loadMarketQuotes(mock, snapshot)
  const rows = buildMarketBoard(entries)
  const routes = buildMarketRoutes(entries, rows, 3)

  assert.ok(routes.length > 0)
  assert.ok(routes.some(route => route.profit > 0), 'expected an obvious profitable route')
  assert.ok(
    routes.some(route => route.kind === 'gather' || route.kind === 'craft'),
    'expected a gather or craft route using live quotes',
  )
  for (const route of routes) {
    assert.ok(route.target.merchantId)
    assert.ok(route.actionLabel.includes(route.target.merchantName))
    assert.ok(route.profitLabel.includes(economy.currency.symbol))
    assert.ok(entries.some(entry => entry.merchantId === route.target.merchantId))
  }
})
