import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PriceReason, Quote } from '../src/shared/types'
import {
  blockedReasonLabel,
  describeEvent,
  eventTypeLabel,
  explainQuote,
  formatDayClock,
  formatMoney,
  formatWeight,
  percentOf,
  signedEffect,
  signedPercent,
  summarizeReasons,
  townHealthLabel,
} from '../src/ui/format'

const reason = (
  code: string,
  label: string,
  value: number,
  effect: number,
  detail?: string,
): PriceReason => ({ code, label, value, effect, detail })

const quote = (overrides: Partial<Quote> = {}): Quote => ({
  merchantId: 'ferro',
  itemId: 'iron_ore',
  side: 'buy',
  quantity: 2,
  basePrice: 10,
  unitPrice: 12,
  total: 24,
  currencySymbol: 'IB',
  reasons: [reason('base', 'Base value', 10, 10)],
  canTrade: true,
  fillQuantity: 2,
  maxQuantity: 7,
  partialFill: false,
  merchantOpen: true,
  merchantBankrupt: false,
  constraints: {
    stock: 20,
    merchantCash: 500,
    merchantReserve: 80,
    playerCash: 150,
    playerInventory: null,
    playerCarryFree: 120,
    maxByStock: 20,
    maxByMerchantCash: null,
    maxByPlayerCash: 12,
    maxByPlayerInventory: null,
    maxByCarry: 10,
    maxByTradeLimit: 7,
    maxFill: 7,
  },
  ...overrides,
})

test('money, weight and clock formatting stays tabular and signed', () => {
  assert.equal(formatMoney(1234.5), '1,234.50 IB')
  assert.equal(formatMoney(-3.2, 'IB', 1), '−3.2 IB')
  assert.equal(formatWeight(42.25, 120), '42.25 / 120 kg')
  assert.equal(formatDayClock(3, 9 * 3600 + 5 * 60), 'Day 3 · 09:05')
  assert.equal(signedEffect(0.4), '+0.40 IB')
  assert.equal(signedEffect(-0.4), '−0.40 IB')
  assert.equal(signedEffect(0), '±0.00')
  assert.equal(signedPercent(12.34), '+12.3%')
  assert.equal(signedPercent(-4), '−4.0%')
  assert.equal(townHealthLabel('strained'), 'Strained')
  assert.equal(percentOf(150, 100), 100)
  assert.equal(percentOf(-5, 100), 0)
})

test('reason summaries name the dominant factor and keep signed effects', () => {
  const summary = summarizeReasons([
    reason('base', 'Base value', 10, 10),
    reason('stock', 'Low stock', 0.5, 1.4, 'stock is 50% below target'),
    reason('demand', 'Recent demand', 0.2, 0.35),
  ])

  assert.match(summary.summary, /Low stock/)
  assert.match(summary.summary, /pushing the price up/)
  assert.equal(summary.rows.length, 3)
  assert.equal(summary.rows[1].direction, 'up')
  assert.equal(summary.rows[1].effect, '+1.40 IB')
  assert.ok(summary.totalEffect > 11)
})

test('quotes translate blocked constraints into plain language', () => {
  assert.equal(blockedReasonLabel('out_of_stock'), 'Out of stock.')
  assert.equal(blockedReasonLabel(undefined), 'This trade is unavailable.')

  const ready = quote({ partialFill: true, fillQuantity: 3, quantity: 5 })
  assert.match(explainQuote(ready, 'Iron Ore'), /Only 3 of 5/)

  const blocked = quote({
    canTrade: false,
    fillQuantity: 0,
    total: 0,
    blockedReason: 'out_of_stock',
    constraints: {
      ...quote().constraints,
      maxByStock: 0,
    },
  })
  assert.match(explainQuote(blocked, 'Iron Ore'), /Out of stock/)
  assert.match(explainQuote(blocked, 'Iron Ore'), /stock is empty/)
})

test('event descriptions are readable and tone-coded', () => {
  const event = {
    id: 'evt_1',
    time: 86400 + 9 * 3600,
    type: 'trade.buy' as const,
    actor: { type: 'player' as const, id: 'player', displayName: 'You' },
    item: 'iron_ore',
    quantity: 4,
    price: 12.5,
    before: { stock: 20, cash: 100, bid: 9, ask: 12 },
    after: { stock: 16, cash: 150, bid: 9.5, ask: 12.5 },
    reasons: [reason('stock', 'Low stock', 0.4, 1.2)],
    cause: 'trade' as const,
    causeId: 'trade-1',
    message: 'You bought 4 iron ore.',
  }

  const line = describeEvent(event, 'Iron Ore')
  assert.equal(line.actor, 'You')
  assert.match(line.headline, /bought 4× Iron Ore at 12\.50 IB/)
  assert.match(line.detail, /Low stock \+1\.20 IB/)
  assert.equal(line.tone, 'neutral')

  const bankrupt = describeEvent({
    ...event,
    type: 'merchant.bankrupt',
    actor: { type: 'merchant', id: 'ferro', displayName: 'Ferro' },
  })
  assert.equal(bankrupt.tone, 'bad')
  assert.equal(bankrupt.headline, 'closed below reserve')

  assert.equal(eventTypeLabel('trade.buy'), 'Purchase')
  assert.equal(eventTypeLabel('custom.thing'), 'custom thing')
})
