import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { SubscriptionFetcher } from '../src/pool/subscription-fetcher.ts'

/**
 * A fake undici seam serving ONLY the speed test (ip-api). Any other URL — a
 * Zen models list, a chat smoke, anything OpenCode — is recorded as a probe
 * attempt, which the subscription contract forbids; tests assert the record
 * stays empty.
 */
function seam() {
  const probeAttempts: string[] = []
  return {
    probeAttempts,
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      const address = init.dispatcher.uri.replace(/^https?:\/\//, '')
      if (url.includes('ip-api')) {
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: `8.8.${address.length}.1`, countryCode: 'US', city: 'c', country: 'c' }) },
        }
      }
      probeAttempts.push(url)
      return { statusCode: 418, body: { text: async () => 'probe attempted' } }
    }) as never,
  }
}

/** A subscription body fixture: mixed airport content (anytls + plaintext). */
const SUB_BODY = [
  'proxies:',
  '  - name: "机场US"',
  '    type: anytls',
  '    server: us01.example.com',
  '    port: 18888',
  '    password: secret-pw',
  '  - name: "明文HTTP"',
  '    type: http',
  '    server: 1.2.3.4',
  '    port: 8080',
  '  - name: "明文SOCKS"',
  '    type: socks5',
  '    server: 5.6.7.8',
  '    port: 1080',
].join('\n')

function makeFetcher(
  fetchImpl: typeof fetch,
  logger?: { info(message: string): void; warn(message: string): void },
  options: { userAgent?: string } = {},
) {
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const transport = seam()
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: transport as never, fetchImpl },
    { logger: logger ?? { info: () => {}, warn: () => {} }, ...options },
  )
  return { pool, fetcher, probeAttempts: transport.probeAttempts }
}

/** A fetch stub that records the User-Agent of every subscription pull. */
function uaRecorder(seen: Array<string | undefined>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined)?.['user-agent'])
    return new Response('')
  }) as unknown as typeof fetch
}

test('subscription refresh: plaintext nodes speed-test into the pool, encrypted park as pending', async () => {
  const { pool, fetcher, probeAttempts } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  const state = await fetcher.refresh()
  // plaintext nodes admitted from the SPEED TEST alone: a subscription row
  // shows the speed latency and never triggers an OpenCode probe
  assert.equal(state.plaintextAdmitted, 2)
  assert.ok(pool.has('1.2.3.4:8080'))
  assert.ok(pool.has('5.6.7.8:1080'))
  assert.ok(pool.list().every((n) => n.source === 'subscription'))
  assert.ok(pool.list().every((n) => n.exitIP !== '' && n.latencyMs >= 0), 'speed-test facts landed on both rows')
  assert.ok(pool.list().every((n) => n.health.state === 'ok'), 'the speed pass is the health verdict')
  assert.deepEqual(probeAttempts, [], 'ZERO requests to OpenCode on a subscription refresh')
  // the anytls node parked for IP-4 conversion, not in the pool
  assert.equal(state.pendingConversion.length, 1)
  assert.equal(state.pendingConversion[0]?.type, 'anytls')
  assert.ok(!pool.has('us01.example.com:18888'))
  assert.equal(state.lastError, '')
})

test('subscription fetch failures are reported, never thrown', async () => {
  const { fetcher } = makeFetcher((async () => { throw new Error('ETIMEDOUT') }) as unknown as typeof fetch)
  fetcher.setUrls(['https://dead.example.com/sub'])
  const state = await fetcher.refresh()
  assert.match(state.lastError, /ETIMEDOUT/)
  assert.equal(state.pendingConversion.length, 0)
})

