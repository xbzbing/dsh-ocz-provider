/**
 * ParsedNode -> sing-box outbound mapping (the TS port of GoProxy
 * buildOutbound), plus the node identity the supervisor keys ports on.
 */

import type { ParsedNode } from './subscription.ts'

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
      const headers = stringHeaders(ws.headers)
      if (headers !== null) transport.headers = headers
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

/** sing-box wants `string -> string` headers; anything else in a raw map fails `sing-box check`. */
function stringHeaders(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
    else if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = String(entry)
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Credentials each outbound type cannot start without. */
const REQUIRED_FIELDS: Record<string, string[]> = {
  vmess: ['uuid'],
  vless: ['uuid'],
  tuic: ['uuid'],
  trojan: ['password'],
  hysteria2: ['password'],
  anytls: ['password'],
  shadowsocks: ['method', 'password'],
}

/**
 * One ParsedNode -> one sing-box outbound (GoProxy buildOutbound), or null for
 * an unsupported type or a node `sing-box check` would reject (bad port, empty
 * server, missing credentials). One such node would otherwise fail the check
 * for the whole config.
 */
export function buildOutbound(node: ParsedNode, tag: string): Record<string, unknown> | null {
  if (typeof node.server !== 'string' || node.server.trim() === '') return null
  if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) return null
  const out = mapOutbound(node, tag)
  if (out === null) return null
  for (const field of REQUIRED_FIELDS[String(out.type)] ?? []) {
    if (typeof out[field] !== 'string' || out[field] === '') return null
  }
  return out
}

/**
 * The node's identity: its outbound config without the tag. Two refreshes that
 * carry the same key carry the same exit; '' = no outbound at all.
 */
export function nodeKey(node: ParsedNode): string {
  const out = buildOutbound(node, '')
  return out === null ? '' : JSON.stringify(out)
}

function mapOutbound(node: ParsedNode, tag: string): Record<string, unknown> | null {
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
      // `method` is the split SIP002 value; Clash entries carry only `cipher`.
      out.method = getStr(raw, 'method') || getStr(raw, 'cipher')
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
      // TLS-mandatory (QUIC + TLS), like anytls below. A node whose Clash
      // entry carries no sni/tls/client-fingerprint/reality-opts would emit
      // an outbound with no tls at all, and `sing-box check` then rejects the
      // ENTIRE config ("initialize outbound[N]: TLS required"), parking every
      // node of the subscription over a few such entries (sing-box 1.14.3).
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
