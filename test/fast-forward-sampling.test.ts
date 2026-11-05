import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FAST_FORWARD_PLAYBACK_MS,
  sampleFastForwardEvents,
} from '../src/shared/economy/fast-forward'

const interval = 10_000
const fromTime = 0
const toTime = interval * 100

const eventAt = (sequence: number, time = (sequence - 1) * interval) => ({
  sequence,
  time,
})

test('fast-forward playback window is the shared four-second reveal', () => {
  assert.equal(FAST_FORWARD_PLAYBACK_MS, 4_000)
})

test('sampling spreads events across the window instead of clustering at the end', () => {
  const events = Array.from({ length: 100 }, (_, index) => eventAt(index + 1))
  const sampled = sampleFastForwardEvents(events, 7, fromTime, toTime)

  assert.equal(sampled.length, 7)
  assert.equal(sampled[sampled.length - 1].sequence, 100)
  assert.deepEqual(
    sampled.map(event => event.sequence),
    [...sampled.map(event => event.sequence)].sort((left, right) => left - right),
  )
  // The naive slice(-7) would put six of the seven samples on the last day.
  assert.ok(
    sampled.filter(event => event.time < toTime * 0.9).length >= 5,
    `sample clustered at the end: ${sampled.map(event => event.time).join(',')}`,
  )
  assert.equal(new Set(sampled.map(event => event.sequence)).size, 7)
})

test('sampling is deterministic even when input order changes', () => {
  const events = Array.from({ length: 40 }, (_, index) => eventAt(index + 1))
  const straight = sampleFastForwardEvents(events, 6, fromTime, toTime)
  const shuffled = sampleFastForwardEvents(
    [...events].reverse(),
    6,
    fromTime,
    toTime,
  )

  assert.deepEqual(straight, shuffled)
})

test('sampling always reserves a slot for the final event', () => {
  const events = [
    eventAt(1, 0),
    eventAt(2, 2_000),
    eventAt(3, 4_000),
    eventAt(4, 900_000),
  ]
  const sampled = sampleFastForwardEvents(events, 2, fromTime, toTime)
  const final = sampled[sampled.length - 1]

  assert.equal(sampled.length, 2)
  assert.equal(final.sequence, 4)
  assert.equal(final.time, 900_000)
})

test('sampling caps and edge limits stay stable', () => {
  const events = [eventAt(1), eventAt(2), eventAt(3)]

  assert.deepEqual(sampleFastForwardEvents(events, 10, fromTime, toTime), events)
  assert.deepEqual(sampleFastForwardEvents(events, 0, fromTime, toTime), [events[2]])
  assert.deepEqual(sampleFastForwardEvents([], 5, fromTime, toTime), [])
  assert.deepEqual(sampleFastForwardEvents(events, 1, fromTime, toTime), [events[2]])
})
