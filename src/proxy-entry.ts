/**
 * One manual proxy entry (`ipPool.manual[]`, `ipPool.pinnedExitId`), parsed the
 * same way by the server (src/ip-pool.ts) and the settings card, so the card
 * never refuses an entry the pool accepts or the reverse. Pure: no Node APIs.
 */

export type ProxyProtocol = 'http' | 'socks5'

export interface ManualProxy {
  /** The trimmed entry: the row id, pin value and usage-ledger key. */
  id: string
  protocol: ProxyProtocol
  /** Bare host (brackets kept for IPv6) and port: what is actually dialled. */
  host: string
  port: number
}

const SCHEMES: Record<string, ProxyProtocol> = {
  http: 'http',
  https: 'http',
  socks4: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5',
}

const AUTHORITY = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(\d{1,5})$/

/**
 * Parse `[scheme://]host:port`. Credentials (`user:pw@`) are refused: the
 * entry is the row id, which lands in logs, /status and usage.json.
 */
export function parseManualProxy(entry: string): ManualProxy | null {
  const trimmed = entry.trim()
  if (trimmed === '') return null
  const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(trimmed)
  let protocol: ProxyProtocol = 'http'
  if (schemeMatch) {
    const mapped = SCHEMES[schemeMatch[1]!.toLowerCase()]
    if (mapped === undefined) return null
    protocol = mapped
  }
  const rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed
  const match = AUTHORITY.exec(rest)
  if (match === null) return null
  const port = Number(match[2])
  if (port < 1 || port > 65535) return null
  return { id: trimmed, protocol, host: match[1]!, port }
}

/** True when {@link parseManualProxy} accepts the entry. */
export function isManualProxyEntry(entry: string): boolean {
  return parseManualProxy(entry) !== null
}
