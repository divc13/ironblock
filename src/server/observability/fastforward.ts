import { EconomyEngine } from '../../shared/economy'
import type {
  DaySummary,
  EconomyFastForwardResult,
  SequencedMarketEvent,
} from '../../shared/economy'
import type { EconomyConfig } from '../../shared/types'
import { money as formatMoney } from './format'
import { buildRecap } from './recap'
import {
  buildPlayerAliases,
  publicizeEvents,
  sanitizeSpectatorSnapshot,
  sanitizeSummary,
} from './sanitize'
import type {
  FastForwardAnnotation,
  FastForwardClonePayload,
  FastForwardRequestBody,
  ObservabilitySource,
} from './types'

export interface FastForwardCloneOptions {
  days?: number
}

export type FastForwardCloneResult =
  | FastForwardClonePayload
  | { ok: false; error: string; message: string }

const parseDays = (config: EconomyConfig, body: FastForwardRequestBody | null): {
  days: number | null
  error: string | null
} => {
  if (body === undefined || body === null || Object.keys(body).length === 0) {
    return { days: config.fastForward.days, error: null }
  }
  const raw = (body as FastForwardRequestBody).days
  if (raw === undefined) return { days: config.fastForward.days, error: null }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    return { days: null, error: 'days must be a positive integer' }
  }
  if (raw > config.fastForward.maxDays) {
    return { days: null, error: `days must be at most ${config.fastForward.maxDays}` }
  }
  return { days: raw, error: null }
}

/**
 * Deterministic seven-day (or N-day) simulation on a throwaway clone.
 *
 * The clone is a fresh `EconomyEngine` built from the live world's snapshot,
 * so the live service is never advanced, never reseeded and never persisted to.
 * Determinism follows from the engine: the clone's RNG seed is derived from the
 * clone input state alone, so identical live state + identical `days` produce
 * identical series, events and annotations.
 */
export function runFastForwardClone(
  source: ObservabilitySource,
  options: FastForwardCloneOptions = {},
  now: () => number = Date.now,
): FastForwardCloneResult {
  const config = source.config
  const body = options as FastForwardRequestBody
  const { days, error } = parseDays(config, body)
  if (days === null) {
    return { ok: false, error: 'invalid_days', message: error ?? 'invalid days' }
  }

  const startedAt = now()
  const cloneStartedAt = now()
  const liveBefore = source.snapshot()
  let clone: EconomyEngine
  try {
    clone = new EconomyEngine(config, { state: liveBefore })
  } catch (cause) {
    return {
      ok: false,
      error: 'clone_failed',
      message: `Could not clone the live world: ${(cause as Error).message}`,
    }
  }
  const cloneMs = now() - cloneStartedAt

  let result: EconomyFastForwardResult
  try {
    result = clone.fastForward(days)
  } catch (cause) {
    return {
      ok: false,
      error: 'simulation_failed',
      message: `Fast-forward failed: ${(cause as Error).message}`,
    }
  }
  const simulateMs = now() - cloneStartedAt - cloneMs

  if (!result.success) {
    return {
      ok: false,
      error: result.error?.code ?? 'fast_forward_failed',
      message: result.error?.message ?? 'Fast-forward failed',
    }
  }

  const liveAfter = source.snapshot()
  const unchanged =
    JSON.stringify(liveBefore) === JSON.stringify(liveAfter) &&
    liveAfter.sequence === liveBefore.sequence &&
    liveAfter.time === liveBefore.time

  const aliases = buildPlayerAliases(liveBefore.players)
  const events = publicizeEvents(result.events, aliases, config)
  const annotations = buildAnnotations(events, result.summaries, config)
  const finalPublicSnapshot = sanitizeSpectatorSnapshot(clone.spectatorSnapshot(), config)

  return {
    ok: true,
    mode: 'deterministic-clone',
    days: result.days,
    startDay: result.startDay,
    endDay: result.endDay,
    fromTime: result.fromTime,
    toTime: result.toTime,
    seed: result.seed,
    finalSequence: result.finalSequence,
    series: result.series.map(point => ({ ...point })),
    summaries: result.summaries.map(sanitizeSummary),
    finalMerchants: finalPublicSnapshot.merchants,
    events,
    annotations,
    recap: buildRecap(finalPublicSnapshot, config),
    timing: {
      cloneMs,
      simulateMs,
      totalMs: now() - startedAt,
      steps: result.steps,
      days: result.days,
      eventCount: result.eventCount,
    },
    live: {
      unchanged,
      sequenceBefore: liveBefore.sequence,
      sequenceAfter: liveAfter.sequence,
      day: liveAfter.day,
      time: liveAfter.time,
    },
  }
}

const reasonValue = (event: SequencedMarketEvent, code: string): number | null =>
  event.reasons.find(reason => reason.code === code)?.value ?? null

/**
 * Causal story beats for the fast-forward animation.
 *
 * Every chain string is a deterministic rendering of engine data ("caravan
 * floods timber -> merchant cash falls -> reserve breached -> stall closed"),
 * so the demo shows real causes, not invented drama.
 */
