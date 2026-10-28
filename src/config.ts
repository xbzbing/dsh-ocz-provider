import Schema from '@deepseek-ai/schemastery'

import { IpPoolConfigSchema, type IpPoolSettings, type VolatileRef } from './ip-pool-settings/namespace.ts'
import { MIN_CONTEXT_WINDOW, type ModelContextWindows } from './model-context.ts'
import type { LocalIpFamily } from './pool/local-family.ts'
import type { RelayConfig } from './relay/supervisor.ts'
import { type RequestHeaders } from './request-headers.ts'

export type { RelayConfig } from './relay/supervisor.ts'

/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 */
export interface Opencode2dshConfig {
  /** Model list refresh interval in seconds. */
  refreshSeconds?: number
  /**
   * Watchdog: ms to wait for the first pi-ai stream event (issue #33). The
   * shipped window (zen-adapter.ts DEFAULT_FIRST_EVENT_MS) is the fallback
   * when unset, so nobody who does not set it sees a behavior change.
   */
  firstEventMs?: number
  /** Watchdog: ms of body silence tolerated mid-stream (chat models). */
  bodyIdleMs?: number
  /**
   * Watchdog: body-idle window for Responses models (muse-spark-*), whose
   * bursty reasoning needs the wider window (issue #7). Applied as a floor
   * over `bodyIdleMs`, never below it.
   */
  responsesBodyIdleMs?: number
  /**
   * The User-Agent sent on every Zen request: chat, the model
   * catalog refresh and the pool's admission probes. Empty = the built-in
   * current-client shape (`opencode/latest/2.2.0/<client>`, where `<client>`
   * mirrors the effective `x-opencode-client`).
   *
   * The anonymous lane accepts a FINGERPRINT, not one string: this header
   * travels with the session/project/request id shapes and the tool
   * definitions, and mixing two generations answers 403. Change it only to a
   * UA whose generation you can keep coherent (adapter/ids.ts
   * `disguiseHeaders` holds the probe recipes).
   */
  userAgent?: string
  /** Live Zen-only header overrides. Override userAgent when User-Agent is present. */
  requestHeaders?: RequestHeaders
  /**
   * Per-model context-window overrides (model id -> tokens), for ids whose
   * models.dev `limit.context` understates what the endpoint really serves
   * (e.g. 200K declared, 1M available). Read on every model resolution, so a
   * settings save applies to the next request without a restart.
   */
  modelContextWindows?: ModelContextWindows
  /**
   * The Bun upstream relay (src/relay/): the process that makes this plugin's
   * requests leave on the official client's connection stack, which the free
   * lane gates on — a payload edit cannot reach that layer. Started lazily by
   * `listModels`/`prepareCall`/the catalog refresh; `enabled: false` sends
   * direct (the lane answers 429), which is what a probe wants.
   */
  relay?: RelayConfig
  /**
   * IP-pool exit routing (docs/ip-pool.md). Everything below is plain plugin
   * config; the settings page owns these live through the volatile `ipPool`
   * node, and this object is the cordis.patch.yml seam.
   */
  ipPool?: IpPoolConfig
}

