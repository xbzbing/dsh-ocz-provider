import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { defaultRelayScript, findBun } from '../src/relay/supervisor.ts'

/**
 * The shipped relay (relay/oc2dsh-relay.mjs) runs as plain JS in a bun child
 * process, so nothing else in the suite executes it. It owns two behaviours
 * that exist nowhere else in this codebase:
 *
 *   1. a 429 is annotated with the egress that produced it plus its
 *      `retry-after`, because the lane's quota is per egress ADDRESS;
 *   2. an egress whose protocol is mislabelled is retried once on the other
 *      scheme and the correction remembered (`PROTO-FIX` in its log).
 *
 * Real listeners stand in for the proxies.
 */

const bun = findBun()
const maybe = bun === null ? test.skip : test
/**
 * The upstream must be TLS: Bun only tunnels through a proxy for `https://`
 * targets (a plain-http target uses absolute-form and never touches CONNECT),
 * so the CONNECT/bridge path under test would go unexercised. The certificate
 * is generated per run into a temp dir rather than committed.
 */
interface TlsPair {
  cert: Buffer
  key: Buffer
  dir: string
}

async function makeTlsPair(): Promise<TlsPair | null> {
  const dir = await mkdtemp(join(tmpdir(), 'oc2dsh-relay-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  const made = await new Promise<boolean>((resolve) => {
    const openssl = spawn('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '2', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' })
    openssl.on('error', () => resolve(false))
    openssl.on('exit', (code) => resolve(code === 0))
  })
  if (!made) {
    await rm(dir, { recursive: true, force: true })
    return null
  }
  return { cert: await readFile(certPath), key: await readFile(keyPath), dir }
}

interface Closer {
  close: () => Promise<void>
  port: number
}

/** TLS upstream: `/quota` answers the lane's 429, everything else 200. */
async function upstream(tls: TlsPair): Promise<Closer> {
  const sockets = new Set<{ destroy: () => void }>()
  const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    if ((req.url ?? '').includes('/quota')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '55248' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise<void>((done) => {
      // Keep-alive sockets outlive the assertions; destroy them or the harness
      // waits on them forever in teardown.
      for (const socket of sockets) socket.destroy()
      server.close(() => done())
    }),
  }
}

/** A SOCKS5 proxy that pipes to the requested target. */
async function socksProxy(): Promise<Closer> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    client.on('error', () => {})
    let stage = 0
    client.on('data', (chunk: Buffer) => {
      if (stage === 0) {
        if (chunk[0] !== 5) { client.destroy(); return }
        client.write(Buffer.from([5, 0]))
        stage = 1
        return
      }
      if (stage !== 1) return
      const atyp = chunk[3]
      let host: string
      let offset = 4
      if (atyp === 1) {
        host = [...chunk.subarray(4, 8)].join('.')
        offset = 8
      } else if (atyp === 3) {
        const length = chunk[4] ?? 0
        host = chunk.subarray(5, 5 + length).toString()
        offset = 5 + length
      } else {
        host = '::1'
        offset = 20
      }
      const port = chunk.readUInt16BE(offset)
      stage = 2
      const target = net.connect({ host, port })
      target.on('error', () => client.destroy())
      target.on('connect', () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        client.pipe(target)
        target.pipe(client)
      })
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise<void>((done) => {
      // Keep-alive sockets outlive the assertions; destroy them or the harness
      // waits on them forever in teardown.
      for (const socket of sockets) socket.destroy()
      server.close(() => done())
    }),
  }
}

/** An HTTP CONNECT proxy. */
async function httpProxy(): Promise<Closer> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    client.on('error', () => {})
    let buffered = Buffer.alloc(0)
    const onHead = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      client.off('data', onHead)
      const head = buffered.subarray(0, end).toString('latin1')
      const match = /^CONNECT\s+([^\s:]+):(\d+)/i.exec(head)
      if (match === null) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      const target = net.connect({ host: match[1], port: Number(match[2]) })
      target.on('error', () => client.destroy())
      target.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const rest = buffered.subarray(end + 4)
        if (rest.length > 0) target.write(rest)
        client.pipe(target)
        target.pipe(client)
      })
    }
    client.on('data', onHead)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise<void>((done) => {
      // Keep-alive sockets outlive the assertions; destroy them or the harness
      // waits on them forever in teardown.
      for (const socket of sockets) socket.destroy()
      server.close(() => done())
    }),
  }
}

/** A listener that accepts and never answers (an HTTP proxy awaiting CRLF). */
async function silentProxy(): Promise<Closer> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    client.on('error', () => {})
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise<void>((done) => {
      // Keep-alive sockets outlive the assertions; destroy them or the harness
      // waits on them forever in teardown.
      for (const socket of sockets) socket.destroy()
      server.close(() => done())
    }),
  }
}

interface Relay {
  port: number
  log: () => string
  close: () => Promise<void>
}

