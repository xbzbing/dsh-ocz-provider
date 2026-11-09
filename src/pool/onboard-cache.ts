/**
 * Screening verdicts from the last onboarding round, keyed by node identity.
 *
 * A plugin reload rebuilds the pool and re-runs the speed pass over every
 * candidate — roughly 25 s of probing for a 45-node subscription, spent again
 * on a reload that changed nothing about those nodes. Each verdict is
 * therefore kept on disk with its own measurement time: a reload inside the
 * TTL reuses it and only new nodes are probed.
 *
 * The TTL is deliberately below the default 30-minute refresh interval, so a
 * scheduled refresh still measures everything; only ad-hoc rebuilds (install,
 * uninstall, settings commit) ride the cache.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { EchoFacts } from './admission.ts'
import { buildOutbound } from './singbox-outbound.ts'
import type { ParsedNode } from './subscription.ts'

/** One candidate's outcome: measured facts, or why the screen refused it. */
export type ScreeningVerdict =
  | { at: number; facts: EchoFacts }
  | { at: number; rejected: string }

export const ONBOARD_CACHE_TTL_MS = 20 * 60_000

/**
 * Stable identity of a candidate, for cache lookups.
 *
 * The full outbound JSON (`nodeKey`) is NOT stable across fetches: the airport
 * re-rolls the uTLS fingerprint on every response, so the same node produces a
 * new key each time and every reload would re-probe. This key is that same
 * JSON with every `fingerprint` field removed — as discriminating as the node
 * itself (one edge carries several nodes told apart by TLS server name), minus
 * the one value the provider randomises.
 */
export function screeningKey(node: ParsedNode): string {
  const out = buildOutbound(node, '')
  if (out === null) return ''
  return JSON.stringify(stripRandomised(out))
}

function stripRandomised(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRandomised)
  if (value === null || typeof value !== 'object') return value
  const copy: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'fingerprint') continue
    copy[key] = stripRandomised(entry)
  }
  return copy
}

/**
 * Read the fresh verdicts; null when the file is absent, corrupt, or holds
 * nothing younger than the TTL. A stale or unreadable cache costs a re-screen,
 * never a failed refresh.
 */
export async function loadOnboardCache(
  path: string,
  ttlMs: number = ONBOARD_CACHE_TTL_MS,
  now: number = Date.now(),
): Promise<Map<string, ScreeningVerdict> | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const entries = (parsed as { entries?: unknown }).entries
  if (entries === null || typeof entries !== 'object') return null
  const fresh = new Map<string, ScreeningVerdict>()
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    const verdict = parseVerdict(value, now, ttlMs)
    if (key !== '' && verdict !== null) fresh.set(key, verdict)
  }
  return fresh.size === 0 ? null : fresh
}

/** Persist this round's verdicts; a write failure costs the next round, not this one. */
export async function saveOnboardCache(path: string, verdicts: ReadonlyMap<string, ScreeningVerdict>): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify({ entries: Object.fromEntries(verdicts) }), 'utf8')
    await rm(path, { force: true })
    await rename(tmp, path)
  } catch {
    // Advisory: an unwritable state dir only means the next reload re-probes.
  }
}

function parseVerdict(value: unknown, now: number, ttlMs: number): ScreeningVerdict | null {
  if (value === null || typeof value !== 'object') return null
  const { at, facts, rejected } = value as Record<string, unknown>
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  const age = now - at
  if (age < 0 || age > ttlMs) return null
  if (facts !== null && typeof facts === 'object') {
    const { exitIP, exitLocation, latencyMs } = facts as Record<string, unknown>
    if (typeof exitIP !== 'string' || typeof exitLocation !== 'string' || typeof latencyMs !== 'number') return null
    return { at, facts: { exitIP, exitLocation, latencyMs } }
  }
  if (typeof rejected === 'string' && rejected !== '') return { at, rejected }
  return null
}
