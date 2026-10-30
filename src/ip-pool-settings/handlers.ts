/**
 * The bridge's actions over the live runtime and the current settings value:
 * /status, /models, /probe, /exit and /usage, each answering a
 * {@link BridgeResult} envelope. Transport (guard, body parsing, JSON
 * framing) lives in routes.ts.
 */

import type { IpPoolRuntime } from '../ip-pool.ts'
import { LOCAL_EXIT_ID } from '../pool/usage.ts'
import type { UsageScope, UsageStore } from '../pool/usage-store.ts'
import type { SessionTitleMap, SessionTitleResolver } from '../pool/session-titles.ts'
import { detectProxyProtocol, type ProxyProtocol } from '../pool/protocol.ts'
import { USAGE_SESSION_LIMIT, buildStatusView, type ProjectResolver } from './views.ts'

export type BridgeResult = { ok: true; value: unknown } | { ok: false; code: string; message: string }

/**
 * Persist one pin value into the plugin's own settings namespace. Returns
 * false when the profile cannot be written (read-only, or no settings service
 * in this composition) — the caller then keeps the live-only pin and the modal
 * reports it as not persisted. An empty value UNSETS the field so the schema
 * default applies instead of a stored empty string.
 */
export type WritePin = (value: string) => Promise<boolean>

/** deps over the live runtime + the current settings value (probe model etc.). */
export interface BridgeHandlers {
  status(): Promise<BridgeResult>
  probe(body: { scope?: unknown; exitId?: unknown }): Promise<BridgeResult>
  /** Selectable probe models (docs §5.2 探活模型 dropdown): S3 static list
   *  first, then the live Zen catalog entries the runtime resolved. */
  models(): Promise<BridgeResult>
  /**
   * One row action from the exit tables: pin, pin-local, unpin, or rotate.
   * The pin family writes `pinnedExitId` and applies live; `rotate` hands the
   * row to the candidate list — a reserve takes its slot, or it sinks to the
   * tail when there is nothing to promote.
   */
  exit(body: { action?: unknown; exitId?: unknown }): Promise<BridgeResult>
  /**
   * Ledger maintenance (清空, docs §5.3). `reset` drops the persisted totals
   * AND the run scope — clearing only one would leave the two views
   * disagreeing — and answers `{cleared: true}`; the caller re-reads /status
   * for the new numbers. It deliberately does NOT need the pool: the ledger
   * records every request with the pool off (§5.6), so its clear must work
   * there too.
   */
  usage(body: { action?: unknown }): Promise<BridgeResult>
}

/** Live-catalog seam for the models() dropdown rows (index.ts injects the
 *  plugin's ModelCatalog when one is running; undefined = static list only). */
export type ListLiveModels = () => string[]

