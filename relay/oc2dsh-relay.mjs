#!/usr/bin/env bun
/**
 * oc2dsh upstream relay — the Bun half of the free-lane gate: the lane gates on
 * the client's TLS/HTTP fingerprint, so this process must send upstream
 * requests with `fetch` — never `node:net`/`node:tls`, which the gate rejects.
 *
 * Contract with the plugin (src/relay/supervisor.ts, docs/relay.md):
 *   - listens on 127.0.0.1:<port>, port from OC2DSH_RELAY_PORT (0 = ephemeral);
 *   - prints `OC2DSH_RELAY_READY <port>` on stdout once listening;
 *   - every request must carry a loopback `Host` naming this port, and — when
 *     OC2DSH_RELAY_TOKEN is set — a path starting with `/_/<token>`, which is
 *     stripped before anything else reads the path;
 *   - forwards `<METHOD> <pathname><search>` to OC2DSH_RELAY_UPSTREAM,
 *     streaming the response back untouched;
 *   - per-request egress from the `x-oc2dsh-egress` header, stripped before
 *     forwarding (the upstream must never see it):
 *       (absent) / `direct`        -> this machine's egress
 *       `direct;family=4|6|prefer6` -> this machine's egress on one IP family
 *                                     (local CONNECT bridge, then `proxy`)
 *       `http://h:p`               -> Bun fetch `proxy` option
 *       `socks5://h:p`             -> local CONNECT->SOCKS5 bridge, then `proxy`
 *     The bridges exist because Bun's `proxy` accepts http(s) only and has no
 *     family knob; they move BYTES only, so the TLS session — and the
 *     fingerprint the gate sees — stays Bun's. They tunnel to the upstream
 *     origin and nowhere else.
 *   - `GET <prefix>/__oc2dsh/health` answers `{"ok":true,…}` without touching upstream.
 */

import net from 'node:net'
import dns from 'node:dns'
import { timingSafeEqual } from 'node:crypto'

const UPSTREAM = (process.env.OC2DSH_RELAY_UPSTREAM || 'https://opencode.ai').replace(/\/+$/, '')
const PORT = Number(process.env.OC2DSH_RELAY_PORT || '0') || 0
const HOST = process.env.OC2DSH_RELAY_HOST || '127.0.0.1'
const TOKEN = (process.env.OC2DSH_RELAY_TOKEN || '').trim()
const EGRESS_HEADER = 'x-oc2dsh-egress'
const HEALTH_PATH = '/__oc2dsh/health'

/** The one authority the bridges may tunnel to: the upstream origin. */
const UPSTREAM_URL = new URL(UPSTREAM)
const TUNNEL_HOST = UPSTREAM_URL.hostname.replace(/^\[|\]$/g, '').toLowerCase()
const TUNNEL_PORT = Number(UPSTREAM_URL.port || (UPSTREAM_URL.protocol === 'https:' ? 443 : 80))

/** Headers that describe ONE hop and must not be forwarded (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding', // Bun sets its own and decodes the body itself
])

/**
 * Headers the official client never sends, added by the Node side of this hop
 * (the OpenAI SDK and undici's fetch). Dropping them, and letting Bun add its
 * default Accept as the client's own fetch does, leaves upstream the client's
 * exact header set, names, casing and order (docs/relay.md).
 */
const NODE_STACK_HEADERS = new Set(['accept', 'accept-language', 'sec-fetch-mode'])
const NODE_STACK_PREFIX = 'x-stainless-'

// -- request admission --------------------------------------------------------