export function buildAnnotations(
  events: SequencedMarketEvent[],
  summaries: DaySummary[],
  config: EconomyConfig,
): FastForwardAnnotation[] {
  const annotations: FastForwardAnnotation[] = []
  const rentByDay = new Map<number, { total: number; count: number; sequence: number; time: number }>()

  const merchantName = (id: string): string => config.merchants[id]?.displayName ?? id
  const itemName = (id: string | null): string => (id ? config.items[id]?.displayName ?? id : '')

  for (const event of events) {
    const base = {
      sequence: event.sequence,
      time: event.time,
      day: Math.floor(event.time / 86400) + 1,
      eventId: event.id,
    }
    switch (event.type) {
      case 'caravan.arrival': {
        const sold = reasonValue(event, 'caravan-sell') ?? 0
        const bought = reasonValue(event, 'caravan-buy') ?? 0
        const cashIn = Math.abs(event.reasons.find(reason => reason.code === 'caravan-sell')?.effect ?? 0)
        annotations.push({
          ...base,
          kind: 'caravan',
          title: 'Caravan arrives',
          chain:
            `Caravan sells ${sold} units into town for ${formatMoney(config, cashIn)} -> merchant cash falls -> ` +
            `stock floods -> asks drift down. Caravan bought ${bought} units back, easing prices up.`,
          eventId: event.id,
        })
        break
      }
      case 'merchant.bankrupt': {
        const merchantId = event.actor.id
        const reserve = config.merchants[merchantId]?.reserve ?? 0
        annotations.push({
          ...base,
          kind: 'bankruptcy',
          title: `${merchantName(merchantId)} closes`,
          chain:
            `${merchantName(merchantId)} cash fell to ${formatMoney(config, event.after.cash ?? 0)} <= reserve ${formatMoney(config, reserve)} ` +
            `-> stall closed -> quotes frozen until a player invests.`,
          eventId: event.id,
        })
        break
      }
      case 'merchant.reopen': {
        annotations.push({
          ...base,
          kind: 'reopen',
          title: `${merchantName(event.actor.id)} reopens`,
          chain:
            `Player investment restored cash -> ${merchantName(event.actor.id)} reopens the stall -> stock and quotes resume.`,
          eventId: event.id,
        })
        break
      }
      case 'merchant.distribution': {
        const detail = event.reasons[0]?.detail ?? 'positive daily merchant profit'
        annotations.push({
          ...base,
          kind: 'distribution',
          title: 'Profit share paid',
          chain:
            `${detail} -> ${formatMoney(config, event.price ?? 0)} paid to ${event.actor.displayName ?? event.actor.id}.`,
          eventId: event.id,
        })
        break
      }
      case 'merchant.recovery': {
        annotations.push({
          ...base,
          kind: 'recovery',
          title: `${merchantName(event.actor.id)} cash recovering`,
          chain:
            `Local trading cash restored +${formatMoney(config, event.price ?? 0)} -> back toward the reserve target.`,
          eventId: event.id,
        })
        break
      }
      case 'order.expired': {
        annotations.push({
          ...base,
          kind: 'order-expired',
          title: 'Bulk order expired',
          chain: `${event.quantity ?? 0} ${itemName(event.item)} undelivered -> reward returned to the issuer.`,
          eventId: event.id,
        })
        break
      }
      case 'sink.rent': {
        const day = base.day
        const entry = rentByDay.get(day) ?? { total: 0, count: 0, sequence: event.sequence, time: event.time }
        entry.total = Math.round((entry.total + (event.price ?? 0)) * 100) / 100
        entry.count += 1
        entry.sequence = Math.max(entry.sequence, event.sequence)
        entry.time = Math.max(entry.time, event.time)
        rentByDay.set(day, entry)
        break
      }
      default:
        break
    }
  }

  for (const [day, entry] of rentByDay) {
    annotations.push({
      kind: 'rent',
      sequence: entry.sequence,
      time: entry.time,
      day,
      title: `Stall rent collected (day ${day})`,
      chain: `${entry.count} open stalls paid ${formatMoney(config, entry.total)} total -> cash sinks out of the town economy.`,
      eventId: null,
    })
  }

  for (const summary of summaries) {
    annotations.push({
      kind: 'day-close',
      sequence: Number.MAX_SAFE_INTEGER,
      time: summary.endedAt,
      day: summary.day,
      title: `Day ${summary.day} closed`,
      chain:
        `${summary.trades.volume} units traded for ${formatMoney(config, summary.trades.value)}; ` +
        `sinks ${formatMoney(config, summary.sinks.total)}; ` +
        (summary.bankruptcies.length > 0
          ? `${summary.bankruptcies.length} bankruptcy(ies); `
          : 'no bankruptcies; ') +
        `caravan arrivals ${summary.caravan.arrivals}.`,
      eventId: null,
    })
  }

  return annotations.sort((left, right) => left.time - right.time || left.sequence - right.sequence)
}
