import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
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
 *      scheme and the correction remembered (`PROTO-FIX` in its log);
 *   3. what the Node side adds (OpenAI SDK `x-stainless-*`, undici's
 *      `accept-language`/`sec-fetch-mode`, an explicit `accept`) never
 *      reaches upstream, so the wire carries the client's header set.
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
  /** Upstream-side observations (`/hang` arrivals and closes). */
  events?: string[]
  /** Sockets currently open on the upstream side. */
  open?: () => number
}

/** TLS upstream: `/quota` answers the lane's 429, everything else 200. */
async function upstream(tls: TlsPair): Promise<Closer> {
  const sockets = new Set<{ destroy: () => void }>()
  const events: string[] = []
  const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    if ((req.url ?? '').includes('/hang')) {
      // Never answers: only the caller's abort can end this request.
      events.push('hang-open')
      res.on('close', () => events.push('hang-closed'))
      return
    }
    if ((req.url ?? '').includes('/echo-headers')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.rawHeaders))
      return
    }
    if ((req.url ?? '').includes('/quota')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '55248', 'x-opencode-log-id': 'log_abc123' })
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
    events,
    open: () => sockets.size,
    close: () => new Promise<void>((done) => {
      // Keep-alive sockets outlive the assertions; destroy them or the harness
      // waits on them forever in teardown.
      for (const socket of sockets) socket.destroy()
      server.close(() => done())
    }),
  }
}

/**
 * A SOCKS5 proxy that pipes to the requested target. `reply` overrides the
 * CONNECT reply bytes, and `split` sends them one byte per write.
 */
