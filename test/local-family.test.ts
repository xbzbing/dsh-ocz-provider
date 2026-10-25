/**
 * 本机出口协议族 (local-family.ts) — the setting, its default, and the socket
 * behaviour each position produces.
 *
 * The free lane answered 200 + a real SSE completion over this host's IPv6 and
 * 403 FreeTierError over its IPv4 on identical bytes. Node resolves
 * opencode.ai's A records first here, so `auto` reorders the answers rather
 * than trust the resolver.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LOCAL_IP_FAMILY,
  localEgressConnectOptions,
  resolveLocalIpFamily,
  hasIpv6Address,
  ipv6FirstLookup,
  sortIpv6First,
  type InterfaceReader,
} from '../src/pool/local-family.ts'

const GLOBAL_V6: InterfaceReader = () => ({
  en0: [
    { address: '192.168.31.100', family: 'IPv4' },
    { address: '240e:305:18ac:3c00:d635:38ff:fe16:a2c0', family: 'IPv6' },
  ],
})

const IPV4_ONLY: InterfaceReader = () => ({
  en0: [
    { address: '192.168.31.100', family: 'IPv4' },
    { address: '127.0.0.1', family: 'IPv4', internal: true },
  ],
})

const LINK_LOCAL_ONLY: InterfaceReader = () => ({
  en0: [
    { address: '192.168.31.100', family: 'IPv4' },
    { address: 'fe80::1c2b:3fff:fe4c:1e1a%en0', family: 'IPv6' },
  ],
})

test('the 本机出口协议族 setting resolves to auto for anything unrecognised', () => {
  assert.equal(resolveLocalIpFamily('ipv4'), 'ipv4')
  assert.equal(resolveLocalIpFamily('ipv6'), 'ipv6')
  assert.equal(resolveLocalIpFamily('auto'), 'auto')
  // A hand-edited profile patch must not be able to make the field unreadable:
  // unknown, empty and absent all land on the shipped default.
  assert.equal(resolveLocalIpFamily('IPv6'), 'auto')
  assert.equal(resolveLocalIpFamily(''), 'auto')
  assert.equal(resolveLocalIpFamily(undefined), 'auto')
  assert.equal(resolveLocalIpFamily(6), 'auto')
  assert.equal(DEFAULT_LOCAL_IP_FAMILY, 'auto', 'the shipped default prefers IPv6 where this machine has it')
})

test('only a routable IPv6 address counts as "this machine has IPv6"', () => {
  assert.equal(hasIpv6Address(GLOBAL_V6), true)
  // Link-local is on every interface and never routable off-link: counting it
  // would send the lane to a family the host may not have at all.
  assert.equal(hasIpv6Address(LINK_LOCAL_ONLY), false)
  assert.equal(hasIpv6Address(IPV4_ONLY), false)
  assert.equal(hasIpv6Address(() => ({})), false)
  // Unique-local (`fd00::/8`) DOES count: the installed app reaches
  // opencode.ai from a ULA source on this host (fd00:6868:… → 2606:4700:78::…).
  assert.equal(hasIpv6Address(() => ({ utun0: [{ address: 'fd00:6868:6868::c70:da13:3828:ced9', family: 'IPv6' }] })), true)
  // A host whose table cannot be read is IPv4-only, never a crash.
  assert.equal(hasIpv6Address(() => { throw new Error('no interfaces') }), false)
  // os.networkInterfaces() reports the numeric family on older Node and the
  // string on newer ones; both spellings must be read the same way.
  assert.equal(hasIpv6Address(() => ({ en0: [{ address: '2001:db8::1', family: 6 }] })), true)
})

test('the explicit positions pin the family; auto only reorders the answers', () => {
  assert.deepEqual(localEgressConnectOptions('ipv4', GLOBAL_V6), { family: 4 })
  assert.deepEqual(localEgressConnectOptions('ipv6', IPV4_ONLY), { family: 6 }, 'only-IPv6 is a pin, not a wish')
  // auto with IPv6 present: AAAA first, IPv4 still in the list for the
  // happy-eyeballs fallback.
  assert.deepEqual(localEgressConnectOptions('auto', GLOBAL_V6), { lookup: ipv6FirstLookup })
  // auto without IPv6: no opinion at all — Node's own order (IPv4 first here).
  assert.deepEqual(localEgressConnectOptions('auto', IPV4_ONLY), {})
  assert.deepEqual(localEgressConnectOptions('auto', LINK_LOCAL_ONLY), {})
})

/** Run the lookup and hand back its arguments (the resolver is IO-bound). */
function callLookup(
  hostname: string,
  options: { family?: number; all?: boolean },
): Promise<{ err: NodeJS.ErrnoException | null; address: string | Array<{ address: string; family: number }>; family?: number }> {
  return new Promise((resolve) => {
    ipv6FirstLookup(hostname, options, (err, address, family) => {
      resolve({ err, address, family })
    })
  })
}

test('the answer order puts every AAAA record ahead of the A records', () => {
  const sorted = sortIpv6First([
    { address: '172.65.90.21', family: 4 },
    { address: '2606:4700:78::90:0:140', family: 6 },
    { address: '172.65.90.22', family: 4 },
    { address: '2606:4700:78::90:0:141', family: 6 },
  ])
  assert.deepEqual(sorted.map((row) => row.family), [6, 6, 4, 4])
  assert.equal(sorted.length, 4, 'nothing is filtered out — the fallback needs the A records')
  // A family-0 answer (the resolver saying "not an address") ranks last.
  assert.deepEqual(sortIpv6First([{ address: 'weird', family: 0 }, { address: '1.1.1.1', family: 4 }]).map((r) => r.address), ['1.1.1.1', 'weird'])
})

test('the IPv6-first lookup reorders what the resolver answers, end to end', async () => {
  // `localhost` resolves from the hosts file, so this exercises the real
  // dns.lookup path without leaving the machine.
  const all = await callLookup('localhost', { all: true })
  assert.equal(all.err, null)
  const rows = all.address as Array<{ address: string; family: number }>
  assert.ok(rows.length >= 1, 'the answers come back')
  if (rows.some((row) => row.family === 6)) {
    assert.equal(rows[0]!.family, 6, 'when the host has an IPv6 loopback, it leads')
  }
  const single = await callLookup('localhost', {})
  assert.equal(single.err, null)
  assert.equal(typeof single.address, 'string', 'the single-answer shape hands back one address')
  assert.equal(single.family, (rows[0] ?? { family: 4 }).family)
})

test('the IPv6-first lookup surfaces resolver failures as ENOTFOUND', async () => {
  // RFC 2606 reserves .invalid, so this cannot resolve anywhere.
  const miss = await callLookup('nonexistent.invalid', {})
  assert.ok(miss.err instanceof Error, 'the resolver error travels through')
  assert.equal((miss.err as NodeJS.ErrnoException).code, 'ENOTFOUND')
})
