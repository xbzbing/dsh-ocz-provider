import { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import Schema from "@deepseek-ai/schemastery";

//#region src/pool/local-family.d.ts

/** The 本机出口 positions the settings dropdown offers. */
type LocalIpFamily = 'auto' | 'ipv4' | 'ipv6';
//#endregion
//#region src/ip-pool-settings/namespace.d.ts

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
interface VolatileRef<T> {
  get(): T;
}
/** The resolved ip-pool settings value (schema defaults → base → user). */
interface IpPoolSettings {
  enabled: boolean;
  probeModels: string[];
  probeContents: string[];
  maxConcurrentProbes: number;
  poolSize: number;
  free: {
    enabled: boolean;
    targetSize: number;
    blockedCountries: string[];
  };
  manual: string[];
  subscription: {
    urls: string[];
    refreshMs: number;
    userAgent: string;
  };
  singbox: {
    path: string;
  };
  pinnedExitId: string;
  pinnedStrict: boolean;
  proxyHosts: string[];
  proxyPathPrefixes: string[];
  /** 本地出口兜底 (docs §3.3); false = a pool miss fails the request. */
  localFallback: boolean;
  /** 本机出口协议族; 'auto' = IPv6 where this machine has one (see the schema field). */
  localIpFamily: LocalIpFamily;
  maxRotateAttempts: number;
  /** 'total' (persisted ledger) or 'run' (this process); see the schema field. */
  usageScope: UsageScopeSetting;
}
/** The two usage scopes the UI switches between. */
type UsageScopeSetting = 'total' | 'run';
//#endregion
//#region src/model-context.d.ts
/**
 * Per-model context-window overrides for the Zen lane (settings → 模型上下文).
 *
 * The Zen catalog and models.dev do not always agree with what the endpoint
 * actually serves: models.dev declares `limit.context: 200000` for ids whose
 * card (and live behaviour) is 1M — `mimo-v2.6-flash-free` is the original
 * case, covered by a built-in override in adapter/catalog.ts. This module is
 * the operator-facing knob for every other id: `model-id = <tokens>`.
 *
 * Like request-headers.ts this file is SHARED by the Host and the browser
 * halves, so it must stay dependency-free (no node imports). Validation lives
 * at both boundaries instead of the schema (AGENTS.md: a callback-bearing
 * `Config` node breaks the settings form round trip):
 *   - the editor calls {@link normalizeModelContextWindows} (strict: a bad
 *     draft is refused with a message);
 *   - every catalog read calls {@link sanitizeModelContextWindows} (lenient: a
 *     hand-edited profile patch cannot inject an invalid window, and a bad
 *     entry never breaks a request or a model lookup).
 */
/** Model id -> context window in tokens. */
type ModelContextWindows = Record<string, number>;
//#endregion
//#region src/relay/supervisor.d.ts

/** Config the supervisor reads (subset of the plugin's `relay` node). */
interface RelayConfig {
  enabled?: boolean;
  /** Explicit bun binary. Empty/unset = search PATH and the usual install dirs. */
  bunPath?: string;
  /** Fixed port; 0/undefined = let the OS pick one. */
  port?: number;
  /** Upstream origin override (tests, or a lane that moves). */
  upstream?: string;
}
interface RelayLogSink {
  info(message: string): void;
  warn(message: string): void;
}
/** Structural spawn seam so tests can drive the lifecycle without bun. */
type RelaySpawn = (command: string, args: string[], options: {
  env: NodeJS.ProcessEnv;
  cwd?: string;
}) => ChildProcessWithoutNullStreams;
interface RelaySupervisorOptions {
  config?: RelayConfig;
  logger?: RelayLogSink;
  spawnImpl?: RelaySpawn;
  /** Script to run (defaults to the shipped relay next to the package root). */
  scriptPath?: string;
  /** Health probe target builder (tests point it at a fake). */
  healthFetch?: (url: string, signal: AbortSignal) => Promise<unknown>;
  /** Readiness window for `OC2DSH_RELAY_READY` + the health probe. */
  readyTimeoutMs?: number;
  /** Restart backoff ceiling (attempts beyond this give up for this process). */
  maxRestarts?: number;
  /**
   * Continuous uptime after which the restart budget is given back. A crash
   * loop still exhausts it; isolated crashes spread over hours no longer add
   * up to a permanent "gave up, requests go direct" state.
   */
  healthyResetMs?: number;
}
interface RelayStatus {
  /** True while a relay process is up and answering health probes. */
  active: boolean;
  /** `http://127.0.0.1:<port>` while active, null otherwise. */
  baseUrl: string | null;
  /** The bun binary in use (null when none was found). */
  bunPath: string | null;
  /** Upstream origin the relay forwards to. */
  upstream: string;
  /** Why the relay is not active (last failure), for diagnostics. */
  lastError: string;
  /** Restarts spent so far. */
  restarts: number;
}
/** Resolve the shipped relay script; empty string when the package is broken. */
declare function defaultRelayScript(): string;
/**
 * Find a bun binary: explicit config, then `OC2DSH_BUN`, then PATH, then the
 * usual install locations (bun's own installer, Homebrew on both prefixes, and
 * nvm's node bin dirs where this machine's bun lives).
 */
declare function findBun(configured?: string): string | null;
/**
 * Owns one relay child process. Idempotent start/stop; safe to call start()
 * repeatedly (a second call joins the running one).
 */
declare class RelaySupervisor {
  #private;
  constructor(options?: RelaySupervisorOptions);
  get upstream(): string;
  /**
   * The base URL of a live relay (`http://127.0.0.1:<port>`), or null when it
   * is not running. The adapter reads this PER REQUEST: a relay that died and
   * came back (new port) is picked up without rebuilding anything.
   */
  get baseUrl(): string | null;
  /** Diagnostics for the status file / bridge. */
  status(): RelayStatus;
  /**
   * Fire-and-forget warm-up for the paths that precede traffic (the host's
   * registration-time model list, and every prepareCall).
   *
   * `apply()` deliberately does NOT do this at load time: a plugin that forks a
   * process merely by being loaded is rude to hosts that never use this
   * provider, and it broke a real harness — a test process with mocked clocks
   * that only wants to exercise the adapter had a live bun child inside it and
   * misread the result (live 2026-10-25, test/watchdog-config.test.ts). Warming
   * on the two calls the host makes right before a turn costs nothing and keeps
   * the first request off the direct (429) path in practice.
   */
  warm(): void;
  /**
   * Start (or join) the relay. Resolves with the base URL, or null when the
   * relay cannot run here (no bun, missing script, disabled) — the caller then
   * keeps sending directly and logs `lastError` once.
   */
  start(): Promise<string | null>;
  /**
   * The relay's own base for one upstream ORIGIN (the lane ladder moves between
   * `/inference` and `/zen`): the relay forwards pathnames verbatim, so the
   * origin's path is preserved and only the scheme/host change.
   */
  baseUrlFor(origin: string): string | null;
  /** Stop the relay (plugin dispose). Idempotent. */
  stop(): Promise<void>;
}
//#endregion
//#region src/request-headers.d.ts
/** Shared validation for the settings editor and the Zen request path. */
type RequestHeaders = Record<string, string>;
//#endregion
//#region src/config.d.ts
/**
 * Plugin configuration (cordis config object, injected via cordis.patch.yml).
 */
interface Opencode2dshConfig {
  /**
   * Integration mode. `adapter` (default) registers a DSH LlmAdapter that
   * streams directly from the Zen anonymous lane — no child process. `sidecar`
   * (legacy, not bundled with the published package) spawns the Go agent
   * binary and registers an llm-pi-ai route to it; build the agent from
   * legacy/agent and pass agentPath.
   */
  mode?: 'adapter' | 'sidecar';
  /** Path to the agent binary (sidecar mode). Not bundled: build from legacy/agent. */
  agentPath?: string;
  /** Extra CLI args forwarded to the agent (after --config). */
  agentArgs?: string[];
  /** Provider route name registered into llm-pi-ai settings. */
  providerId?: string;
  /** Credential reference (env var name) holding the local agent token. */
  apiKeyEnv?: string;
  /** Model list refresh interval in seconds (agent refresh_seconds matches). */
  refreshSeconds?: number;
  /** Restart backoff: initial delay ms. */
  restartDelayMs?: number;
  /** Restart backoff: max delay ms. */
  restartMaxDelayMs?: number;
  /** Consecutive crash count that trips the circuit breaker. */
  maxConsecutiveCrashes?: number;
  /**
   * Watchdog: ms to wait for the first pi-ai stream event (issue #33). The
   * shipped window (zen-adapter.ts DEFAULT_FIRST_EVENT_MS) is the fallback
   * when unset, so nobody who does not set it sees a behavior change.
   */
  firstEventMs?: number;
  /** Watchdog: ms of body silence tolerated mid-stream (chat models). */
  bodyIdleMs?: number;
  /**
   * Watchdog: body-idle window for Responses models (muse-spark-*), whose
   * bursty reasoning needs the wider window (issue #7). Applied as a floor
   * over `bodyIdleMs`, never below it.
   */
  responsesBodyIdleMs?: number;
  /**
   * The User-Agent sent on every Zen request (adapter mode): chat, the model
   * catalog refresh and the pool's admission probes. Empty = the built-in
   * current-client shape (`opencode/latest/2.1.3/<client>`, where `<client>`
   * mirrors the effective `x-opencode-client`).
   *
   * The anonymous lane accepts a FINGERPRINT, not one string: this header
   * travels with the session/project/request id shapes and the tool
   * definitions, and mixing two generations answers 403. Change it only to a
   * UA whose generation you can keep coherent (adapter/ids.ts
   * `disguiseHeaders` holds the live-probed recipes).
   */
  userAgent?: string;
  /** Live Zen-only header overrides. Override userAgent when User-Agent is present. */
  requestHeaders?: RequestHeaders;
  /**
   * Per-model context-window overrides (model id -> tokens), for ids whose
   * models.dev `limit.context` understates what the endpoint really serves
   * (e.g. 200K declared, 1M available). Read on every model resolution, so a
   * settings save applies to the next request without a restart.
   */
  modelContextWindows?: ModelContextWindows;
  /**
   * The Bun upstream relay (src/relay/): the process that makes this plugin's
   * requests leave on the official client's connection stack.
   *
   * WHY IT IS NOT OPTIONAL IN PRACTICE (live 2026-10-25): the free lane gates on
   * the client's TLS/HTTP fingerprint. A byte-identical official request is
   * answered 429 by Node h1/h2, curl, Python and Go from every egress, and 200
   * when the same bytes leave through Bun (relay/supervisor.ts records the
   * matrix). Payload fixes cannot reach that layer, so the adapter addresses
   * its requests at a loopback relay that re-originates them with bun's own
   * fetch. `enabled: false` restores the pre-fix behaviour exactly (direct
   * Node requests, 429 on the free lane) — useful for probing, not for use.
   */
  relay?: RelayConfig;
  /**
   * IP-pool exit routing (docs/ip-pool.md). Everything below is pure plugin
   * config; the settings page (IP-6) will own these live, this object is
   * the cordis.patch.yml seam.
   */
  ipPool?: IpPoolConfig;
}
/** docs/ip-pool.md section 5.1 schema (subset owned by config today). */
interface IpPoolConfig {
  /** Master switch; false keeps the process exactly as today (direct). */
  enabled?: boolean;
  /** Manually added plain proxies: 'http://h:p' or 'socks5://h:p'. */
  manual?: string[];
  /** Fixed primary exit address (docs/ip-pool.md 3.6). */
  pinnedExitId?: string;
  /** Absolute pinning: never rotate, never direct-fallback (3.6). */
  pinnedStrict?: boolean;
  /** Hosts whose traffic goes through the pool (default opencode.ai). */
  proxyHosts?: string[];
  /** Path prefixes on those hosts the pool carries (default /inference/v1). */
  proxyPathPrefixes?: string[];
  /**
   * 本地出口兜底 (docs §3.3): may a request the pool cannot carry egress from
   * this machine? Default FALSE — an empty or fully-cooling pool fails the
   * request instead of leaking the local IP. An explicit 固定本机 pin is
   * honoured either way.
   */
  localFallback?: boolean;
  /**
   * 本机出口协议族 (local-family.ts): which IP family the LOCAL egress dials
   * with — `auto` (default) prefers IPv6 when this machine has a routable one
   * and falls back to IPv4, `ipv4` / `ipv6` pin the family. Exit traffic is
   * unaffected.
   */
  localIpFamily?: LocalIpFamily;
  /** Free-source pool (docs/ip-pool.md 1.2 source 1, 3.5, 4.5). */
  free?: {
    enabled?: boolean;
    /** Target capacity for the free pool (docs 3.5). */
    targetSize?: number;
    /** Admission geo blocklist (country codes). */
    blockedCountries?: string[];
  };
  /** Airport/Clash subscriptions (docs 1.2 source 3, IP-3). */
  subscriptions?: string[];
  /** Subscription refresh interval ms (docs 4.6, default 30min) and the fetch
   *  User-Agent (airports gate on it; empty = built-in default). */
  subscription?: {
    refreshMs?: number;
    userAgent?: string;
  };
  /** Cross-exit probe concurrency cap (docs 4.1; same-exit always serial). */
  maxConcurrentProbes?: number;
  /**
   * Whole-pool capacity: how many exits stay online at once, any source
   * (default 20). The onboarding speed-tests candidates, keeps the fastest
   * `poolSize` and shrinks the sing-box config to them, so it also bounds the
   * number of local SOCKS listeners.
   */
  poolSize?: number;
  /** sing-box conversion core for encrypted nodes (docs 1.2.2, IP-4). */
  singbox?: {
    /** sing-box binary: PATH name or absolute path; unset parks encrypted
     *  nodes as pending-conversion. */
    path?: string;
  };
  /** Admission smoke model (docs 4.1 probeModels[0]). */
  probeModels?: string[];
  /** Admission probe-content pool (docs 4.1 step 4); empty = ['hello']. */
  probeContents?: string[];
  /** Same-request rotate attempts on pre-content failures (docs 3.4). */
  maxRotateAttempts?: number;
}
type ResolvedConfig = Required<Pick<Opencode2dshConfig, 'providerId' | 'apiKeyEnv' | 'refreshSeconds' | 'restartDelayMs' | 'restartMaxDelayMs' | 'maxConsecutiveCrashes'>> & Opencode2dshConfig;
declare function resolveConfig(config?: Opencode2dshConfig): ResolvedConfig;
declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
  /** Integration mode; `adapter` (default) is the shipped shape. */
  mode: Schema<"adapter" | "sidecar", "adapter" | "sidecar", "defined">;
  /** Path to the agent binary (sidecar mode only; not bundled). */
  agentPath: Schema<string, string, "plain">;
  /** Extra CLI args forwarded to the agent (after --config). */
  agentArgs: Schema<string[], string[], "defined">;
  /** Provider route name registered into llm-pi-ai settings (sidecar mode). */
  providerId: Schema<string, string, "defined">;
  /** Credential reference (env var name) holding the local agent token. */
  apiKeyEnv: Schema<string, string, "defined">;
  /** Model list refresh interval in seconds. */
  refreshSeconds: Schema<number, number, "defined">;
  /** Restart backoff: initial delay ms. */
  restartDelayMs: Schema<number, number, "defined">;
  /** Restart backoff: max delay ms. */
  restartMaxDelayMs: Schema<number, number, "defined">;
  /** Consecutive crash count that trips the circuit breaker. */
  maxConsecutiveCrashes: Schema<number, number, "defined">;
  /**
   * Watchdog: ms to wait for the first stream event. No `.default()` on
   * purpose — the adapter owns those numbers (DEFAULT_FIRST_EVENT_MS &
   * friends), and duplicating them here would make two sources of truth for
   * one window. Undefined leaves the shipped value in force.
   */
  firstEventMs: Schema<number, number, "plain">;
  /** Watchdog: ms of body silence tolerated mid-stream (chat models). */
  bodyIdleMs: Schema<number, number, "plain">;
  /** Watchdog: ms of body-idle floor for Responses models (muse-spark-*). */
  responsesBodyIdleMs: Schema<number, number, "plain">;
  /**
   * The User-Agent sent on every Zen request. Ordinary config — the card
   * does not edit it, the profile patch does. No `.default()`: the adapter
   * owns the built-in CLI-identical string (ids.ts `opencodeUserAgent`), and
   * duplicating it here would be a second source of truth for one header.
   */
  userAgent: Schema<string, string, "plain">;
  /** A separate volatile field: edits apply to the next Zen request without restart. */
  requestHeaders: Schema<RequestHeaders, RequestHeaders, "volatile-defined">;
  /**
   * Per-model context windows (model id -> tokens), served as their own
   * volatile node and read at model-resolution time. Empty = models.dev's
   * `limit.context` (with the built-in mimo override still in force).
   */
  modelContextWindows: Schema<ModelContextWindows, ModelContextWindows, "volatile-defined">;
  /**
   * The Bun upstream relay (src/relay/): without it the free lane answers 429
   * no matter what this plugin sends. Ordinary config, not part of the
   * settings form — see the interface note.
   */
  relay: Schema<RelayConfig, RelayConfig, never>;
  /** The ip-pool settings form (docs/ip-pool.md §5.1); served as this entry. */
  ipPool: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    probeModels: Schema<string[], string[], "defined">;
    probeContents: Schema<string[], string[], "defined">;
    maxConcurrentProbes: Schema<number, number, "defined">;
    poolSize: Schema<number, number, "defined">;
    free: Schema<Schemastery.ObjectS<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      targetSize: Schema<number, number, "defined">;
      blockedCountries: Schema<string[], string[], "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      targetSize: Schema<number, number, "defined">;
      blockedCountries: Schema<string[], string[], "defined">;
    }>>, "plain">;
    manual: Schema<string[], string[], "defined">;
    subscriptions: Schema<string[], string[], "plain">;
    subscription: Schema<Schemastery.ObjectS<NoInfer<{
      urls: Schema<string[], string[], "defined">;
      refreshMs: Schema<number, number, "defined">;
      userAgent: Schema<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      urls: Schema<string[], string[], "defined">;
      refreshMs: Schema<number, number, "defined">;
      userAgent: Schema<string, string, "defined">;
    }>>, "plain">;
    singbox: Schema<Schemastery.ObjectS<NoInfer<{
      path: Schema<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      path: Schema<string, string, "defined">;
    }>>, "plain">;
    pinnedExitId: Schema<string, string, "defined">;
    pinnedStrict: Schema<boolean, boolean, "defined">;
    proxyHosts: Schema<string[], string[], "defined">;
    proxyPathPrefixes: Schema<string[], string[], "defined">;
    localFallback: Schema<boolean, boolean, "defined">;
    localIpFamily: Schema<string, string, "defined">;
    maxRotateAttempts: Schema<number, number, "defined">;
    usageScope: Schema<string, string, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    probeModels: Schema<string[], string[], "defined">;
    probeContents: Schema<string[], string[], "defined">;
    maxConcurrentProbes: Schema<number, number, "defined">;
    poolSize: Schema<number, number, "defined">;
    free: Schema<Schemastery.ObjectS<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      targetSize: Schema<number, number, "defined">;
      blockedCountries: Schema<string[], string[], "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      targetSize: Schema<number, number, "defined">;
      blockedCountries: Schema<string[], string[], "defined">;
    }>>, "plain">;
    manual: Schema<string[], string[], "defined">;
    subscriptions: Schema<string[], string[], "plain">;
    subscription: Schema<Schemastery.ObjectS<NoInfer<{
      urls: Schema<string[], string[], "defined">;
      refreshMs: Schema<number, number, "defined">;
      userAgent: Schema<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      urls: Schema<string[], string[], "defined">;
      refreshMs: Schema<number, number, "defined">;
      userAgent: Schema<string, string, "defined">;
    }>>, "plain">;
    singbox: Schema<Schemastery.ObjectS<NoInfer<{
      path: Schema<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      path: Schema<string, string, "defined">;
    }>>, "plain">;
    pinnedExitId: Schema<string, string, "defined">;
    pinnedStrict: Schema<boolean, boolean, "defined">;
    proxyHosts: Schema<string[], string[], "defined">;
    proxyPathPrefixes: Schema<string[], string[], "defined">;
    localFallback: Schema<boolean, boolean, "defined">;
    localIpFamily: Schema<string, string, "defined">;
    maxRotateAttempts: Schema<number, number, "defined">;
    usageScope: Schema<string, string, "defined">;
  }>>>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
  /** Integration mode; `adapter` (default) is the shipped shape. */
  mode: Schema<"adapter" | "sidecar", "adapter" | "sidecar", "defined">;
  /** Path to the agent binary (sidecar mode only; not bundled). */
  agentPath: Schema<string, string, "plain">;
  /** Extra CLI args forwarded to the agent (after --config). */
  agentArgs: Schema<string[], string[], "defined">;
  /** Provider route name registered into llm-pi-ai settings (sidecar mode). */
  providerId: Schema<string, string, "defined">;
  /** Credential reference (env var name) holding the local agent token. */
  apiKeyEnv: Schema<string, string, "defined">;
  /** Model list refresh interval in seconds. */
  refreshSeconds: Schema<number, number, "defined">;
  /** Restart backoff: initial delay ms. */
  restartDelayMs: Schema<number, number, "defined">;
  /** Restart backoff: max delay ms. */
  restartMaxDelayMs: Schema<number, number, "defined">;
  /** Consecutive crash count that trips the circuit breaker. */
  maxConsecutiveCrashes: Schema<number, number, "defined">;
  /**
   * Watchdog: ms to wait for the first stream event. No `.default()` on
   * purpose — the adapter owns those numbers (DEFAULT_FIRST_EVENT_MS &
   * friends), and duplicating them here would make two sources of truth for
   * one window. Undefined leaves the shipped value in force.
   */
  firstEventMs: Schema<number, number, "plain">;
  /** Watchdog: ms of body silence tolerated mid-stream (chat models). */
  bodyIdleMs: Schema<number, number, "plain">;
  /** Watchdog: ms of body-idle floor for Responses models (muse-spark-*). */
  responsesBodyIdleMs: Schema<number, number, "plain">;
  /**
   * The User-Agent sent on every Zen request. Ordinary config — the card
   * does not edit it, the profile patch does. No `.default()`: the adapter
   * owns the built-in CLI-identical string (ids.ts `opencodeUserAgent`), and
   * duplicating it here would be a second source of truth for one header.
   */
  userAgent: Schema<string, string, "plain">;
  /** A separate volatile field: edits apply to the next Zen request without restart. */
  requestHeaders: Schema<RequestHeaders, RequestHeaders, "volatile-defined">;
  /**
   * Per-model context windows (model id -> tokens), served as their own
   * volatile node and read at model-resolution time. Empty = models.dev's
   * `limit.context` (with the built-in mimo override still in force).
   */
  modelContextWindows: Schema<ModelContextWindows, ModelContextWindows, "volatile-defined">;
  /**
   * The Bun upstream relay (src/relay/): without it the free lane answers 429
   * no matter what this plugin sends. Ordinary config, not part of the
   * settings form — see the interface note.
   */
  relay: Schema<RelayConfig, RelayConfig, never>;
  /** The ip-pool settings form (docs/ip-pool.md §5.1); served as this entry. */
  ipPool: Schema<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    probeModels: Schema<string[], string[], "defined">;
    probeContents: Schema<string[], string[], "defined">;
    maxConcurrentProbes: Schema<number, number, "defined">;
    poolSize: Schema<number, number, "defined">;
    free: Schema<Schemastery.ObjectS<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      targetSize: Schema<number, number, "defined">;
      blockedCountries: Schema<string[], string[], "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      targetSize: Schema<number, number, "defined">;
      blockedCountries: Schema<string[], string[], "defined">;
    }>>, "plain">;
    manual: Schema<string[], string[], "defined">;
    subscriptions: Schema<string[], string[], "plain">;
    subscription: Schema<Schemastery.ObjectS<NoInfer<{
      urls: Schema<string[], string[], "defined">;
      refreshMs: Schema<number, number, "defined">;
      userAgent: Schema<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      urls: Schema<string[], string[], "defined">;
      refreshMs: Schema<number, number, "defined">;
      userAgent: Schema<string, string, "defined">;
    }>>, "plain">;
    singbox: Schema<Schemastery.ObjectS<NoInfer<{
      path: Schema<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      path: Schema<string, string, "defined">;
    }>>, "plain">;
    pinnedExitId: Schema<string, string, "defined">;
    pinnedStrict: Schema<boolean, boolean, "defined">;
    proxyHosts: Schema<string[], string[], "defined">;
    proxyPathPrefixes: Schema<string[], string[], "defined">;
    localFallback: Schema<boolean, boolean, "defined">;
    localIpFamily: Schema<string, string, "defined">;
    maxRotateAttempts: Schema<number, number, "defined">;
    usageScope: Schema<string, string, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: Schema<boolean, boolean, "defined">;
    probeModels: Schema<string[], string[], "defined">;
    probeContents: Schema<string[], string[], "defined">;
    maxConcurrentProbes: Schema<number, number, "defined">;
    poolSize: Schema<number, number, "defined">;
    free: Schema<Schemastery.ObjectS<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      targetSize: Schema<number, number, "defined">;
      blockedCountries: Schema<string[], string[], "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      enabled: Schema<boolean, boolean, "defined">;
      targetSize: Schema<number, number, "defined">;
      blockedCountries: Schema<string[], string[], "defined">;
    }>>, "plain">;
    manual: Schema<string[], string[], "defined">;
    subscriptions: Schema<string[], string[], "plain">;
    subscription: Schema<Schemastery.ObjectS<NoInfer<{
      urls: Schema<string[], string[], "defined">;
      refreshMs: Schema<number, number, "defined">;
      userAgent: Schema<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      urls: Schema<string[], string[], "defined">;
      refreshMs: Schema<number, number, "defined">;
      userAgent: Schema<string, string, "defined">;
    }>>, "plain">;
    singbox: Schema<Schemastery.ObjectS<NoInfer<{
      path: Schema<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
      path: Schema<string, string, "defined">;
    }>>, "plain">;
    pinnedExitId: Schema<string, string, "defined">;
    pinnedStrict: Schema<boolean, boolean, "defined">;
    proxyHosts: Schema<string[], string[], "defined">;
    proxyPathPrefixes: Schema<string[], string[], "defined">;
    localFallback: Schema<boolean, boolean, "defined">;
    localIpFamily: Schema<string, string, "defined">;
    maxRotateAttempts: Schema<number, number, "defined">;
    usageScope: Schema<string, string, "defined">;
  }>>>, "volatile">;
}>>, "plain">;
/**
 * What `apply()` receives once the Loader has resolved {@link Config}.
 *
 * `ipPool` is a STABLE reference, not a value: the Loader commits a settings
 * save into the same object and announces it with `loader/volatile-update`, so
 * consumers read `.get()` at the moment they need a snapshot and never cache
 * the object it returned.
 */