/** True when `host` is a loopback authority naming this listener's port. */
function isOwnHost(host, port) {
  if (typeof host !== 'string') return false
  const value = host.toLowerCase()
  return value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`
}

const TOKEN_BYTES = Buffer.from(TOKEN)

/**
 * The request path with the `/_/<token>` prefix removed, or null when the
 * prefix is missing or wrong. No token configured = the path as given.
 */
function stripToken(pathname) {
  if (TOKEN === '') return pathname
  if (!pathname.startsWith('/_/')) return null
  const rest = pathname.slice(3)
  const slash = rest.indexOf('/')
  const presented = Buffer.from(slash === -1 ? rest : rest.slice(0, slash))
  if (presented.length !== TOKEN_BYTES.length || !timingSafeEqual(presented, TOKEN_BYTES)) return null
  return slash === -1 ? '/' : rest.slice(slash)
}

// -- egress -------------------------------------------------------------------

/**
 * Egress as the plugin asks for it. An absent header is a plain request (the
 * plugin always sets it, but a hand-run curl must not blow up).
 */
function parseEgress(raw) {
  const value = (raw || '').trim()
  if (value === '' || value.toLowerCase() === 'direct') return { kind: 'direct' }
  const family = /^direct;\s*family=(4|6|prefer6)$/i.exec(value)?.[1]?.toLowerCase()
  if (family !== undefined) return { kind: 'direct', family }
  const scheme = /^(https?|socks5h?):\/\//i.exec(value)?.[1]?.toLowerCase()
  if (scheme === undefined) return { kind: 'invalid', value }
  if (scheme === 'http' || scheme === 'https') return { kind: 'http', url: value }
  return { kind: 'socks5', url: value }
}

/** One egress as the log and the 429 annotation name it. */
function describeEgress(egress) {
  if (egress.kind !== 'direct') return egress.kind
  return egress.family === undefined ? 'direct' : `direct;family=${egress.family}`
}

/**
 * Protocol corrections learned at runtime, per egress URL: a connect that dies
 * because a row is labelled with the wrong scheme is retried once on the other
 * scheme, and the success is remembered so later requests skip the doomed
 * first attempt. The row's own label is corrected on the pool side
 * (pool/transport.ts relabel, or the pin probe) — this process has no way back
 * into it.
 */
const protocolFixes = new Map()

/** host:port of an egress URL — the key a correction is remembered under. */
function egressKey(url) {
  return String(url).replace(/^[a-z0-9]+:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
}

/** Rebuild one egress URL on `kind`, keeping its host:port. */
function withScheme(url, kind) {
  return `${kind}://${egressKey(url)}`
}

/** Apply a remembered correction to this request's egress. */
function withFix(egress) {
  if (egress.url === undefined) return egress
  const fixed = protocolFixes.get(egressKey(egress.url))
  if (fixed === undefined || fixed === egress.kind) return egress
  return { kind: fixed, url: withScheme(egress.url, fixed) }
}

/** The same proxy on the other scheme. */
function swapEgress(egress) {
  const kind = egress.kind === 'http' ? 'socks5' : 'http'
  return { kind, url: withScheme(egress.url, kind) }
}

/** `55248` -> `15h20m`, for error text a human has to read. */
function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return `${hours}h${String(minutes).padStart(2, '0')}m`
}

const FAMILY_LABEL = { 4: ' IPv4', 6: ' IPv6', prefer6: ' IPv6 优先' }

/**
 * The free lane's 429 is a QUOTA on the egress ADDRESS, not a broken request,
 * and nothing in the response says so. The relay is the only hop that sees both
 * the status and the egress it chose, so it appends that context (exit plus the
 * retry-after window) to the message the host will show; the body stays valid
 * JSON with the original fields intact.
 */
function annotateQuotaResponse(text, headers, egress) {
  const retryAfter = Number(headers.get('retry-after') ?? '')
  const where = egress.kind === 'direct'
    ? `本机出口${egress.family === undefined ? '' : FAMILY_LABEL[egress.family]}`
    : `出口 ${egress.url}`
  const reset = Number.isFinite(retryAfter) && retryAfter > 0
    ? `，retry-after ${retryAfter}s≈${humanDuration(retryAfter)} 后恢复`
    : ''
  const hint = `[oc2dsh: ${where}${reset}。免费额度按出口 IP 计，换一个出口即可继续]`
  try {
    const parsed = JSON.parse(text)
    const error = parsed?.error ?? parsed
    if (typeof error?.message === 'string') {
      error.message = `${error.message} ${hint}`
      return JSON.stringify(parsed)
    }
  } catch {
    // not JSON: fall through and keep the text readable
  }
  return `${text} ${hint}`
}

// -- local CONNECT bridges ------------------------------------------------------

/**
 * SOCKS5 handshake timeout. Loopback inbounds answer in well under a
 * millisecond, so this only fires when the port is NOT a SOCKS server — where
 * the peer may sit on our greeting forever instead of replying. Without it the
 * request hangs and the protocol swap in the handler never fires.
 */
