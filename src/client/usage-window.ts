/**
 * The 流量 tab's daily chart axis.
 *
 * The ledger only stores the days that carried traffic, so plotting its buckets
 * directly collapses every day the host was off: three requests a week apart
 * would sit side by side and read as a daily trend. The chart therefore owns a
 * calendar window ending today, and a day the ledger never wrote is a zero
 * column — spacing is time, not list position. The window is capped at 30 days
 * and starts at the first day with traffic, see {@link chartDays}.
 *
 * Kept out of the .tsx so the window maths is testable without a renderer
 * (the client bundle has none in this repo's test setup).
 */
import type { UsageView } from './types.ts'

/** One ledger day bucket. */
export type UsageDay = UsageView['days'][number]

/** `2026-10-14` → `10-14` (the year is noise in a 30-day window). */
export function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day
}

/** Local calendar day key, matching the ledger's own `YYYY-MM-DD` buckets. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** The `span` calendar days ending at `now`, oldest first. */
export function dayWindow(span: number, now: Date): string[] {
  const keys: string[] = []
  for (let back = span - 1; back >= 0; back -= 1) {
    keys.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)))
  }
  return keys
}

/**
 * The window's columns: `span` days ending today, oldest first, with the
 * ledger's buckets joined on and every unwritten day zeroed.
 *
 * The LEADING run of empty days is dropped — a chart that opens with a fortnight
 * of nothing wastes its width on the period before this machine had any traffic
 * — but an empty day between two rows is kept: there the gap IS the data. An
 * empty window yields no columns at all, which the panel renders as its empty
 * state.
 * @param recorded - the ledger's day buckets (any order, possibly gappy).
 * @param span - the most calendar days the chart may show.
 * @param now - the day the window ends on (the operator's today).
 * @returns up to `span` buckets; `[0]` is the first day with traffic,
 * `[length-1]` is today.
 */
export function chartDays(recorded: readonly UsageDay[], span: number, now: Date): UsageDay[] {
  const byDay = new Map(recorded.map((row) => [row.day, row]))
  const columns = dayWindow(span, now)
    .map((day) => byDay.get(day) ?? { day, requests: 0, tokens: 0, outputTokens: 0, outputMs: 0 })
  const first = columns.findIndex(hasTraffic)
  return first < 0 ? [] : columns.slice(first)
}

/** A day the ledger actually wrote: a request, or tokens booked against it. */
function hasTraffic(row: UsageDay): boolean {
  return row.requests > 0 || row.tokens > 0
}

