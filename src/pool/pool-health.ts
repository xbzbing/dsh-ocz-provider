/**
 * What the exit table learned, kept across a process (or a plugin reload).
 *
 * A fresh pool starts every row at "nothing proven": a cooldown earned a
 * minute ago is gone, an (exit, model) ban is gone, and the exit that just
 * refused this machine is handed out again. That is cheap to fix and expensive
 * to get wrong — a frozen verdict poisons the pool for hours — so this file
 * stores only facts that carry their own clock:
 *
 *  - cooldowns and bans are absolute deadlines; a past one is dropped;
 *  - "ok" and "dead" are LIVENESS claims with a short life (a row proven alive
 *    ten minutes ago is a hint, not a fact), and an expired claim falls back to
 *    `unknown` while the measured facts stay — the card then says 已测速·未验证,
 *    the same distinction the pool already draws for a row it cannot vouch for;
 *  - measurement facts (exit IP / location / latency / grade) and the passive
 *    counters are diagnostics and keep their longer TTL.
 *
 * The document is keyed by exit id and applied through `ExitPool.seedHealth`,
 * which also covers rows that arrive AFTER assembly (subscription exits land
 * one refresh later under their stable 127.0.0.1:<port> id).
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ExitNode, ExitPool } from './pool.ts'

/** How long a proven-alive claim survives as a hint. */
export const PROVEN_TTL_MS = 10 * 60_000
/** How long a dead mark survives (it is a strike, not a verdict). */
export const DEAD_TTL_MS = 15 * 60_000
/** How long measured exit facts are worth showing. */
export const FACTS_TTL_MS = 6 * 60 * 60_000
/** How long a banned (exit, model) pairing is honoured. */
export const BAN_TTL_MS = 6 * 60 * 60_000
/** How long an upstream abuse flag (ExitNote) is honoured. */
export const ABUSIVE_TTL_MS = 3 * 60 * 60_000

export type StoredHealthState = 'unknown' | 'ok' | 'dead'
export type StoredBanState = 'ok' | 'suspect' | 'banned'

export interface StoredPassive {
  ok: number
  limited: number
  refused: number
  dead: number
  transport: number
}

export interface StoredFacts {
  exitIP: string
  exitLocation: string
  latencyMs: number
  quality: ExitNode['quality']
}

export interface StoredBan {
  model: string
  state: StoredBanState
  bannedAt: number
  consecutiveFailures: number
}

export interface StoredExit {
  /** When this record was collected (epoch ms); every TTL is read against it. */
  at: number
  state: StoredHealthState
  lastProbedAt: number
  consecutiveLimited: number
  cooldownUntil: number
  deadStrikes: number
  deadAt: number
  note: '' | 'abusive'
  noteAt: number
  passive: StoredPassive
  facts: StoredFacts
  lastUsedAt: number
  bans: StoredBan[]
}

export interface PoolHealthDocument {
  version: 1
  savedAt: number
  exits: Record<string, StoredExit>
}

/** Collect every row's health into the stored shape. */
export function collectPoolHealth(pool: ExitPool, now: number = Date.now()): PoolHealthDocument {
  const exits: Record<string, StoredExit> = {}
  for (const row of pool.list()) {
    exits[row.id] = {
      at: now,
      state: row.health.state,
      lastProbedAt: row.health.lastProbedAt,
      consecutiveLimited: row.health.consecutiveLimited,
      cooldownUntil: row.health.cooldownUntil,
      deadStrikes: row.health.deadStrikes,
      deadAt: row.health.deadAt,
      note: row.health.note,
      noteAt: row.health.noteAt,
      passive: pool.passiveStats(row.id),
      facts: {
        exitIP: row.exitIP,
        exitLocation: row.exitLocation,
        latencyMs: row.latencyMs,
        quality: row.quality,
      },
      lastUsedAt: pool.activity(row.id).lastUsedAt,
      bans: row.bans
        .filter((entry) => entry.ban.state !== 'ok')
        .map((entry) => ({
          model: entry.model,
          state: entry.ban.state,
          bannedAt: entry.ban.bannedAt,
          consecutiveFailures: entry.ban.consecutiveFailures,
        })),
    }
  }
  return { version: 1, savedAt: now, exits }
}

/** One row as the pool should seat it after a restore. */
export interface SeededRow {
  state: StoredHealthState
  lastProbedAt: number
  consecutiveLimited: number
  cooldownUntil: number
  deadStrikes: number
  deadAt: number
  note: '' | 'abusive'
  noteAt: number
  passive?: StoredPassive
  facts?: StoredFacts
  lastUsedAt?: number
  bans?: StoredBan[]
}

/**
 * The rows worth restoring now: expired claims drop to `unknown`, expired
 * cooldowns/bans/notes disappear, and a live claim keeps its clock so the next
 * refresh measures it again instead of trusting it.
 */
