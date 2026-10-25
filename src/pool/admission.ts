/**
 * Admission probe — the gate a free-source candidate must pass before it
 * becomes an ExitNode (docs/ip-pool.md 4.5). Four steps, fail-fast:
 *
 *   1. connectivity + latency   (via the candidate, GET an IP echo endpoint)
 *   2. exit IP + geo            (same response; also the pool's routing key)
 *   3. HTTPS tunnel             (via the candidate, GET the Zen models list —
 *                                probing the real target beats generic test
 *                                sites, and a forged 200 cannot fake step 4)
 *   4. anonymous-lane smoke     (1-token chat via the candidate)
 *
 * All requests carry their own ProxyAgent (per-request dispatch, verified
 * against npm undici): the admission path never touches the global
 * dispatcher.
 *
 * Which steps a source runs:
 *   - free candidates        -> the full chain (steps 1-4)
 *   - manual/subscription/   -> admitTrusted: smoke only (their node facts
 *     goproxy probe action     already exist) — this is the SETTINGS CARD's
 *                              探测/批量探活 action, an explicit user request
 *   - subscription add/      -> admitBySpeed: steps 1-2 ONLY — the speed test
 *     refresh                   whose latency the pool displays. Per operator
 *                              decision 2026-10-24 (添加订阅后，不对 OpenCode
 *                              进行任何主动探测，只显示测速的延迟) neither the
 *                              refresh nor a later reserve swap sends a single
 *                              request to OpenCode; acceptance of an exit IP
 *                              is learned passively from real traffic.
 *                              pinned nodes are admitted with warnings instead
 *                              of rejections (the user vouches, 3.1).
 */

import type { Dispatcher } from 'undici'

import { ZEN_BASE_URL } from '../adapter/catalog.ts'
import { renderEnvBlock } from '../adapter/env-block.ts'
import { EGRESS_HEADER } from '../relay/egress.ts'
import { FREE_LANE_GATE_TOOL_NAMES, freeLaneGateTool } from '../adapter/gate-tools.ts'
import { canonicalSessionID, DEFAULT_PROJECT_ID, disguiseHeaders, mintedMessageID, opencodeUserAgent } from '../adapter/ids.ts'
import { laneOrigins } from '../adapter/lane.ts'
import { gradeOf, UNVERIFIED_QUALITY, type ExitNode, type ExitPool } from './pool.ts'
import { exitProxyUri } from './dispatcher.ts'
import { pickSmokeContent } from './smoke-content.ts'

