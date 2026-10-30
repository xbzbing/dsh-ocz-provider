/**
 * Bun relay supervisor: resolve the `bun` binary, spawn
 * `relay/oc2dsh-relay.mjs`, read the `OC2DSH_RELAY_READY <port>` line, health-check
 * the listener, restart it with bounded backoff, and stop it with the plugin
 * fiber. The relay must send on Bun's connection stack because the free lane
 * gates on it; a machine without bun keeps working — relay inactive, requests go
 * out directly, one clear warning. Config comes from the `relay` node of the
 * plugin config (config.ts): `enabled` (default true), `bunPath`, `port`
 * (0 = ephemeral), `upstream`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { get as httpGet } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Config the supervisor reads (subset of the plugin's `relay` node). */
export interface RelayConfig {
  enabled?: boolean
  /** Explicit bun binary. Empty/unset = search PATH and the usual install dirs. */
  bunPath?: string
  /** Fixed port; 0/undefined = let the OS pick one. */
  port?: number
  /** Upstream origin override (tests, or a lane that moves). */
  upstream?: string
}

export interface RelayLogSink {
  info(message: string): void
  warn(message: string): void
}

/** Structural spawn seam so tests can drive the lifecycle without bun. */
export type RelaySpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
) => ChildProcessWithoutNullStreams

export interface RelaySupervisorOptions {
  config?: RelayConfig
  logger?: RelayLogSink
  spawnImpl?: RelaySpawn
  /** Script to run (defaults to the shipped relay next to the package root). */
  scriptPath?: string
  /** Health probe target builder (tests point it at a fake). */
  healthFetch?: (url: string, signal: AbortSignal) => Promise<unknown>
  /** Readiness window for `OC2DSH_RELAY_READY` + the health probe. */
  readyTimeoutMs?: number
  /** Restart backoff ceiling (attempts beyond this give up for this process). */
  maxRestarts?: number
  /**
   * Continuous uptime after which the restart budget is given back: the budget
   * bounds a crash loop, not a process lifetime, and a child that dies before
   * the window keeps its strikes.
   */
  healthyResetMs?: number
}

export interface RelayStatus {
  /** True while a relay process is up and answering health probes. */
  active: boolean
  /** `http://127.0.0.1:<port>` while active, null otherwise (never the token). */
  baseUrl: string | null
  /** The bun binary in use (null when none was found). */
  bunPath: string | null
  /** Upstream origin the relay forwards to. */
  upstream: string
  /** Why the relay is not active (last failure), for diagnostics. */
  lastError: string
  /** Restarts spent so far. */
  restarts: number
}

/** The lane origin the relay forwards to by default. */
export const DEFAULT_RELAY_UPSTREAM = 'https://opencode.ai'

/** Readiness marker the relay prints on stdout (relay/oc2dsh-relay.mjs). */
const READY_MARKER = 'OC2DSH_RELAY_READY'

/** Health path behind the token prefix (relay/oc2dsh-relay.mjs). */
const HEALTH_PATH = '/__oc2dsh/health'

/** Startup stdout kept for the failure message; a longer line is cut. */
const STARTUP_EXCERPT_CHARS = 400
const MAX_LINE_CHARS = 8_192

/** Restart backoff: 500 ms doubling, 30 s ceiling (docs/relay.md §1). */
function backoffMs(strikes: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, strikes - 1))
}

/** warm() retry spacing once the restart budget is spent, or bun/the script is missing. */
const EXHAUSTED_RETRY_MS = 5 * 60_000
const UNAVAILABLE_RETRY_MS = 60_000

/**
 * Environment the child inherits: what bun needs to run on macOS, Linux and
 * Windows, plus CA settings. Proxy variables are deliberately absent — Bun's
 * fetch honours HTTP(S)_PROXY, which would turn `direct` into an env proxy.
 */
const CHILD_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TZ',
  'LANG', 'LANGUAGE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'BUN_INSTALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
])

