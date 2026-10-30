/**
 * sing-box child-process supervision — the TS port of GoProxy
 * custom/singbox.go (docs/ip-pool.md 1.2.2). The one external binary this
 * plugin will ever spawn, and only when the user's subscriptions carry
 * encrypted nodes:
 *
 *   ParsedNode[] -> config JSON (one local SOCKS5 inbound per node, ports
 *   from 30001 keyed by node identity) -> `sing-box check` preflight -> `sing-box run` ->
 *   port-readiness wait. The converted nodes return as local http-address
 *   exits and join the pool through the trusted admission path.
 *
 * Process supervision: interrupt -> 5s grace -> kill (Windows: taskkill /T
 * since signals are not deliverable), exit-watch so crashes surface, and
 * the caller (subscription layer) drives Reload on every refresh — a new
 * node list regenerates the config and restarts the process, same as
 * GoProxy's Reload.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { buildOutbound, nodeKey } from './singbox-outbound.ts'
import type { ParsedNode } from './subscription.ts'

export { buildOutbound, nodeKey }

export interface SingBoxOptions {
  /** sing-box binary: PATH name or absolute path. */
  binPath: string
  /** Directory for config + working dir. */
  dataDir: string
  /** First local SOCKS5 port (default 30000, ascending per node). */
  basePort?: number
  /** Port-readiness wait (default 10s). */
  readyTimeoutMs?: number
  logger?: { info(message: string): void; warn(message: string): void }
}

export interface ConvertedExit {
  /** Local dial address: 127.0.0.1:<port>. */
  address: string
  protocol: 'socks5'
  /** The source node this exit serves (diagnostics + dedupe key). */
  node: ParsedNode
  /** The node's index in the candidate list: the handle the onboarding passes
   *  back to reload() when it shrinks or promotes. */
  slot: number
  /**
   * The node's identity (its outbound config). The local port follows it across
   * refreshes; a port that comes back serving a different key is a different
   * exit. Absent from conversion seams that do not track identity.
   */
  key?: string
}

/**
 * Can this node's server address ever be dialled from THIS machine?
 *
 * A public subscription handing out a private / loopback / link-local /
 * multicast literal is carrying a placeholder, not a node: converting it
 * anyway hands it a local SOCKS5 port and a trusted-admission row that can
 * only ever fail. Dropping it at conversion is the only place the pool never
 * sees it.
 *
 * Hostnames always pass: resolving them is sing-box's job, and a hostname may
 * legitimately point at something reachable only through another hop.
 */
export function isDialableServer(server: string): boolean {
  const host = server.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) return !isUnroutableIPv4(Number(v4[1]), Number(v4[2]))
  const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (mapped) return !isUnroutableIPv4(Number(mapped[1]), Number(mapped[2]))
  if (host.includes(':')) return !isUnroutableIPv6(host)
  return true
}

/** RFC1918 plus the literals that never route (0/8, 127/8, link-local, CGNAT, benchmark, multicast). */
function isUnroutableIPv4(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return false
}

function isUnroutableIPv6(host: string): boolean {
  if (host === '::' || host === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(host)) return true // ff00::/8 multicast
  return false
}

// -- config generation --------------------------------------------------------

export interface GeneratedConfig {
  config: Record<string, unknown>
  /**
   * Local port per INPUT node, index-aligned; `0` for a node whose type has no
   * sing-box outbound mapping (no inbound, no rule, no port burned).
   *
   * Index alignment, NOT a `type:server:port` key: that key is not a node
   * identity — a real airport fronts many distinct nodes on ONE edge
   * `host:port` and separates them only by the anytls TLS `server_name`, so a
   * keyed map collapses distinct nodes onto one port and orphans the rest
   * (listening, never handed to the pool). Two nodes that are genuinely one
   * exit are still collapsed, one layer down and quota-aware:
   * `ExitPool.add()` refuses a second address that measured the same exit IP
   * (docs §3.1).
   */
  ports: number[]
}

