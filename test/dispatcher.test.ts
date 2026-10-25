import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import * as realUndici from 'undici'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import {
  NO_EXIT_MESSAGE,
  PoolRoutingDispatcher,
  dispatchRequestPath,
  exitProxyUri,
  isLoopback,
  matchesPathPrefix,
  normalizeHost,
  resolveProxyPathPrefixes,
  routingContext,
} from '../src/pool/dispatcher.ts'
import { RoutingInstaller } from '../src/pool/installer.ts'
import { ipv6FirstLookup } from '../src/pool/local-family.ts'

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'h:1',
    protocol: 'http',
    source: 'manual',
    pinned: false,
    exitIP: '1.1.1.1',
    exitLocation: 'US city',
    latencyMs: 300,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

test('normalizeHost strips scheme, port and brackets', () => {
  assert.equal(normalizeHost('https://opencode.ai/zen'), 'opencode.ai')
  assert.equal(normalizeHost('opencode.ai:443'), 'opencode.ai')
  assert.equal(normalizeHost('[2001:db8::1]:1080'), '2001:db8::1')
  assert.ok(isLoopback('127.0.0.1:8080'))
  assert.ok(isLoopback('localhost'))
  assert.ok(!isLoopback('opencode.ai'))
})

test('exitProxyUri maps exit ids to ProxyAgent URIs', () => {
  assert.equal(exitProxyUri('h:1', 'http'), 'http://h:1')
  assert.equal(exitProxyUri('h:1', 'socks5'), 'socks5://h:1')
  assert.equal(exitProxyUri('http://pre.formatted:3', 'http'), 'http://pre.formatted:3')
})

/** A recording fake undici seam: dispatch tags each hop. */
function fakeSeam() {
  const hops: string[] = []
  const makeAgent = (tag: string) => ({
    tag,
    dispatch(_opts: unknown, _handler: unknown): boolean {
      hops.push(tag)
      return true
    },
    close: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  })
  const direct = makeAgent('direct')
  const proxyAgents = new Map<string, ReturnType<typeof makeAgent>>()
  const seam = {
    Agent: class {
      constructor(_options?: unknown) {
        return direct
      }
    },
    ProxyAgent: class {
      constructor(options: { uri: string }) {
        const existing = proxyAgents.get(options.uri)
        if (existing) return existing
        const agent = makeAgent(`proxy:${options.uri}`)
        proxyAgents.set(options.uri, agent)
        return agent
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => direct,
  }
  return { seam, hops, proxyAgents }
}

test('dispatcher: non-pool hosts and loopback go direct; pool hosts route to picked exits', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'p:1', exitIP: '1.1.1.1', latencyMs: 10 }))
  pool.add(node({ id: 'p:2', exitIP: '2.2.2.2', latencyMs: 20 }))
  pool.markOk('p:1')
  pool.markOk('p:2')

  const { seam, hops } = fakeSeam()
  const router = new PoolRoutingDispatcher({
    pool,
    undici: seam as never,
    proxyHosts: ['opencode.ai'],
  })

  router.dispatch({ origin: 'https://example.com/x' } as never, {} as never)
  assert.deepEqual(hops, ['direct'])

  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/inference/v1/chat/completions' } as never, {} as never)
  })
  assert.equal(hops.length, 2)
  assert.match(hops[1]!, /^proxy:/)
})

/**
 * One opencode.ai serves several lanes: host-only routing would drag all of
 * them through the exits, counting a foreign provider's `/inference/go/...`
 * traffic as pool requests (no tokens are attributed — only our adapter books
 * usage). The path scope keeps every other lane on the host.
 */