export function restorableRows(doc: PoolHealthDocument, now: number = Date.now()): Array<[string, SeededRow]> {
  const rows: Array<[string, SeededRow]> = []
  for (const [id, stored] of Object.entries(doc.exits ?? {})) {
    if (stored === null || typeof stored !== 'object') continue
    const at = Number.isFinite(stored.at) ? stored.at : doc.savedAt
    // Each claim ages from ITS OWN clock, not from the snapshot: a proof made
    // an hour before the file was written is an hour old when it is read back.
    const provenAge = Math.max(0, now - (Number(stored.lastProbedAt) || at))
    const deadAge = Math.max(0, now - (Number(stored.deadAt) || at))
    const state: StoredHealthState = stored.state === 'ok'
      ? (provenAge <= PROVEN_TTL_MS ? 'ok' : 'unknown')
      : stored.state === 'dead'
        ? (deadAge <= DEAD_TTL_MS ? 'dead' : 'unknown')
        : 'unknown'
    const cooling = Number.isFinite(stored.cooldownUntil) && stored.cooldownUntil > now
    const abusive = stored.note === 'abusive' && Number.isFinite(stored.noteAt) && now - stored.noteAt <= ABUSIVE_TTL_MS
    const factsFresh = provenAge <= FACTS_TTL_MS && typeof stored.facts?.exitIP === 'string'
    rows.push([id, {
      state,
      lastProbedAt: Number(stored.lastProbedAt) || 0,
      consecutiveLimited: Number(stored.consecutiveLimited) || 0,
      cooldownUntil: cooling ? stored.cooldownUntil : 0,
      deadStrikes: Number(stored.deadStrikes) || 0,
      deadAt: state === 'dead' ? (Number(stored.deadAt) || at) : 0,
      note: abusive ? 'abusive' : '',
      noteAt: abusive ? (Number(stored.noteAt) || 0) : 0,
      passive: stored.passive,
      ...(factsFresh ? { facts: stored.facts } : {}),
      ...(Number.isFinite(stored.lastUsedAt) && stored.lastUsedAt > 0 ? { lastUsedAt: stored.lastUsedAt } : {}),
      bans: (Array.isArray(stored.bans) ? stored.bans : []).filter((ban) =>
        ban.state === 'banned' && Number.isFinite(ban.bannedAt) && now - ban.bannedAt <= BAN_TTL_MS),
    }])
  }
  return rows
}

/** Seed the pool from a document: rows present now, and rows that land later. */
export function restorePoolHealth(pool: ExitPool, doc: PoolHealthDocument, now: number = Date.now()): number {
  const rows = restorableRows(doc, now)
  pool.seedHealth(rows)
  return rows.length
}

/**
 * Read the store; null when it is absent, unreadable, or written by a version
 * this build does not know. A bad file costs a cold pool, never a failed start.
 */
export async function loadPoolHealth(path: string): Promise<PoolHealthDocument | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as Partial<PoolHealthDocument>
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) return null
    if (parsed.exits === null || typeof parsed.exits !== 'object') return null
    return { version: 1, savedAt: Number(parsed.savedAt) || 0, exits: parsed.exits }
  } catch {
    return null
  }
}

/** Write atomically (temp file + rename): a crash never leaves half a document. */
export async function writePoolHealth(path: string, doc: PoolHealthDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(doc)}\n`, 'utf8')
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

export interface PoolHealthWriter {
  /** Write now when anything changed since the last write. */
  flush(): Promise<void>
  /** Stop the periodic write. */
  stop(): void
}

/** How often the periodic snapshot runs. */
export const HEALTH_WRITE_EVERY_MS = 15_000

/**
 * Keep the store up to date while the pool runs. The snapshot is compared
 * with the last write before touching the disk, so an idle pool costs no I/O
 * and a busy one writes at most once per interval.
 */
export function startPoolHealthWriter(options: {
  pool: ExitPool
  path: string
  everyMs?: number
  now?: () => number
  onError?: (err: unknown) => void
}): PoolHealthWriter {
  const now = options.now ?? Date.now
  let last = ''
  let timer: NodeJS.Timeout | undefined
  const write = async (force: boolean): Promise<void> => {
    let serialized: string
    try {
      serialized = JSON.stringify(collectPoolHealth(options.pool, now()))
    } catch (err) {
      options.onError?.(err)
      return
    }
    if (!force && serialized === last) return
    try {
      await writePoolHealth(options.path, JSON.parse(serialized) as PoolHealthDocument)
      last = serialized
    } catch (err) {
      options.onError?.(err)
    }
  }
  const every = options.everyMs ?? HEALTH_WRITE_EVERY_MS
  if (every > 0) {
    timer = setInterval(() => { void write(false) }, every)
    timer.unref?.()
  }
  return {
    flush: () => write(true),
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
