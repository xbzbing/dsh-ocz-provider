/**
 * Who may call the bridge. Two fences, in order:
 *   1. this module's own: loopback socket + canonical loopback Host header +
 *      same-origin browser request;
 *   2. the host: from 0.2.3 the webserver authenticates an exact route before
 *      dispatch (default `required` policy through `webserver/authorize`) and
 *      hands the admitted `peer` to the handler — that peer is the proof, so
 *      the route needs no second call. Hosts that predate it expose the
 *      authentication on the `connection` service instead: `admit(request)`
 *      (current, cookie → peer or a 401/403 rejection) or the removed
 *      `requestRejection(request)` (≤ 0.2.2-rc.5, same decision as a status).
 *      The two are called in that order so an old host keeps its exact former
 *      behaviour. No fence and no peer = no way to authenticate = 403.
 */

/** The host request facts a fence reads (the cookie and Host are in `headers`). */
export interface BridgeAuthRequest {
  headers: Record<string, string | string[] | undefined>
  method?: string
  url?: URL
  transport?: 'http' | 'upgrade'
}

/** The slice of the host `connection` service the bridge authenticates with. */
export interface ConnectionFence {
  /**
   * Legacy (≤ 0.2.2-rc.5) decision: undefined = admitted, else the HTTP status.
   */
  requestRejection?(request: unknown): number | undefined
  /** Current decision: a rejection status, or the admitted peer. */
  admit?(request: BridgeAuthRequest): { rejection?: number; peer?: unknown } | undefined
}

/** Reads the host `connection` service at request time (undefined = absent). */
export type ConnectionReader = () => ConnectionFence | undefined

/** Whether a socket address is a literal loopback peer. */
function isLoopbackAddress(address: unknown): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether a normalized hostname is a literal loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Parse one bare Host authority; undefined for anything non-canonical. */
function parseAuthority(authority: string): { url: URL } | undefined {
  if (authority.trim() !== authority) return undefined
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority)
    : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL('http://' + authority)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) return undefined
    return { url }
  } catch {
    return undefined
  }
}

/** Browser same-origin marker (loopback hosts are always same-origin here). */
function isSameOriginRequest(request: { headers: Record<string, string | string[] | undefined> }, hostUrl: URL): boolean {
  const headers = request.headers
  const site = headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(String(origin)).host === hostUrl.host
  } catch {
    return false
  }
}

/** Hot-path trust decision: loopback socket + canonical Host + same-origin. */
export function isTrustedBridgeRequest(request: {
  socket?: { remoteAddress?: unknown }
  headers: Record<string, string | string[] | undefined>
}): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined || parsed.url.host.toLowerCase() !== host.toLowerCase()) return false
  if (!isSameOriginRequest(request, parsed.url)) return false
  return isLoopbackHostname(parsed.url.hostname)
}

/**
 * The full admission decision: the HTTP status to refuse with, or undefined
 * when the request may proceed. Fails closed when the connection service is
 * absent or throws.
 */
export function bridgeRejection(
  request: Parameters<typeof isTrustedBridgeRequest>[0] & { method?: string; url?: unknown },
  connection: ConnectionReader | undefined,
  hostAdmitted?: boolean,
): 401 | 403 | undefined {
  if (!isTrustedBridgeRequest(request)) return 403
  // The 0.2.3 host authenticated this exact route before dispatch and handed
  // its peer to the handler; there is nothing left to ask.
  if (hostAdmitted === true) return undefined
  const fence = connection?.()
  if (fence === undefined) return 403
  try {
    if (typeof fence.requestRejection === 'function') return asStatus(fence.requestRejection(request))
    if (typeof fence.admit === 'function') {
      const admission = fence.admit(toAuthRequest(request))
      return admission === undefined ? 403 : asStatus(admission.rejection)
    }
  } catch {
    return 403
  }
  return 403
}

/** Normalize a host verdict (undefined = admitted) to the status to answer. */
function asStatus(rejection: number | undefined): 401 | 403 | undefined {
  if (rejection === undefined) return undefined
  return rejection === 401 ? 401 : 403
}

/** The request shape `admit()` reads: headers plus the URL its Host came from. */
function toAuthRequest(request: { headers: Record<string, string | string[] | undefined>; method?: string; url?: unknown }): BridgeAuthRequest {
  const host = request.headers.host
  let url: URL | undefined
  if (typeof request.url === 'string') {
    try {
      url = new URL(request.url, `http://${typeof host === 'string' ? host : 'localhost'}`)
    } catch {
      url = undefined
    }
  }
  return {
    headers: request.headers,
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(url === undefined ? {} : { url }),
    transport: 'http',
  }
}