test('dispatcher: the path scope keeps other lanes on the host out of the pool', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 10 }))
  pool.markOk('a:1')
  const { seam, hops } = fakeSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })
  const dispatch = (path: string): void => {
    routingContext.run({ model: 'm', session: `s:${path}` }, () => {
      router.dispatch({ origin: 'https://opencode.ai', path } as never, {} as never)
    })
  }
  /** Only the hops that reached an EXIT; 'direct' shows up for out-of-scope
   *  requests too, and that is exactly what must not be mistaken for routing. */
  const proxied = (): string[] => hops.filter((hop) => hop.startsWith('proxy:'))

  // our own lane: through an exit
  dispatch('/inference/v1/chat/completions')
  assert.deepEqual(proxied(), ['proxy:http://a:1'], 'the plugin lane is proxied')

  // the separate provider's paid lane on the same host: direct, and not one
  // byte of pool state moves
  dispatch('/inference/go/v1/chat/completions')
  assert.equal(proxied().length, 1, 'the go lane must not touch an exit')
  assert.equal(hops.at(-1), 'direct')
  dispatch('/inference/go/v1/usage')
  assert.equal(proxied().length, 1, 'nor the usage poll')

  // query strings do not defeat the match, and a prefix never leaks into a
  // longer sibling segment
  dispatch('/inference/v1/responses?stream=1')
  assert.equal(proxied().length, 2)
  dispatch('/inference/v10/chat/completions')
  assert.equal(proxied().length, 2, '/inference/v10 is not /inference/v1')

  // Empty resolves to the default (never to "no path is in scope"); '/' opts
  // the whole host back in, which is the documented knob for that.
  router.setProxyPathPrefixes([])
  assert.deepEqual(router.proxyPathPrefixes, ['/inference/v1'])
  router.setProxyPathPrefixes(['/'])
  dispatch('/inference/go/v1/chat/completions')
  assert.equal(proxied().length, 3, "'/' puts the whole host back in scope")

  // A caller that exposes no path stays IN scope: guessing "out" would
  // silently disable routing.
  routingContext.run({ model: 'm', session: 'bare' }, () => {
    router.dispatch({ origin: 'https://opencode.ai' } as never, {} as never)
  })
  assert.equal(proxied().length, 4)
})

test('proxy path prefixes: empty means the default, entries normalize, matching is segment-aware', () => {
  assert.deepEqual(resolveProxyPathPrefixes(undefined), ['/inference/v1'])
  assert.deepEqual(resolveProxyPathPrefixes([]), ['/inference/v1'])
  assert.deepEqual(resolveProxyPathPrefixes(['', '   ']), ['/inference/v1'])
  assert.deepEqual(resolveProxyPathPrefixes(['inference/v1/', '/inference/go/v1?x=1']), ['/inference/v1', '/inference/go/v1'])

  assert.ok(matchesPathPrefix('/inference/v1', '/inference/v1'))
  assert.ok(matchesPathPrefix('/inference/v1/chat/completions?a=1', '/inference/v1'))
  assert.ok(!matchesPathPrefix('/inference/v10', '/inference/v1'))
  assert.ok(!matchesPathPrefix('/inference/go/v1/chat/completions', '/inference/v1'))
  assert.ok(matchesPathPrefix('/anything', '/'))

  // both dispatch shapes undici hands over: fetch builds origin+path,
  // a Request-shaped argument carries the whole URL
  assert.equal(dispatchRequestPath({ path: '/a?b=1' } as never), '/a?b=1')
  assert.equal(dispatchRequestPath({ url: 'https://h/zen/v1/m?q=1' } as never), '/zen/v1/m?q=1')
  assert.equal(dispatchRequestPath({} as never), '')
})