interface ResolvedPluginConfig extends Omit<ResolvedConfig, 'ipPool' | 'requestHeaders' | 'modelContextWindows'> {
  ipPool: VolatileRef<IpPoolSettings>;
  requestHeaders: VolatileRef<RequestHeaders>;
  modelContextWindows: VolatileRef<ModelContextWindows>;
}
/**
 * Everything the plugin persists next to the agent: the generated
 * agent-config.json (design.md section 8.3 template) and the local auth token.
 * The data directory doubles as the models.dev cache location for the agent.
 */
interface AgentConfigPaths {
  dataDir: string;
  configPath: string;
  tokenPath: string;
}
declare function configPaths(dataDir: string): AgentConfigPaths;
/**
 * Read the persisted token or generate and persist a fresh one.
 * Best-effort 0600 on POSIX; Windows profile dirs are user-scoped already.
 */
declare function ensureToken(paths: AgentConfigPaths): Promise<string>;
/**
 * Write agent-config.json atomically (tmp + rename) every plugin start, so a
 * version upgrade or option change reaches the next agent spawn. The agent
 * accepts JSON with comments; we emit plain JSON.
 */
declare function writeAgentConfig(paths: AgentConfigPaths, options: {
  token: string;
  refreshSeconds: number;
}): Promise<void>;
//#endregion
//#region src/agent-process.d.ts
/**
 * Drives the agent child process (design.md section 8.1-8.2):
 * spawn with piped stdio, READY-line handshake for the random port,
 * exponential-backoff restart on unexpected exit (1s -> 60s, circuit breaker
 * after N consecutive crashes), and graceful stop (SIGTERM -> 5s -> SIGKILL;
 * Windows uses taskkill /T because signals are not deliverable there).
 */
