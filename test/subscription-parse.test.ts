import test from 'node:test'
import assert from 'node:assert/strict'

import { parseProxyLinks, parseShadowsocksLink, parseStandardLink, parseSubscription, safeDecode } from '../src/pool/subscription.ts'
import { buildOutbound } from '../src/pool/singbox.ts'

test('safeDecode: malformed percent-encoding comes back verbatim', () => {
  assert.equal(safeDecode('%E5%80%8D'), '倍')
  assert.equal(safeDecode('倍率100%'), '倍率100%')
})

test('a node name that is not valid percent-encoding no longer fails the round', () => {
  const node = parseStandardLink('trojan://pw@t.example.com:443#倍率100%', 'trojan')
  assert.equal(node?.name, '倍率100%')
  assert.equal(node?.raw.password, 'pw')
  const ss = parseShadowsocksLink(`ss://${Buffer.from('aes-256-gcm:p:w').toString('base64')}@s.example.com:8388#100%off`)
  assert.equal(ss?.name, '100%off')
})

test('parseProxyLinks: one bad line costs that line only', () => {
  const vmess = (port: number) => `vmess://${Buffer.from(JSON.stringify({ add: 'v.example.com', port, id: 'u', ps: `p${port}` })).toString('base64')}`
  const body = [
    vmess(443),
    vmess(70_000),
    'trojan://pw@t.example.com:443#倍率100%',
  ].join('\n')
  const { nodes, skipped } = parseProxyLinks(body)
  assert.deepEqual(nodes.map((node) => node.type), ['vmess', 'trojan'])
  assert.equal(skipped, 1, 'the out-of-range vmess port is skipped')
  assert.equal(parseSubscription(body).nodes.length, 2)
})

test('ss:// SIP002 userinfo is split into method and password for sing-box', () => {
  const ss = parseShadowsocksLink(`ss://${Buffer.from('chacha20-ietf-poly1305:pa:ss').toString('base64')}@s.example.com:8388#n`)
  assert.equal(ss?.raw.method, 'chacha20-ietf-poly1305')
  assert.equal(ss?.raw.password, 'pa:ss')
  const out = buildOutbound(ss!, 'out')
  assert.equal(out?.method, 'chacha20-ietf-poly1305')
  assert.equal(out?.password, 'pa:ss')
})
