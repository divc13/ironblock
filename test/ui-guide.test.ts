import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compassDirection,
  distanceInPaces,
  guidePercent,
  selectFirstDayGuide,
  type GuideEventLike,
} from '../src/ui/guide'

const soldIngots = (quantity: number): GuideEventLike[] => [
  {
    type: 'trade.sell',
    actor: { type: 'player' },
    item: 'iron_ingot',
    quantity,
  },
]

const base = {
  day: 1,
  cash: 150,
  inventory: [] as Array<{ itemId: string; quantity: number }>,
  events: [] as GuideEventLike[],
}

test('first-day guide advances from gathering to smelting to selling to the week', () => {
  const gather = selectFirstDayGuide(base)
  assert.equal(gather.step.id, 'gather')
  assert.match(gather.step.title, /Gather 6 Iron Ore/)
  assert.deepEqual(gather.step.progress, { current: 0, target: 6, label: '0 / 6 ore' })
  assert.equal(gather.step.target?.kind, 'resource')

  const smelt = selectFirstDayGuide({
    ...base,
    inventory: [{ itemId: 'iron_ore', quantity: 6 }],
  })
  assert.equal(smelt.step.id, 'smelt')
  assert.match(smelt.step.title, /Smelt 3 Iron Ingots/)
  assert.equal(smelt.step.panel, 'bag')

  const sell = selectFirstDayGuide({
    ...base,
    inventory: [{ itemId: 'iron_ingot', quantity: 3 }],
  })
  assert.equal(sell.step.id, 'sell')
  assert.equal(sell.step.panel, 'market')
  assert.equal(sell.step.actionLabel, 'Find a buyer')

  const withBuyer = selectFirstDayGuide({
    ...base,
    inventory: [{ itemId: 'iron_ingot', quantity: 3 }],
    bestIngotBuyer: { merchantId: 'rook', displayName: 'Rook Kestrel', unitPrice: 14.09 },
  })
  assert.equal(withBuyer.step.id, 'sell')
  assert.match(withBuyer.step.title, /Rook Kestrel/)
  assert.deepEqual(withBuyer.step.target, {
    kind: 'merchant',
    id: 'rook',
    label: 'Rook Kestrel',
  })

  const week = selectFirstDayGuide({ ...base, events: soldIngots(3) })
  assert.equal(week.step.id, 'week')
  assert.equal(week.step.progress.target, 7)

  const done = selectFirstDayGuide({ ...base, day: 8, events: soldIngots(3) })
  assert.equal(done.step.id, 'done')
  assert.equal(done.step.completed, true)
})

test('guide progress stays on the selling phase after a partial sale', () => {
  const guide = selectFirstDayGuide({
    ...base,
    inventory: [{ itemId: 'iron_ingot', quantity: 2 }],
    events: soldIngots(1),
  })
  assert.equal(guide.step.id, 'sell')
  assert.deepEqual(guide.step.progress, { current: 1, target: 3, label: '1 / 3 sold' })
  assert.equal(guide.soldIngots, 1)
})

test('partial ingots reduce the ore still needed and keep progress honest', () => {
  const gather = selectFirstDayGuide({
    ...base,
    inventory: [
      { itemId: 'iron_ingot', quantity: 1 },
      { itemId: 'iron_ore', quantity: 1 },
    ],
  })
  assert.equal(gather.step.id, 'gather')
  assert.match(gather.step.title, /Gather 4 Iron Ore/)
  assert.equal(gather.step.progress.current, 1)
  assert.equal(gather.step.progress.target, 4)
  assert.equal(guidePercent(gather.step.progress), 25)
})

test('compass and pace helpers describe the live waypoint plainly', () => {
  assert.equal(compassDirection(0, -10), 'N')
  assert.equal(compassDirection(10, 0), 'E')
  assert.equal(compassDirection(0, 10), 'S')
  assert.equal(compassDirection(-10, 0), 'W')
  assert.equal(compassDirection(10, -10), 'NE')
  assert.equal(compassDirection(0, 0), 'here')
  assert.equal(distanceInPaces(96), 3)
})