/** docs/ip-pool.md section 5.1 schema (subset owned by config today). */
export interface IpPoolConfig {
  /** Master switch; false keeps the process exactly as today (direct). */
  enabled?: boolean
  /** Manually added plain proxies: 'http://h:p' or 'socks5://h:p'. */
  manual?: string[]
  /** Fixed primary exit address (docs/ip-pool.md 3.6). */
  pinnedExitId?: string
  /** Absolute pinning: never rotate, never direct-fallback (3.6). */
  pinnedStrict?: boolean
  /** Hosts whose traffic goes through the pool (default opencode.ai). */
  proxyHosts?: string[]
  /** Path prefixes on those hosts the pool carries (default /inference/v1). */
  proxyPathPrefixes?: string[]
  /**
   * 本地出口兜底 (docs §3.3): may a request the pool cannot carry egress from
   * this machine? Default FALSE — an empty or fully-cooling pool fails the
   * request instead of leaking the local IP. An explicit 固定本机 pin is
   * honoured either way.
   */
  localFallback?: boolean
  /**
   * 本机出口协议族 (local-family.ts): which IP family the LOCAL egress dials
   * with — `auto` (default) prefers IPv6 when this machine has a routable one
   * and falls back to IPv4, `ipv4` / `ipv6` pin the family. Exit traffic is
   * unaffected.
   */
  localIpFamily?: LocalIpFamily
  /** Free-source pool (docs/ip-pool.md 1.2 source 1, 3.5, 4.5). */
  free?: {
    enabled?: boolean
    /** Target capacity for the free pool (docs 3.5). */
    targetSize?: number
    /** Admission geo blocklist (country codes). */
    blockedCountries?: string[]
  }
  /** Airport/Clash subscriptions (docs 1.2 source 3, IP-3). */
  subscriptions?: string[]
  /** Subscription refresh interval ms (docs 4.6, default 30min) and the fetch
   *  User-Agent (airports gate on it; empty = built-in default). */
  subscription?: { refreshMs?: number; userAgent?: string }
  /** Cross-exit probe concurrency cap (docs 4.1; same-exit always serial). */
  maxConcurrentProbes?: number
  /**
   * Whole-pool capacity: how many exits stay online at once, any source
   * (settings schema default 10). The onboarding speed-tests candidates, keeps
   * the fastest `poolSize` and shrinks the sing-box config to them, so it also
   * bounds the number of local SOCKS listeners.
   */
  poolSize?: number
  /** sing-box conversion core for encrypted nodes (docs 1.2.2, IP-4). */
  singbox?: {
    /** sing-box binary: PATH name or absolute path; unset parks encrypted
     *  nodes as pending-conversion. */
    path?: string
  }
  /** Admission smoke model (docs 4.1 probeModels[0]). */
  probeModels?: string[]
  /** Admission probe-content pool (docs 4.1 step 4); empty = ['hello']. */
  probeContents?: string[]
  /** Same-request rotate attempts on pre-content failures (docs 3.4). */
  maxRotateAttempts?: number
}

export const defaults = {
  refreshSeconds: 300,
}

export type ResolvedConfig = Required<Pick<Opencode2dshConfig, 'refreshSeconds'>> & Opencode2dshConfig

export function resolveConfig(config: Opencode2dshConfig = {}): ResolvedConfig {
  return { ...defaults, ...config }
}

/**
 * The plugin's `Config` — the whole DSH settings contract in one schema.
 * DSH 0.1.7 has no imperative `ctx.settings.register(ns, schema)`: a plugin
 * declares editable settings by exporting this schema, and dsh-settings derives
 * the served namespace from the Loader entry id. Three consequences shape it:
 *
 *  - `ipPool` is ONE `.volatile()` node, so the whole subtree is the settings
 *    form (nesting `.volatile()` deeper is a hard schemastery error, and
 *    per-field marks would fragment the card's form value into siblings).
 *  - `requestHeaders` and `modelContextWindows` are separate volatile
 *    dictionaries, read at request / model-resolution time.
 *  - the remaining fields are ORDINARY configuration, which `volatileForm()`
 *    drops from the form; `userAgent` remains a profile-only field.
 *
 * The reference is `dsh-llm-deepseek`'s `deepSeekConfigFields`.
 */
/**
 * `requestHeaders` must stay a PLAIN dict — never a `.transform()`.
 *
 * dsh-settings rebuilds the served form from `Config.toJSON()` (`plainSchema`)
 * and serializes it a second time for the browser; a transform's `callback`
 * survives the first `toJSON()` but is dropped on that rebuild, so the
 * rehydrated node throws `callback is not a function`, the
 * `ConfigFormController.decode()` result is undefined, and the 配置 card never
 * leaves its loading state. Validation therefore lives at the editor
 * (`parseRequestHeaders`, strict) and at the request boundary
 * (`sanitizeRequestHeaders`, lenient), not in the schema;
 * `test/request-headers.test.ts` and `scripts/smoke-dsh-compat.mjs` guard the
 * round trip.
 */
const RequestHeadersConfigSchema: Schema<RequestHeaders, RequestHeaders, 'volatile-defined'> =
  Schema.dict(Schema.string()).default({}).volatile()

/**
 * Per-model context windows, also a PLAIN dict for the same reason as
 * `requestHeaders`: no `.transform()` (or any callback) may survive into the
 * served form. Range/format validation lives in src/model-context.ts at the
 * editor and catalog boundaries; the schema only keeps the value a dictionary
 * of positive integers so the form still decodes a hand-edited profile.
 */
