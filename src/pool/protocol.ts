/**
 * Which protocol does a proxy LISTENER actually speak?
 *
 * Why this exists (live 2026-10-25): the pool's rows carry a protocol that the
 * operator typed (manual rows) or that the subscription converter inferred, and
 * nothing ever checked it against the listener. A row labelled `http` whose
 * port is a sing-box SOCKS inbound takes every request through the relay's
 * HTTP CONNECT into a SOCKS server that answers nothing and drops the socket —
 * the user sees `502 relay_error ECONNRESET` (6 ms, measured) on EVERY request
 * while the same port answers 200 through `socks5://`. The pool cannot see
 * that failure kind as anything but "transport", so it kept re-picking the row.
 *
 * The two probes are protocol-level and never reach the upstream: a SOCKS5
 * greeting (`05 01 00`) and an HTTP CONNECT to a reserved-by-RFC5737 address
 * (nothing is dialled — only the proxy's own reply is read). Both are one
 * connect + one short read, and a refused port answers immediately, so this is
 * cheap enough to run on a pin click and after a transport failure.
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

/** One connect-and-read probe: resolves with the first bytes, null on failure. */
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
 * HTTP proxies answer the CONNECT verb with a status line. The target is
 * documentation-reserved (RFC 5737) and never dialled by a well-behaved proxy
 * for a detection probe; a 407/403/502 reply is just as good a signature as
 * 200, because only an HTTP proxy can emit it at all.
 */
function probeHttp(endpoint: ProxyEndpoint, timeoutMs: number): Promise<boolean> {
  const head = 'CONNECT 203.0.113.1:443 HTTP/1.1\r\nHost: 203.0.113.1:443\r\n\r\n'
  return probeBytes(endpoint, Buffer.from(head, 'latin1'), (first) => first.length >= 5 && first.subarray(0, 5).toString('latin1') === 'HTTP/', timeoutMs)
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