/** The allowlisted slice of `source` (names compared case-insensitively, as Windows does). */
export function relayChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (CHILD_ENV_NAMES.has(upper) || upper.startsWith('LC_')) env[name] = value
  }
  return env
}

/**
 * Candidate relay scripts, in order: next to the built `lib/` (the installed
 * layout), then the source checkout's own `relay/` (running from `src/` in
 * tests). The first existing file wins.
 */
function defaultScriptCandidates(): string[] {
  const here = (): string => {
    try {
      return fileURLToPath(new URL('.', import.meta.url))
    } catch {
      return process.cwd()
    }
  }
  const base = here()
  return [
    join(base, '..', '..', 'relay', 'oc2dsh-relay.mjs'),
    join(base, '..', 'relay', 'oc2dsh-relay.mjs'),
    join(base, 'relay', 'oc2dsh-relay.mjs'),
  ]
}

/** Resolve the shipped relay script; empty string when the package is broken. */
export function defaultRelayScript(): string {
  for (const candidate of defaultScriptCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/**
 * Find a bun binary: explicit config, then `OC2DSH_BUN`, then PATH, then the
 * usual install locations (bun's own installer, Homebrew on both prefixes, and
 * nvm's node bin dirs where this machine's bun lives).
 */
export function findBun(configured?: string): string | null {
  const explicit = (configured ?? '').trim()
  if (explicit !== '') return existsSync(explicit) ? explicit : null
  const fromEnv = (process.env.OC2DSH_BUN ?? '').trim()
  if (fromEnv !== '') return existsSync(fromEnv) ? fromEnv : null
  if (process.env.BUN_INSTALL !== undefined) {
    const candidate = join(process.env.BUN_INSTALL, 'bin', 'bun')
    if (existsSync(candidate)) return candidate
  }
  const exe = process.platform === 'win32' ? 'bun.exe' : 'bun'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, exe)
    if (existsSync(candidate)) return candidate
  }
  const home = homedir()
  const fixed = [
    join(home, '.bun', 'bin', exe),
    `/opt/homebrew/bin/${exe}`,
    `/usr/local/bin/${exe}`,
  ]
  for (const candidate of fixed) {
    if (existsSync(candidate)) return candidate
  }
  // nvm keeps node's bin dirs under ~/.nvm/versions/node/<ver>/bin; bun can be
  // installed beside node there, so the newest version dir is tried first.
  const nvmRoot = join(home, '.nvm', 'versions', 'node')
  try {
    if (existsSync(nvmRoot)) {
      for (const version of readdirSync(nvmRoot).sort().reverse()) {
        const candidate = join(nvmRoot, version, 'bin', exe)
        if (existsSync(candidate)) return candidate
      }
    }
  } catch {
    // an unreadable nvm tree simply contributes no candidate
  }
  return null
}

/**
 * Owns one relay child process. Idempotent start/stop; safe to call start()
 * repeatedly (a second call joins the running one).
 */
export class RelaySupervisor {
  readonly #config: RelayConfig
  readonly #logger?: RelayLogSink
  readonly #spawn: RelaySpawn
  readonly #scriptPath: string
  readonly #healthFetch: (url: string, signal: AbortSignal) => Promise<unknown>
  readonly #readyTimeoutMs: number
  readonly #maxRestarts: number
  readonly #healthyResetMs: number
  #child: ChildProcessWithoutNullStreams | null = null
  /** `http://127.0.0.1:<port>` of the live relay. */
  #origin: string | null = null
  /** {@link #origin} plus the per-spawn `/_/<token>` prefix every request needs. */
  #baseUrl: string | null = null
  /** Earliest time warm() may spawn again (startup-failure backoff). */
  #nextAttemptAt = 0
  #bunPath: string | null = null
  #lastError = ''
  #restarts = 0
  #starting: Promise<string | null> | null = null
  #stopping = false