/**
 * The full sing-box config for a node list (GoProxy generateConfig).
 *
 * `keep` restricts the emitted inbounds to those candidate indexes (the
 * onboarding's selection). `assigned` carries the supervisor's per-node ports
 * (see `SingBoxSupervisor`); without it a node's port is its position in the
 * CANDIDATE list, never its position in the emitted subset — so shrinking
 * the config to the fastest N, or promoting a reserve later, leaves every node
 * that stays selected on the same local port. That stability is what lets the
 * pool keep its exit ids (and their health, counters and session stickiness)
 * across a rebuild; a positional subset would renumber every survivor and
 * silently repoint the pool at different nodes.
 */
export function generateConfig(nodes: ParsedNode[], basePort = 30_000, keep?: readonly number[], assigned?: readonly number[]): GeneratedConfig {
  const ports: number[] = []
  const inbounds: Array<Record<string, unknown>> = []
  const outbounds: Array<Record<string, unknown>> = []
  const rules: Array<Record<string, unknown>> = []
  const keepSet = keep === undefined ? null : new Set(keep)
  nodes.forEach((node, index) => {
    if (keepSet !== null && !keepSet.has(index)) {
      ports.push(0)
      return
    }
    const tag = `node-${index}`
    const outbound = buildOutbound(node, `out-${tag}`)
    if (outbound === null) {
      // Keep the index slot (0 = unmapped) so node -> port stays a plain
      // positional lookup that no key can collide on.
      ports.push(0)
      return
    }
    const port = assigned !== undefined ? assigned[index] ?? 0 : basePort + 1 + index
    if (port <= 0) {
      ports.push(0)
      return
    }
    ports.push(port)
    inbounds.push({
      type: 'socks',
      tag: `in-${tag}`,
      listen: '127.0.0.1',
      listen_port: port,
    })
    outbounds.push(outbound)
    rules.push({ inbound: [`in-${tag}`], outbound: `out-${tag}` })
  })
  outbounds.push({ type: 'direct', tag: 'direct' })
  return {
    config: {
      log: { level: 'warn' },
      inbounds,
      outbounds,
      route: { rules, final: 'direct' },
    },
    ports,
  }
}

// -- process supervision -------------------------------------------------------

const STOP_GRACE_MS = 5_000

