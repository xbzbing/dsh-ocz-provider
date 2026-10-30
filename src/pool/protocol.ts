/**
 * Which protocol does a proxy LISTENER actually speak?
 *
 * A row's protocol is typed by the operator (manual rows) or inferred by the
 * subscription converter, and a wrong label sends HTTP CONNECT into a SOCKS
 * listener (or the reverse): the peer drops the socket, every request dies in
 * milliseconds with `502 relay_error ECONNRESET`, and the pool sees only
 * "transport" — so it keeps re-picking the row (AGENTS.md, egress row hygiene).
 *
 * The probes are protocol-level and never reach the upstream: a SOCKS5
 * greeting (`05 01 00`), then an origin-form HTTP request and an HTTP CONNECT
 * to a reserved-by-RFC5737 address (only the proxy's own reply is read). Each
 * is one connect + one short read, and a refused port answers immediately, so
 * this is cheap enough to run on a pin click and after a transport failure.
 */

import net from 'node:net'

export type ProxyProtocol = 'http' | 'socks5'

export interface ProxyEndpoint {
  host: string
  port: number
}

/** host:port out of `host:port`, `http://host:port` or `socks5://host:port`. */
export function proxyEndpoint(address: string): ProxyEndpoint | null {
  const trimmed = address.trim().replace(/^[a-z0-9]+:\/\//i, '')
  const slash = trimmed.indexOf('/')
  const authority = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const lastColon = authority.lastIndexOf(':')
  if (lastColon <= 0) return null
  const host = authority.slice(0, lastColon).replace(/^\[|\]$/g, '')
  const port = Number(authority.slice(lastColon + 1))
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

/** One connect-and-read probe: true when the reply satisfies `want`, false on
 *  timeout, socket error or close-before-answer. */
function probeBytes(endpoint: ProxyEndpoint, payload: Buffer, want: (first: Buffer) => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const socket = net.connect({ host: endpoint.host, port: endpoint.port })
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
    socket.once('connect', () => {
      socket.write(payload)
    })
    socket.on('data', (chunk: Buffer) => finish(want(chunk)))
  })
}

/** SOCKS5 servers answer the method negotiation with `05 <method>`. */
function probeSocks(endpoint: ProxyEndpoint, timeoutMs: number): Promise<boolean> {
  return probeBytes(endpoint, Buffer.from([5, 1, 0]), (first) => first.length >= 2 && first[0] === 5, timeoutMs)
}

/**
 * HTTP proxies answer with a status line, and any status counts: only an HTTP
 * speaker can emit one. Two requests, cheapest first:
 *
 *   1. an origin-form `GET /` — a proxy answers it (400/403/404/…) without
 *      dialling anything, so proxies that resolve a CONNECT target before
 *      replying (squid, tinyproxy) still answer inside the timeout;
 *   2. a CONNECT to a documentation-reserved address (RFC 5737), for proxies
 *      that drop an origin-form request without a reply.
 */
async function probeHttp(endpoint: ProxyEndpoint, timeoutMs: number): Promise<boolean> {
  const isStatus = (first: Buffer): boolean => first.length >= 5 && first.subarray(0, 5).toString('latin1') === 'HTTP/'
  const origin = 'GET / HTTP/1.1\r\nHost: 203.0.113.1\r\nConnection: close\r\n\r\n'
  if (await probeBytes(endpoint, Buffer.from(origin, 'latin1'), isStatus, timeoutMs)) return true
  const connect = 'CONNECT 203.0.113.1:443 HTTP/1.1\r\nHost: 203.0.113.1:443\r\n\r\n'
  return probeBytes(endpoint, Buffer.from(connect, 'latin1'), isStatus, timeoutMs)
}

/**
 * Detect the protocol of one listener, or null when nothing usable answers.
 *
 * null is a first-class answer: the caller must NOT guess in that case (an
 * unreachable listener is a pin to refuse, not a row to relabel).
 */
export async function detectProxyProtocol(address: string, options: { timeoutMs?: number } = {}): Promise<ProxyProtocol | null> {
  const endpoint = proxyEndpoint(address)
  if (endpoint === null) return null
  const timeoutMs = options.timeoutMs ?? 1_200
  if (await probeSocks(endpoint, timeoutMs)) return 'socks5'
  if (await probeHttp(endpoint, timeoutMs)) return 'http'
  return null
}

/** True when the address points at this machine (no DNS involved). */
export function isLoopbackEndpoint(address: string): boolean {
  const endpoint = proxyEndpoint(address)
  if (endpoint === null) return false
  return endpoint.host === '127.0.0.1' || endpoint.host === 'localhost' || endpoint.host === '::1'
}
