import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calendarDayIndex, weekDayAxis, weekPointLabel } from '../src/spectator/week-time'
import { merchantCashChange } from '../src/spectator/merchant-change'

const DAY = 86_400

test('event buckets use calendar days, not elapsed 24-hour blocks from a mid-day start', () => {
  const startDay = 10
  const fromTime = (startDay - 1) * DAY + 12 * 3_600 // day 10, noon
  const eventTime = (startDay + 1 - 1) * DAY + 30 * 60 // day 11, 00:30
  assert.equal(calendarDayIndex(eventTime, startDay), 2)
  // The old elapsed-time bucket would have called this day 1.
  assert.equal(Math.ceil((eventTime - fromTime) / DAY), 1)
})

test('a mid-day clone end gets a separate Final bucket after the seven closes', () => {
  const startDay = 10
  const lastClose = (startDay + 6) * DAY // end of day 16
  const toTime = (startDay + 7) * DAY + 12 * 3_600 // day 17, noon
  const axis = weekDayAxis(startDay, 7, toTime, lastClose)
  assert.deepEqual(axis.labels, ['Open', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'Final'])
  assert.equal(axis.partialIndex, 8)
  assert.equal(weekPointLabel(startDay, 7, axis.partialIndex), 'Day 16 close')
  assert.equal(weekPointLabel(startDay, 8, axis.partialIndex), 'Final partial day')
})

test('a clone ending exactly on a close has no extra partial bucket', () => {
  const startDay = 10
  const lastClose = (startDay + 7) * DAY
  const axis = weekDayAxis(startDay, 7, lastClose, lastClose)
  assert.equal(axis.labels.length, 8)
  assert.equal(axis.partialIndex, null)
  assert.equal(axis.maxIndex, 7)
})

test('completed preview merchant cards use the preview start, not the live day open', () => {
  const preview = merchantCashChange(6_613, { mode: 'preview', start: 6_000 })
  assert.deepEqual(preview, { delta: 613, label: 'over preview' })
  const live = merchantCashChange(6_613, { mode: 'live', start: 6_000 })
  assert.deepEqual(live, { delta: 613, label: 'today' })
})
