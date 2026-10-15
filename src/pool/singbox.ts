/**
 * sing-box child-process supervision — the TS port of GoProxy
 * custom/singbox.go (docs/ip-pool.md 1.2.2). The one external binary this
 * plugin will ever spawn, and only when the user's subscriptions carry
 * encrypted nodes:
 *
 *   ParsedNode[] -> config JSON (one local SOCKS5 inbound per node, port
 *   30000+ ascending) -> `sing-box check` preflight -> `sing-box run` ->
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

import type { ParsedNode } from './subscription.ts'

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
  /** The node's index in the candidate list — its stable port slot, and the
   *  handle the onboarding passes back to reload() when it shrinks or promotes. */
  slot: number
}

/**
 * Can this node's server address ever be dialled from THIS machine?
 *
 * A public subscription handing out a private / loopback / link-local /
 * multicast literal is carrying a placeholder, not a node. Live 2026-10-13: a
 * trojan node with `server: 10.255.255.255` was converted anyway, got a local
 * SOCKS5 port, was admitted through the trusted fallback and sat in the exit
 * table as a `127.0.0.1:30005` row — a rotation slot that could only ever
 * fail. Dropping it at conversion is the only place the pool never sees it.
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

// -- outbound mapping (GoProxy buildOutbound, verbatim semantics) ----------

const getStr = (raw: Record<string, unknown>, key: string): string => {
  const value = raw[key]
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}
const getStrDefault = (raw: Record<string, unknown>, key: string, fallback: string): string => {
  const value = getStr(raw, key)
  return value !== '' ? value : fallback
}
const getInt = (raw: Record<string, unknown>, key: string): number => {
  const value = Number(raw[key])
  return Number.isFinite(value) ? value : 0
}
const getBool = (raw: Record<string, unknown>, key: string): boolean => raw[key] === true

function applyTLS(raw: Record<string, unknown>, out: Record<string, unknown>): void {
  const hasTLS =
    getBool(raw, 'tls') ||
    getStr(raw, 'sni') !== '' ||
    getStr(raw, 'client-fingerprint') !== '' ||
    // reality implies TLS even without an explicit sni (vless reality nodes
    // sometimes carry only reality-opts)
    (raw['reality-opts'] !== undefined && typeof raw['reality-opts'] === 'object')
  if (!hasTLS) return
  const tls: Record<string, unknown> = { enabled: true }
  const sni = getStr(raw, 'sni') || getStr(raw, 'servername')
  if (sni !== '') tls.server_name = sni
  if (getBool(raw, 'skip-cert-verify')) tls.insecure = true
  const alpn = raw.alpn
  if (Array.isArray(alpn)) {
    const list = alpn.filter((entry): entry is string => typeof entry === 'string')
    if (list.length > 0) tls.alpn = list
  }
  const fingerprint = getStr(raw, 'client-fingerprint')
  if (fingerprint !== '') tls.utls = { enabled: true, fingerprint }
  const reality = raw['reality-opts']
  if (reality && typeof reality === 'object') {
    const opts = reality as Record<string, unknown>
    tls.reality = {
      enabled: true,
      public_key: getStr(opts, 'public-key'),
      short_id: getStr(opts, 'short-id'),
    }
  }
  out.tls = tls
}

function applyTransport(raw: Record<string, unknown>, out: Record<string, unknown>): void {
  const network = getStrDefault(raw, 'network', 'tcp')
  if (network === 'ws') {
    const transport: Record<string, unknown> = { type: 'ws' }
    const opts = raw['ws-opts']
    if (opts && typeof opts === 'object') {
      const ws = opts as Record<string, unknown>
      const path = getStr(ws, 'path')
      if (path !== '') transport.path = path
      const headers = ws.headers
      if (headers && typeof headers === 'object') transport.headers = headers
    }
    out.transport = transport
  } else if (network === 'grpc') {
    const transport: Record<string, unknown> = { type: 'grpc' }
    const opts = raw['grpc-opts']
    if (opts && typeof opts === 'object') {
      const sn = getStr(opts as Record<string, unknown>, 'grpc-service-name')
      if (sn !== '') transport.service_name = sn
    }
    out.transport = transport
  } else if (network === 'h2') {
    const transport: Record<string, unknown> = { type: 'http' }
    const opts = raw['h2-opts']
    if (opts && typeof opts === 'object') {
      const h2 = opts as Record<string, unknown>
      const path = getStr(h2, 'path')
      if (path !== '') transport.path = path
      const host = h2.host
      if (Array.isArray(host) && typeof host[0] === 'string') transport.host = [host[0]]
    }
    out.transport = transport
  } else if (network === 'httpupgrade') {
    const transport: Record<string, unknown> = { type: 'httpupgrade' }
    const opts = raw['ws-opts']
    if (opts && typeof opts === 'object') {
      const ws = opts as Record<string, unknown>
      const path = getStr(ws, 'path')
      if (path !== '') transport.path = path
      const headers = ws.headers
      if (headers && typeof headers === 'object') {
        const host = (headers as Record<string, unknown>).Host
        if (typeof host === 'string') transport.host = host
      }
    }
    out.transport = transport
  }
}

/** One ParsedNode -> one sing-box outbound (GoProxy buildOutbound). */
export function buildOutbound(node: ParsedNode, tag: string): Record<string, unknown> | null {
  const raw = node.raw
  const out: Record<string, unknown> = {
    tag,
    server: node.server,
    server_port: node.port, // sing-box uses server_port, not port
  }
  switch (node.type) {
    case 'vmess':
      out.type = 'vmess'
      out.uuid = getStr(raw, 'uuid')
      out.alter_id = getInt(raw, 'alterId')
      out.security = getStrDefault(raw, 'cipher', 'auto')
      applyTLS(raw, out)
      applyTransport(raw, out)
      break
    case 'vless':
      out.type = 'vless'
      out.uuid = getStr(raw, 'uuid')
      const flow = getStr(raw, 'flow')
      if (flow !== '') out.flow = flow
      applyTLS(raw, out)
      applyTransport(raw, out)
      break
    case 'trojan':
      out.type = 'trojan'
      out.password = getStr(raw, 'password')
      applyTLS(raw, out)
      applyTransport(raw, out)
      break
    case 'shadowsocks': {
      out.type = 'shadowsocks'
      out.method = getStr(raw, 'cipher') || getStr(raw, 'method')
      out.password = getStr(raw, 'password')
      const plugin = getStr(raw, 'plugin')
      if (plugin !== '') {
        out.plugin = plugin
        const opts = raw['plugin-opts']
        if (opts && typeof opts === 'object') {
          out.plugin_opts = Object.entries(opts as Record<string, unknown>)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join(';')
        }
      }
      break
    }
    case 'hysteria2':
      out.type = 'hysteria2'
      out.password = getStr(raw, 'password')
      // TLS-mandatory (QUIC + TLS), like anytls below. Verified against
      // sing-box 1.14.3: a node whose Clash entry carries no sni/tls/
      // client-fingerprint/reality-opts produced an outbound with no tls at
      // all, and `sing-box check` then rejected the ENTIRE config with
      // "initialize outbound[N]: TLS required" — parking all 49 nodes of a
      // real airport subscription over 4 hysteria2 entries.
      applyTLS({ ...raw, tls: true }, out)
      break
    case 'tuic':
      out.type = 'tuic'
      out.uuid = getStr(raw, 'uuid')
      out.password = getStr(raw, 'password')
      out.congestion_control = getStrDefault(raw, 'congestion-controller', 'bbr')
      // TUIC is TLS-mandatory too (measured the same way as hysteria2).
      applyTLS({ ...raw, tls: true }, out)
      break
    case 'anytls':
      out.type = 'anytls'
      out.password = getStr(raw, 'password')
      // anytls is TLS-mandatory (GoProxy forceTLS)
      applyTLS({ ...raw, tls: true }, out)
      break
    default:
      return null
  }
  return out
}

