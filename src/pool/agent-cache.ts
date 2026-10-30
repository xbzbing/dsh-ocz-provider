/**
 * Per-exit ProxyAgent cache (docs/ip-pool.md §2): LRU-capped, keyed by exit id
 * and rebuilt whenever the exit's dial URI changes (a relabelled protocol must
 * reach the socket, not just the table). Retired agents are closed, never
 * destroyed, so requests already riding them finish.
 */

import type { Dispatcher } from 'undici'

export class ExitAgentCache {
  readonly #cap: number
  readonly #build: (uri: string) => Dispatcher
  /** Map insertion order is the LRU order (oldest first). */
  readonly #entries = new Map<string, { uri: string; agent: Dispatcher }>()

  constructor(cap: number, build: (uri: string) => Dispatcher) {
    this.#cap = Math.max(1, cap)
    this.#build = build
  }

  get size(): number {
    return this.#entries.size
  }

  /** The agent dialling `uri` for this exit; `build` errors propagate. */
  get(exitId: string, uri: string): Dispatcher {
    const cached = this.#entries.get(exitId)
    if (cached !== undefined) {
      this.#entries.delete(exitId)
      if (cached.uri === uri) {
        this.#entries.set(exitId, cached)
        return cached.agent
      }
      retire(cached.agent)
    }
    const agent = this.#build(uri)
    this.#entries.set(exitId, { uri, agent })
    while (this.#entries.size > this.#cap) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      const evicted = this.#entries.get(oldest)
      this.#entries.delete(oldest)
      if (evicted !== undefined) retire(evicted.agent)
    }
    return agent
  }

  /** Every cached agent (dispatcher close/destroy). */
  agents(): Dispatcher[] {
    return [...this.#entries.values()].map((entry) => entry.agent)
  }

  clear(): void {
    this.#entries.clear()
  }
}

function retire(agent: Dispatcher): void {
  void agent.close().catch(() => {})
}