const SOCKS_HANDSHAKE_TIMEOUT_MS = 3_000

/**
 * Ceiling on the rescue attempt that follows a failed proxy connect (see the
 * swap in the request handler). The FIRST attempt is deliberately unbounded, so
 * a slow-but-healthy exit is never cut; this one only runs after a connect has
 * already failed, where waiting is pure loss.
 */
const SWAP_TIMEOUT_MS = 8_000

/** A CONNECT head larger than this, or slower than the timeout, is dropped. */
const CONNECT_HEAD_LIMIT_BYTES = 8 * 1024
const CONNECT_HEAD_TIMEOUT_MS = 10_000

/**
 * Per-address TCP connect bound for direct dials: short while another address
 * is left to try (a black-holed IPv6 path must not stall the IPv4 fallback),
 * longer for the last one.
 */
const DIRECT_FALLBACK_CONNECT_MS = 3_000
const DIRECT_LAST_CONNECT_MS = 10_000

/** Bridges with no open tunnel for this long are closed; at most this many live. */
const BRIDGE_IDLE_MS = 5 * 60_000
const BRIDGE_LIMIT = 32

/** Expected SOCKS5 reply length from its first bytes; undefined = need more, null = unknown ATYP. */
function socks5ReplyLength(buffer) {
  if (buffer.length < 5) return undefined
  const atyp = buffer[3]
  if (atyp === 1) return 4 + 4 + 2
  if (atyp === 4) return 4 + 16 + 2
  if (atyp === 3) return 4 + 1 + buffer[4] + 2
  return null
}

/**
 * SOCKS5 CONNECT (no auth) on a socket to the proxy. Replies are buffered
 * until complete, so a reply split across reads parses the same; resolves with
 * whatever arrived after the reply (it belongs to the tunnel).
 */
function socks5Connect(socket, host, port) {
  return new Promise((resolve, reject) => {
    let stage = 0
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (error, leftover) => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (error !== null) {
        socket.destroy()
        reject(error)
        return
      }
      // Errors after the handshake belong to the tunnel (splice tears it down).
      socket.on('error', () => {})
      socket.pause()
      resolve(leftover)
    }
    const onError = (err) => finish(err)
    const onClose = () => finish(new Error('socks5 closed during handshake'))
    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (stage === 0) {
        if (buffer.length < 2) return
        if (buffer[0] !== 5 || buffer[1] !== 0) return finish(new Error('socks5 auth rejected'))
        buffer = buffer.subarray(2)
        stage = 1
        const name = Buffer.from(host)
        socket.write(Buffer.concat([
          Buffer.from([5, 1, 0, 3, name.length]),
          name,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]))
      }
      if (buffer.length >= 2 && buffer[0] !== 5) return finish(new Error('socks5 bad reply version'))
      if (buffer.length >= 2 && buffer[1] !== 0) return finish(new Error(`socks5 connect code ${buffer[1]}`))
      const total = socks5ReplyLength(buffer)
      if (total === undefined) return
      if (total === null) return finish(new Error(`socks5 unknown address type ${buffer[3]}`))
      if (buffer.length < total) return
      finish(null, buffer.subarray(total))
    }
    socket.setTimeout(SOCKS_HANDSHAKE_TIMEOUT_MS, () => finish(new Error('socks5 handshake timeout')))
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.write(Buffer.from([5, 1, 0]))
  })
}

/** host:port of a socks URL. */
function socksEndpoint(url) {
  const withoutScheme = url.replace(/^socks5h?:\/\//i, '')
  const slash = withoutScheme.indexOf('/')
  const authority = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash)
  const lastColon = authority.lastIndexOf(':')
  if (lastColon === -1) return null
  const host = authority.slice(0, lastColon).replace(/^\[|\]$/g, '')
  const port = Number(authority.slice(lastColon + 1))
  if (host === '' || !Number.isFinite(port) || port <= 0) return null
  return { host, port }
}

/** Open a tunnel to the proxy and through it to `host:port`. */
function openViaSocks(endpoint) {
  return async (host, port) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port })
    try {
      return { socket, leftover: await socks5Connect(socket, host, port) }
    } catch (err) {
      throw new Error(`${err.message} (socks ${endpoint.host}:${endpoint.port})`)
    }
  }
}