const ModelContextWindowsConfigSchema: Schema<ModelContextWindows, ModelContextWindows, 'volatile-defined'> =
  Schema.dict(Schema.number().step(1).min(MIN_CONTEXT_WINDOW)).default({}).volatile()

/**
 * The Bun relay node, as a plain schemastery object. Ordinary config (not
 * volatile): it is a profile/yml knob, it changes when the operator installs
 * or moves bun, and it must not depend on the settings form round-tripping —
 * see the `requestHeaders` note above for what a callback-bearing node does to
 * the whole configuration page.
 */
const RelayConfigSchema: Schema<RelayConfig, RelayConfig, never> = Schema.object({
  /** Master switch; false = direct Node requests, which the free lane answers 429. */
  enabled: Schema.boolean().default(true),
  /** Explicit bun binary; empty = search PATH and the usual install dirs. */
  bunPath: Schema.string().default(''),
  /** Fixed relay port; 0 = the OS picks one (recommended — no collisions). */
  port: Schema.number().step(1).min(0).max(65535).default(0),
  /** Upstream origin (default https://opencode.ai; override for staging). */
  upstream: Schema.string().default(''),
})

export const Config = Schema.object({
  /** Model list refresh interval in seconds. */
  refreshSeconds: Schema.number().step(1).min(1).default(defaults.refreshSeconds),
  /**
   * Watchdog: ms to wait for the first stream event. No `.default()` on
   * purpose — the adapter owns those numbers (DEFAULT_FIRST_EVENT_MS &
   * friends), and duplicating them here would make two sources of truth for
   * one window. Undefined leaves the shipped value in force.
   */
  firstEventMs: Schema.number().step(1).min(1).max(600_000),
  /** Watchdog: ms of body silence tolerated mid-stream (chat models). */
  bodyIdleMs: Schema.number().step(1).min(1).max(600_000),
  /** Watchdog: ms of body-idle floor for Responses models (muse-spark-*). */
  responsesBodyIdleMs: Schema.number().step(1).min(1).max(600_000),
  /**
   * The User-Agent sent on every Zen request. Ordinary config — the card
   * does not edit it, the profile patch does. No `.default()`: the adapter
   * owns the built-in CLI-identical string (ids.ts `opencodeUserAgent`), and
   * duplicating it here would be a second source of truth for one header.
   */
  userAgent: Schema.string(),
  /** A separate volatile field: edits apply to the next Zen request without restart. */
  requestHeaders: RequestHeadersConfigSchema,
  /**
   * Per-model context windows (model id -> tokens), served as their own
   * volatile node and read at model-resolution time. Empty = models.dev's
   * `limit.context` (with the built-in mimo override still in force).
   */
  modelContextWindows: ModelContextWindowsConfigSchema,
  /**
   * The Bun upstream relay (src/relay/): without it the free lane answers 429
   * no matter what this plugin sends. Ordinary config, not part of the
   * settings form — see the interface note.
   */
  relay: RelayConfigSchema,
  /** The ip-pool settings form (docs/ip-pool.md §5.1); served as this entry. */
  ipPool: IpPoolConfigSchema.volatile(),
})

/**
 * What `apply()` receives once the Loader has resolved {@link Config}.
 *
 * `ipPool` is a STABLE reference, not a value: the Loader commits a settings
 * save into the same object and announces it with `loader/volatile-update`, so
 * consumers read `.get()` at the moment they need a snapshot and never cache
 * the object it returned.
 */
export interface ResolvedPluginConfig extends Omit<ResolvedConfig, 'ipPool' | 'requestHeaders' | 'modelContextWindows'> {
  ipPool: VolatileRef<IpPoolSettings>
  requestHeaders: VolatileRef<RequestHeaders>
  modelContextWindows: VolatileRef<ModelContextWindows>
}

/** Every field except the volatile ip-pool and live-Zen references. */
export type OrdinaryPluginConfig = Omit<ResolvedPluginConfig, 'ipPool' | 'requestHeaders' | 'modelContextWindows'>

/**
 * The ordinary half of a resolved config, for the call sites that reconfigure
 * the pool runtime and need a plain object. Spreading the whole config instead
 * would hand `startIpPool` the volatile reference where it expects values.
 */
export function ordinaryConfig(config: ResolvedPluginConfig): OrdinaryPluginConfig {
  const { ipPool: _ipPool, requestHeaders: _requestHeaders, modelContextWindows: _modelContextWindows, ...ordinary } = config
  return ordinary
}