function canConnect(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * One sing-box child at a time. `reload()` and `stop()` run under one mutex, so
 * two refreshes can never leave an orphaned child holding the same ports, and a
 * reload requested before a `stop()` never spawns after it.
 *
 * Ports follow node IDENTITY (`nodeKey`), not list position: a node keeps its
 * port across refreshes and reorders, new nodes take the lowest free port, and
 * a port whose node vanished can be reused by a new node — the onboarding sees
 * the key change and treats the address as a new exit (docs/ip-pool.md §4.7).
 */
export class SingBoxSupervisor {
  readonly #options: SingBoxOptions
  #child: ChildProcess | null = null
  #running = false
  #configPath: string
  #dataDir: string
  /** Port per node of the last reload(), index-aligned (`0` = no inbound). */
  #ports: number[] = []
  #nodes: ParsedNode[] = []
  /** Port per node identity, carried across reloads. */
  #portByKey = new Map<string, number>()
  /** Serializes reload/stop. */
  #lock: Promise<void> = Promise.resolve()
  /** Bumped by every stop(); a reload requested before it never spawns. */
  #stopEpoch = 0

  constructor(options: SingBoxOptions) {
    this.#options = options
    this.#dataDir = options.dataDir
    this.#configPath = join(options.dataDir, 'singbox-config.json')
  }

  /** Live re-apply of the binary path (settings page, docs §5.1). The next
   *  reload() resolves through it; a running child keeps serving until then. */
  setBinPath(path: string): void {
    this.#options.binPath = path
  }

  get running(): boolean {
    return this.#running
  }

  /** The ports the last reload() handed out, index-aligned with its node list
   *  (`0` = that node produced no inbound). Diagnostics only. */
  get ports(): number[] {
    return [...this.#ports]
  }

  #exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(job, job)
    this.#lock = run.then(() => undefined, () => undefined)
    return run
  }

  /** The binary location: absolute path as-is; bare name must exist on PATH
   *  (verified through `sing-box version` — LookPath equivalent). */
  async #resolveBinary(): Promise<string> {
    const bin = this.#options.binPath
    if (bin.includes('/') || bin.includes('\\') || bin.includes(':')) {
      if (existsSync(bin)) return bin
      throw new Error(`sing-box not found at ${bin}`)
    }
    // bare name: check via version output (LookPath semantics)
    const probe = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ['version'], { stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
    })
    if (!probe) throw new Error(`sing-box not found on PATH ("${bin}"); install it or set singbox.path`)
    return bin
  }

  /** Per-node ports for this node list: identities keep theirs, new ones take the lowest free. */
  #assignPorts(nodes: ParsedNode[]): number[] {
    const base = this.#options.basePort ?? 30_000
    const seen = new Map<string, number>()
    // Byte-identical nodes are distinct listeners: the occurrence count keeps their keys apart.
    const keys = nodes.map((node) => {
      const key = nodeKey(node)
      if (key === '') return ''
      const occurrence = seen.get(key) ?? 0
      seen.set(key, occurrence + 1)
      return `${occurrence}:${key}`
    })
    const ports = keys.map(() => 0)
    const used = new Set<number>()
    const next = new Map<string, number>()
    keys.forEach((key, index) => {
      const previous = key === '' ? undefined : this.#portByKey.get(key)
      if (previous === undefined || used.has(previous)) return
      ports[index] = previous
      used.add(previous)
      next.set(key, previous)
    })
    let free = base + 1
    keys.forEach((key, index) => {
      if (key === '' || ports[index] !== 0) return
      while (used.has(free)) free += 1
      ports[index] = free
      used.add(free)
      next.set(key, free)
    })
    this.#portByKey = next
    return ports
  }

  /**
   * Full reload: regenerate the config for the node list and (re)start.
   *
   * `keep` (candidate indexes) emits only those nodes' inbounds — the
   * onboarding's "keep the fastest N" and its later reserve promotions — while
   * every kept node stays on its own port. Absent = every node.
   */
  reload(input: ParsedNode[], keep?: readonly number[]): Promise<ConvertedExit[]> {
    const epoch = this.#stopEpoch
    return this.#exclusive(() => this.#reload(input, keep, epoch))
  }

  async #reload(input: ParsedNode[], keep: readonly number[] | undefined, epoch: number): Promise<ConvertedExit[]> {
    if (epoch !== this.#stopEpoch) throw new Error('sing-box was stopped; reload abandoned')
    // One pass splits dialable nodes from placeholder servers (private /
    // loopback / link-local literals a public subscription should never hand
    // out); only the dialable half reaches the config.
    const nodes: ParsedNode[] = []
    const unroutable: ParsedNode[] = []
    for (const node of input) (isDialableServer(node.server) ? nodes : unroutable).push(node)
    if (unroutable.length > 0) {
      const sample = unroutable
        .slice(0, 5)
        .map((node) => `${node.type} ${node.server}:${node.port}`)
        .join(', ')
      this.#options.logger?.warn(
        `oc2dsh: sing-box conversion skipped ${unroutable.length} node(s) whose server address cannot be dialled from this machine (${sample}${unroutable.length > 5 ? ', …' : ''})`,
      )
    }
    // no tunnel nodes -> stop and clean (GoProxy Reload empty case). A keep
    // selection that matches nothing is the same state: nothing to run.
    const emit = keep === undefined ? nodes.length : keep.length
    if (nodes.length === 0 || emit === 0) {
      await this.#stopChild()
      this.#nodes = []
      this.#ports = []
      return []
    }
    const binary = await this.#resolveBinary()
    const assigned = this.#assignPorts(nodes)
    const invalid = assigned.filter((port) => port === 0).length
    if (invalid > 0 && keep === undefined) {
      this.#options.logger?.warn(`oc2dsh: sing-box conversion skipped ${invalid} node(s) with an unsupported type or an invalid config (bad port, missing credentials)`)
    }
    const { config, ports } = generateConfig(nodes, this.#options.basePort ?? 30_000, keep, assigned)

    // atomic config write (tmp + rename)
    await mkdir(this.#dataDir, { recursive: true })
    const tmp = `${this.#configPath}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
    await rm(this.#configPath, { force: true })
    await rename(tmp, this.#configPath)

    // preflight: `sing-box check`
    const checkOk = await new Promise<boolean>((resolve) => {
      const child = spawn(binary, ['check', '-c', this.#configPath, '-D', this.#dataDir], { stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
    })
    if (!checkOk) {
      throw new Error('sing-box config check failed (run `sing-box check` on the generated config for details)')
    }

    await this.#stopChild()
    if (epoch !== this.#stopEpoch) throw new Error('sing-box was stopped; reload abandoned')
    this.#child = spawn(binary, ['run', '-c', this.#configPath, '-D', this.#dataDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const child = this.#child
    this.#running = true
    this.#nodes = nodes
    this.#ports = ports
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text.length > 0) this.#options.logger?.info(`[sing-box] ${text}`)
    })
    child.once('exit', (code, signal) => {
      // Our own stop() clears #child first, so only an unexpected exit lands here.
      if (this.#child !== child) return
      this.#running = false
      this.#options.logger?.warn(`oc2dsh: sing-box exited unexpectedly (${signal !== null ? `signal ${signal}` : `code ${code}`}); converted exits are unreachable until the next refresh`)
    })
    child.once('error', (err) => {
      if (this.#child !== child) return
      this.#running = false
      this.#options.logger?.warn(`oc2dsh: sing-box failed: ${err.message}`)
    })

    // port readiness (GoProxy: 20 x 500ms over the first port)
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? 10_000)
    const listening = ports.filter((port) => port > 0)
    let ready = false
    while (Date.now() < deadline && !ready) {
      if (!this.#running) throw new Error('sing-box exited immediately after start (see logs)')
      await new Promise((resolve) => setTimeout(resolve, 500))
      for (const port of listening) {
        // eslint-disable-next-line no-await-in-loop
        if (await canConnect(port)) {
          ready = true
          break
        }
      }
    }
    if (!ready) this.#options.logger?.warn('oc2dsh: sing-box ports not ready in time; some converted nodes may be unreachable')

    const exits: ConvertedExit[] = []
    nodes.forEach((node, index) => {
      const port = ports[index] ?? 0
      if (port <= 0) return
      exits.push({ address: `127.0.0.1:${port}`, protocol: 'socks5', node, slot: index, key: nodeKey(node) })
    })
    return exits
  }

  /**
   * Stop the child: interrupt -> grace -> kill (taskkill /T on Windows). Any
   * reload requested before this call is abandoned instead of spawning later.
   */
  stop(): Promise<void> {
    this.#stopEpoch += 1
    return this.#exclusive(() => this.#stopChild())
  }

  async #stopChild(): Promise<void> {
    const child = this.#child
    this.#child = null
    this.#running = false
    if (child === null || exited(child)) return
    // Listen before signalling: an exit that lands between kill() and a later
    // `once('exit')` would never be seen.
    const gone = new Promise<void>((resolve) => {
      if (exited(child)) resolve()
      else child.once('exit', () => resolve())
    })
    if (process.platform === 'win32' && child.pid) {
      await taskkill(['/T', '/PID', String(child.pid)])
    } else {
      child.kill('SIGINT')
    }
    if (await settles(gone, STOP_GRACE_MS)) return
    if (process.platform === 'win32' && child.pid) {
      await taskkill(['/T', '/F', '/PID', String(child.pid)])
    } else {
      child.kill('SIGKILL')
    }
    if (!(await settles(gone, STOP_GRACE_MS))) {
      this.#options.logger?.warn(`oc2dsh: sing-box (pid ${child.pid ?? '?'}) did not exit after SIGKILL; giving up on it`)
    }
  }
}

/** True once the child is gone, by exit code OR by signal. */
function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** Did `promise` settle within `ms`? */
async function settles(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function taskkill(args: string[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const killer = spawn('taskkill', args, { stdio: 'ignore' })
    killer.once('exit', () => resolve())
    killer.once('error', () => resolve())
  })
}
