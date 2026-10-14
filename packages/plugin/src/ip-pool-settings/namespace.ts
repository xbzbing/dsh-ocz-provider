/**
 * ip-pool settings namespace (docs/ip-pool.md §5.1) — the schemastery schema
 * the plugin's `Config` marks volatile, and the live re-apply wiring.
 *
 * Two entry states (docs §5 phase IP-5):
 *  - `ipPool.enabled` in the entry config at plugin boot: the Loader resolves
 *    it into the volatile reference, so the pool assembles immediately;
 *  - the user flips `enabled` on in the settings page later: the committed
 *    value lands in the same reference, `loader/volatile-update` fires, and
 *    the pool assembles then.
 *
 * Everything the card can change lands through that event and is applied to
 * the LIVE runtime (no restart): manual/pinned address lists rebuild the exit
 * table's manual rows, subscription URLs/refresh re-seed the fetcher, probe
 * knobs go straight to the Prober, geo blocklist to the admission deps, and
 * toggling `enabled` installs/uninstalls the global dispatcher.
 *
 * DSH 0.1.7 owns this seam end to end: there is no `ctx.settings.register()`.
 * A plugin's editable settings ARE the volatile fields of its own exported
 * `Config`, and the namespace they are served under is the Loader entry id
 * (`dsh-settings` reads `entry.options.id`). So this constant mirrors the
 * `id:` of the row in cordis.patch.yml, and the client half spells the same
 * literal (a browser package may not import a Host one).
 */

import Schema from '@deepseek-ai/schemastery'

import { DEFAULT_SMOKE_CONTENT, normalizeSmokeContents } from '../pool/smoke-content.ts'
import { DEFAULT_SUBSCRIPTION_USER_AGENT } from '../pool/subscription.ts'

/**
 * Settings namespace owned by this plugin: the Loader entry id declared by
 * `cordis.patch.yml`. Mirrored by `SETTINGS_NAMESPACE` in src/client/index.ts.
 */
export const IP_POOL_NAMESPACE = 'opencode2dsh'

/**
 * cosmokit's volatile config reference, structurally typed.
 *
 * DSH wraps every `.volatile()` Config field in one of these and hands the
 * plugin a STABLE reference whose `get()` returns the current immutable
 * snapshot; the Loader commits saves into the same object and announces them
 * with `loader/volatile-update`. Declared structurally (rather than imported
 * from cosmokit/cordis) to keep the plugin independent of the host's exact
 * @deepseek-ai version, per the PluginContext discipline in src/index.ts.
 */
export interface VolatileRef<T> {
  get(): T
}

