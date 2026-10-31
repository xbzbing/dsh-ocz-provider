/**
 * Shared browser-side shapes: the resolved `ipPool` settings value, the bridge
 * /status view (mirrors src/ip-pool-settings/bridge.ts) and the page-bound
 * settings form. Type-only apart from the bridge prefix, so every surface
 * (card, modal, usage panel, tests) can import it without pulling a component.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The bridge prefix (same-origin, loopback-only on the host). */
export const BRIDGE_PREFIX = '/api/oc2dsh/ip-pool'

/** Locale-bound copy for the `settings.ip-pool` namespace. */
export type IpPoolCardLocale = PropsLocale<'settings.ip-pool'>['t']

/** One settings write, as the Host's path-op vocabulary spells it. */
export type ConfigPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** The reactive values and commands this page reads and writes through. */
export interface ConfigPageForm {
  /** Accepted Host values, refreshed by the provider. */
  readonly state: ConfigFormSnapshot<Record<string, unknown>>
  /** Submit field edits together with the revision the editor read. */
  mutate(ops: readonly ConfigPathOp[], expectedRevision?: number): Promise<boolean>
}

/** The two usage scopes the UI switches between. */
export type UsageScopeView = 'total' | 'run'

/** The three 本机出口协议族 positions (mirrors src/pool/local-family.ts). */
export type LocalIpFamilyView = 'auto' | 'ipv4' | 'ipv6'

/** The resolved ip-pool settings value (mirrors the schemastery schema). */
export interface IpPoolSettingsValue {
  enabled: boolean
  probeModels: string[]
  /** Probe-content pool; empty = the Host default ('hello'). */
  probeContents: string[]
  maxConcurrentProbes: number
  /** Whole-pool capacity: exits kept online at once (default 10). */
  poolSize: number
  manual: string[]
  subscription: { urls: string[]; refreshMs: number; userAgent: string }
  /** Previous composition spelling, migrated on a subscription edit. */
  subscriptions?: string[]
  singbox: { path: string }
  pinnedExitId: string
  pinnedStrict: boolean
  proxyHosts: string[]
  /** 本地出口兜底: false = a pool miss fails instead of using this machine. */
  localFallback: boolean
  /** 本机出口协议族: 'auto' = IPv6 where this machine has one (default). */
  localIpFamily: LocalIpFamilyView
  /** 'total' = the persisted ledger, 'run' = this host process. */
  usageScope: UsageScopeView
}

/** Per-exit token totals (mirrors src/pool/usage.ts TokenTotals). */
export interface TokenTotalsView {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** Cumulative decode window (ms), diagnostics only; older hosts omit it. */
  outputMs?: number
}

/** One exit row of the /status view. */
export interface ExitRowView {
  id: string
  source: string
  protocol: string
  pinned: boolean
  exitIP: string
  exitLocation: string
  latencyMs: number
  quality: string
  state: 'unknown' | 'ok' | 'dead'
  cooling: boolean
  cooldownUntil: number
  consecutiveLimited: number
  bannedModels: Array<{ model: string; state: 'suspect' | 'banned'; bannedAt: number }>
  /** `'abusive'` = OpenCode flagged this exit's IP; the row is benched for hours. */
  note?: string
  passive: { ok: number; limited: number; refused: number; dead: number; transport: number }
  /** Sum of the passive buckets — the stats modal's sort key. */
  requests: number
  /** Epoch ms of the most recent dispatch (0 = never). */
  lastUsedAt: number
  inFlight: number
  /** Rejected upstream with no reserve left: kept as the last resort, listed last. */
  demoted?: boolean
  /** Follows the usage scope: the persisted ledger for 总览, this process for 本次重启. */
  tokens: TokenTotalsView
  /** Recent (3-min window) output speed in tok/s; 0 = hidden. */
  speed?: number
}

/**
 * The persistent usage ledger as /status serves it (mirrors bridge.ts
 * UsageView). Optional on the status view so an older host snapshot parses.
 */
export interface UsageView {
  scope: UsageScopeView
  retentionDays: number
  /** When this process started (the run scope's origin). */
  runSince: number
  /** All-time persisted totals — the footer's 总览 figure. */
  total: TokenTotalsView
  /** Totals for the scope being shown. */
  scoped: TokenTotalsView
  /** Recent (3-min window) output speed in tok/s, the same under every scope; 0 = hidden. */
  recentSpeed?: number
  days: Array<{ day: string; requests: number; tokens: number; outputTokens: number; outputMs: number }>
  sessions: Array<{
    id: string
    label: string
    requests: number
    tokens: number
    outputTokens: number
    outputMs: number
    firstAt: number
    lastAt: number
    project: { id: string; title: string; path: string } | null
  }>
  projects: Array<{ id: string; title: string; path: string; requests: number; tokens: number; sessions: number; lastAt: number }>
  stored: { sessions: number; days: number; exits: number }
}

/** Bridge /status view. Optional fields are absent on older host snapshots. */
export interface PoolStatusView {
  zenUserAgent?: string
  /** The pool runtime is running (not the draft switch on the card). */
  enabled: boolean
  /** Whether the pool runtime exists at all (absent on older host snapshots). */
  runtimeReady?: boolean
  deferredReason: string
  /** Composing dispatcher this layer runs below (absent on older snapshots). */
  composedUnder?: string
  total: number
  bySource: Record<'manual' | 'subscription' | 'goproxy', number>
  /** Usable exits across the whole pool, any source. */
  availableTotal: number
  /** Whole-pool capacity in force (settings `poolSize`, default 10). */
  poolSize: number
  /** The pin in force. `local` marks the 本机 sentinel (no exit at all). */
  pinned: { id: string; strict: boolean; local?: boolean } | null
  /** Why the pin is not carrying traffic right now; null = in use or nothing pinned. */
  pinnedSkip?: 'dead' | 'cooling' | null
  proxyHosts: string[]
  exits: ExitRowView[]
  prober: { queued: number; inFlight: number; enqueued: number; completed: number }
  subscription: { urlCount: number; pendingConversion: number; convertedAdmitted: number; plaintextAdmitted: number; lastFetch: number; lastError: string } | null
  /** Pool-host requests that fell back to direct, with their tokens. */
  direct: { requests: number; tokens: TokenTotalsView }
  /** Model traffic that egressed from this machine: the modal's 本机 row. */
  local?: { requests: number; tokens: TokenTotalsView; lastUsedAt: number; speed?: number }
  /** The persistent usage ledger. */
  usage?: UsageView | null
  /** Pool-wide recent (3-min window) output speed in tok/s; 0 = hidden. */
  recentSpeed?: number
  /** Today's all-in token figure (ledger day bucket): the footer's token figure. */
  todayTokens?: number
  /** 本地出口兜底 in force on the router. */
  localFallback?: boolean
  /** 本机出口协议族 in force on the router. */
  localIpFamily?: LocalIpFamilyView
  at: number
}