// -- config generation --------------------------------------------------------

export interface GeneratedConfig {
  config: Record<string, unknown>
  /**
   * Local port per INPUT node, index-aligned; `0` for a node whose type has no
   * sing-box outbound mapping (no inbound, no rule, no port burned).
   *
   * Index alignment replaced a `type:server:port`-keyed map (live 2026-10-13).
   * That key is NOT a node identity: a real airport fronts many distinct nodes
   * on ONE edge `host:port` and separates them only by the anytls TLS
   * `server_name`, so 44 parsed nodes collapsed into 13 keys. The map kept the
   * LAST port per key, every earlier node resolved to that same port, and 31
   * generated inbounds were orphaned — listening, never handed to the pool. The
   * exit table showed 13 exits for a 44-node subscription. Two nodes that are
   * genuinely one exit are still collapsed, one layer down and quota-aware:
   * `ExitPool.add()` refuses a second address that measured the same exit IP
   * (docs §3.1).
   */
  ports: number[]
}

/**
 * The full sing-box config for a node list (GoProxy generateConfig).
 *
 * `keep` restricts the emitted inbounds to those candidate indexes (the
 * onboarding's selection). Ports are assigned from the node's position in the
 * CANDIDATE list, never from its position in the emitted subset — so shrinking
 * the config to the fastest N, or promoting a reserve later, leaves every node
 * that stays selected on the same local port. That stability is what lets the
 * pool keep its exit ids (and their health, counters and session stickiness)
 * across a rebuild; a positional subset would renumber every survivor and
 * silently repoint the pool at different nodes.
 */