async function socksProxy(options: { reply?: Buffer; split?: boolean } = {}): Promise<Closer> {
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
      target.on('connect', async () => {
        const reply = options.reply ?? Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        if (options.split === true) {
          // No pause after the last byte: the tunnel's first bytes follow it.
          for (let i = 0; i < reply.length; i += 1) {
            if (i > 0) await new Promise((resolve) => setTimeout(resolve, 2))
            client.write(reply.subarray(i, i + 1))
          }
        } else {
          client.write(reply)
        }
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
async function startRelay(upstreamPort: number, options: { token?: string; upstream?: string } = {}): Promise<Relay> {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    // An env proxy would carry "direct" requests somewhere else entirely.
    if (!/_proxy$/i.test(name)) env[name] = value
  }
  const child = spawn(bun as string, [defaultRelayScript()], {
    env: {
      ...env,
      OC2DSH_RELAY_PORT: '0',
      OC2DSH_RELAY_UPSTREAM: options.upstream ?? `https://127.0.0.1:${upstreamPort}`,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      ...(options.token !== undefined ? { OC2DSH_RELAY_TOKEN: options.token } : {}),
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
  fn: (upstreamPort: number, events: string[], open: () => number) => Promise<void>,
): Promise<void> {
  const tls = await makeTlsPair()
  if (tls === null) {
    t.skip('openssl unavailable')
    return
  }
  const fake = await upstream(tls)
  try {
    await fn(fake.port, fake.events ?? [], fake.open ?? (() => 0))
  } finally {
    await fake.close()
    await rm(tls.dir, { recursive: true, force: true })
  }
}

maybe('upstream sees the client header set, not the Node stack additions', async (t) => {
  await withUpstream(t, async (upstreamPort) => {
    const relay = await startRelay(upstreamPort)
    try {
      const session = 'ses_e7a58a468ffeSWbLKI121D4nWy'
      const res = await fetch(`http://127.0.0.1:${relay.port}/inference/openai/v1/echo-headers`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'x-stainless-retry-count': '0',
          'x-stainless-lang': 'js',
          authorization: 'Bearer public',
          'user-agent': 'opencode/latest/2.2.0/cli',
          b3: 'c61faeadc62bcb4034071424cfdf074a-6f7048a1b05e6431-1-1010cd9f473a6a8d',
          traceparent: '00-c61faeadc62bcb4034071424cfdf074a-6f7048a1b05e6431-01',
          'x-opencode-client': 'cli',
          'x-opencode-project': '2752b498507aba026b4d114783abe85b6f8509fb',
          'x-opencode-session': session,
          'x-opencode-session-id': session,
          'x-session-affinity': session,
          'x-session-id': session,
          'content-type': 'application/json',
          'x-oc2dsh-egress': 'direct',
        },
        body: '{}',
      })
      const raw = JSON.parse(await res.text()) as string[]
      const names = raw.filter((_, i) => i % 2 === 0)
      // The 2.2.0 client's own wire, captured over TLS: same names, casing, order.
      assert.deepEqual(names, [
        'Authorization', 'Content-Type', 'User-Agent', 'b3', 'traceparent',
        'x-opencode-client', 'x-opencode-project', 'x-opencode-session', 'x-opencode-session-id',
        'x-session-affinity', 'x-session-id', 'Connection', 'Accept', 'Host', 'Accept-Encoding', 'Content-Length',
      ])
      assert.equal(raw[names.indexOf('Accept') * 2 + 1], '*/*', "Bun's own default, as the client sends")
    } finally {
      await relay.close()
    }
  })
})

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

// -- admission, tunnels and families ----------------------------------------------

type Raw = { status: number; body: string; headers: Record<string, string | string[] | undefined> }

/** One HTTP call with full control of Host (fetch cannot set it). */
function rawCall(port: number, path: string, options: { host?: string; egress?: string; signal?: AbortSignal } = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${port}`, 'content-type': 'application/json' }
    if (options.egress !== undefined) headers['x-oc2dsh-egress'] = options.egress
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers, ...(options.signal ? { signal: options.signal } : {}) }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end('{}')
  })
}

/** The local port of the bridge the relay opened for `key`. */
function bridgePort(log: string, key: string): number {
  const escaped = key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const match = new RegExp(`BRIDGE ${escaped} -> http://127\\.0\\.0\\.1:(\\d+)`).exec(log)
  assert.ok(match !== null, `no bridge for ${key} in log: ${log}`)
  return Number(match[1])
}

/** Send `head` to a bridge and read its status line (or '' when it just closed). */
function rawConnect(port: number, head: string | Buffer): Promise<{ line: string; socket: net.Socket }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.on('error', () => {})
    let text = ''
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1')
      if (text.includes('\r\n')) resolve({ line: text.split('\r\n')[0]!, socket })
    })
    socket.on('close', () => resolve({ line: text.split('\r\n')[0] ?? '', socket }))
    socket.write(head)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

maybe('the relay requires its own loopback Host and the per-spawn token', async (t) => {
  await withUpstream(t, async (upstreamPort) => {
    const token = 'a'.repeat(48)
    const relay = await startRelay(upstreamPort, { token })
    try {
      assert.equal((await rawCall(relay.port, '/v1/ok')).status, 403, 'no token prefix')
      assert.equal((await rawCall(relay.port, `/_/${'b'.repeat(48)}/v1/ok`)).status, 403, 'wrong token')
      assert.equal((await rawCall(relay.port, `/_/${token}x/v1/ok`)).status, 403, 'token must end at a path segment')
      assert.equal((await rawCall(relay.port, `/_/${token}/v1/ok`, { host: 'evil.example:80' })).status, 421, 'forged Host')
      assert.equal((await rawCall(relay.port, `/_/${token}/v1/ok`, { host: '127.0.0.1:1' })).status, 421, 'another port')
      const ok = await rawCall(relay.port, `/_/${token}/v1/ok?x=1`, { host: `localhost:${relay.port}` })
      assert.equal(ok.status, 200)
      assert.equal((JSON.parse(ok.body) as { path: string }).path, '/v1/ok?x=1', 'the prefix never reaches upstream')
      const health = await rawCall(relay.port, `/_/${token}/__oc2dsh/health`)
      assert.equal(health.status, 200)
      assert.ok(!relay.log().includes(token), 'the token is never logged')
    } finally {
      await relay.close()
    }
  })
})

maybe('a 429 keeps the upstream headers it carried', async (t) => {
  await withUpstream(t, async (upstreamPort) => {
    const relay = await startRelay(upstreamPort)
    try {
      const reply = await rawCall(relay.port, '/v1/quota')
      assert.equal(reply.status, 429)
      assert.equal(reply.headers['retry-after'], '55248')
      assert.equal(reply.headers['x-opencode-log-id'], 'log_abc123')
      assert.match(String(reply.headers['content-type']), /application\/json/)
      assert.match(reply.body, /本机出口/)
    } finally {
      await relay.close()
    }
  })
})

maybe('a client abort reaches the upstream request', async (t) => {
  await withUpstream(t, async (upstreamPort, events) => {
    const relay = await startRelay(upstreamPort)
    try {
      const controller = new AbortController()
      const pending = rawCall(relay.port, '/v1/hang', { signal: controller.signal }).catch(() => null)
      for (let i = 0; i < 100 && !events.includes('hang-open'); i += 1) await sleep(20)
      assert.ok(events.includes('hang-open'), 'the request reached upstream')
      controller.abort()
      await pending
      for (let i = 0; i < 100 && !events.includes('hang-closed'); i += 1) await sleep(20)
      assert.ok(events.includes('hang-closed'), 'the upstream request was cancelled with the client')
    } finally {
      await relay.close()
    }
  })
})

maybe('a bridge tunnels to the upstream origin only, and tears both sides down', async (t) => {
  await withUpstream(t, async (upstreamPort, _events, upstreamOpen) => {
    const socks = await socksProxy()
    const relay = await startRelay(upstreamPort)
    try {
      const egress = `socks5://127.0.0.1:${socks.port}`
      assert.equal((await post(relay.port, '/v1/ok', egress)).status, 200)
      const port = bridgePort(relay.log(), egress)

      const foreign = await rawConnect(port, 'CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\n\r\n')
      assert.match(foreign.line, / 403 /, 'an open CONNECT proxy would hand any local process a pool exit')
      foreign.socket.destroy()
      const otherPort = await rawConnect(port, `CONNECT 127.0.0.1:${socks.port} HTTP/1.1\r\n\r\n`)
      assert.match(otherPort.line, / 403 /)
      otherPort.socket.destroy()

      const oversized = await rawConnect(port, Buffer.alloc(9 * 1024, 'a'))
      assert.match(oversized.line, / 431 /, 'a head without an end is capped')
      oversized.socket.destroy()

      const baseline = upstreamOpen()
      const tunnel = await rawConnect(port, `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\n\r\n`)
      assert.match(tunnel.line, / 200 /)
      for (let i = 0; i < 50 && upstreamOpen() <= baseline; i += 1) await sleep(20)
      assert.equal(upstreamOpen(), baseline + 1, 'the tunnel holds one upstream socket')
      // The upstream side of the tunnel must go away with the client.
      tunnel.socket.destroy()
      for (let i = 0; i < 50 && upstreamOpen() > baseline; i += 1) await sleep(20)
      assert.equal(upstreamOpen(), baseline, 'a client that leaves closes its upstream socket')
      const after = await rawConnect(port, `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\n\r\n`)
      assert.match(after.line, / 200 /, 'the bridge keeps serving after a torn-down tunnel')
      after.socket.destroy()
    } finally {
      await relay.close()
      await socks.close()
    }
  })
})

maybe('a SOCKS5 reply split across reads still connects; an unknown ATYP is refused', async (t) => {
  await withUpstream(t, async (upstreamPort) => {
    // ATYP 4 (IPv6 bound address): 22 bytes, delivered one byte at a time.
    const split = await socksProxy({ split: true, reply: Buffer.from([5, 0, 0, 4, ...new Array(16).fill(0), 0, 0]) })
    const odd = await socksProxy({ reply: Buffer.from([5, 0, 0, 9, 0, 0, 0, 0, 0, 0]) })
    const relay = await startRelay(upstreamPort)
    try {
      const ok = await post(relay.port, '/v1/ok', `socks5://127.0.0.1:${split.port}`)
      assert.equal(ok.status, 200, ok.body)
      const bad = await post(relay.port, '/v1/ok', `socks5://127.0.0.1:${odd.port}`)
      assert.notEqual(bad.status, 200)
      assert.match(relay.log(), /socks5 unknown address type 9/)
    } finally {
      await relay.close()
      await split.close()
      await odd.close()
    }
  })
})

/** TLS listeners on 127.0.0.1:P and [::1]:P that name their own family; null without IPv6. */
async function dualStackUpstream(tls: TlsPair): Promise<{ port: number; closeV6: () => Promise<void>; close: () => Promise<void> } | null> {
  const make = (family: number) => {
    const sockets = new Set<{ destroy: () => void }>()
    const server = https.createServer({ cert: tls.cert, key: tls.key }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ family }))
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    const close = () => new Promise<void>((done) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => done())
    })
    return { server, close }
  }
  const v4 = make(4)
  v4.server.listen(0, '127.0.0.1')
  await once(v4.server, 'listening')
  const address = v4.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const v6 = make(6)
  const bound = await new Promise<boolean>((resolve) => {
    v6.server.once('error', () => resolve(false))
    v6.server.listen(port, '::1', () => resolve(true))
  })
  if (!bound) {
    await v4.close()
    return null
  }
  let v6Open = true
  const closeV6 = async () => {
    if (!v6Open) return
    v6Open = false
    await v6.close()
  }
  return { port, closeV6, close: async () => { await closeV6(); await v4.close() } }
}