/** One TCP connect to an address, bounded; resolves once connected. */
function connectOnce(address, family, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port, family })
    const fail = (err) => {
      socket.destroy()
      reject(err)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error(`connect timeout ${address}:${port}`)))
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.off('error', fail)
      socket.on('error', () => {})
      socket.pause()
      resolve(socket)
    })
  })
}

/** Every address `host` resolves to, filtered and ordered for `family`. */
function addressesFor(host, family) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true }, (err, rows) => {
      if (err) return reject(err)
      const list = Array.isArray(rows) ? rows : []
      const v6 = list.filter((row) => row.family === 6)
      const v4 = list.filter((row) => row.family === 4)
      const chosen = family === '4' ? v4 : family === '6' ? v6 : [...v6, ...v4]
      if (chosen.length === 0) return reject(new Error(`no IPv${family === '4' ? '4' : '6'} address for ${host}`))
      resolve(chosen)
    })
  })
}

/**
 * Dial `host:port` from this machine on one family: `4`/`6` use that family
 * only, `prefer6` tries every AAAA answer first and falls back to A on a
 * connect failure.
 */
function openDirect(family) {
  return async (host, port) => {
    const addresses = await addressesFor(host, family)
    let lastError
    for (let i = 0; i < addresses.length; i += 1) {
      const row = addresses[i]
      const bound = i < addresses.length - 1 ? DIRECT_FALLBACK_CONNECT_MS : DIRECT_LAST_CONNECT_MS
      try {
        return { socket: await connectOnce(row.address, row.family, port, bound), leftover: Buffer.alloc(0) }
      } catch (err) {
        lastError = err
      }
    }
    throw lastError ?? new Error(`no address for ${host}`)
  }
}

/** Parse `CONNECT host:port HTTP/1.x`; brackets are stripped from IPv6 literals. */
function parseConnectTarget(head) {
  const line = head.split('\r\n', 1)[0] ?? ''
  const match = /^CONNECT\s+(\[[^\]\s]+\]|[^\s:[\]]+):(\d{1,5})\s+HTTP\/1\.[01]$/i.exec(line)
  if (match === null) return null
  const port = Number(match[2])
  if (port <= 0 || port > 65535) return null
  return { host: match[1].replace(/^\[|\]$/g, ''), port }
}

/** Join two sockets; either side closing or failing destroys both. */
function splice(a, b) {
  let done = false
  const teardown = () => {
    if (done) return
    done = true
    a.destroy()
    b.destroy()
  }
  for (const socket of [a, b]) {
    socket.on('error', teardown)
    socket.on('close', teardown)
  }
  a.pipe(b)
  b.pipe(a)
}

/**
 * Serve one CONNECT on `client`: read a bounded head, refuse anything but the
 * upstream origin, then splice the client onto `open(host, port)`.
 */