test('dispatcher: ALS context selects the exit by model (two-tier health routing)', () => {  const pool = new ExitPool({ modelBanConfirmations: 2 })
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 10 }))
  pool.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 20 }))
  pool.markOk('a:1')
  pool.markOk('b:2')
  // ban a:1 for muse -> muse must route via b:2
  pool.markModelSignal('a:1', 'muse')
  pool.markModelSignal('a:1', 'muse')

  const { seam, hops } = fakeSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })
  routingContext.run({ model: 'muse', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.match(hops[0]!, /b:2/)
  hops.length = 0
  // Same session stays sticky to b:2 even for another model (3.3): b:2 is
  // not banned for 'other', so the sticky exit keeps serving it.
  routingContext.run({ model: 'other', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.match(hops[0]!, /b:2/)
  // A fresh session picks a:1 for 'other' (a:1 is only banned for muse).
  hops.length = 0
  routingContext.run({ model: 'other', session: 's2' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.match(hops[0]!, /a:1/)
})

/**
 * 本地出口兜底 — the pool exists so this machine's IP stays off the wire (the
 * free lane refuses this host's CN egress), so the DEFAULT is fail-closed; the
 * settings switch opts back into fail-open. An explicit 固定本机 pin is the
 * operator asking for local egress and works either way.
 */
test('dispatcher: an empty pool fails closed by default — no local egress', () => {
  const pool = new ExitPool()
  const { seam, hops } = fakeSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })
  const errors: Error[] = []
  const handler = { onResponseError: (_controller: unknown, error: Error) => { errors.push(error) } } as never
  const context: { exitId?: string } = {}
  routingContext.run(context as never, () => {
    router.dispatch({ origin: 'https://opencode.ai/inference/v1/x' } as never, handler)
  })
  assert.deepEqual(hops, [], 'nothing was dispatched — this machine never egressed')
  assert.equal(errors.length, 1, 'the request failed instead of falling back')
  assert.equal(errors[0]!.message, NO_EXIT_MESSAGE)
  assert.equal(context.exitId, undefined, 'not stamped as a direct fallback')
  assert.equal(pool.directRequests, 0, 'and not counted as one either')
})

test('dispatcher: 本地出口兜底 ON restores the direct fallback, live-switchable', () => {
  const pool = new ExitPool()
  const { seam, hops } = fakeSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'], localFallback: true })
  assert.equal(router.localFallback, true)
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.deepEqual(hops, ['direct'], 'opted in: the machine takes the request')
  assert.equal(pool.directRequests, 1, 'and the modal 直连兜底 row sees it')

  // The settings page flips it on a running router.
  router.setLocalFallback(false)
  assert.equal(router.localFallback, false)
  const errors: Error[] = []
  routingContext.run({ model: 'm', session: 's2' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, { onResponseError: (_c: unknown, e: Error) => { errors.push(e) } } as never)
  })
  assert.deepEqual(hops, ['direct'], 'no second direct dispatch after the switch went off')
  assert.equal(errors.length, 1)
})

test('dispatcher: an explicit 固定本机 pin still egresses locally with the fallback off', () => {
  // The pin is the operator choosing this machine, not the pool falling back
  // to it — pick() answers null for the sentinel, and that must not read as
  // "no exit" once the switch is off.
  const pool = new ExitPool()
  pool.pinLocal()
  const { seam, hops } = fakeSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.deepEqual(hops, ['direct'], 'the explicit pin wins over the switch')
})

test('dispatcher: an exit whose proxy agent cannot be built follows the same switch', () => {
  // A row with an unusable address is "the pool cannot carry this request"
  // just as much as an empty pool: falling back there would leak the very IP
  // the switch is guarding.
  const pool = new ExitPool()
  pool.add(node({ id: 'p:1' }))
  pool.markOk('p:1')
  const directHops: string[] = []
  const seam = {
    ...fakeSeam().seam,
    Agent: class {
      constructor() {
        return { dispatch: () => { directHops.push('direct'); return true } }
      }
    } as never,
    ProxyAgent: class {
      constructor() {
        throw new Error('bad proxy uri')
      }
    } as never,
  }

  const strict = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })
  const errors: Error[] = []
  routingContext.run({ model: 'm', session: 's' }, () => {
    strict.dispatch({ origin: 'https://opencode.ai/x' } as never, { onResponseError: (_c: unknown, e: Error) => { errors.push(e) } } as never)
  })
  assert.equal(errors.length, 1, 'strict: the build failure fails the request')
  assert.deepEqual(directHops, [], 'strict: this machine never egressed')

  const lenient = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'], localFallback: true })
  routingContext.run({ model: 'm', session: 's' }, () => {
    lenient.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.deepEqual(directHops, ['direct'], 'opted in: the machine takes it')
})


test('installer: install/disable swaps the global dispatcher and restores the previous one', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'p:1' }))
  pool.markOk('p:1')
  pool.pin('p:1')

  const { seam } = fakeSeam()
  const installed: unknown[] = []
  const originalDispatcher = { tag: 'original' }
  let current: unknown = originalDispatcher
  // Faithful undici 8.x slot: the getter and setter share ONE cell, and the
  // setter returns void — it does NOT hand back the replaced dispatcher, so
  // only a getter read can prove the restore.
  const recordingSeam = {
    ...seam,
    getGlobalDispatcher: () => current,
    setGlobalDispatcher: (dispatcher: unknown) => {
      installed.push(dispatcher)
      current = dispatcher
      return undefined
    },
  }
  const logs: string[] = []
  const installer = new RoutingInstaller({
    pool,
    undici: recordingSeam as never,
    logger: { info: (m) => logs.push(m), warn: () => {} },
  })

  installer.install()
  assert.ok(installer.enabled)
  assert.equal(installed.length, 1)
  assert.ok(installed[0] instanceof PoolRoutingDispatcher)
  assert.ok(logs.some((line) => line.includes('PoolRoutingDispatcher')))

  installer.disable()
  assert.ok(!installer.enabled)
  // second setGlobalDispatcher call restored the original
  assert.equal(installed[1], originalDispatcher)
  assert.equal(
    current,
    originalDispatcher,
    'the global slot itself must be back on the original dispatcher',
  )
})

