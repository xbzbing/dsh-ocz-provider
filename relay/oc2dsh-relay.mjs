#!/usr/bin/env bun
/**
 * oc2dsh upstream relay — the second half of the free-lane gate.
 *
 * WHY A SEPARATE BUN PROCESS EXISTS (live-probed 2026-10-25): the anonymous
 * lane gates on the CLIENT CONNECTION STACK, not on the payload. A
 * byte-identical replay of the official 2.1.4 request (its 16 headers, its
 * captured body, its family path) answers 429 FreeUsageLimitError from Node
 * h1/h2, curl 8.7 h2, Python urllib and Go net/http on every egress — direct
 * v4/v6, the client's own ULA source address and all seven pool exits — while
 * the SAME bytes through this relay answer 200 with a real SSE stream.
 * Ablations ruled out the header set, header case, body, route,
 * `accept-encoding`, HTTP version, source IP, cookies and trace headers; what
 * is left is the TLS/HTTP fingerprint of the client library, which no payload
 * edit can move. The official client is a Bun binary, so the fix is to let
 * BUN send the request.
 *
 * Verified in this exact shape (`docs/local/capture-214/`):
 *   Bun fetch, direct ………………………………… 200
 *   Bun fetch, `proxy: http://…` …………… 200
 *   Bun fetch through a CONNECT->SOCKS5 bridge … 200 (three pool exits)
 *   Bun `node:tls` + hand-written HTTP/1.1 ……… 429   <- NOT the same stack
 * That last line is the important one: this relay must use `fetch`, never
 * `node:net`/`node:tls`, or the gate closes again.
 *
 * Contract with the plugin (src/relay/supervisor.ts):
 *   - listens on 127.0.0.1:<port>, port from OC2DSH_RELAY_PORT (0 = ephemeral);
 *   - prints `OC2DSH_RELAY_READY <port>` on stdout once listening;
 *   - forwards `<METHOD> <pathname><search>` to OC2DSH_RELAY_UPSTREAM,
 *     streaming the response back untouched;
 *   - per-request egress from the `x-oc2dsh-egress` header, which is stripped
 *     before forwarding (the upstream must never see it):
 *       (absent) / `direct`   -> this machine's egress
 *       `http://h:p`          -> Bun fetch `proxy` option
 *       `socks5://h:p`        -> local CONNECT->SOCKS5 bridge, then `proxy`
 *     The SOCKS bridge exists because Bun's `proxy` accepts http(s) only
 *     (`UnsupportedProxyProtocol` for socks5://), while the exit pool is
 *     SOCKS5-shaped (sing-box inbounds). The bridge moves BYTES only — the
 *     TLS session is still Bun's, so the fingerprint that passes the gate is
 *     preserved.
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
 * always sets the header, but a hand-run curl against this relay must not blow
 * up), `direct` = no proxy.
 */
function parseEgress(raw) {
  const value = (raw || '').trim()
  if (value === '' || value.toLowerCase() === 'direct') return { kind: 'direct' }
  const scheme = /^(https?|socks5h?):\/\//i.exec(value)?.[1]?.toLowerCase()
  if (scheme === undefined) return { kind: 'invalid', value }
  if (scheme === 'http' || scheme === 'https') return { kind: 'http', url: value }
  return { kind: 'socks5', url: value }
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

/** SOCKS5 CONNECT (no auth) on an already-open socket to the proxy. */
function socks5Connect(socket, host, port) {
  return new Promise((resolve, reject) => {
    let stage = 0
    const fail = (why) => reject(new Error(`socks5 ${why}`))
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
        upstream.on('error', () => client.destroy())
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
            client.destroy()
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
    const egress = parseEgress(request.headers.get(EGRESS_HEADER))
    const forwarded = new Headers()
    request.headers.forEach((value, name) => {
      const key = name.toLowerCase()
      if (HOP_BY_HOP.has(key)) return
      if (key === EGRESS_HEADER) return
      forwarded.set(name, value)
    })
    const body =
      method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer())
    let proxy
    try {
      proxy = await proxyFor(egress)
    } catch (err) {
      log(`${method} ${url.pathname} ${egress.kind} EGRESS-ERR ${err.message}`)
      return Response.json({ error: { type: 'relay_error', message: String(err.message ?? err) } }, { status: 502 })
    }
    const target = `${UPSTREAM}${url.pathname}${url.search}`
    let upstream
    try {
      upstream = await fetch(target, {
        method,
        headers: forwarded,
        body,
        ...(proxy === undefined ? {} : { proxy }),
      })
    } catch (err) {
      log(`${method} ${url.pathname} ${egress.kind} UPSTREAM-ERR ${String(err?.message ?? err).slice(0, 160)}`)
      return Response.json({ error: { type: 'relay_error', message: String(err?.message ?? err) } }, { status: 502 })
    }
    const headers = new Headers(upstream.headers)
    // The request went out without `accept-encoding`, so the body is identity;
    // dropping these three keeps the client from trying to decode or to size a
    // stream it will receive in chunks.
    headers.delete('content-length')
    headers.delete('content-encoding')
    headers.delete('transfer-encoding')
    log(`${method} ${url.pathname} ${upstream.status} ${Date.now() - started}ms ${egress.kind}`)
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