export function generateConfig(nodes: ParsedNode[], basePort = 30_000, keep?: readonly number[]): GeneratedConfig {
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
    const port = basePort + 1 + index
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

export class SingBoxSupervisor {
  readonly #options: SingBoxOptions
  #child: ChildProcess | null = null
  #running = false
  #configPath: string
  #dataDir: string
  /** Port per node of the last reload(), index-aligned (`0` = no inbound). */
  #ports: number[] = []
  #nodes: ParsedNode[] = []

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

  /**
   * Full reload: regenerate the config for the node list and (re)start.
   *
   * `keep` (candidate indexes) emits only those nodes' inbounds — the
   * onboarding's "keep the fastest N" and its later reserve promotions — while
   * every kept node stays on its own stable port. Absent = every node.
   */
  async reload(input: ParsedNode[], keep?: readonly number[]): Promise<ConvertedExit[]> {
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
      await this.stop()
      this.#nodes = []
      this.#ports = []
      return []
    }
    const binary = await this.#resolveBinary()
    const { config, ports } = generateConfig(nodes, this.#options.basePort ?? 30_000, keep)

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

    await this.stop()
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
    child.once('exit', () => {
      if (this.#child === child) this.#running = false
    })
    child.once('error', () => {
      if (this.#child === child) this.#running = false
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
      exits.push({ address: `127.0.0.1:${port}`, protocol: 'socks5', node, slot: index })
    })
    return exits
  }

  /** Graceful stop: interrupt -> grace -> kill (taskkill /T on Windows). */
  async stop(): Promise<void> {
    const child = this.#child
    if (child === null || child.exitCode !== null) {
      this.#running = false
      return
    }
    this.#child = null
    if (process.platform === 'win32' && child.pid) {
      // graceful attempt first, then /T /F
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/T', '/PID', String(child.pid)], { stdio: 'ignore' })
        killer.once('exit', () => resolve())
        killer.once('error', () => resolve())
      })
    } else {
      child.kill('SIGINT')
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const grace = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), STOP_GRACE_MS))
    if ((await Promise.race([exited.then(() => 'exit' as const), grace])) === 'timeout') {
      if (process.platform === 'win32' && child.pid) {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
          killer.once('exit', () => resolve())
          killer.once('error', () => resolve())
        })
      } else {
        child.kill('SIGKILL')
      }
      await exited
    }
    this.#running = false
  }
}