test('end-to-end: builtin fetch routes through a real local proxy via the installer', async () => {
  // The load-bearing integration test (docs/ip-pool.md 2): npm undici's
  // setGlobalDispatcher + our PoolRoutingDispatcher drive the BUILTIN fetch.
  let proxied = 0
  let directHits = 0
  const server = http.createServer((req, res) => {
    // Absolute-URI request => the fetch went through the forward proxy;
    // origin-form => direct. (undici ProxyAgent sends absolute-URI GETs.)
    if (req.url?.startsWith('http://')) {
      proxied += 1
    } else {
      directHits += 1
    }
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as { port: number }
  const port = address.port

  const pool = new ExitPool()
  pool.add(node({ id: `127.0.0.1:${port}`, protocol: 'http', exitIP: '1.2.3.4', latencyMs: 10 }))
  pool.markOk(`127.0.0.1:${port}`)

  const previous = realUndici.getGlobalDispatcher()
  const installer = new RoutingInstaller({
    pool,
    // seam type is structural on purpose (npm undici's fetch element types
    // never match Node's built-ins); the real module satisfies it at runtime
    undici: realUndici as never,
    proxyHosts: ['example.test'], // routes through the pool
    logger: { info: () => {}, warn: () => {} },
  })
  installer.install()
  try {
    // The pinned exit points at the same server, but through ProxyAgent the
    // request arrives with an absolute URI — the server can tell the two
    // paths apart even though they land on one port. The path is the plugin's
    // own lane: the scope defaults to /inference/v1, so anything else on the
    // host is deliberately left out of the pool.
    const response = await fetch(`http://example.test:${port}/inference/v1/chat/completions`)
    assert.equal(response.status, 200)
    assert.ok(proxied >= 1, 'builtin fetch did not go through the proxy')
  } finally {
    installer.disable()
    realUndici.setGlobalDispatcher(previous)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // Direct path restored after teardown: loopback host bypasses the pool.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const reopenedPort = (server.address() as { port: number }).port
  // (server.close stops accepting but we reopened; fetch a fresh direct URL)
  const after = await fetch(`http://127.0.0.1:${reopenedPort}/after`)
  assert.equal(after.status, 200)
  assert.ok(directHits >= 1)
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

// -- passive signals (docs §4.2/4.3): the handler wrapper observes the
// real request's outcome and writes the two-tier health -------------------------

/** Fake seam whose agents synchronously answer with a scripted status code. */
function respondingSeam(statusOf: (tag: string) => number) {
  const hops: string[] = []
  const answer = (tag: string, handler: { onResponseStart?: (c: unknown, s: number, h: never, m?: string) => void }) => {
    const code = statusOf(tag)
    handler.onResponseStart?.({} as never, code, {} as never)
  }
  const direct = { dispatch(_o: unknown, h: unknown): boolean { answer('direct', h as never); return true }, close: () => Promise.resolve(), destroy: () => Promise.resolve() }
  const agents = new Map<string, typeof direct>()
  const proxy = (uri: string) => {
    const found = agents.get(uri)
    if (found) return found
    const agent = { dispatch(_o: unknown, h: unknown): boolean { const tag = `proxy:${uri}`; hops.push(tag); answer(tag, h as never); return true }, close: () => Promise.resolve(), destroy: () => Promise.resolve() }
    agents.set(uri, agent)
    return agent
  }
  return {
    hops,
    seam: {
      Agent: class { constructor() { return direct } },
      ProxyAgent: class { constructor(options: { uri: string }) { return proxy(options.uri) } },
      setGlobalDispatcher: () => undefined,
      getGlobalDispatcher: () => direct,
    },
  }
}

test('dispatcher passive signal: 2xx marks the exit ok; 429 cools it and reroutes the session', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 10 }))
  pool.markOk('a:1')
  const { seam } = respondingSeam(() => 200)
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.equal(pool.isUsable('a:1', 'm'), true)
  assert.deepEqual(pool.passiveStats('a:1'), { ok: 1, limited: 0, refused: 0, dead: 0, transport: 0 })

  // the exit answers 429: cooldown lands and the sticky session is dropped
  const hot = respondingSeam(() => 429)
  const router2 = new PoolRoutingDispatcher({ pool, undici: hot.seam as never, proxyHosts: ['opencode.ai'] })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router2.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.equal(pool.isUsable('a:1', 'm'), false, '429 cools the exit')
  assert.equal(pool.passiveStats('a:1').limited, 1)
})

test('dispatcher passive signal: 403 marks the model, transport errors strike dead', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 10 }))
  pool.markOk('a:1')
  const refused = respondingSeam(() => 403)
  const router = new PoolRoutingDispatcher({ pool, undici: refused.seam as never, proxyHosts: ['opencode.ai'] })
  routingContext.run({ model: 'muse', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  routingContext.run({ model: 'muse', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.equal(pool.isUsable('a:1', 'muse'), false, 'two 403s ban the model')
  assert.equal(pool.isUsable('a:1', 'other'), true, 'the exit still serves other models')
  assert.equal(pool.passiveStats('a:1').refused, 2)

  // transport-grade failure: the handler errors without a response start
  const dead = {
    Agent: class { constructor() { return { dispatch: () => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() } } },
    ProxyAgent: class {
      constructor() {
        return {
          dispatch(_o: unknown, handler: { onResponseError?: (c: unknown, e: Error) => void }): boolean {
            handler.onResponseError?.({} as never, new Error('connect ECONNREFUSED'))
            return true
          },
          close: () => Promise.resolve(),
          destroy: () => Promise.resolve(),
        }
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => ({ dispatch: () => true }),
  }
  pool.markOk('a:1')
  const router2 = new PoolRoutingDispatcher({ pool, undici: dead as never, proxyHosts: ['opencode.ai'] })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router2.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.equal(pool.passiveStats('a:1').transport, 1)
  assert.equal(pool.isUsable('a:1', 'other'), false, 'transport failure strikes the exit dead')
})

// -- R1 coexistence: defer when a foreign dispatcher owns the global slot ------

test('installer defers to a foreign dispatcher and recovers when the slot frees', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  pool.markOk('a:1')
  const warned: string[] = []
  const logger = { info: () => {}, warn: (m: string) => warned.push(m) }
  let currentGlobal: unknown = { dispatch: () => true } // a foreign layer
  const seam = {
    Agent: realUndici.Agent,
    ProxyAgent: realUndici.ProxyAgent,
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => currentGlobal,
  }
  const installer = new RoutingInstaller({ pool, undici: seam as never, logger })

  // foreign owner: named class -> defer
  ;(currentGlobal as { constructor: { name: string } }).constructor = class ForeignLayer {}
  installer.install()
  assert.equal(installer.enabled, false, 'deferred instead of installing')
  assert.match(installer.deferredReason ?? '', /ForeignLayer/)
  assert.ok(warned.some((m) => m.includes('deferred')), 'warn surfaced')

  // slot freed (undici default Agent): install proceeds
  currentGlobal = new realUndici.Agent()
  installer.install()
  assert.equal(installer.enabled, true, 'recovers once the slot is free')
  assert.equal(installer.deferredReason, null)
  installer.disable()
})

// -- response-silence sentinel (docs §4.3): undici fires NO handler callback
// when a proxy CONNECT dies at the connection stage, so the passive signal
// never sees that death; the sentinel records a transport strike when a
// dispatched request stays totally mute past its deadline. --------------------

test('dispatcher sentinel: a mute connection records transport and reroutes the session', async () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'dead:1', exitIP: '1.1.1.1' }))
  pool.markOk('dead:1')
  const mute = {
    Agent: class { constructor() { return { dispatch: () => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() } } },
    ProxyAgent: class {
      constructor() {
        return {
          // the blackhole: accepts the dispatch, then fires NOTHING
          dispatch: (): boolean => true,
          close: () => Promise.resolve(),
          destroy: () => Promise.resolve(),
        }
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => ({ dispatch: () => true }),
  }
  const router = new PoolRoutingDispatcher({ pool, undici: mute as never, proxyHosts: ['opencode.ai'], sentinelMs: 60 })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  // immediately after: no verdict yet, exit still usable
  assert.equal(pool.isUsable('dead:1', 'm'), true, 'before the deadline nothing is recorded')
  await new Promise((r) => setTimeout(r, 140))
  assert.deepEqual(pool.passiveStats('dead:1'), { ok: 0, limited: 0, refused: 0, dead: 0, transport: 1 }, 'mute dispatch recorded as transport')
  assert.equal(pool.isUsable('dead:1', 'm'), false, 'dead strike landed')
})

test('dispatcher sentinel: a wired judge gets the cut instead of an immediate strike', async () => {
  // The cut is a QUESTION for pool/transport.ts, not a verdict: a mislabelled
  // listener answers nothing and is not a dead line, so the observer hands it
  // over (`onTransportCut`) rather than striking.
  const pool = new ExitPool()
  pool.add(node({ id: 'mute:1', exitIP: '1.1.1.1' }))
  pool.markOk('mute:1')
  const cuts: string[] = []
  const mute = {
    Agent: class { constructor() { return { dispatch: () => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() } } },
    ProxyAgent: class {
      constructor() {
        return { dispatch: (): boolean => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() }
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => ({ dispatch: () => true }),
  }
  const router = new PoolRoutingDispatcher({
    pool,
    undici: mute as never,
    proxyHosts: ['opencode.ai'],
    sentinelMs: 60,
    onTransportCut: (exitId) => { cuts.push(exitId) },
  })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  await new Promise((r) => setTimeout(r, 140))
  assert.deepEqual(cuts, ['mute:1'], 'the judge saw exactly one cut')
  assert.equal(pool.isUsable('mute:1', 'm'), true, 'the dispatcher no longer strikes on its own')
  assert.deepEqual(pool.passiveStats('mute:1'), { ok: 0, limited: 0, refused: 0, dead: 0, transport: 0 }, 'and does not double-count it')
})

test('dispatcher sentinel: any handler callback disarms it (a live exit is never falsely struck)', async () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'live:1', exitIP: '1.1.1.1' }))
  pool.markOk('live:1')
  const answering = respondingSeam(() => 200)
  const router = new PoolRoutingDispatcher({ pool, undici: answering.seam as never, proxyHosts: ['opencode.ai'], sentinelMs: 60 })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  await new Promise((r) => setTimeout(r, 140))
  assert.deepEqual(pool.passiveStats('live:1'), { ok: 1, limited: 0, refused: 0, dead: 0, transport: 0 }, 'answered request classified ok, sentinel disarmed')
  assert.equal(pool.isUsable('live:1', 'm'), true)
})