/** True when a value is one of the Loader's stable volatile references. */
export function isVolatileRef<T>(value: unknown): value is VolatileRef<T> {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Read a volatile reference, tolerating an absent one and a host that handed
 * over a plain object instead (a composition predating the `Config` export, or
 * a direct unit-test invocation of `apply()`).
 */
export function readVolatile<T>(value: VolatileRef<T> | T | undefined): T | undefined {
  if (value === undefined) return undefined
  return isVolatileRef<T>(value) ? value.get() : value
}

/** docs/ip-pool.md §4.6 probe defaults (S3 first entry is the doc-mandated default). */
const DEFAULT_PROBE_MODEL = 'big-pickle'

export const IpPoolConfigSchema = Schema.object({
  /** Master switch; false keeps the process exactly as today (direct). */
  enabled: Schema.boolean().default(false),
  /** Probe model set; empty = [S3 first] (docs §4.6 probeModels). */
  probeModels: Schema.array(Schema.string()).default([]),
  /**
   * Probe-content pool: the smoke request's user turn is picked from it at
   * random (live request 2026-10-14). Empty = {@link DEFAULT_SMOKE_CONTENT}.
   */
  probeContents: Schema.array(Schema.string()).default([]),
  /** Cross-exit probe concurrency cap (1-8; same-exit is always serial, §4.1). */
  maxConcurrentProbes: Schema.number().min(1).max(8).step(1).default(3),
  /**
   * Whole-pool capacity — how many exits stay online at once, any source
   * (default 10). The onboarding speed-tests every candidate, keeps the
   * fastest `poolSize` and shrinks the sing-box config to them, so this is
   * also the number of local SOCKS listeners the pool opens.
   */
  poolSize: Schema.number().min(1).max(100).step(1).default(10),
  free: Schema.object({
    /** Free-source fetching master switch (docs §1.2 source 1). */
    enabled: Schema.boolean().default(true),
    /** Free-pool target capacity (docs §3.5). */
    targetSize: Schema.number().min(1).max(100).step(1).default(20),
    /** Admission geo blocklist (ISO country codes). */
    blockedCountries: Schema.array(Schema.string()).default(['CN']),
  }),
  /** Manually added plain proxies: 'http://h:p' or 'socks5://h:p' (§1.2 source 2). */
  manual: Schema.array(Schema.string()).default([]),
  /**
   * Previous patch spelling. A plain (default-less) array field here does NOT
   * stay undefined the way this comment once assumed: `Schema.array()` resolves
   * an absent array to `[]`, so the field is always present in a served value.
   * `resolveIpPoolSettings()` therefore prefers nested `subscription.urls` and
   * only falls back to this key when that one is empty.
   */
  subscriptions: Schema.array(Schema.string()),
  subscription: Schema.object({
    /** Airport/self-hosted subscription URLs (display-redacted client-side, §5.1). */
    urls: Schema.array(Schema.string()).default([]),
    /** Subscription refresh interval (§4.6, one request per URL per refresh). */
    refreshMs: Schema.number().min(60_000).max(24 * 60 * 60_000).step(1).default(30 * 60_000),
    /**
     * Fetch User-Agent for subscription URLs (§4.6). Airports gate on it and
     * some pick the returned format from it, so it stays user-editable without
     * a plugin release. Empty = the built-in default.
     */
    userAgent: Schema.string().default(DEFAULT_SUBSCRIPTION_USER_AGENT),
  }),
  singbox: Schema.object({
    /** sing-box binary: PATH name or absolute path; empty parks encrypted nodes. */
    path: Schema.string().default('sing-box'),
  }),
  /** Fixed primary exit address (docs §3.6). */
  pinnedExitId: Schema.string().default(''),
  /** Absolute pinning: never rotate, never direct-fallback (docs §3.6). */
  pinnedStrict: Schema.boolean().default(false),
  /** Hosts whose traffic goes through the pool (default opencode.ai). */
  proxyHosts: Schema.array(Schema.string()).default([]),
  /**
   * Path prefixes on those hosts the pool carries (default `/zen/v1`, this
   * plugin's own lane). Empty = every path on the host, which also drags the
   * separate `opencode-go` provider's `/zen/go/v1` calls through the exits.
   */
  proxyPathPrefixes: Schema.array(Schema.string()).default([]),
  /** Same-request rotate attempts on pre-content transport/429 failures (§3.4). */
  maxRotateAttempts: Schema.number().min(0).max(10).step(1).default(3),
  /**
   * Which population the usage surfaces report (live request 2026-10-14):
   * `total` = the persisted ledger (up to 90 days, survives restarts), `run` =
   * this host process only. A string rather than a union schema so a hand-edited
   * profile cannot make the field unreadable; anything but 'run' resolves to
   * `total`.
   */
  usageScope: Schema.string().default('total'),
})

/** The resolved ip-pool settings value (schema defaults → base → user). */
export interface IpPoolSettings {
  enabled: boolean
  probeModels: string[]
  probeContents: string[]
  maxConcurrentProbes: number
  poolSize: number
  free: { enabled: boolean; targetSize: number; blockedCountries: string[] }
  manual: string[]
  subscription: { urls: string[]; refreshMs: number; userAgent: string }
  singbox: { path: string }
  pinnedExitId: string
  pinnedStrict: boolean
  proxyHosts: string[]
  proxyPathPrefixes: string[]
  maxRotateAttempts: number
  /** 'total' (persisted ledger) or 'run' (this process); see the schema field. */
  usageScope: UsageScopeSetting
}

/** The two usage scopes the UI switches between. */
export type UsageScopeSetting = 'total' | 'run'

/** Anything but 'run' resolves to the persisted scope. */
export function resolveUsageScope(value: unknown): UsageScopeSetting {
  return value === 'run' ? 'run' : 'total'
}

/** Resolve the schema-level default for the probe model set (§4.6). */
export function resolveProbeModels(configured: string[]): string[] {
  if (configured.length > 0) return [...new Set(configured)]
  return [DEFAULT_PROBE_MODEL]
}

/**
 * Resolve the probe-content pool (§4.5 step 4): trimmed and deduped, or the
 * single default when nothing is configured — the runtime always hands
 * admission a non-empty pool, so the random pick has something to choose from.
 */
export function resolveProbeContents(configured: string[]): string[] {
  const pool = normalizeSmokeContents(configured)
  return pool.length > 0 ? pool : [DEFAULT_SMOKE_CONTENT]
}

/**
 * Either layer's ip-pool spelling: the resolved settings value (the volatile
 * reference's snapshot) and the flat entry-config shape, which carries
 * subscription URLs under the legacy `subscriptions` key.
 *
 * Declared as a recursive partial rather than `Partial<IpPoolSettings> & ...`,
 * because the latter intersects the REQUIRED nested `subscription` shape with
 * its partial and so still demands `refreshMs` from a patch that only sets
 * `urls` — exactly the half-written form the defaults exist to complete.
 */
export interface AnyIpPoolSection {
  enabled?: boolean
  manual?: string[]
  pinnedExitId?: string
  pinnedStrict?: boolean
  proxyHosts?: string[]
  proxyPathPrefixes?: string[]
  free?: Partial<IpPoolSettings['free']>
  /** Settings spelling: nested. */
  subscription?: Partial<IpPoolSettings['subscription']>
  /** Entry-config spelling: flat list, legacy key. */
  subscriptions?: string[]
  singbox?: Partial<IpPoolSettings['singbox']>
  probeModels?: string[]
  probeContents?: string[]
  maxConcurrentProbes?: number
  poolSize?: number
  maxRotateAttempts?: number
  usageScope?: string
}

/**
 * Fill every default into one ip-pool value, from whichever layer produced
 * it. Deliberately schema-independent: the volatile reference is the
 * authoritative source, but a composition that predates the `Config` export
 * (or a hand-edited profile patch) can still present the flat spelling, and
 * neither may crash the boot path.
 */
export function resolveIpPoolSettings(value: AnyIpPoolSection | undefined): IpPoolSettings {
  const raw = value ?? {}
  // Subscription URLs live under the canonical nested `subscription.urls`; the
  // flat `subscriptions` key is the PREVIOUS patch spelling, kept only for
  // older compositions. It cannot be tested with `??`: a resolved value has
  // already been through the schema, and `Schema.array()` gives an ARRAY an
  // implicit `[]` even without `.default()` — so `subscriptions` is never
  // nullish, and a `??` chain lets that empty array shadow every URL the
  // settings page writes. The pool then assembles with zero subscription URLs
  // and never creates the fetcher at all. Prefer the nested spelling whenever
  // it carries content; fall back to the legacy key only when it does not.
  const nestedUrls = raw.subscription?.urls ?? []
  const legacyUrls = raw.subscriptions ?? []
  const urls = nestedUrls.length > 0 ? nestedUrls : legacyUrls
  return {
    enabled: raw.enabled ?? false,
    probeModels: raw.probeModels ?? [],
    probeContents: raw.probeContents ?? [],
    maxConcurrentProbes: raw.maxConcurrentProbes ?? 3,
    poolSize: raw.poolSize ?? 10,
    free: {
      enabled: raw.free?.enabled ?? true,
      targetSize: raw.free?.targetSize ?? 20,
      blockedCountries: raw.free?.blockedCountries ?? ['CN'],
    },
    manual: raw.manual ?? [],
    subscription: {
      urls,
      refreshMs: raw.subscription?.refreshMs ?? 30 * 60_000,
      userAgent: raw.subscription?.userAgent ?? DEFAULT_SUBSCRIPTION_USER_AGENT,
    },
    singbox: { path: raw.singbox?.path ?? 'sing-box' },
    pinnedExitId: raw.pinnedExitId ?? '',
    pinnedStrict: raw.pinnedStrict ?? false,
    proxyHosts: raw.proxyHosts ?? [],
    proxyPathPrefixes: raw.proxyPathPrefixes ?? [],
    maxRotateAttempts: raw.maxRotateAttempts ?? 3,
    usageScope: resolveUsageScope(raw.usageScope),
  }
}

/**
 * Map one resolved settings value onto the plugin config shape (config.ts).
 * Round-trip complete: every field the runtime reads must survive here, or a
 * live commit silently resets it to the default.
 */
export function toIpPoolConfig(value: IpPoolSettings): {
  enabled: boolean
  manual: string[]
  pinnedExitId: string
  pinnedStrict: boolean
  proxyHosts: string[]
  proxyPathPrefixes: string[]
  free: { enabled: boolean; targetSize: number; blockedCountries: string[] }
  subscriptions: string[]
  subscription: { refreshMs: number; userAgent: string }
  singbox: { path: string }
  probeModels: string[]
  probeContents: string[]
  maxConcurrentProbes: number
  poolSize: number
  maxRotateAttempts: number
  usageScope: UsageScopeSetting
} {
  return {
    enabled: value.enabled,
    manual: value.manual,
    pinnedExitId: value.pinnedExitId,
    pinnedStrict: value.pinnedStrict,
    proxyHosts: value.proxyHosts,
    proxyPathPrefixes: value.proxyPathPrefixes,
    free: {
      enabled: value.free.enabled,
      targetSize: value.free.targetSize,
      blockedCountries: value.free.blockedCountries,
    },
    subscriptions: value.subscription.urls,
    subscription: { refreshMs: value.subscription.refreshMs, userAgent: value.subscription.userAgent },
    singbox: { path: value.singbox.path },
    probeModels: resolveProbeModels(value.probeModels),
    probeContents: resolveProbeContents(value.probeContents),
    maxConcurrentProbes: value.maxConcurrentProbes,
    poolSize: value.poolSize,
    maxRotateAttempts: value.maxRotateAttempts,
    usageScope: value.usageScope,
  }
}