interface ReadyInfo {
  port: number;
  version: string;
}
type AgentState = 'starting' | 'ready' | 'stopped' | 'tripped';
declare class AgentProcess extends EventEmitter {
  #private;
  private child;
  private state;
  private consecutiveCrashes;
  private restartTimer;
  private stopping;
  private disposed;
  private backoffMs;
  private readySinceMs;
  private readonly agentPath;
  private readonly args;
  private readonly options;
  constructor(agentPath: string, args: string[], options: {
    restartDelayMs: number;
    restartMaxDelayMs: number;
    maxConsecutiveCrashes: number;
    onLog?: (line: string) => void;
  });
  getState(): AgentState;
  get readyInfo(): ReadyInfo | null;
  /** Spawn the agent and resolve with the READY handshake result. */
  start(readyTimeoutMs?: number): Promise<ReadyInfo>;
  /** Read stdout until the READY line (design.md section 8.2). */
  private readReadyLine;
  private pipeLogs;
  private onExit;
  private detach;
  /** Graceful stop: terminate, wait, then force-kill the whole tree. */
  stop(): Promise<void>;
  /** Idempotent teardown: no more restarts after dispose. */
  dispose(): Promise<void>;
  private terminate;
  private killTree;
  private taskkill;
  private setState;
}
//#endregion
//#region src/provider.d.ts
interface PiAiModelEntry {
  id: string;
  name: string;
}
interface ProviderTarget {
  providerId: string;
  apiKeyEnv: string;
  port: number;
}
declare function providerBaseURL(port: number): string;
/**
 * Minimal settings/credentials seam so tests can run against fakes.
 *
 * `mutate` is optional because DSH 0.1.7's `SettingsForms` always has it while
 * a reduced composition (and the sidecar's degraded fallback) may not; every
 * caller checks before writing rather than throwing on a missing writer.
 * The read face is `describe()` on 0.1.7, with 0.1.1's `get(ns)` tolerated.
 */