maybe('direct;family=… dials the upstream on the requested family', async (t) => {
  const tls = await makeTlsPair()
  if (tls === null) {
    t.skip('openssl unavailable')
    return
  }
  const dual = await dualStackUpstream(tls)
  if (dual === null) {
    await rm(tls.dir, { recursive: true, force: true })
    t.skip('no IPv6 loopback')
    return
  }
  const relay = await startRelay(dual.port, { upstream: `https://localhost:${dual.port}` })
  const familyOf = async (egress: string): Promise<number> => {
    const reply = await post(relay.port, '/v1/ok', egress)
    assert.equal(reply.status, 200, `${egress}: ${reply.body}`)
    return (JSON.parse(reply.body) as { family: number }).family
  }
  try {
    assert.equal(await familyOf('direct;family=4'), 4)
    assert.equal(await familyOf('direct;family=6'), 6)
    assert.equal(await familyOf('direct;family=prefer6'), 6)
    await dual.closeV6()
    assert.equal(await familyOf('direct;family=prefer6'), 4, 'prefer6 falls back to IPv4 on a connect failure')
    const v6only = await post(relay.port, '/v1/ok', 'direct;family=6')
    assert.equal(v6only.status, 502, 'family=6 never falls back')
    assert.match(v6only.body, /relay_error/)
  } finally {
    await relay.close()
    await dual.close()
    await rm(tls.dir, { recursive: true, force: true })
  }
})
