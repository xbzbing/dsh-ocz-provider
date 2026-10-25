#!/usr/bin/env bun
/**
 * oc2dsh upstream relay — the Bun half of the free-lane gate: the lane gates on
 * the client's TLS/HTTP fingerprint, so this process must send upstream
 * requests with `fetch` — never `node:net`/`node:tls`, which the gate rejects.
 *
 * Contract with the plugin (src/relay/supervisor.ts):
 *   - listens on 127.0.0.1:<port>, port from OC2DSH_RELAY_PORT (0 = ephemeral);
 *   - prints `OC2DSH_RELAY_READY <port>` on stdout once listening;
 *   - forwards `<METHOD> <pathname><search>` to OC2DSH_RELAY_UPSTREAM,
 *     streaming the response back untouched;
 *   - per-request egress from the `x-oc2dsh-egress` header, stripped before
 *     forwarding (the upstream must never see it):
 *       (absent) / `direct`   -> this machine's egress
 *       `http://h:p`          -> Bun fetch `proxy` option
 *       `socks5://h:p`        -> local CONNECT->SOCKS5 bridge, then `proxy`
 *     The bridge exists because Bun's `proxy` accepts http(s) only
 *     (`UnsupportedProxyProtocol` for socks5://) while the exit pool is
 *     SOCKS5-shaped; it moves BYTES only, so the TLS session — and the
 *     fingerprint the gate sees — stays Bun's.
 *   - `GET /__oc2dsh/health` answers `{"ok":true,…}` without touching upstream.
 *
 * Nothing secret crosses this process: the lane's credential is the literal
 * `public`, and the relay is bound to loopback.
 */

import net from 'node:net'

const UPSTREAM = (process.env.OC2DSH_RELAY_UPSTREAM || 'https://opencode.ai').replace(/\/+$/, '')
const PORT = Number(process.env.OC2DSH_RELAY_PORT || '0') || 0
const HOST = process.env.OC2DSH_RELAY_HOST || '127.0.0.1'
const EGRESS_HEADER = 'x-oc2dsh-egress'

/** Headers that describe ONE hop and must not be forwarded (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding', // identity upstream: no decode ambiguity on the way back
])

/**
 * Egress as the plugin asks for it. `undefined` = plain request (the plugin
 * always sets the header, but a hand-run curl must not blow up), `direct` = no
 * proxy.
 */
function parseEgress(raw) {
  const value = (raw || '').trim()
  if (value === '' || value.toLowerCase() === 'direct') return { kind: 'direct' }
  const scheme = /^(https?|socks5h?):\/\//i.exec(value)?.[1]?.toLowerCase()
  if (scheme === undefined) return { kind: 'invalid', value }
  if (scheme === 'http' || scheme === 'https') return { kind: 'http', url: value }
  return { kind: 'socks5', url: value }
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

/**
 * The free lane's 429 is a QUOTA on the egress ADDRESS, not a broken request,
 * and nothing in the response says so. The relay is the only hop that sees both
 * the status and the egress it chose, so it appends that context (exit plus the
 * retry-after window) to the message the host will show; the body stays valid
 * JSON with the original fields intact.
 */
function annotateQuotaResponse(text, headers, egress) {
  const retryAfter = Number(headers.get('retry-after') ?? '')
  const where = egress.kind === 'direct' ? '本机出口' : `出口 ${egress.url}`
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

// -- CONNECT -> SOCKS5 bridge (one listener per distinct socks proxy) --------

/** scheme://host:port of a socks URL. */
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

/** SOCKS5 CONNECT (no auth) on an already-open socket to the proxy. */
function socks5Connect(socket, host, port) {
  return new Promise((resolve, reject) => {
    let stage = 0
    const fail = (why) => {
      socket.setTimeout(0)
      reject(new Error(`socks5 ${why}`))
    }
    socket.setTimeout(SOCKS_HANDSHAKE_TIMEOUT_MS, () => {
      socket.destroy()
      fail('handshake timeout')
    })
    const onData = (chunk) => {
      if (stage === 0) {
        if (chunk[0] !== 5 || chunk[1] !== 0) return fail('auth rejected')
        const name = Buffer.from(host)
        stage = 1
        socket.write(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, name.length]),
            name,
            Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          ]),
        )
        return
      }
      if (stage !== 1) return
      if (chunk[1] !== 0) return fail(`connect code ${chunk[1]}`)
      stage = 2
      socket.setTimeout(0)
      socket.off('data', onData)
      // Anything after the reply belongs to the tunnel.
      const atyp = chunk[3]
      let offset = 4
      if (atyp === 1) offset += 4
      else if (atyp === 3) offset += 1 + chunk[4]
      else offset += 16
      resolve(chunk.subarray(offset + 2))
    }
    socket.on('data', onData)
    socket.once('error', (err) => reject(err))
    socket.write(Buffer.from([5, 1, 0]))
  })
}

/**
 * Serve HTTP CONNECT on 127.0.0.1 and tunnel every request through `socks`.
 * Returns the local port. One listener per socks endpoint, cached for the
 * process lifetime (the pool has one such endpoint per encrypted exit).
 */
const bridges = new Map()

