import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { detectProxyProtocol, isLoopbackEndpoint, proxyEndpoint } from '../src/pool/protocol.ts'

/**
 * The detector exists because a pool row's protocol was never checked against
 * the listener (live 2026-10-25: an `http` row on a SOCKS inbound 502'd every
 * request in 6 ms). These tests stand up real listeners, because the thing
 * under test is exactly "what does this socket answer".
 */

interface Listening {
  port: number
  close: () => Promise<void>
}

/** A listener that greets every connection with `greeting` and then idles. */
function listener(greeting: Buffer | null): Promise<Listening> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', () => {
        if (greeting !== null) socket.write(greeting)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () => new Promise<void>((done) => { server.close(() => done()) }),
      })
    })
  })
}

/** A port nothing listens on: bind, read the number, release it. */
async function deadPort(): Promise<number> {
  const probe = await listener(null)
  await probe.close()
  return probe.port
}

test('proxyEndpoint parses the three address spellings and rejects junk', () => {
  assert.deepEqual(proxyEndpoint('127.0.0.1:30033'), { host: '127.0.0.1', port: 30033 })
  assert.deepEqual(proxyEndpoint('socks5://127.0.0.1:30033'), { host: '127.0.0.1', port: 30033 })
  assert.deepEqual(proxyEndpoint(' http://proxy.example:8080/ '), { host: 'proxy.example', port: 8080 })
  assert.deepEqual(proxyEndpoint('http://[::1]:1087'), { host: '::1', port: 1087 })
  assert.equal(proxyEndpoint('127.0.0.1'), null)
  assert.equal(proxyEndpoint(':30033'), null)
  assert.equal(proxyEndpoint('host:0'), null)
  assert.equal(proxyEndpoint('host:99999'), null)
})

test('isLoopbackEndpoint only trusts literal loopback spellings', () => {
  assert.equal(isLoopbackEndpoint('127.0.0.1:30033'), true)
  assert.equal(isLoopbackEndpoint('http://localhost:1087'), true)
  assert.equal(isLoopbackEndpoint('socks5://[::1]:30033'), true)
  assert.equal(isLoopbackEndpoint('10.0.0.1:30033'), false)
  assert.equal(isLoopbackEndpoint('nonsense'), false)
})

test('a SOCKS5 greeting identifies a socks listener', async () => {
  const socks = await listener(Buffer.from([5, 0]))
  try {
    assert.equal(await detectProxyProtocol(`127.0.0.1:${socks.port}`), 'socks5')
    // The scheme in the address never decides the answer.
    assert.equal(await detectProxyProtocol(`http://127.0.0.1:${socks.port}`), 'socks5')
  } finally {
    await socks.close()
  }
})

test('an HTTP status line identifies an http listener', async () => {
  const http = await listener(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n', 'latin1'))
  try {
    assert.equal(await detectProxyProtocol(`127.0.0.1:${http.port}`), 'http')
    assert.equal(await detectProxyProtocol(`socks5://127.0.0.1:${http.port}`), 'http')
  } finally {
    await http.close()
  }
})

test('a 407 reply is still an http proxy', async () => {
  const http = await listener(Buffer.from('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n', 'latin1'))
  try {
    assert.equal(await detectProxyProtocol(`127.0.0.1:${http.port}`), 'http')
  } finally {
    await http.close()
  }
})

test('a listener that answers nothing is undecided, not guessed', async () => {
  const silent = await listener(null)
  try {
    assert.equal(await detectProxyProtocol(`127.0.0.1:${silent.port}`, { timeoutMs: 200 }), null)
  } finally {
    await silent.close()
  }
})

test('a closed port is undecided and answers fast', async () => {
  const port = await deadPort()
  const started = Date.now()
  assert.equal(await detectProxyProtocol(`127.0.0.1:${port}`), null)
  assert.ok(Date.now() - started < 1_000, 'a refused port must not wait out the timeout')
})

test('an unparsable address is undecided without touching the network', async () => {
  assert.equal(await detectProxyProtocol('not-an-address'), null)
})