export interface AdmissionDeps {
  pool: ExitPool
  undici: {
    ProxyAgent: new (options: { uri: string; clientFactory?: (origin: URL | string, options?: unknown) => unknown }) => Dispatcher
    request(url: string, options: { dispatcher: Dispatcher; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ statusCode: number; body: { text(): Promise<string> } }>
  }
  /** zen endpoint override for tests. */
  zenBaseUrl?: string
  /** Second origin rung for tests; defaults to the lane ladder. */
  fallbackBaseUrl?: string
  /** ip echo override for tests. */
  ipEchoUrl?: string
  /** chat model for the smoke request (probeModels[0] upstream). */
  smokeModel?: string
  /**
   * Probe-content pool (settings `probeContents`): ONE entry is drawn per
   * exit probe — i.e. once per call into this module, so a candidate's whole
   * admission shares one turn (live correction 2026-10-14: 每个出口随机抽一个).
   * Empty/undefined falls back to {@link DEFAULT_SMOKE_CONTENT}
   * (smoke-content.ts).
   */
  smokeContents?: string[]
  /**
   * A pre-drawn turn for one exit's whole pass. Callers that probe one exit
   * across SEVERAL models (the runtime's per-exit pass) set this once, so
   * every model of that exit sends the same sentence and the draw stays a
   * per-exit decision instead of a per-request one.
   */
  smokeContent?: string
  /** Injected for tests: the random draw's source. */
  random?: () => number
  timeoutMs?: number
  blockedCountries?: string[]
  /**
   * The Bun relay's base URL, read at probe time (null while it is down).
   *
   * A smoke request is a real chat call, so it faces the SAME connection-stack
   * gate the adapter does: sent from undici it is answered 429 whatever its
   * payload, which the verdict table then reads as "exit quota consumed" and
   * cools a perfectly good exit (2026-10-25). With a relay up, the smoke goes
   * through it with the candidate's own egress, and the verdict means what it
   * says. The models-list step stays direct — it is not gated, and probing it
   * through the relay would hide a broken exit behind a working relay.
   */
  relayBaseUrl?: () => string | null
  logger?: { warn(message: string): void }
}

export interface EchoFacts {
  exitIP: string
  exitLocation: string
  latencyMs: number
}

/**
 * Coarse screen (admission steps 1+2, docs/ip-pool.md 4.5 修订): one request
 * through the candidate to the ip echo. This step touches only the wild
 * candidate and a public IP service — never the anonymous lane — so callers
 * may fan it out at high concurrency (admissionFanout; GoProxy uses 300 for
 * the same reason). Steps 3-4 (which spend anonymous-lane quota) stay on the
 * bounded Prober.
 */
export async function coarseScreen(
  deps: Pick<AdmissionDeps, 'undici' | 'ipEchoUrl' | 'blockedCountries' | 'logger'>,
  candidate: { address: string; protocol: 'http' | 'socks5' },
  options: { relaxed?: boolean; pinned?: boolean; timeoutMs?: number } = {},
): Promise<EchoFacts | { rejected: string }> {
  const ipEcho = deps.ipEchoUrl ?? DEFAULT_IP_ECHO
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const blocked = new Set(deps.blockedCountries ?? ['CN'])
  const maxResponseMs = options.relaxed ? RELAXED_RESPONSE_MS : 3_000

  let agent: Dispatcher | null = null
  try {
    // exitProxyUri keeps a scheme the address already carries (issue #44):
    // manual ids are parsed with their scheme, and `http://http://host:port`
    // makes undici's ProxyAgent throw InvalidArgumentError.
    agent = new deps.undici.ProxyAgent({ uri: exitProxyUri(candidate.address, candidate.protocol) })
  } catch (err) {
    return { rejected: `agent-build: ${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    const started = Date.now()
    const echo = await withTimeout(
      deps.undici.request(ipEcho, { dispatcher: agent }),
      timeout,
      'probe',
    )
    const latencyMs = Date.now() - started
    if (echo.statusCode !== 200) return { rejected: `echo HTTP ${echo.statusCode}` }
    let body: EchoResponse
    try {
      body = JSON.parse(await echo.body.text()) as EchoResponse
    } catch {
      return { rejected: 'echo body not JSON' }
    }
    if (body.status !== 'success' || !body.query) return { rejected: 'echo did not report an exit IP' }
    const country = body.countryCode?.toUpperCase() ?? ''
    if (blocked.has(country)) return { rejected: `geo-blocked ${country}` }
    if (latencyMs > maxResponseMs && !options.pinned) {
      return { rejected: `latency ${latencyMs}ms > ${maxResponseMs}ms` }
    }
    return {
      exitIP: body.query,
      exitLocation: `${body.countryCode} ${body.city}`.trim(),
      latencyMs,
    }
  } catch (err) {
    return { rejected: err instanceof Error ? err.message : String(err) }
  } finally {
    void agent.close().catch(() => {})
  }
}

/** Bounded fan-out helper for the coarse screen (wild candidates only).
 *  onProgress reports (screensCompleted, survivorsSoFar) as the fan-out runs
 *  (settings-page refill progress, docs §5.3). */
export async function coarseScreenBatch(
  deps: Parameters<typeof coarseScreen>[0],
  candidates: Array<{ address: string; protocol: 'http' | 'socks5' }>,
  options: { fanout?: number; relaxed?: boolean; timeoutMs?: number; onProgress?: (done: number, passed: number) => void } = {},
): Promise<Map<string, EchoFacts>> {
  const fanout = Math.max(1, options.fanout ?? 300)
  const results = new Map<string, EchoFacts>()
  const queue = [...candidates]
  let done = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const candidate = queue.shift()
      if (candidate === undefined) return
      const verdict = await coarseScreen(deps, candidate, options)
      done += 1
      if ('exitIP' in verdict) results.set(candidate.address, verdict)
      options.onProgress?.(done, results.size)
    }
  }
  await Promise.all(Array.from({ length: Math.min(fanout, candidates.length) }, () => worker()))
  return results
}

interface EchoResponse {
  status: string
  query: string
  countryCode: string
  city: string
}

const DEFAULT_IP_ECHO = 'http://ip-api.com/json/?fields=status,country,countryCode,city,query'
const DEFAULT_TIMEOUT_MS = 8_000
/** critical-state relaxed latency gate (docs/ip-pool.md 4.6 maxResponseMs). */
const RELAXED_RESPONSE_MS = 6_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** One admission probe for one candidate address. Pure effects: returns the
 *  verdict; the caller (refill scheduler) applies it to the pool. */
export interface AdmissionResult {
  admitted: boolean
  node?: ExitNode
  /** Step that rejected the candidate, with the reason (diagnostics). */
  reason?: string
  /**
   * The candidate passed every step except quota: alive proxy, working Zen
   * tunnel, 429 at smoke (2026-09-05 decision: these are good exits whose
   * quota is consumed elsewhere — free proxies are shared worldwide). The
   * caller admits them and immediately cools them (markLimited), so the
   * periodic probe retries when the cooldown expires.
   */
  limited?: boolean
  /**
   * Trusted-source fallback: admission did NOT verify this candidate (the
   * probe never got a response through the exit), but the node is kept
   * because the source is paid and the address is the routing key
   * (docs §4.5: never evict a subscription line over one probe failure).
   *
   * Callers MUST NOT read this as "healthy". Live 2026-10-13: five dead
   * subscription exits (one trojan pointed at 10.255.255.255, two behind an
   * unreachable 166.0.16.46, one hysteria2 port refused, one anytls edge
   * whose TLS never completed) were re-admitted by this fallback and then
   * markOk()'d on every probe round — state `ok`, grade `S` (gradeOf(0)),
   * `exitIP` unknown — so the picker ranked them FIRST and fed them real
   * requests that died at the transport layer. Keep the node, demote the
   * claim: `markUnverified()` instead.
   */
  unverified?: boolean
}

export async function admitCandidate(
  deps: AdmissionDeps,
  candidate: { address: string; protocol: 'http' | 'socks5'; source: ExitNode['source'] },
  options: {
    relaxed?: boolean
    pinned?: boolean
    timeoutMs?: number
    /** Pre-screened echo facts (coarseScreen output): skips steps 1-2. */
    echoFacts?: EchoFacts
  } = {},
): Promise<AdmissionResult> {
  const zenBase = deps.zenBaseUrl ?? ZEN_BASE_URL
  // The lane's origin ladder (adapter/lane.ts): the adapter serves chat from
  // whichever door answers, so an exit that reaches only ONE of the two origins
  // is a good exit. Probing a single origin would discard it and churn the pool
  // while real conversations kept working.
  const origins = laneOrigins(zenBase, deps.fallbackBaseUrl)
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const smokeModel = deps.smokeModel ?? 'big-pickle'
  // One draw per call = one draw per exit probe (a pre-drawn pass value wins).
  const smokeContent = deps.smokeContent ?? pickSmokeContent(deps.smokeContents, deps.random)
  // Live-observed 2026-09-09: zen now REJECTS anonymous-lane chat without
  // the CLI session headers (400 MissingSessionID "can only be used in
  // OpenCode") — the smoke request must carry the same disguise set the
  // adapter sends, or every candidate fails step 4 regardless of exit
  // quality (a full refill round admitted 0 of 701 tunnel-OK survivors).
  // Per-candidate ids: the upstream correlates sessions with exits, so a
  // probe session must not collide with real adapter sessions. The canonical
  // mapping (ids.ts) is mandatory here too — the old 24-hex probe sessions
  // drew 403 FreeTierError on the free lane like every other foreign shape.
  const probeHeaders = () => disguiseHeaders({
    session: canonicalSessionID(`admission:${candidate.address}`),
    request: mintedMessageID(),
    project: DEFAULT_PROJECT_ID,
    parentSession: '',
  })

  let agent: Dispatcher | null = null
  try {
    agent = new deps.undici.ProxyAgent({ uri: exitProxyUri(candidate.address, candidate.protocol) })
  } catch (err) {
    return { admitted: false, reason: `agent-build: ${err instanceof Error ? err.message : String(err)}` }
  }

  const request = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    withTimeout(
      deps.undici.request(url, { dispatcher: agent!, ...init }),
      timeout,
      init.method === 'POST' ? 'smoke' : 'probe',
    )

  /**
   * Ask each origin in ladder order and keep the best answer: 200 wins
   * outright, a 429 (quota consumed — the exit itself is fine, see the smoke
   * comment below) beats any hard failure, and otherwise the FIRST door's
   * status is the one reported, because that is the door the adapter prefers.
   */
  const probeLane = async (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<number> => {
    let verdict = 0
    for (const origin of origins) {
      const { statusCode } = await request(`${origin}${path}`, init)
      if (statusCode === 200) return 200
      if (verdict === 0 || (statusCode === 429 && verdict !== 429)) verdict = statusCode
    }
    return verdict
  }

  try {
    // Steps 1+2 run inline only when the caller has not pre-screened the
    // candidate (coarseScreen/batch output = echoFacts; the refill loop
    // always pre-screens free candidates at high fan-out).
    let facts: EchoFacts
    if (options.echoFacts) {
      facts = options.echoFacts
    } else {
      const verdict = await coarseScreen(deps, candidate, options)
      if ('rejected' in verdict) return { admitted: false, reason: verdict.rejected }
      facts = verdict
    }

    // One admitted node shape, shared by the full-pass and 429-limited paths.
    const admittedNode = (): ExitNode => ({
      id: candidate.address,
      protocol: candidate.protocol,
      source: candidate.source,
      pinned: options.pinned ?? false,
      exitIP: facts.exitIP,
      exitLocation: facts.exitLocation,
      latencyMs: facts.latencyMs,
      quality: gradeOf(facts.latencyMs),
      addedAt: Date.now(),
    })

    // Step 3: HTTPS tunnel to the real upstream (models list, Bearer public).
    const modelsStatus = await probeLane('/v1/models', {
      headers: { authorization: 'Bearer public', 'user-agent': opencodeUserAgent(), 'x-opencode-client': 'cli', accept: 'application/json', ...probeHeaders() },
    })
    if (modelsStatus !== 200) {
      return { admitted: false, reason: `zen models HTTP ${modelsStatus}` }
    }

    // Step 4: anonymous-lane smoke (streaming, 1 token). The free lane
    // rejects non-streaming bodies outright and wants the gate tools in the
    // body — now with the GENUINE definitions (2026-10-14) — plus a canonical
    // `ses_*` session header and the request/project id shapes the adapter
    // sends (adapter/ids.ts). `tool_choice` is left to the model: the gate
    // rejects `'none'` outright (403), and a 200 is all this step reads.
    //
    // Two things the smoke shares with the adapter since 2026-10-25: the
    // system prompt carries the `<env>` block the quota layer demands
    // (adapter/env-block.ts), and the request is sent through the Bun relay
    // when one is up, because the stack gate refuses every Node-side chat —
    // a smoke that always 429s would read as "exit quota consumed" and cool
    // healthy exits. Without a relay the probe keeps its old direct shape.
    const relayBase = deps.relayBaseUrl?.() ?? null
    const smokeBody = JSON.stringify({
      model: smokeModel,
      messages: [
        { role: 'system', content: renderEnvBlock() },
        { role: 'user', content: smokeContent },
      ],
      max_tokens: 1,
      stream: true,
      stream_options: { include_usage: true },
      tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
    })
    const smokeEgress = exitProxyUri(candidate.address, candidate.protocol)
    const smokeStatus = relayBase !== null
      ? await request(`${relayBase}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer public',
          'content-type': 'application/json',
          [EGRESS_HEADER]: smokeEgress,
          ...probeHeaders(),
        },
        body: smokeBody,
      }).then((response) => response.statusCode)
      : await probeLane('/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer public',
          'content-type': 'application/json',
          ...probeHeaders(),
        },
        body: smokeBody,
      })
    if (smokeStatus !== 200) {
      // 429 = the exit is good (alive + tunnel verified) but its anonymous
      // quota is currently consumed. Admit with limited: the caller cools it
      // and the periodic probe retries later (measured 2026-09-05: 429 is
      // the single largest smoke failure among tunnel-OK survivors).
      if (smokeStatus === 429) {
        return {
          admitted: true,
          limited: true,
          reason: `zen smoke HTTP 429`,
          node: admittedNode(),
        }
      }
      return { admitted: false, reason: `zen smoke HTTP ${smokeStatus}` }
    }

    return { admitted: true, node: admittedNode() }
  } catch (err) {
    return { admitted: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    void agent.close().catch(() => {})
  }
}