test('subscription URLs are redacted in logs', async () => {
  const logs: string[] = []
  const { fetcher } = makeFetcher(
    (async () => new Response('')) as unknown as typeof fetch,
    { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  )
  fetcher.setUrls(['https://sub.example.com/VerySecretToken1234567890abcdef'])
  await fetcher.refresh()
  // nothing in the log carries the full credential
  assert.ok(logs.every((line) => !line.includes('VerySecretToken1234567890abcdef')))
  assert.ok(logs.some((line) => line.includes('…')))
})

test('subscription nodes never enter the pool twice (idempotent refresh)', async () => {
  const { pool, fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  await fetcher.refresh()
  const rows = pool.list().filter((n) => n.source === 'subscription')
  assert.equal(rows.length, 2) // still the same two plaintext nodes
})

// -- fetch User-Agent (airport allow-lists) -----------------------------------

test('subscription pulls send the default User-Agent, not a UA the airport gates out', async () => {
  const seen: Array<string | undefined> = []
  const { fetcher } = makeFetcher(uaRecorder(seen))
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  await fetcher.refresh()
  // One pull per URL; the admission smoke rides deps.undici, not fetchImpl.
  // The default must be a client VERSION: airport panels raise their UA floor
  // over time, so an old spelling comes back as an error page instead of the
  // subscription body (docs/ip-pool.md).
  assert.deepEqual(seen, ['clash-verge/v2.4.2'])
  assert.equal(fetcher.userAgent, 'clash-verge/v2.4.2')
})

test('the fetch UA is configurable and live-updatable without a restart', async () => {
  const seen: Array<string | undefined> = []
  const { fetcher } = makeFetcher(uaRecorder(seen), undefined, { userAgent: 'clash-verge/v2.0.3' })
  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  assert.deepEqual(seen, ['clash-verge/v2.0.3'])

  // A settings save calls setUserAgent and the NEXT refresh must carry it.
  fetcher.setUserAgent('mihomo/1.19.0')
  await fetcher.refresh()
  assert.equal(seen.at(-1), 'mihomo/1.19.0')
})

test('a blank UA falls back to the default instead of sending none', async () => {
  const seen: Array<string | undefined> = []
  const { fetcher } = makeFetcher(uaRecorder(seen), undefined, { userAgent: '   ' })
  assert.equal(fetcher.userAgent, 'clash-verge/v2.4.2')

  fetcher.setUserAgent('clash-verge/v2.4.2')
  fetcher.setUserAgent('')
  assert.equal(fetcher.userAgent, 'clash-verge/v2.4.2')

  fetcher.setUrls(['https://sub.example.com/x'])
  await fetcher.refresh()
  assert.deepEqual(seen, ['clash-verge/v2.4.2'])
})

// -- conversion core attached after construction -------------------------------

test('a supervisor attached after construction converts on the next refresh', async () => {
  // The supervisor is re-read on every round: `singbox.path` is editable while
  // the pool runs, so a core attached after construction must convert on the
  // next refresh instead of leaving encrypted nodes parked forever.
  const { pool, fetcher } = makeFetcher((async () => new Response(SUB_BODY)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/x'])
  const before = await fetcher.refresh()
  assert.equal(before.pendingConversion.length, 1, 'the anytls node parks while no core is configured')
  assert.equal(pool.has('127.0.0.1:30001'), false)

  const reloaded: Array<unknown> = []
  fetcher.setSupervisor({
    reload: async (nodes, keep) => {
      reloaded.push(nodes)
      const slots = keep ?? nodes.map((_, index) => index)
      // Port digits differ on purpose: the test seam answers the ip-api echo
      // with a query derived from the address LENGTH, and the pool refuses a
      // second row carrying the same exit IP (pool.add).
      return slots.map((index) => ({ address: index === 0 ? '127.0.0.1:30001' : '127.0.0.1:300001', protocol: 'socks5' as const, node: nodes[index]!, slot: index }))
    },
    stop: async () => {},
    running: true,
  })

  const after = await fetcher.refresh()
  assert.equal(reloaded.length, 1, 'the attached core is used by the next round')
  assert.equal(after.pendingConversion.length, 0, 'nothing stays parked once conversion ran')
  assert.ok(pool.has('127.0.0.1:30001'), 'the converted exit is admitted')
  assert.equal(pool.get('127.0.0.1:30001')?.source, 'subscription')
})

// -- live re-apply of the URL list and the refresh interval ---------------------

/** Drain the microtask queue so a fire-and-forget refresh can settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A fetch stub that records every pulled URL (empty 200 bodies). */
function urlRecorder(seen: string[]): typeof fetch {
  return (async (url: string) => {
    seen.push(String(url))
    return new Response('')
  }) as unknown as typeof fetch
}

test('setUrls: a changed list on a running fetcher pulls right away', async () => {
  const pulls: string[] = []
  const { fetcher } = makeFetcher(urlRecorder(pulls))
  fetcher.setUrls(['https://a.example.com/x'])
  assert.deepEqual(pulls, [], 'before start() the caller owns the first pull')

  fetcher.start()
  await settle()
  assert.deepEqual(pulls, ['https://a.example.com/x'])

  // A changed list pulls right away: re-seeding only would leave the new URL
  // waiting for the next timer tick — up to 30 minutes of "the setting did
  // not apply".
  fetcher.setUrls(['https://a.example.com/x', 'https://b.example.com/y'])
  await settle()
  assert.deepEqual(pulls, ['https://a.example.com/x', 'https://a.example.com/x', 'https://b.example.com/y'])

  fetcher.setUrls(['https://a.example.com/x', 'https://b.example.com/y'])
  await settle()
  assert.equal(pulls.length, 3, 'an unchanged list stays quiet')

  fetcher.setUrls([])
  await settle()
  assert.equal(fetcher.urlCount, 0)
  assert.equal(pulls.length, 3, 'removing every URL fetches nothing')
  fetcher.stop()
})

test('setIntervalMs: only a real change re-arms the refresh timer', async (t) => {
  // Every settings commit calls setIntervalMs, so re-arming unconditionally
  // would push the next fetch a full interval away from the save — a save must
  // make the pool fresher, not staler.
  t.mock.timers.enable({ apis: ['setInterval'], now: 0 })
  const pulls: string[] = []
  const { fetcher } = makeFetcher(urlRecorder(pulls))
  fetcher.setUrls(['https://a.example.com/x'])
  fetcher.start()
  await settle()
  assert.equal(pulls.length, 1)

  t.mock.timers.tick(29 * 60_000)
  fetcher.setIntervalMs(30 * 60_000)
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(pulls.length, 2, 'the original 30-minute deadline still fires')

  fetcher.setIntervalMs(60 * 60_000)
  t.mock.timers.tick(30 * 60_000)
  await settle()
  assert.equal(pulls.length, 2, 'after a real change the old deadline no longer fires')
  t.mock.timers.tick(30 * 60_000)
  await settle()
  assert.equal(pulls.length, 3, 'the new 60-minute interval took over')
  fetcher.stop()
})

// -- swaps queued behind the rebuild lock -------------------------------------

/** Two encrypted nodes: the conversion yields two local SOCKS5 exits. */
const TWO_ENCRYPTED = [
  'proxies:',
  '  - name: "机场US1"',
  '    type: anytls',
  '    server: us01.example.com',
  '    port: 18888',
  '    password: secret-pw',
  '  - name: "机场US2"',
  '    type: anytls',
  '    server: us02.example.com',
  '    port: 18889',
  '    password: secret-pw',
].join('\n')

test('a swap refused by the rebuild lock runs once the lock frees', async () => {
  // The lock exists so a burst of dead exits never stacks sing-box rebuilds.
  // An AUTOMATIC swap (dead rotation, probe verdict) must therefore wait its
  // turn instead of being dropped — the row would otherwise stay dead with
  // nothing left to retry it. The operator's own 轮换 keeps the old answer:
  // false, and the bridge reports "busy, try again".
  const log: string[] = []
  const { pool, fetcher } = makeFetcher(
    (async () => new Response(TWO_ENCRYPTED)) as unknown as typeof fetch,
    { info: (message: string) => log.push(message), warn: (message: string) => log.push(message) },
  )
  fetcher.setUrls(['https://sub.example.com/x'])

  let armed = false
  let reached!: () => void
  const inRebuild = new Promise<void>((resolve) => { reached = resolve })
  let release!: () => void
  const rebuild = new Promise<void>((resolve) => { release = resolve })
  fetcher.setSupervisor({
    reload: async (nodes, keep) => {
      if (armed && keep !== undefined) {
        reached()
        await rebuild
      }
      const slots = keep ?? nodes.map((_, index) => index)
      // Port digits differ on purpose: the test seam answers the ip-api echo
      // with a query derived from the address LENGTH, and the pool refuses a
      // second row carrying the same exit IP (pool.add).
      return slots.map((index) => ({ address: index === 0 ? '127.0.0.1:30001' : '127.0.0.1:300001', protocol: 'socks5' as const, node: nodes[index]!, slot: index }))
    },
    stop: async () => {},
    running: true,
  })

  await fetcher.refresh()
  assert.ok(pool.has('127.0.0.1:30001') && pool.has('127.0.0.1:300001'), 'both converted exits are online')

  // Drop the capacity so the trim has work to do, then hold its rebuild.
  pool.setPoolSize(1)
  armed = true
  const trimming = fetcher.enforceCapacity()
  await inRebuild
  assert.equal(pool.list().length, 1, 'the trim evicted before rebuilding')
  const survivor = pool.list()[0]!.id

  assert.equal(await fetcher.replaceExit(survivor, { defer: true }), false, 'a held lock refuses the swap')
  assert.equal(await fetcher.replaceExit(survivor), false, 'the manual path is refused too')
  assert.equal(log.filter((line) => line.includes('deferred swap')).length, 0, 'nothing runs while the lock is held')

  release()
  await trimming
  assert.equal(
    log.filter((line) => line.includes(`deferred swap of ${survivor}`)).length,
    1,
    'the queued swap ran the moment the lock freed',
  )
  assert.equal(fetcher.busy, false, 'the lock is free again')

  fetcher.stop()
})

test('a refresh that shrinks the conversion drops the rows whose port it retired', async () => {
  // Every refresh builds a NEW onboarder, so the retired-port prune only works
  // when the previous round's addresses are handed over. Without it a row on
  // a port sing-box no longer serves stays pickable and every request through
  // it dies at CONNECT (ECONNREFUSED).
  let body = TWO_ENCRYPTED
  const { pool, fetcher } = makeFetcher((async () => new Response(body)) as unknown as typeof fetch)
  fetcher.setUrls(['https://sub.example.com/x'])
  fetcher.setSupervisor({
    reload: async (nodes, keep) => {
      const slots = keep ?? nodes.map((_, index) => index)
      // Distinct address lengths: the seam's echo IP derives from the length.
      return slots.map((index) => ({ address: index === 0 ? '127.0.0.1:30001' : '127.0.0.1:300001', protocol: 'socks5' as const, node: nodes[index]!, slot: index }))
    },
    stop: async () => {},
    running: true,
  })

  await fetcher.refresh()
  assert.ok(pool.has('127.0.0.1:30001') && pool.has('127.0.0.1:300001'), 'both converted exits are online')

  body = TWO_ENCRYPTED.split('\n').slice(0, 6).join('\n')
  await fetcher.refresh()
  assert.ok(pool.has('127.0.0.1:30001'), 'the port the new conversion still serves stays')
  assert.equal(pool.has('127.0.0.1:300001'), false, 'the retired port left the pool')
  fetcher.stop()
})

test('subscription refresh: plaintext nodes respect poolSize and leave when the subscription drops them', async () => {
  const lines = (servers: string[]) => ['proxies:', ...servers.flatMap((server, index) => [
    `  - name: "p${index}"`,
    '    type: http',
    `    server: ${server}`,
    '    port: 8080',
  ])].join('\n')
  let body = lines(['1.2.3.4', '11.22.33.44', '111.122.133.144'])
  const pool = new ExitPool({ poolSize: 2 })
  const prober = new Prober({ pool, maxConcurrentProbes: 1 })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam() as never, fetchImpl: (async () => new Response(body)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  await fetcher.refresh()
  assert.equal(pool.list().length, 2, 'a full pool does not grow past poolSize')

  body = lines(['1.2.3.4'])
  await fetcher.refresh()
  assert.deepEqual(pool.list().map((row) => row.id), ['1.2.3.4:8080'], 'nodes the subscription dropped leave the pool')
})

test('subscription refresh: a failed fetch never prunes plaintext rows', async () => {
  let fail = false
  const body = ['proxies:', '  - name: "p"', '    type: http', '    server: 1.2.3.4', '    port: 8080'].join('\n')
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam() as never, fetchImpl: (async () => (fail ? new Response('', { status: 502 }) : new Response(body))) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token-abcdef-123456'])
  await fetcher.refresh()
  assert.ok(pool.has('1.2.3.4:8080'))
  fail = true
  await fetcher.refresh()
  assert.ok(pool.has('1.2.3.4:8080'), 'an airport hiccup is not an empty subscription')
})