interface DshSeams {
  credentials: {
    set(ref: string, value: string): Promise<void>;
  };
  settings: {
    describe?(options?: {
      redactSecrets?: boolean;
    }): unknown;
    get?(ns: string): unknown;
    mutate?(ns: string, ops: Array<{
      op: 'set' | 'unset';
      path: Array<string | number>;
      value?: unknown;
    }>, expectedRevision?: number): Promise<void>;
  };
  logger: {
    info(message: string): void;
    warn(message: string): void;
  };
}
/** Parse the agent's OpenAI-shaped /v1/models reply into pi-ai model entries. */
declare function toPiAiModels(data: unknown): PiAiModelEntry[];
declare function fetchModels(port: number, token: string, timeoutMs?: number): Promise<PiAiModelEntry[]>;
/** GET /healthz (no auth); throws on transport failure or non-2xx. */
declare function fetchHealth(port: number, timeoutMs?: number): Promise<unknown>;
/**
 * Ensure the credential and the llm-pi-ai provider route reflect the running
 * agent. Safe to call repeatedly (every refresh): writes are no-ops when the
 * stored shape already matches, and mutate keeps other namespaces/routes
 * untouched because it edits only the oc2dsh subtree.
 */
declare function registerProvider(seams: DshSeams, target: ProviderTarget, token: string, models: PiAiModelEntry[]): Promise<void>;
//#endregion
//#region src/index.d.ts
/**
 * oc2dsh DSH cordis plugin entry.
 *
 * Two modes (config.mode, default `adapter`):
 *  - adapter: register a DSH LlmAdapter streaming directly from the Zen
 *    anonymous lane (marketplace shape: no child process, no binary).
 *  - sidecar (legacy/dev): prepare data dir + token + agent-config.json,
 *    spawn the Go agent, wait for READY, register the llm-pi-ai provider
 *    route, schedule model refresh.
 *
 * Settings: the editable surface is the `ipPool` field of {@link Config},
 * marked volatile. DSH 0.1.7 serves it under this entry's Loader id and
 * commits saves into the same reference, announcing them with
 * `loader/volatile-update`; there is no `ctx.settings.register()`.
 *
 * dispose(): stop timers/catalog, terminate the agent tree (sidecar mode).
 * The cordis fiber disposal guarantees this runs on plugin reload/unload and
 * on DSH shutdown.
 */