/** Admit a trusted-source candidate (manual/subscription/goproxy): smoke
 *  only; failure warns instead of rejecting for pinned (docs 4.5). Existing
 *  pool facts are PRESERVED on the failure fallback — a failed smoke wipes
 *  neither a previously measured exitIP/latency nor the routing key. */
export async function admitTrusted(
  deps: AdmissionDeps,
  candidate: { address: string; protocol: 'http' | 'socks5'; source: 'manual' | 'subscription' | 'goproxy' },
  options: {
    pinned?: boolean
    previous?: { exitIP: string; exitLocation: string; latencyMs: number; quality?: ExitNode['quality'] }
    /** Facts the onboarding already measured in its speed pass: skips steps
     *  1-2 so the connectivity test does not re-measure every candidate. */
    echoFacts?: EchoFacts
  } = {},
): Promise<AdmissionResult> {
  const result = await admitCandidate(deps, candidate, { pinned: options.pinned, echoFacts: options.echoFacts })
  if (result.admitted) return result
  // Trusted candidates: keep the node (the address is the routing key
  // fallback, 3.1), warn, and let periodic probing revisit.
  deps.logger?.warn(`opencode2dsh: trusted exit ${candidate.address} failed admission (${result.reason}); kept UNVERIFIED with ${options.previous?.exitIP ? 'previous' : 'unknown'} exit facts (not routing until a probe verifies it)`)
  const previous = options.previous
  // Keep only what was actually MEASURED. A previous entry with no exitIP
  // carries no measurement (it is itself a former fallback), so preserving its
  // grade would keep a phantom 'S' alive across rounds — exactly how the dead
  // nodes stayed top-tier on 2026-10-13.
  const kept = previous !== undefined && previous.exitIP !== '' ? previous : undefined
  return {
    admitted: true,
    unverified: true,
    reason: result.reason ?? 'unverified',
    node: {
      id: candidate.address,
      protocol: candidate.protocol,
      source: candidate.source,
      pinned: options.pinned ?? false,
      exitIP: kept?.exitIP ?? '',
      exitLocation: kept?.exitLocation ?? '',
      latencyMs: kept?.latencyMs ?? 0,
      // A never-measured exit gets the WORST grade, not the best: gradeOf(0)
      // is 'S', which ranked dead nodes above live ones until 2026-10-13.
      quality: kept === undefined ? UNVERIFIED_QUALITY : kept.quality ?? gradeOf(kept.latencyMs),
      addedAt: Date.now(),
    },
  }
}