test('dispatcher sentinel: tunnel-established silence aborts the dispatch (the muse 70-minute hang)', async () => {
  // After onRequestStart (tunnel stands) a dead-behind-the-tunnel exit sends
  // no response headers and no error — fetch would wait forever and the turn
  // never finishes. The sentinel re-arms at onRequestStart and ABORTS the
  // live controller when the headers window lapses, so fetch rejects and the
  // adapter's rotate loop takes over.
  const pool = new ExitPool()
  pool.add(node({ id: 'mute:1', exitIP: '1.1.1.1' }))
  pool.markOk('mute:1')
  const aborts: string[] = []
  const semiMute = {
    Agent: class { constructor() { return { dispatch: () => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() } } },
    ProxyAgent: class {
      constructor() {
        return {
          dispatch: (_o: unknown, handler: { onRequestStart?: (c: { abort(e: Error): void }, ctx: unknown) => void }): boolean => {
            // the tunnel stands (onRequestStart fires, first window disarms),
            // then NOTHING — the hang window behind the tunnel
            handler.onRequestStart?.({ abort: (e: Error) => aborts.push(e.message) } as never, {} as never)
            return true
          },
          close: () => Promise.resolve(),
          destroy: () => Promise.resolve(),
        }
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => ({ dispatch: () => true }),
  }
  const router = new PoolRoutingDispatcher({ pool, undici: semiMute as never, proxyHosts: ['opencode.ai'], sentinelMs: 60, headersMs: 60 })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  await new Promise((r) => setTimeout(r, 160))
  assert.deepEqual(pool.passiveStats('mute:1'), { ok: 0, limited: 0, refused: 0, dead: 0, transport: 1 }, 'headers-window silence recorded as transport')
  assert.equal(pool.isUsable('mute:1', 'm'), false, 'dead-behind-tunnel exit struck dead')
  assert.equal(aborts.length, 1, 'the live controller was aborted')
  assert.ok(aborts[0]!.includes('response silence'), 'abort carries the diagnosis')
})

test('dispatcher sentinel: response headers disarm the second window (slow bodies are never struck)', async () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'slow:1', exitIP: '1.1.1.1' }))
  pool.markOk('slow:1')
  const lateBody = {
    Agent: class { constructor() { return { dispatch: () => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() } } },
    ProxyAgent: class {
      constructor() {
        return {
          dispatch: (_o: unknown, handler: { onRequestStart?: (c: unknown, ctx: unknown) => void; onResponseStart?: (c: unknown, s: number, h: unknown, m?: string) => void }): boolean => {
            handler.onRequestStart?.({ abort: () => { throw new Error('must not abort once headers arrived') } } as never, {} as never)
            // headers arrive within the window; the BODY then trickles long
            // past the sentinel deadline — that must be fine (no re-arm after
            // onResponseStart; LLM stream pacing is not the sentinel's business)
            setTimeout(() => handler.onResponseStart?.({} as never, 200, {} as never), 30)
            return true
          },
          close: () => Promise.resolve(),
          destroy: () => Promise.resolve(),
        }
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => ({ dispatch: () => true }),
  }
  const router = new PoolRoutingDispatcher({ pool, undici: lateBody as never, proxyHosts: ['opencode.ai'], sentinelMs: 60 })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(pool.passiveStats('slow:1'), { ok: 1, limited: 0, refused: 0, dead: 0, transport: 0 }, 'headers-then-slow-body never struck')
  assert.equal(pool.isUsable('slow:1', 'm'), true)
})

