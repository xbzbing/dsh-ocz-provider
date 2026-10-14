/**
 * Host session titles for the usage ledger's Top 会话 list (live request
 * 2026-10-14: "会话显示会话标题，现在看起来是显示的部分提示词").
 *
 * The ledger records a label at request time — the conversation's first user
 * turn, truncated (adapter/ids.ts conversationLabel). That is a PROMPT
 * fragment, not the name the sidebar shows for the same conversation. The
 * real title lives in the host's session log (`session/title` events, folded
 * by @deepseek-ai/dsh-session-query), so it is joined READ-TIME here, exactly
 * like the workspace-registry project join: the title provider may generate
 * (or the user may rename) the title long after our first record, and the
 * ledger must never store a copy that then goes stale.
 *
 * `/status` is polled every 2s while the stats modal is open (3s by the
 * settings card), so every fold is cached with a TTL — resolved titles for a
 * minute, misses for a quarter of that (a first-prompt title lands
 * asynchronously right after the first turn, and a fresh miss must notice it
 * soon). A failing host query degrades to "no titles this round"; the caller
 * keeps the recorded labels, never an error.
 */

/** Structural face of `ctx.sessionQuery.readTitleSnapshots` (host service). */
export interface SessionTitleQueryFace {
  readTitleSnapshots?(
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<{
    sessionId?: unknown
    status?: unknown
    value?: { title?: { title?: unknown } } | undefined
  }>>
}

/** Session id → host session title; untitled ids are absent from the map. */
export type SessionTitleMap = ReadonlyMap<string, string>

/** Resolve one batch of session ids to their host titles. */
export type SessionTitleResolver = (sessionIds: readonly string[]) => Promise<SessionTitleMap>

/** Cached RESOLVED titles are reused for this long (renames show up later). */
export const TITLE_HIT_TTL_MS = 60_000

/** A miss (no title yet / unknown session) is retried after this long. */
export const TITLE_MISS_TTL_MS = 15_000

/** Bound on the cache; dropped wholesale when exceeded (like ids.ts' session cache). */
const TITLE_CACHE_LIMIT = 2048

interface CacheEntry {
  title: string
  at: number
}

/**
 * Build a cached title resolver over one host session-query service.
 *
 * @param query - the host's `ctx.sessionQuery` (structural: any object with
 *   a compatible `readTitleSnapshots`, or none of it).
 * @param options - `now` clock seam (tests); TTLs follow the exported defaults.
 * @returns a resolver that never rejects: query failures and rejected rows
 *   resolve to "whatever was cached", so `/status` can never fail on titles.
 */
export function makeSessionTitleResolver(
  query: SessionTitleQueryFace,
  options: { now?: () => number } = {},
): SessionTitleResolver {
  const now = options.now ?? Date.now
  const cache = new Map<string, CacheEntry>()

  return async (sessionIds: readonly string[]): Promise<SessionTitleMap> => {
    const out = new Map<string, string>()
    if (typeof query.readTitleSnapshots !== 'function') return out
    const seen = new Set<string>()
    const missing: string[] = []
    const stamp = now()
    for (const id of sessionIds) {
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const hit = cache.get(id)
      // A resolved title is stable for a while; an absence is not (the host
      // may title the session a moment later), so the two get different TTLs.
      const ttl = hit !== undefined && hit.title !== '' ? TITLE_HIT_TTL_MS : TITLE_MISS_TTL_MS
      if (hit !== undefined && stamp - hit.at < ttl) {
        if (hit.title !== '') out.set(id, hit.title)
        continue
      }
      missing.push(id)
    }
    if (missing.length === 0) return out

    let rows: ReadonlyArray<{
      sessionId?: unknown
      status?: unknown
      value?: { title?: { title?: unknown } } | undefined
    }> = []
    try {
      rows = await query.readTitleSnapshots(missing)
    } catch {
      // Host query failed (disposed service, corpus error): report the cached
      // hits we already collected and leave the misses for the next round.
      return out
    }
    const answered = now()
    for (const row of rows) {
      const id = typeof row.sessionId === 'string' ? row.sessionId : ''
      if (id === '') continue
      const title = row.status === 'fulfilled' && typeof row.value?.title?.title === 'string'
        ? row.value.title.title
        : ''
      if (cache.size >= TITLE_CACHE_LIMIT) cache.clear()
      cache.set(id, { title, at: answered })
      if (title !== '') out.set(id, title)
    }
    return out
  }
}