function serveConnect(client, open, onTunnel) {
  let buffered = Buffer.alloc(0)
  let answered = false
  const refuse = (status) => {
    if (answered) return
    answered = true
    client.off('data', onHead)
    client.setTimeout(0)
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  client.on('error', () => client.destroy())
  client.setTimeout(CONNECT_HEAD_TIMEOUT_MS, () => {
    if (!answered) client.destroy()
  })
  const onHead = (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    const end = buffered.indexOf('\r\n\r\n')
    if (end === -1 || end > CONNECT_HEAD_LIMIT_BYTES) {
      if (buffered.length > CONNECT_HEAD_LIMIT_BYTES) refuse('431 Request Header Fields Too Large')
      return
    }
    client.off('data', onHead)
    client.pause()
    client.setTimeout(0)
    const target = parseConnectTarget(buffered.subarray(0, end).toString('latin1'))
    if (target === null) return refuse('400 Bad Request')
    if (target.host.toLowerCase() !== TUNNEL_HOST || target.port !== TUNNEL_PORT) {
      log(`BRIDGE refused CONNECT ${target.host}:${target.port} (not the upstream origin)`)
      return refuse('403 Forbidden')
    }
    const rest = buffered.subarray(end + 4)
    open(target.host, target.port).then(
      ({ socket, leftover }) => {
        if (client.destroyed) {
          socket.destroy()
          return
        }
        answered = true
        onTunnel(client)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (rest.length > 0) socket.write(rest)
        if (leftover.length > 0) client.write(leftover)
        splice(client, socket)
      },
      (err) => {
        log(`BRIDGE connect failed ${target.host}:${target.port}: ${err.message}`)
        /**
         * Answer like a proxy instead of dropping the socket: a silent close
         * leaves Bun's CONNECT waiting for a status line, so the request hangs
         * and the protocol-swap retry in the handler never fires.
         */
        refuse('502 Bad Gateway')
      },
    )
  }
  client.on('data', onHead)
}

/**
 * Local CONNECT listeners on 127.0.0.1, one per socks endpoint or direct
 * family, created on first use. A failed listen is forgotten; a bridge with no
 * open tunnel for {@link BRIDGE_IDLE_MS} is closed, and past
 * {@link BRIDGE_LIMIT} the least recently used idle one goes first.
 */
const bridges = new Map()

function bridgeFor(key, open) {
  const cached = bridges.get(key)
  if (cached !== undefined) {
    cached.lastUsed = Date.now()
    return cached.port
  }
  const entry = { port: undefined, server: undefined, tunnels: 0, lastUsed: Date.now() }
  entry.port = new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      serveConnect(client, open, (tunnel) => {
        entry.tunnels += 1
        entry.lastUsed = Date.now()
        tunnel.once('close', () => {
          entry.tunnels -= 1
          entry.lastUsed = Date.now()
        })
      })
    })
    entry.server = server
    server.on('error', (err) => {
      if (bridges.get(key) === entry) bridges.delete(key)
      reject(err)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      log(`BRIDGE ${key} -> http://127.0.0.1:${port}`)
      resolve(port)
    })
  })
  entry.port.catch(() => {})
  bridges.set(key, entry)
  trimBridges()
  return entry.port
}

/** Close idle bridges: every one past the idle window, then LRU down to the cap. */
function trimBridges() {
  const now = Date.now()
  const idle = [...bridges.entries()].filter(([, entry]) => entry.tunnels === 0)
  idle.sort((left, right) => left[1].lastUsed - right[1].lastUsed)
  let excess = bridges.size - BRIDGE_LIMIT
  for (const [key, entry] of idle) {
    if (now - entry.lastUsed < BRIDGE_IDLE_MS && excess <= 0) continue
    bridges.delete(key)
    entry.server?.close()
    excess -= 1
    log(`BRIDGE closed ${key} (idle)`)
  }
}

const bridgeSweep = setInterval(trimBridges, 60_000)
bridgeSweep.unref?.()

/** Resolve the Bun `proxy` option for one request, or undefined for direct. */
async function proxyFor(egress) {
  if (egress.kind === 'direct') {
    if (egress.family === undefined) return undefined
    const port = await bridgeFor(`direct;family=${egress.family}`, openDirect(egress.family))
    return `http://127.0.0.1:${port}`
  }
  if (egress.kind === 'http') return egress.url
  if (egress.kind === 'socks5') {
    const endpoint = socksEndpoint(egress.url)
    if (endpoint === null) throw new Error(`unparsable socks url ${egress.url}`)
    const port = await bridgeFor(egress.url, openViaSocks(endpoint))
    return `http://127.0.0.1:${port}`
  }
  throw new Error(`unsupported egress ${egress.value}`)
}

function log(line) {
  process.stdout.write(`RELAY ${line}\n`)
}

// -- the relay itself -------------------------------------------------------