/** Build the bridge handlers over the runtime + current settings. */
export function makeBridgeHandlers(
  runtime: () => IpPoolRuntime | null,
  settings: () => {
    pinnedStrict: boolean
    proxyHosts: string[]
    proxyPathPrefixes?: string[]
    /** 'total' (ledger) or 'run' (this process) — the card's switch. */
    usageScope?: UsageScope
  },
  deps: {
    listLiveModels?: ListLiveModels
    writePin?: WritePin
    /** The persistent ledger (absent = a composition without one). */
    usage?: UsageStore
    /** Session id → project, resolved from the host's workspace registry. */
    projectOf?: ProjectResolver
    /** Session id → host session title, resolved from the host's session corpus. */
    sessionTitles?: SessionTitleResolver
    /** Process start, for the 本次重启 label. */
    runSince?: () => number
    /**
     * Which protocol a listener actually speaks (pool/protocol.ts). Injected so
     * the pin checks below stay unit-testable without opening sockets; the
     * default opens one connect-and-read per call.
     */
    detectProtocol?: (address: string) => Promise<ProxyProtocol | null>
  } = {},
): BridgeHandlers {
  return {
    async status() {
      const current = settings()
      /**
       * The top-session join: ask the host for the titles of exactly the rows
       * the view will render, before building it — the resolver is TTL-cached,
       * so the modal's 2s poll mostly reads cache. A missing resolver or a
       * failed batch just yields no map: every row keeps its recorded label
       * and /status still answers.
       */
      let sessionTitles: SessionTitleMap | undefined
      const store = deps.usage
      if (deps.sessionTitles !== undefined && store !== undefined) {
        const scope: UsageScope = current.usageScope ?? 'total'
        try {
          sessionTitles = await deps.sessionTitles(store.sessions(scope, USAGE_SESSION_LIMIT).map((row) => row.id))
        } catch {
          sessionTitles = undefined
        }
      }
      return {
        ok: true,
        value: buildStatusView(runtime(), current.pinnedStrict, current.proxyHosts, {
          proxyPathPrefixes: current.proxyPathPrefixes,
          usage: deps.usage,
          usageScope: current.usageScope,
          projectOf: deps.projectOf,
          sessionTitles,
          runSince: deps.runSince?.(),
        }),
      }
    },
    async probe(body) {
      const rt = runtime()
      if (rt === null) return { ok: false, code: 'pool-disabled', message: 'ip pool is not running (enabled off)' }
      const scope = body.scope
      if (scope === 'all') {
        const queued = await rt.probeAll()
        return { ok: true, value: { queued } }
      }
      if (scope === 'subscription') {
        // docs §5.2 订阅「立即刷新」: re-pull the subscription URLs on demand —
        // the fetcher's refresh timer is the only other way they are re-pulled.
        await rt.refreshSubscriptions()
        return { ok: true, value: { refreshed: true } }
      }
      if (scope === 'exit') {
        const exitId = typeof body.exitId === 'string' ? body.exitId : ''
        if (!rt.pool.has(exitId)) return { ok: false, code: 'unknown-exit', message: `exit "${exitId}" is not in the pool` }
        const count = await rt.probeExit(exitId)
        return { ok: true, value: { queued: count } }
      }
      return { ok: false, code: 'settings-rejected', message: "probe scope must be 'all', 'exit' or 'subscription'" }
    },
    async models() {
      const { staticFreeModels } = await import('../adapter/catalog.ts')
      const rows: Array<{ id: string; verified: boolean }> = staticFreeModels.map((id) => ({ id, verified: true }))
      const seen = new Set(staticFreeModels)
      for (const id of deps.listLiveModels?.() ?? []) {
        if (typeof id !== 'string' || id === '' || seen.has(id)) continue
        seen.add(id)
        rows.push({ id, verified: false })
      }
      return { ok: true, value: { models: rows } }
    },
    async exit(body) {
      const rt = runtime()
      if (rt === null) return { ok: false, code: 'pool-disabled', message: 'ip pool is not running (enabled off)' }
      const action = body.action

      if (action === 'pin' || action === 'pin-local' || action === 'unpin') {
        // An empty value is the unpin spelling, `pin-local` the 本机 row's
        // button: keeping the sentinel host-side means the browser bundle never
        // has to spell it (and cannot drift from it).
        const raw = action === 'unpin'
          ? ''
          : action === 'pin-local'
            ? LOCAL_EXIT_ID
            : (typeof body.exitId === 'string' ? body.exitId.trim() : '')
        if (raw !== '' && raw !== LOCAL_EXIT_ID && !rt.pool.has(raw)) {
          return { ok: false, code: 'unknown-exit', message: `exit "${raw}" is not in the pool` }
        }
        /**
         * Verify BEFORE pinning (AGENTS.md egress-row hygiene): a pin makes
         * `pick()` hand the row to every request, so a row whose protocol was
         * typed wrong (or a port with nothing behind it) fails EVERY request
         * instead of one. The two outcomes are deliberately different:
         *   - a listener that speaks the OTHER protocol is self-correcting:
         *     the row is relabelled and the pin proceeds (the operator's
         *     intent — "route through this port" — is unambiguous);
         *   - nothing answering at all is refused, because no relabel can make
         *     it work and a pin would silence the whole lane.
         * Rows with measured facts (a verified subscription exit) skip the
         * probe: their protocol came from a real request, so probing would
         * only add latency to every pin click.
         */
        let corrected: ProxyProtocol | null = null
        if (raw !== '' && raw !== LOCAL_EXIT_ID) {
          const node = rt.pool.get(raw)
          const unverified = node === undefined || node.exitIP === '' || node.source === 'manual'
          if (unverified) {
            let found: ProxyProtocol | null
            try {
              found = await (deps.detectProtocol ?? detectProxyProtocol)(raw)
            } catch {
              found = null
            }
            if (found === null) {
              return {
                ok: false,
                code: 'exit-unreachable',
                message: `出口 ${raw} 没有监听（或不是代理），未固定：换一个出口，或先确认该端口已启动`,
              }
            }
            if (node !== undefined && found !== node.protocol) {
              rt.pool.refresh(raw, { protocol: found })
              corrected = found
            }
            // Pinning a row that was struck dead has to revive it: the
            // operator just proved the listener answers, and a pin on a dead
            // row is a pin `pick()` skips.
            rt.pool.revive(raw)
          }
        }
        // Persist first, then apply: the settings commit lands on the same
        // pool through reconfigure(), and applying it here as well makes the
        // click effective even when the profile is read-only (the modal then
        // reports `persisted: false` instead of pretending).
        let persisted = false
        try {
          persisted = await deps.writePin?.(raw) ?? false
        } catch {
          persisted = false
        }
        if (raw === '') rt.pool.unpin()
        else if (raw === LOCAL_EXIT_ID) rt.pool.pinLocal()
        else rt.pool.pin(raw)
        return {
          ok: true,
          // `corrected` appears only when the row was relabelled, so a pin on
          // a healthy row answers without the field.
          value: { pinned: raw, local: raw === LOCAL_EXIT_ID, persisted, ...(corrected === null ? {} : { corrected }) },
        }
      }

      if (action === 'rotate') {
        const exitId = typeof body.exitId === 'string' ? body.exitId : ''
        if (!rt.pool.has(exitId)) {
          return { ok: false, code: 'unknown-exit', message: `exit "${exitId}" is not in the pool` }
        }
        // Rotating the pinned exit has to unpin first: the pin lives in the
        // settings, and a later commit would otherwise re-pin a row that is no
        // longer in the pool — and re-admit it as a manual row when the id
        // happens to parse as an address (subscription ids do).
        if (rt.pool.pinnedId === exitId) {
          try {
            await deps.writePin?.('')
          } catch { /* live unpin below still holds */ }
          rt.pool.unpin()
        }
        // The subscription layer owns the candidate list: it promotes the
        // next-fastest reserve, or keeps the exit at the pool tail when the
        // reserve is empty (both documented in docs §5.3 `POST /exit`).
        const promoted = await rt.subscriptions?.replaceExit(exitId).catch(() => false) ?? false
        if (!promoted && rt.pool.has(exitId)) {
          // A running onboarding/trim holds the rebuild mutex and replaceExit()
          // answers false without consulting the reserve. Sinking the row then
          // would violate the request ("promote first, sink only when there is
          // nothing to promote"), so say busy instead and leave the row alone.
          if (rt.subscriptions?.busy === true) {
            return { ok: true, value: { rotated: false, promoted: false, busy: true, remaining: rt.pool.snapshot().total } }
          }
          // No onboarder at all (no subscription round ran in this process):
          // the row still has to stop outranking live exits.
          rt.pool.demoteToTail(exitId)
        }
        return { ok: true, value: { rotated: true, promoted, remaining: rt.pool.snapshot().total } }
      }

      return { ok: false, code: 'settings-rejected', message: "exit action must be 'pin', 'pin-local', 'unpin' or 'rotate'" }
    },
    async usage(body) {
      const store = deps.usage
      if (store === undefined) return { ok: false, code: 'no-ledger', message: 'this composition has no persistent usage ledger' }
      if (body.action !== 'reset') return { ok: false, code: 'settings-rejected', message: "usage action must be 'reset'" }
      await store.clear()
      return { ok: true, value: { cleared: true } }
    },
  }
}