test('dispatcher sentinel: window (b) is looser than (a) — a slow LLM TTFB behind a live tunnel is never struck', async () => {
  // onRequestStart can fire ~0.9s in with headers ~2.7s behind it (measured);
  // a single window would abort the dispatch mid-flight and strike a HEALTHY
  // exit dead, so window (b) carries the upstream-composition wait on its own
  // budget.
  const pool = new ExitPool()
  pool.add(node({ id: 'ttfb:1', exitIP: '1.1.1.1' }))
  pool.markOk('ttfb:1')
  const slowHeaders = {
    Agent: class { constructor() { return { dispatch: () => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() } } },
    ProxyAgent: class {
      constructor() {
        return {
          dispatch: (_o: unknown, handler: { onRequestStart?: (c: unknown, ctx: unknown) => void; onResponseStart?: (c: unknown, s: number, h: unknown, m?: string) => void }): boolean => {
            handler.onRequestStart?.({ abort: () => { throw new Error('healthy exit aborted!') } } as never, {} as never)
            // headers arrive 80ms later: past window (a)'s 60ms, well inside
            // window (b)'s 200ms — the request must survive
            setTimeout(() => handler.onResponseStart?.({} as never, 200, {} as never), 80)
            return true
          },
          close: () => Promise.resolve(),
          destroy: () => Promise.resolve(),
        }
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => ({ dispatch: () => true }),
  }
  const router = new PoolRoutingDispatcher({ pool, undici: slowHeaders as never, proxyHosts: ['opencode.ai'], sentinelMs: 60, headersMs: 200 })
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(pool.passiveStats('ttfb:1'), { ok: 1, limited: 0, refused: 0, dead: 0, transport: 0 }, 'slow TTFB behind a live tunnel classified ok, never struck')
  assert.equal(pool.isUsable('ttfb:1', 'm'), true)
})

test('dispatcher: 本机 traffic rides the local-egress agent the family setting builds', () => {
  // The family setting exists because the free lane refuses this host's IPv4
  // and accepts its IPv6 on identical bytes. Only the LOCAL egress may move:
  // #direct still carries loopback, out-of-pool hosts and other lanes — those
  // are not what 本机出口协议族 selects.
  const pool = new ExitPool()
  const built: Array<{ options: unknown; tag: string }> = []
  const hops: string[] = []
  const seam = {
    Agent: class {
      constructor(options?: unknown) {
        const tag = `agent-${built.length}`
        built.push({ options, tag })
        return {
          tag,
          dispatch: (): boolean => { hops.push(tag); return true },
          close: () => Promise.resolve(),
          destroy: () => Promise.resolve(),
        }
      }
    },
    ProxyAgent: class {
      constructor() {
        throw new Error('no exit is used in this test')
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => undefined,
  }
  const router = new PoolRoutingDispatcher({
    pool,
    undici: seam as never,
    proxyHosts: ['opencode.ai'],
    localFallback: true,
    localIpFamily: 'ipv4',
  })
  assert.equal(router.localIpFamily, 'ipv4')
  assert.equal(built[0]!.options, undefined, 'the plain direct agent takes no connect options')
  assert.deepEqual(built[1]!.options, { connect: { family: 4 } }, 'the local agent dials the family it was told')

  router.dispatch({ origin: 'https://example.com/x' } as never, {} as never)
  assert.deepEqual(hops, ['agent-0'], 'out-of-pool hosts keep the plain direct path')
  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/inference/v1/chat/completions' } as never, {} as never)
  })
  assert.deepEqual(hops, ['agent-0', 'agent-1'], 'pool-host traffic the pool cannot carry rides the local agent')

  // The settings page moves it live: a NEW socket family means a new agent,
  // and the next request is what proves the swap, not the getter.
  router.setLocalIpFamily('ipv6')
  assert.equal(router.localIpFamily, 'ipv6')
  assert.deepEqual(built[2]!.options, { connect: { family: 6 } })
  routingContext.run({ model: 'm', session: 's2' }, () => {
    router.dispatch({ origin: 'https://opencode.ai/x' } as never, {} as never)
  })
  assert.equal(hops.at(-1), 'agent-2')

  // Re-applying the same position is a no-op: no churn of a live socket pool.
  const before = built.length
  router.setLocalIpFamily('ipv6')
  assert.equal(built.length, before, 'nothing changed about the socket, so nothing is rebuilt')

  // An unknown value resolves back to the default instead of breaking routing.
  router.setLocalIpFamily('IPv6-only')
  assert.equal(router.localIpFamily, 'auto')
})

test('dispatcher: the auto position follows the machine\'s interface table', () => {
  const pool = new ExitPool()
  const options: unknown[] = []
  const seam = {
    Agent: class {
      constructor(next?: unknown) {
        options.push(next)
        return { dispatch: () => true, close: () => Promise.resolve(), destroy: () => Promise.resolve() }
      }
    },
    ProxyAgent: class {},
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => undefined,
  }
  const noIpv6 = { en0: [{ address: '192.168.31.100', family: 'IPv4' }] }
  const withIpv6 = { en0: [{ address: '192.168.31.100', family: 'IPv4' }, { address: '240e:305:18ac:3c00::1', family: 'IPv6' }] }
  const plain = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'], listInterfaces: () => noIpv6 })
  assert.equal(plain.localIpFamily, 'auto')
  assert.deepEqual(options[1], { connect: {} }, 'no IPv6 on the machine: no opinion, exactly as before the setting')
  options.length = 0
  new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'], listInterfaces: () => withIpv6 })
  const connect = (options[1] as { connect: { lookup?: unknown } }).connect
  assert.equal(connect.lookup, ipv6FirstLookup, 'IPv6 present: the resolver answers AAAA first')
})
