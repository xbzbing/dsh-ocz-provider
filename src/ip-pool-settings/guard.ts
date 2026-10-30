/**
 * Who may call the bridge. Two fences, both required:
 *   1. this module's own: loopback socket + canonical loopback Host header +
 *      same-origin browser request;
 *   2. the host's `connection` service (`requestRejection`): its Host/Origin
 *      fence plus the browser login cookie. The host webserver matches exact
 *      routes before its `/api` prefix route, so the cookie check that guards
 *      `/api` never runs for these paths unless the bridge asks for it.
 * No `connection` service = no way to authenticate the caller = 403.
 */

/** The slice of the host `connection` service the bridge uses. */
export interface ConnectionFence {
  /** undefined = admitted; otherwise the HTTP status to answer (401/403). */
  requestRejection(request: unknown): number | undefined
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
  request: Parameters<typeof isTrustedBridgeRequest>[0],
  connection: ConnectionReader | undefined,
): 401 | 403 | undefined {
  if (!isTrustedBridgeRequest(request)) return 403
  const fence = connection?.()
  if (fence === undefined || typeof fence.requestRejection !== 'function') return 403
  let rejection: number | undefined
  try {
    rejection = fence.requestRejection(request)
  } catch {
    return 403
  }
  if (rejection === undefined) return undefined
  return rejection === 401 ? 401 : 403
}