interface PluginContext {
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  llm?: {
    registerAdapter(providers: string[], adapter: unknown): unknown;
  };
  credentials?: {
    set(ref: string, value: string): Promise<void>;
  };
  /**
   * DSH 0.1.7 `SettingsForms` (dsh-settings). Read face for the sidecar's
   * namespace writes; `configure` is how a plugin claims its own settings
   * page instead of letting the domain auto-generate one. The 0.1.1
   * `register()/watch()` scope seam is gone and deliberately not re-declared.
   */
  /**
   * The host's workspace registry (`@deepseek-ai/dsh-workspace`), requested on
   * demand: it is the authority on which project a session belongs to, and the
   * usage ledger's 流量 tab joins session ids to it at read time.
   */
  workspaceRegistry?: {
    list?(): Array<{
      id: unknown;
      title: string;
      path: string;
      sessionIds?: readonly unknown[];
    }>;
  };
  /**
   * The host's session query engine (`@deepseek-ai/dsh-session-query`),
   * requested on demand: its title fold is the authority on what a session is
   * CALLED, and the usage ledger's 流量 tab joins session ids to it at read
   * time — the recorded first-prompt label stays only as the fallback.
   */
  sessionQuery?: {
    readTitleSnapshots?(sessionIds: readonly string[], signal?: AbortSignal): Promise<ReadonlyArray<{
      sessionId?: unknown;
      status?: unknown;
      value?: {
        title?: {
          title?: unknown;
        };
      } | undefined;
    }>>;
  };
  settings?: {
    describe?(options?: {
      redactSecrets?: boolean;
    }): unknown;
    get?(ns: string): unknown;
    mutate?(ns: string, ops: Array<{
      op: 'set' | 'unset';
      path: Array<string | number>;
      value?: unknown;
    }>, expectedRevision?: number): Promise<void>;
    configure?(presentation: {
      auto?: boolean;
    }, owner?: unknown): () => void;
  };
  /** Web route registration (dsh-host-webserver service, docs §5.3). */
  webServer?: {
    register(route: {
      kind: 'exact' | 'prefix';
      path: string;
      handler: (req: unknown, res: unknown) => void | Promise<void>;
    }): () => void;
  };
  /** cordis fiber injection: run the callback once every listed service is up. */
  inject?(services: string[], callback: (ctx: PluginContext) => void | Promise<void>): unknown;
  effect?(fn: () => () => void): unknown;
  on?(event: string, listener: (...args: never[]) => unknown): () => void;
}
declare const name = "oc2dsh";
/**
 * Only `llm` gates this fiber, because adapter mode (the shipped default) uses
 * nothing else: the Zen lane's credential is the literal `'public'`, and the
 * ip-pool settings ride the `Config` volatile reference. DSH 0.1.7 composes
 * `ctx.settings` as `SettingsForms`, which itself injects
 * `['configEditor', 'profileContext']` and ships disabled wherever no
 * `profileContext` exists (headless/CLI) — demanding it here kept the whole
 * fiber from ever activating, and with it the provider route. Sidecar mode and
 * the `configure({ auto: false })` page claim ask for the extra seams through
 * `ctx.inject` instead.
 */
declare const inject: readonly ["llm"];
declare function apply(ctx: PluginContext, config?: ResolvedPluginConfig | Opencode2dshConfig): void;
/**
 * Locate the agent binary (sidecar mode, legacy — the published package does
 * not bundle it): explicit config wins; then a sibling `legacy/agent` dev
 * build; then a bare name on PATH.
 */
declare function defaultAgentPath(): string;
//#endregion
export { AgentProcess, Config, type DshSeams, type Opencode2dshConfig, PluginContext, type RelayStatus, RelaySupervisor, apply, configPaths, defaultAgentPath, defaultRelayScript, ensureToken, fetchHealth, fetchModels, findBun, inject, name, providerBaseURL, registerProvider, resolveConfig, toPiAiModels, writeAgentConfig };