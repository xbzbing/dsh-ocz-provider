/**
 * The 流量 tab's daily chart axis: a calendar window capped at 30 days ending
 * today, with the ledger's gappy buckets joined onto it, unwritten days zeroed,
 * and the leading run of empty days dropped.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { chartDays, dayWindow, shortDay, type UsageDay } from '../src/client/usage-window.ts'

/** A bucket with `tokens` spread over one day. */
const bucket = (day: string, tokens: number): UsageDay => ({ day, requests: 1, tokens, outputTokens: 0, outputMs: 0 })

/** One column, with the index bounds checked (noUncheckedIndexedAccess). */
function at<T>(rows: readonly T[], index: number): T {
  const row = rows[index]
  assert.ok(row !== undefined, `no entry at ${index}`)
  return row
}

test('the window is exactly 30 calendar days, oldest first, ending today', () => {
  const keys = dayWindow(30, new Date(2026, 10, 1, 23, 59))
  assert.equal(keys.length, 30)
  assert.equal(at(keys, 0), '2026-10-03')
  assert.equal(at(keys, 29), '2026-11-01')
  // Consecutive days with no repeats or holes, across a month boundary.
  for (let index = 1; index < keys.length; index += 1) {
    const previous = new Date(`${at(keys, index - 1)}T00:00:00`)
    const current = new Date(`${at(keys, index)}T00:00:00`)
    assert.equal(Math.round((current.getTime() - previous.getTime()) / 86_400_000), 1, `${at(keys, index - 1)} → ${at(keys, index)}`)
  }
})

test('an empty day between two rows keeps its column', () => {
  const days = chartDays([bucket('2026-10-29', 5_000), bucket('2026-11-01', 900)], 30, new Date(2026, 10, 1))
  // 10-29 … 11-01: the gap in the middle is drawn, the empty lead-in is not.
  assert.deepEqual(days.map((row) => row.day), ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
  assert.equal(at(days, 0).tokens, 5_000)
  assert.equal(at(days, 1).tokens, 0)
  assert.equal(at(days, 2).tokens, 0)
  assert.equal(at(days, 3).tokens, 900)
})

test('the chart starts at the first day with traffic, inside the 30-day cap', () => {
  const days = chartDays([bucket('2026-10-20', 7), bucket('2026-10-22', 9)], 30, new Date(2026, 10, 1))
  assert.equal(at(days, 0).day, '2026-10-20')
  assert.equal(days.length, 13) // 10-20 … 11-01
  assert.equal(at(days, 0).tokens, 7)
  assert.equal(at(days, 1).tokens, 0) // 10-21 untouched
  assert.equal(at(days, 2).tokens, 9)
})

test('a request with no booked tokens still counts as traffic', () => {
  const days = chartDays([{ day: '2026-10-25', requests: 1, tokens: 0, outputTokens: 0, outputMs: 0 }], 30, new Date(2026, 10, 1))
  assert.equal(at(days, 0).day, '2026-10-25')
})

test('nothing in the window yields no columns at all', () => {
  assert.deepEqual(chartDays([], 30, new Date(2026, 10, 1)), [])
  // A ledger whose only buckets are older than the window is the same case; the
  // panel tells the two apart with its own copy, not with extra columns.
  assert.deepEqual(chartDays([bucket('2026-09-01', 999)], 30, new Date(2026, 10, 1)), [])
})

test('buckets outside the window are dropped and ordering does not matter', () => {
  const days = chartDays([
    bucket('2026-11-01', 3),
    bucket('2026-09-01', 999), // older than the 30-day window
    bucket('2026-10-20', 7),
  ], 30, new Date(2026, 10, 1))
  assert.equal(at(days, 0).day, '2026-10-20')
  assert.equal(days.reduce((sum, row) => sum + row.tokens, 0), 10)
})

test('a short window keeps only its tail', () => {
  const days = chartDays([bucket('2026-11-01', 3)], 7, new Date(2026, 10, 1))
  assert.deepEqual(days.map((row) => row.day), ['2026-11-01'])
  assert.equal(at(days, 0).tokens, 3)
})

test('a year boundary rolls the window back a year', () => {
  const keys = dayWindow(3, new Date(2027, 0, 1))
  assert.deepEqual(keys, ['2026-12-30', '2026-12-31', '2027-01-01'])
})

test('the column label drops the year', () => {
  assert.equal(shortDay('2026-10-14'), '10-14')
  assert.equal(shortDay('10-14'), '10-14')
})
