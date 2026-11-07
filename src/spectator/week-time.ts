/**
 * Calendar-day helpers shared by the spectator week price chart.
 *
 * Preview summaries are labelled by calendar day, events arrive at arbitrary
 * times, and the clone can end in the middle of a day. Keeping the bucket math
 * in one place prevents the three sources from drifting onto different axes.
 */

export const DAY_SECONDS = 86_400

export const calendarDay = (time: number): number => Math.floor(time / DAY_SECONDS) + 1

/** 1-based index of a calendar day relative to the preview's start day. */
export const calendarDayIndex = (time: number, startDay: number): number =>
  calendarDay(time) - startDay + 1

export interface WeekDayAxis {
  /** `Open`, the seven simulated closes, and `Final` when the clone ends mid-day. */
  labels: string[]
  maxIndex: number
  /** Index of the separate final partial day, or null when the clone ends on a close. */
  partialIndex: number | null
}

/**
 * Build the price-chart x-axis. A trailing partial day is kept as its own
 * `Final` bucket instead of being folded into the last full close.
 */
export function weekDayAxis(
  startDay: number,
  days: number,
  toTime: number,
  lastCloseTime: number | null,
): WeekDayAxis {
  const safeDays = Math.max(1, Math.floor(days))
  const labels = ['Open', ...Array.from({ length: safeDays }, (_, index) => `D${index + 1}`)]
  const hasPartial =
    lastCloseTime !== null &&
    Number.isFinite(lastCloseTime) &&
    Number.isFinite(toTime) &&
    toTime > lastCloseTime + 1e-6
  if (hasPartial) labels.push('Final')
  return {
    labels,
    maxIndex: labels.length - 1,
    partialIndex: hasPartial ? labels.length - 1 : null,
  }
}

export function weekPointLabel(
  startDay: number,
  index: number,
  partialIndex: number | null,
): string {
  if (index <= 0) return 'Week open'
  if (partialIndex !== null && index === partialIndex) return 'Final partial day'
  return `Day ${startDay + index - 1} close`
}