/** A JSON refusal from the relay itself (never forwarded upstream). */
function refusal(status, message) {
  return Response.json({ error: { type: 'relay_refused', message } }, { status })
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // Bun's ceiling. The lane streams tokens; anything under a minute would cut
  // healthy long answers mid-stream.
  idleTimeout: 255,
  async fetch(request) {
    // DNS rebinding and foreign local callers: only this listener's own
    // loopback authority, and only with the per-spawn path token.
    if (!isOwnHost(request.headers.get('host'), server.port)) return refusal(421, 'misdirected request')
    const url = new URL(request.url)
    const pathname = stripToken(url.pathname)
    if (pathname === null) return refusal(403, 'forbidden')
    if (pathname === HEALTH_PATH) {
      return Response.json({ ok: true, upstream: UPSTREAM, pid: process.pid })
    }
    const method = request.method
    const started = Date.now()
    const requested = parseEgress(request.headers.get(EGRESS_HEADER))
    let egress = withFix(requested)
    const forwarded = new Headers()
    request.headers.forEach((value, name) => {
      const key = name.toLowerCase()
      if (HOP_BY_HOP.has(key)) return
      if (key === EGRESS_HEADER) return
      if (NODE_STACK_HEADERS.has(key) || key.startsWith(NODE_STACK_PREFIX)) return
      forwarded.set(name, value)
    })
    const body =
      method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer())
    const target = `${UPSTREAM}${pathname}${url.search}`
    /**
     * One upstream attempt over `candidate`. The caller's abort always rides
     * along, so a client that leaves cancels the upstream request too.
     */
    const attempt = async (candidate, timeoutMs) => {
      const proxy = await proxyFor(candidate)
      const signal = timeoutMs === undefined
        ? request.signal
        : AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
      return await fetch(target, {
        method,
        headers: forwarded,
        body,
        signal,
        ...(proxy === undefined ? {} : { proxy }),
      })
    }
    let upstream
    let failure
    try {
      upstream = await attempt(egress)
    } catch (err) {
      failure = err
    }
    /**
     * A connect that never produced a response is the shape of a protocol
     * mismatch (see `protocolFixes`): one retry on the other scheme, and the
     * correction is remembered for this egress URL. A caller that already left
     * gets no retry.
     */
    if (upstream === undefined && !request.signal.aborted && (egress.kind === 'http' || egress.kind === 'socks5')) {
      /**
       * The rescue attempt is BOUNDED: the first attempt already failed, so a
       * peer that accepts the connection and then says nothing would otherwise
       * hold this request forever. Healthy traffic never reaches here, so this
       * bound cannot cut a slow-but-working exit.
       */
      const alt = swapEgress(egress)
      try {
        upstream = await attempt(alt, SWAP_TIMEOUT_MS)
        egress = alt
        protocolFixes.set(egressKey(alt.url), alt.kind)
        log(`PROTO-FIX ${alt.url} ${requested.kind}->${alt.kind} (connect failed, retry served)`)
      } catch (err) {
        failure = err
      }
    }
    if (upstream === undefined) {
      if (request.signal.aborted) {
        log(`${method} ${pathname} ${describeEgress(egress)} CLIENT-ABORT ${Date.now() - started}ms`)
        return new Response(null, { status: 499 })
      }
      log(`${method} ${pathname} ${describeEgress(egress)} UPSTREAM-ERR ${String(failure?.message ?? failure).slice(0, 160)}`)
      return Response.json({ error: { type: 'relay_error', message: String(failure?.message ?? failure) } }, { status: 502 })
    }
    const headers = new Headers(upstream.headers)
    // Bun's fetch already decoded the body, so these three would make the
    // caller decode it again or size a stream it receives in chunks.
    headers.delete('content-length')
    headers.delete('content-encoding')
    headers.delete('transfer-encoding')
    log(`${method} ${pathname} ${upstream.status} ${Date.now() - started}ms ${describeEgress(egress)}`)
    if (upstream.status === 429) {
      const text = await upstream.text()
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
      return new Response(annotateQuotaResponse(text, upstream.headers, egress), { status: 429, headers })
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  },
})

log(`READY ${server.port} upstream=${UPSTREAM} pid=${process.pid}`)
// The supervisor parses exactly this line; keep the spelling stable.
process.stdout.write(`OC2DSH_RELAY_READY ${server.port}\n`)

/**
 * Parent-death watchdog: the supervisor pipes our stdin, so EOF = parent gone.
 * Opt-in (`OC2DSH_RELAY_WATCH_STDIN=1`) because a relay started by hand from a
 * shell — or with stdin on /dev/null — sees EOF immediately and would stop on
 * its first tick.
 */
if (process.env.OC2DSH_RELAY_WATCH_STDIN === '1') {
  process.stdin.on('end', () => shutdown('stdin closed'))
  process.stdin.on('close', () => shutdown('stdin closed'))
  process.stdin.resume()
}

let stopping = false
function shutdown(why) {
  if (stopping) return
  stopping = true
  log(`STOP ${why}`)
  void server.stop(true)
  setTimeout(() => process.exit(0), 250)
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => shutdown(signal))
}
