/**
 * 本机出口协议族: which IP family this machine's own egress uses when the pool
 * does not carry the request — an explicit 固定本机 pin, or 本地出口兜底 after a
 * pool miss.
 *
 * Why the setting exists: the free lane refuses this host's IPv4 and accepts
 * its IPv6 on byte-identical requests; the measurements live in
 * docs/ip-pool.md §3.7. `auto` (the default) reproduces the official client:
 * prefer IPv6 when this machine carries a routable one, and keep Node's
 * happy-eyeballs fallback (`autoSelectFamily`, on by default) so an absent or
 * broken IPv6 path still reaches IPv4. `ipv4` and `ipv6` pin the family
 * outright, for operators who know their line.
 *
 * Scope: only the LOCAL egress (this agent, and the relay's direct requests
 * via {@link relayDirectFamily}). Exit traffic is unaffected (a ProxyAgent
 * dials 127.0.0.1 and the family decision belongs to the far side), and so is
 * the router's plain `#direct` path, which carries loopback, out-of-pool hosts
 * and other lanes — a process-wide family flip is not this setting's job.
 */

import { lookup as dnsLookup } from 'node:dns'
import type { LookupAddress, LookupOptions } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { networkInterfaces } from 'node:os'

/** The 本机出口 positions the settings dropdown offers. */
export type LocalIpFamily = 'auto' | 'ipv4' | 'ipv6'

/** Shipped default: prefer IPv6 where this machine has it (mirrors the app). */
export const DEFAULT_LOCAL_IP_FAMILY: LocalIpFamily = 'auto'

/**
 * Anything that is not one of the two explicit positions resolves to `auto` —
 * a hand-edited profile patch must not be able to make the field unreadable
 * (same tolerance `resolveUsageScope` has for its own string setting).
 */
export function resolveLocalIpFamily(value: unknown): LocalIpFamily {
  return value === 'ipv4' || value === 'ipv6' ? value : DEFAULT_LOCAL_IP_FAMILY
}

/** One `os.networkInterfaces()` row, structurally (a test seam, not the OS). */
export interface InterfaceAddress {
  address: string
  family: string | number
  internal?: boolean
}

/** The interface table reader; injectable so tests never touch the host. */
export type InterfaceReader = () => Record<string, InterfaceAddress[] | undefined>

/**
 * Does this machine carry an IPv6 address it could actually leave by?
 *
 * Link-local (`fe80::/10`) does not count: every interface has one and it is
 * never routable off-link, so counting it would send the lane to a family the
 * host may not have at all — the exact mistake this check exists to avoid.
 * Unique-local (`fd00::/8`, `fc00::/7`) DOES count: the installed app reaches
 * opencode.ai from a ULA source on this host, so it is a working path here
 * (docs/ip-pool.md §3.7).
 */
export function hasIpv6Address(listInterfaces: InterfaceReader = networkInterfaces as InterfaceReader): boolean {
  let table: Record<string, InterfaceAddress[] | undefined>
  try {
    table = listInterfaces()
  } catch {
    // A host whose interface table cannot be read is treated as IPv4-only:
    // native order then applies and nothing regresses.
    return false
  }
  for (const rows of Object.values(table)) {
    for (const row of rows ?? []) {
      const family = typeof row.family === 'string' ? row.family : row.family === 6 ? 'IPv6' : 'IPv4'
      if (family !== 'IPv6' || row.internal === true) continue
      // Strip a zone suffix ('fe80::1%en0') before matching, and compare
      // case-insensitively: the OS spells the same address both ways.
      const address = row.address.toLowerCase().split('%')[0] ?? ''
      if (address === '' || address === '::1' || address.startsWith('fe80')) continue
      return true
    }
  }
  return false
}

/** IPv6 ranks above IPv4; a family-0 answer (not an IP at all) ranks last. */
function rank(address: LookupAddress): number {
  return address.family === 6 ? 2 : address.family === 4 ? 1 : 0
}

/**
 * The resolver's answers with AAAA first, every answer kept.
 *
 * Exported because this ordering IS the behaviour worth testing: it is the one
 * thing that makes `auto` reach IPv6 at all on a host whose resolver hands
 * back A records before AAAA (this machine does exactly that for opencode.ai).
 */
export function sortIpv6First(addresses: readonly LookupAddress[]): LookupAddress[] {
  return [...addresses].sort((a, b) => rank(b) - rank(a))
}

/**
 * `dns.lookup` with the AAAA answers first.
 *
 * The ordering is the whole point: `autoSelectFamily` only races the next
 * address when the previous CONNECTION fails, and the free lane's refusal is
 * an HTTP-level 403 that arrives over a perfectly healthy IPv4 socket — so a
 * happy-eyeballs setup that starts on IPv4 never reaches IPv6. Reversing the
 * resolver's order is what makes the IPv6 attempt first; keeping every answer
 * (never filtering to one family) is what keeps the fallback intact for hosts
 * and networks where IPv6 is absent, unroutable or black-holed.
 */
export const ipv6FirstLookup: LookupFunction = (hostname, options, callback) => {
  const opts: LookupOptions = options ?? {}
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 0)
      return
    }
    const rows = Array.isArray(addresses) ? addresses : []
    const sorted = sortIpv6First(rows)
    const first = sorted[0]
    if (first === undefined) {
      const notFound = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: 'ENOTFOUND',
        errno: -3008,
        syscall: 'getaddrinfo',
        hostname,
      }) as NodeJS.ErrnoException
      callback(notFound, '', 0)
      return
    }
    // `all: true` is how the happy-eyeballs path asks (it wants the whole list,
    // in the order it should try); anything else wants one answer back.
    if (opts.all === true) callback(null, sorted)
    else callback(null, first.address, first.family)
  })
}

/** The `connect` options an undici Agent takes for the local egress. */
export interface LocalEgressConnectOptions {
  family?: number
  lookup?: LookupFunction
}

/**
 * The `connect` options for the local-egress Agent, from one dropdown position.
 *
 * An empty object means "no opinion": the Agent then resolves with Node's own
 * order (IPv4 first on hosts like this one).
 */
export function localEgressConnectOptions(
  family: LocalIpFamily = DEFAULT_LOCAL_IP_FAMILY,
  listInterfaces: InterfaceReader = networkInterfaces as InterfaceReader,
): LocalEgressConnectOptions {
  if (family === 'ipv4') return { family: 4 }
  if (family === 'ipv6') return { family: 6 }
  return hasIpv6Address(listInterfaces) ? { lookup: ipv6FirstLookup } : {}
}

/**
 * The same choice for traffic the Bun relay sends from this machine
 * (src/relay/egress.ts `directEgressDirective`): null = the relay's own order.
 */
export function relayDirectFamily(
  family: LocalIpFamily = DEFAULT_LOCAL_IP_FAMILY,
  listInterfaces: InterfaceReader = networkInterfaces as InterfaceReader,
): 4 | 6 | 'prefer6' | null {
  if (family === 'ipv4') return 4
  if (family === 'ipv6') return 6
  return hasIpv6Address(listInterfaces) ? 'prefer6' : null
}