/**
 * Speed-test-only admission for PAID sources (subscription refresh, operator
 * decision 2026-10-24: 添加订阅后，不对 OpenCode 进行任何主动探测，只显示
 * 测速的延迟). Runs coarseScreen — connectivity, exit IP, geo, latency — and
 * NOTHING else: no Zen models list, no anonymous-lane smoke, no request of any
 * kind to OpenCode. The measured latency IS the value the pool row displays;
 * whether OpenCode will accept this exit IP is left entirely to passive
 * verdicts from real traffic (pool.recordPassive), the standing liveness model
 * since 2026-10-23.
 *
 * Failure never rejects a paid line (docs §4.5): the node is kept UNVERIFIED
 * with unknown facts — same trusted-source contract as admitTrusted's
 * fallback, minus the probe that used to decide it.
 */
export async function admitBySpeed(
  deps: Pick<AdmissionDeps, 'undici' | 'ipEchoUrl' | 'blockedCountries' | 'logger'>,
  candidate: { address: string; protocol: 'http' | 'socks5'; source: ExitNode['source'] },
  options: { pinned?: boolean } = {},
): Promise<AdmissionResult> {
  const verdict = await coarseScreen(deps, candidate, { pinned: options.pinned })
  if ('exitIP' in verdict) {
    return {
      admitted: true,
      node: {
        id: candidate.address,
        protocol: candidate.protocol,
        source: candidate.source,
        pinned: options.pinned ?? false,
        exitIP: verdict.exitIP,
        exitLocation: verdict.exitLocation,
        latencyMs: verdict.latencyMs,
        quality: gradeOf(verdict.latencyMs),
        addedAt: Date.now(),
      },
    }
  }
  deps.logger?.warn(`opencode2dsh: speed test failed for paid exit ${candidate.address} (${verdict.rejected}); kept UNVERIFIED with unknown exit facts (no OpenCode probe runs for subscriptions)`)
  return {
    admitted: true,
    unverified: true,
    reason: verdict.rejected,
    node: {
      id: candidate.address,
      protocol: candidate.protocol,
      source: candidate.source,
      pinned: options.pinned ?? false,
      exitIP: '',
      exitLocation: '',
      latencyMs: 0,
      // Never measured -> worst grade (gradeOf(0) is 'S', the 2026-10-13 trap).
      quality: UNVERIFIED_QUALITY,
      addedAt: Date.now(),
    },
  }
}