/** Spawn the real relay script against a real upstream, like the host does. */
async function startRelay(upstreamPort: number): Promise<Relay> {
  const child = spawn(bun as string, [defaultRelayScript()], {
    env: {
      ...process.env,
      OC2DSH_RELAY_PORT: '0',
      OC2DSH_RELAY_UPSTREAM: `https://127.0.0.1:${upstreamPort}`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { log += chunk })
  child.stderr.on('data', (chunk: string) => { log += chunk })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay never reported readiness: ${log}`)), 15_000)
    const scan = (): void => {
      const match = /OC2DSH_RELAY_READY (\d+)/.exec(log)
      if (match !== null) {
        clearTimeout(timer)
        child.stdout.off('data', scan)
        resolve(Number(match[1]))
      }
    }
    child.stdout.on('data', scan)
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`relay exited ${code}: ${log}`)) })
  })
  return {
    port,
    log: () => log,
    close: () => new Promise<void>((done) => {
      // A child that is already gone never emits 'exit' again — waiting for it
      // would hang forever.
      if (child.exitCode !== null || child.signalCode !== null) {
        done()
        return
      }
      child.once('exit', () => done())
      child.kill('SIGTERM')
    }),
  }
}

type Reply = { status: number; body: string; ms: number }

async function post(relayPort: number, path: string, egress?: string): Promise<Reply> {
  const started = Date.now()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (egress !== undefined) headers['x-oc2dsh-egress'] = egress
  const res = await fetch(`http://127.0.0.1:${relayPort}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'ping' }] }),
  })
  const body = await res.text()
  return { status: res.status, body, ms: Date.now() - started }
}

/**
 * Run `fn` against a TLS upstream, skipping cleanly when this machine cannot
 * make a certificate (openssl missing) and always cleaning the temp dir up.
 */
async function withUpstream(
  t: { skip: (reason: string) => void },
  fn: (upstreamPort: number) => Promise<void>,
): Promise<void> {
  const tls = await makeTlsPair()
  if (tls === null) {
    t.skip('openssl unavailable')
    return
  }
  const fake = await upstream(tls)
  try {
    await fn(fake.port)
  } finally {
    await fake.close()
    await rm(tls.dir, { recursive: true, force: true })
  }
}

maybe('a 429 is annotated with the egress and its retry-after', async (t) => {
  await withUpstream(t, async (upstreamPort) => {
    const relay = await startRelay(upstreamPort)
    try {
      const direct = await post(relay.port, '/v1/quota')
      assert.equal(direct.status, 429)
      // The upstream's own fields survive; the diagnosis is appended, not swapped.
      const parsed = JSON.parse(direct.body) as { error: { type: string; message: string } }
      assert.equal(parsed.error.type, 'FreeUsageLimitError')
      assert.match(parsed.error.message, /本机出口/)
      assert.match(parsed.error.message, /retry-after 55248s/)
      assert.match(parsed.error.message, /按出口 IP 计/)

      const exit = await httpProxy()
      try {
        const through = await post(relay.port, '/v1/quota', `http://127.0.0.1:${exit.port}`)
        assert.equal(through.status, 429)
        assert.match(through.body, new RegExp(`出口 http://127\\.0\\.0\\.1:${exit.port}`))
      } finally {
        await exit.close()
      }
    } finally {
      await relay.close()
    }
  })
})

maybe('an http label on a SOCKS inbound is retried as socks5 and remembered', async (t) => {
  await withUpstream(t, async (upstreamPort) => {
    const socks = await socksProxy()
    const relay = await startRelay(upstreamPort)
    try {
      const wrong = `http://127.0.0.1:${socks.port}`
      const first = await post(relay.port, '/v1/ok', wrong)
      assert.equal(first.status, 200, `expected the swap to rescue the request, got ${first.body}`)
      assert.match(relay.log(), /PROTO-FIX .*http->socks5/)

      const second = await post(relay.port, '/v1/ok', wrong)
      assert.equal(second.status, 200)
      const fixes = relay.log().match(/PROTO-FIX/g) ?? []
      assert.equal(fixes.length, 1, 'the correction must be remembered, not re-learned')
      assert.ok(second.ms < 1_000, `a remembered correction must be fast (took ${second.ms}ms)`)
    } finally {
      await relay.close()
      await socks.close()
    }
  })
})

maybe('a socks5 label on an HTTP proxy is retried as http', async (t) => {
  await withUpstream(t, async (upstreamPort) => {
    const http = await httpProxy()
    const relay = await startRelay(upstreamPort)
    try {
      const wrong = `socks5://127.0.0.1:${http.port}`
      const first = await post(relay.port, '/v1/ok', wrong)
      assert.equal(first.status, 200, `expected the reverse swap to rescue the request, got ${first.body}`)
      assert.match(relay.log(), /PROTO-FIX .*socks5->http/)
      assert.equal((await post(relay.port, '/v1/ok', wrong)).status, 200)
    } finally {
      await relay.close()
      await http.close()
    }
  })
})

maybe('a proxy that never answers the handshake fails fast instead of hanging', async (t) => {
  await withUpstream(t, async (upstreamPort) => {
    const silent = await silentProxy()
    const relay = await startRelay(upstreamPort)
    try {
      // Both bounds are asserted here: a 3 s SOCKS handshake timeout and an
      // 8 s rescue ceiling, so a peer that never answers ends as a 502.
      const reply = await post(relay.port, '/v1/ok', `socks5://127.0.0.1:${silent.port}`)
      assert.equal(reply.status, 502, 'a peer that never answers must end as a 502, not a hang')
      assert.match(reply.body, /relay_error/)
      assert.ok(reply.ms < 20_000, `expected both bounds to cap this (took ${reply.ms}ms)`)
      assert.match(relay.log(), /socks5 handshake timeout/)
    } finally {
      await relay.close()
      await silent.close()
    }
  })
})

maybe('a dead egress answers 502 relay_error, not a hang', async (t) => {
  await withUpstream(t, async (upstreamPort) => {
    const relay = await startRelay(upstreamPort)
    try {
      const dead = await silentProxy()
      const port = dead.port
      await dead.close()
      const reply = await post(relay.port, '/v1/ok', `socks5://127.0.0.1:${port}`)
      assert.equal(reply.status, 502)
      assert.match(reply.body, /relay_error/)
      assert.ok(reply.ms < 12_000, `a refused port must not wait out a timeout (took ${reply.ms}ms)`)
    } finally {
      await relay.close()
    }
  })
})