  constructor(options: RelaySupervisorOptions = {}) {
    this.#config = options.config ?? {}
    this.#logger = options.logger
    this.#spawn = options.spawnImpl ?? (spawn as unknown as RelaySpawn)
    this.#scriptPath = options.scriptPath ?? defaultRelayScript()
    this.#healthFetch = options.healthFetch ?? defaultHealthFetch
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 15_000
    this.#maxRestarts = options.maxRestarts ?? 5
    this.#healthyResetMs = options.healthyResetMs ?? 60_000
  }

  get upstream(): string {
    const configured = (this.#config.upstream ?? '').trim()
    return configured !== '' ? configured.replace(/\/+$/, '') : DEFAULT_RELAY_UPSTREAM
  }

  /**
   * The base URL of a live relay (`http://127.0.0.1:<port>/_/<token>`), or null
   * when it is not running. The adapter reads this PER REQUEST: a relay that
   * died and came back (new port, new token) is picked up without rebuilding
   * anything.
   */
  get baseUrl(): string | null {
    return this.#baseUrl
  }

  /** Diagnostics for the status file / bridge. */
  status(): RelayStatus {
    return {
      active: this.#baseUrl !== null,
      baseUrl: this.#baseUrl === null ? null : this.#origin,
      bunPath: this.#bunPath,
      upstream: this.upstream,
      lastError: this.#lastError,
      restarts: this.#restarts,
    }
  }

  /**
   * Fire-and-forget warm-up for the paths that precede traffic (the host's
   * registration-time model list, and every prepareCall). `apply()` does not do
   * this at load time: loading the plugin must not fork a process for a host
   * that never uses this provider.
   */
  warm(): void {
    if (this.#stopping || this.#baseUrl !== null || this.#starting !== null || this.#config.enabled === false) return
    if (Date.now() < this.#nextAttemptAt) return
    void this.start().catch(() => {})
  }

  /**
   * Start (or join) the relay. Resolves with the base URL, or null when the
   * relay cannot run here (no bun, missing script, disabled) — the caller then
   * keeps sending directly and logs `lastError` once.
   */
  start(): Promise<string | null> {
    if (this.#stopping) return Promise.resolve(null)
    if (this.#baseUrl !== null) return Promise.resolve(this.#baseUrl)
    if (this.#config.enabled === false) {
      this.#lastError = 'relay disabled by config'
      return Promise.resolve(null)
    }
    if (this.#starting !== null) return this.#starting
    this.#starting = this.#spawnAndWait().finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  /**
   * The relay's own base for one upstream ORIGIN (the lane ladder moves between
   * `/inference` and `/zen`): the relay forwards pathnames verbatim, so the
   * origin's path is preserved and only the scheme/host change.
   */
  baseUrlFor(origin: string): string | null {
    if (this.#baseUrl === null) return null
    let pathname = ''
    try {
      pathname = new URL(origin).pathname.replace(/\/+$/, '')
    } catch {
      pathname = ''
    }
    return `${this.#baseUrl}${pathname}`
  }

  async #spawnAndWait(): Promise<string | null> {
    const bun = findBun(this.#config.bunPath)
    this.#bunPath = bun
    if (bun === null) {
      this.#lastError = 'no bun binary found (安装 bun 后重启，或设置 relay.bunPath)'
      this.#logger?.warn(`oc2dsh: ${this.#lastError} — upstream requests stay direct and will be answered 429 by the free lane`)
      this.#nextAttemptAt = Date.now() + UNAVAILABLE_RETRY_MS
      return null
    }
    if (this.#scriptPath === '') {
      this.#lastError = 'relay script missing from the installed package (relay/oc2dsh-relay.mjs)'
      this.#logger?.warn(`oc2dsh: ${this.#lastError}`)
      this.#nextAttemptAt = Date.now() + UNAVAILABLE_RETRY_MS
      return null
    }
    // Per-spawn capability: the relay refuses any request path without it.
    const token = randomBytes(24).toString('hex')
    try {
      const port = await this.#spawnOnce(bun, token)
      if (this.#stopping) {
        await this.#killChild()
        return null
      }
      this.#origin = `http://127.0.0.1:${port}`
      this.#baseUrl = `${this.#origin}/_/${token}`
      this.#lastError = ''
      this.#nextAttemptAt = 0
      this.#logger?.info(`oc2dsh: upstream relay ready at ${this.#origin} (bun ${bun})`)
      return this.#baseUrl
    } catch (err) {
      if (this.#stopping) return null
      this.#lastError = err instanceof Error ? err.message : String(err)
      // A failed start is a strike in the same budget a crash spends, and
      // warm() waits out the backoff instead of respawning on every call.
      this.#restarts += 1
      this.#nextAttemptAt = Date.now() + (this.#restarts >= this.#maxRestarts ? EXHAUSTED_RETRY_MS : backoffMs(this.#restarts))
      this.#logger?.warn(`oc2dsh: upstream relay failed to start: ${this.#lastError}`)
      return null
    }
  }

  /** One spawn attempt: start, read the ready line, health-check. */
  #spawnOnce(bun: string, token: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...relayChildEnv(),
        OC2DSH_RELAY_HOST: '127.0.0.1',
        OC2DSH_RELAY_PORT: String(this.#config.port ?? 0),
        OC2DSH_RELAY_UPSTREAM: this.upstream,
        OC2DSH_RELAY_TOKEN: token,
        // stdin stays a pipe: EOF is how the child learns we are gone.
        OC2DSH_RELAY_WATCH_STDIN: '1',
      }
      let child: ChildProcessWithoutNullStreams
      try {
        child = this.#spawn(bun, [this.#scriptPath], { env })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      this.#child = child
      // The child stays ATTACHED until it is ready (see #detach below): while
      // starting, its pipes carry the readiness line, so unref'ing them early
      // would let the loop drain and leave this promise pending forever. Once
      // listening it is detached, because the relay must never keep its parent
      // alive.
      let settled = false
      let sawReady = false
      let excerpt = ''
      let pending = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        void this.#killChild()
        reject(new Error(`relay did not report readiness within ${this.#readyTimeoutMs}ms`))
      }, this.#readyTimeoutMs)
      timer.unref?.()
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const onReady = (port: number): void => {
        sawReady = true
        // Health-check before declaring victory: the ready line only proves the
        // listener exists, and the adapter is about to send real traffic through it.
        this.#probe(`http://127.0.0.1:${port}/_/${token}${HEALTH_PATH}`)
          .then(() => settle(() => {
            this.#detach(child)
            this.#armBudgetReset(child)
            resolve(port)
          }))
          .catch((err: unknown) => settle(() => {
            void this.#killChild()
            reject(err instanceof Error ? err : new Error(String(err)))
          }))
      }
      /**
       * One stdout line: the ready marker while starting, an excerpt kept for a
       * startup failure, and the `OC2DSH_RELAY_TRACE=1` mirror to stderr (the
       * child's log stays out of the host's stdout).
       */
      const onLine = (line: string): void => {
        if (line.startsWith(READY_MARKER)) {
          const port = Number(line.slice(READY_MARKER.length).trim())
          if (!sawReady && Number.isFinite(port) && port > 0) onReady(port)
          return
        }
        if (!settled && excerpt.length < STARTUP_EXCERPT_CHARS) {
          excerpt = `${excerpt}${line}\n`.slice(0, STARTUP_EXCERPT_CHARS)
        }
        if (line.trim() !== '' && process.env.OC2DSH_RELAY_TRACE === '1') console.error('[relay]', line)
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        pending += chunk
        let newline = pending.indexOf('\n')
        while (newline !== -1) {
          onLine(pending.slice(0, newline).replace(/\r$/, ''))
          pending = pending.slice(newline + 1)
          newline = pending.indexOf('\n')
        }
        if (pending.length > MAX_LINE_CHARS) {
          onLine(pending)
          pending = ''
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim()
        if (text !== '') this.#lastError = text.slice(0, 400)
      })
      child.on('error', (err) => {
        this.#detach(child)
        settle(() => reject(err instanceof Error ? err : new Error(String(err))))
      })
      child.on('exit', (code, signal) => {
        this.#child = null
        // A child that dies while we are starting is a start failure; one that
        // dies later is handled by the restart path below.
        if (!settled) {
          this.#detach(child)
          settle(() => reject(new Error(`relay exited during startup (code ${code ?? 'null'}, signal ${signal ?? 'none'}): ${excerpt.trim()}`)))
          return
        }
        this.#onExit(code, signal)
      })
    })
  }

  /**
   * Give the restart budget back after {@link #healthyResetMs} of continuous
   * uptime: the budget exists to stop a crash LOOP, not to cap a process
   * lifetime, and a child that dies before the window keeps its strikes.
   */
  #armBudgetReset(child: ChildProcessWithoutNullStreams): void {
    const timer = setTimeout(() => {
      if (this.#stopping) return
      if (this.#child !== child || this.#baseUrl === null) return
      this.#restarts = 0
    }, this.#healthyResetMs)
    timer.unref?.()
  }

  /**
   * Release a ready (or failed) child from the parent's event loop: the child
   * handle and its three stdio pipes are unref'd here, and only here — startup
   * needs those handles to deliver the readiness line. The child still dies
   * with us: its stdin is a pipe, and EOF is its own shutdown signal.
   */
  #detach(child: ChildProcessWithoutNullStreams): void {
    try {
      child.unref()
      // The stdio pipes are net.Socket-backed child pipes at runtime, but typed
      // as Writable/Readable, which do not declare unref(). Same call, casted.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        ;(stream as unknown as { unref?: () => void }).unref?.()
      }
    } catch {
      // a child that is already gone needs no detaching
    }
  }

  /** After a crash of a ready relay: restart with backoff, bounded. */
  #onExit(code: number | null, signal: string | null): void {
    this.#baseUrl = null
    this.#origin = null
    if (this.#stopping) return
    this.#lastError = `relay exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`
    this.#logger?.warn(`oc2dsh: ${this.#lastError}`)
    if (this.#restarts >= this.#maxRestarts) {
      this.#nextAttemptAt = Date.now() + EXHAUSTED_RETRY_MS
      this.#logger?.warn(`oc2dsh: upstream relay gave up after ${this.#restarts} restarts; requests will go direct (429 expected)`)
      return
    }
    this.#restarts += 1
    const delay = backoffMs(this.#restarts)
    this.#nextAttemptAt = Date.now() + delay
    const timer = setTimeout(() => {
      if (this.#stopping) return
      void this.start().catch(() => {})
    }, delay)
    timer.unref?.()
  }

  /** GET the health endpoint, bounded. */
  #probe(url: string): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    timer.unref?.()
    return this.#healthFetch(url, controller.signal)
      .then(() => undefined)
      .finally(() => clearTimeout(timer))
  }

  async #killChild(): Promise<void> {
    const child = this.#child
    this.#child = null
    if (child === null) return
    try {
      // Closing stdin is the relay's own parent-death signal (it exits on EOF),
      // so this is a clean stop even where signals are unreliable.
      child.stdin?.end()
      child.kill('SIGTERM')
    } catch {
      // already gone
    }
  }

  /** Stop the relay (plugin dispose). Idempotent. */
  async stop(): Promise<void> {
    this.#stopping = true
    this.#baseUrl = null
    this.#origin = null
    await this.#killChild()
  }
}

/**
 * Default health probe: `node:http` against loopback, deliberately NOT `fetch`:
 * the pool's installer swaps `globalThis.fetch` while routing is on, so a
 * `fetch` probe could be routed by that layer — or answered by a host/test
 * mock of it — instead of reaching this process.
 */
function defaultHealthFetch(url: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { signal }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`relay health probe answered HTTP ${response.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
    request.on('error', reject)
  })
}