function bridgeFor(socksUrl) {
  const cached = bridges.get(socksUrl)
  if (cached !== undefined) return cached
  const endpoint = socksEndpoint(socksUrl)
  if (endpoint === null) return Promise.reject(new Error(`unparsable socks url ${socksUrl}`))
  const created = new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      client.on('error', () => {})
      let buffered = Buffer.alloc(0)
      const onHead = (chunk) => {
        buffered = Buffer.concat([buffered, chunk])
        const end = buffered.indexOf('\r\n\r\n')
        if (end === -1) return
        client.off('data', onHead)
        const head = buffered.subarray(0, end).toString('latin1')
        const rest = buffered.subarray(end + 4)
        const target = /^CONNECT\s+([^\s:]+):(\d+)/i.exec(head)
        if (target === null) {
          client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
          return
        }
        const [host, port] = [target[1], Number(target[2])]
        const upstream = net.connect({ host: endpoint.host, port: endpoint.port })
        /**
         * A dead SOCKS inbound must answer 502, not just drop the socket: a
         * silent close leaves Bun's CONNECT waiting for a status line.
         */
        upstream.on('error', () => {
          log(`BRIDGE socks upstream unreachable ${endpoint.host}:${endpoint.port}`)
          try {
            client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          } catch {
            client.destroy()
          }
          upstream.destroy()
        })
        socks5Connect(upstream, host, port).then(
          (leftover) => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (rest.length > 0) upstream.write(rest)
            if (leftover.length > 0) client.write(leftover)
            client.pipe(upstream)
            upstream.pipe(client)
          },
          (err) => {
            log(`BRIDGE socks connect failed ${host}:${port}: ${err.message}`)
            /**
             * Answer like a proxy instead of dropping the socket: a silent
             * close leaves Bun's CONNECT waiting for a status line, so the
             * request hangs until the caller's timeout and the protocol-swap
             * retry in the handler never fires. 502 is true AND actionable.
             */
            try {
              client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
            } catch {
              client.destroy()
            }
            upstream.destroy()
          },
        )
      }
      client.on('data', onHead)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      log(`BRIDGE ${socksUrl} -> http://127.0.0.1:${port}`)
      resolve(port)
    })
  })
  bridges.set(socksUrl, created)
  return created
}

/** Resolve the Bun `proxy` option for one request, or undefined for direct. */
async function proxyFor(egress) {
  if (egress.kind === 'direct') return undefined
  if (egress.kind === 'http') return egress.url
  if (egress.kind === 'socks5') {
    const port = await bridgeFor(egress.url)
    return `http://127.0.0.1:${port}`
  }
  throw new Error(`unsupported egress ${egress.value}`)
}

function log(line) {
  process.stdout.write(`RELAY ${line}\n`)
}

// -- the relay itself -------------------------------------------------------

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // Bun's ceiling. The lane streams tokens; anything under a minute would cut
  // healthy long answers mid-stream.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/__oc2dsh/health') {
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
      forwarded.set(name, value)
    })
    const body =
      method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer())
    const target = `${UPSTREAM}${url.pathname}${url.search}`
    /** One upstream attempt over `candidate`, resolving to a Response. */
    const attempt = async (candidate, signal) => {
      const proxy = await proxyFor(candidate)
      return await fetch(target, {
        method,
        headers: forwarded,
        body,
        ...(proxy === undefined ? {} : { proxy }),
        ...(signal === undefined ? {} : { signal }),
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
     * correction is remembered for this egress URL.
     */
    if (upstream === undefined && (egress.kind === 'http' || egress.kind === 'socks5')) {
      /**
       * The rescue attempt is BOUNDED: the first attempt already failed, so a
       * peer that accepts the connection and then says nothing would otherwise
       * hold this request forever. Healthy traffic never reaches here, so this
       * bound cannot cut a slow-but-working exit.
       */
      const alt = swapEgress(egress)
      try {
        upstream = await attempt(alt, AbortSignal.timeout(SWAP_TIMEOUT_MS))
        egress = alt
        protocolFixes.set(egressKey(alt.url), alt.kind)
        log(`PROTO-FIX ${alt.url} ${requested.kind}->${alt.kind} (connect failed, retry served)`)
      } catch (err) {
        failure = err
      }
    }
    if (upstream === undefined) {
      log(`${method} ${url.pathname} ${egress.kind} UPSTREAM-ERR ${String(failure?.message ?? failure).slice(0, 160)}`)
      return Response.json({ error: { type: 'relay_error', message: String(failure?.message ?? failure) } }, { status: 502 })
    }
    const headers = new Headers(upstream.headers)
    // The request went out without `accept-encoding`, so the body is identity;
    // dropping these three keeps the client from trying to decode or to size a
    // stream it will receive in chunks.
    headers.delete('content-length')
    headers.delete('content-encoding')
    headers.delete('transfer-encoding')
    log(`${method} ${url.pathname} ${upstream.status} ${Date.now() - started}ms ${egress.kind}`)
    if (upstream.status === 429) {
      const text = await upstream.text()
      return new Response(annotateQuotaResponse(text, upstream.headers, egress), {
        status: 429,
        headers: { 'content-type': headers.get('content-type') ?? 'application/json' },
      })
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
