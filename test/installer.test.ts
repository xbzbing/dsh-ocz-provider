/**
 * RoutingInstaller: the global dispatcher slot must be RESTORED on disable.
 *
 * On Node 24 / undici 8.x `setGlobalDispatcher()` returns `undefined`, so the
 * previous dispatcher must be read back through `getGlobalDispatcher()`.
 * Without that read `#previous` stays null, `disable()` skips the restore,
 * and the PoolRoutingDispatcher keeps capturing every fetch in the process —
 * surviving plugin dispose.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RoutingInstaller } from '../src/pool/installer.ts'
import { PoolRoutingDispatcher } from '../src/pool/dispatcher.ts'

/** Minimal undici stand-in: a dispatcher slot with the real setter semantics. */
function makeUndiciStub() {
  /** Every dispatch that reached a plain (non-proxy) agent, in order. */
  const directHops: string[] = []
  class Agent {
    destroyed = false
    dispatch(_options: unknown, _handler: unknown): boolean {
      directHops.push('direct')
      return true
    }
    async destroy(): Promise<void> {
      this.destroyed = true
    }
    async close(): Promise<void> {
      this.destroyed = true
    }
  }

  const initial = new Agent()
  let slot: unknown = initial
  let setCalls = 0

  const stub = {
    Agent,
    initial,
    directHops,
    /** The module fetch the installer swaps in (differs from the built-in). */
    fetch: function moduleFetch(_input: unknown, _init?: unknown): Promise<unknown> {
      return Promise.resolve({ ok: true })
    },
    get setCalls(): number {
      return setCalls
    },
    /** `getGlobalDispatcher()` — where the previous dispatcher is read back. */
    getGlobalDispatcher: (): unknown => slot,
    /**
     * Faithful to undici 8.x: swaps the slot and returns **undefined** —
     * the replaced dispatcher is never handed back.
     */
    setGlobalDispatcher(next: unknown): undefined {
      setCalls += 1
      slot = next
      return undefined
    },
    peek: (): unknown => slot,
  }
  return stub
}

/** The installer's pool seam; only the members `disable()` touches matter here. */
function makePoolStub() {
  return {
    get: () => null,
    pick: () => null,
    has: () => false,
    list: () => [],
    snapshot: () => ({ total: 0 }),
    recordPassive: () => 'ok',
    recordPassiveTransport: () => {},
    rerouteSession: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeInstaller(undici: ReturnType<typeof makeUndiciStub>) {
  return new RoutingInstaller({
    pool: makePoolStub(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undici: undici as any,
    proxyHosts: ['opencode.ai'],
    logger: { info: () => {}, warn: () => {} },
  })
}

test('install() swaps the global dispatcher and marks itself enabled', () => {
  const undici = makeUndiciStub()
  const installer = makeInstaller(undici)

  assert.equal(installer.enabled, false)
  installer.install()

  assert.equal(installer.enabled, true)
  assert.ok(
    undici.peek() instanceof PoolRoutingDispatcher,
    'the global slot must hold our routing layer while enabled',
  )
})

test('proxyHosts reports the list actually in force, empty config included', () => {
  // The settings schema defaults proxyHosts to []: an empty list must resolve
  // to the default, not to "proxy nothing" while /status displays opencode.ai
  // from its own fallback. The card reads this getter, so it can only show the
  // hosts the router is really using.
  const installer = new RoutingInstaller({
    pool: makePoolStub(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undici: makeUndiciStub() as any,
    proxyHosts: [],
    logger: { info: () => {}, warn: () => {} },
  })
  assert.deepEqual(installer.proxyHosts, ['opencode.ai'], 'empty config reports the default it resolves to')

  installer.install()
  assert.deepEqual(installer.proxyHosts, ['opencode.ai'], 'and the running router agrees')

  installer.setProxyHosts(['api.example.com'])
  assert.deepEqual(installer.proxyHosts, ['api.example.com'], 'a live re-apply is reported immediately')

  installer.setProxyHosts([])
  assert.deepEqual(installer.proxyHosts, ['opencode.ai'], 'clearing the field falls back to the default')
})

test('proxyPathPrefixes reports the path scope actually in force', () => {
  // Same contract as proxyHosts, for the second half of the routing rule: the
  // card and /status must read the scope the router is using, not a display
  // default — otherwise "which opencode.ai traffic is in the pool" is
  // unanswerable.
  const installer = new RoutingInstaller({
    pool: makePoolStub(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undici: makeUndiciStub() as any,
    proxyPathPrefixes: [],
    logger: { info: () => {}, warn: () => {} },
  })
  assert.deepEqual(installer.proxyPathPrefixes, ['/inference/v1'], 'empty config reports the default it resolves to')

  installer.install()
  assert.deepEqual(installer.proxyPathPrefixes, ['/inference/v1'], 'and the running router agrees')

  installer.setProxyPathPrefixes(['/inference/v1/', 'inference/go/v1'])
  assert.deepEqual(installer.proxyPathPrefixes, ['/inference/v1', '/inference/go/v1'], 'a live re-apply is reported normalized')

  installer.setProxyPathPrefixes(['/'])
  assert.deepEqual(installer.proxyPathPrefixes, ['/'], 'the whole host stays expressible')

  installer.setProxyPathPrefixes([])
  assert.deepEqual(installer.proxyPathPrefixes, ['/inference/v1'], 'clearing the field falls back to the default')
})

test('disable() restores the dispatcher that was active before install', () => {
  const undici = makeUndiciStub()
  const before = undici.peek()
  const installer = makeInstaller(undici)

  installer.install()
  assert.notEqual(undici.peek(), before, 'install must replace the slot')

  installer.disable()
  assert.equal(
    undici.peek(),
    before,
    'disable() must put the ORIGINAL dispatcher back — the bug left the routing layer installed forever',
  )
})

test('dispose() restores the dispatcher too (plugin teardown path)', () => {
  const undici = makeUndiciStub()
  const before = undici.peek()
  const installer = makeInstaller(undici)

  installer.install()
  installer.dispose()

  assert.equal(undici.peek(), before, 'dispose() is the path a plugin unload takes')
})

test('the restored dispatcher is not our own destroyed layer', () => {
  const undici = makeUndiciStub()
  const installer = makeInstaller(undici)

  installer.install()
  installer.disable()

  assert.equal(
    undici.peek() instanceof PoolRoutingDispatcher,
    false,
    'a destroyed PoolRoutingDispatcher must never be left in the slot',
  )
})

test('install() does not depend on setGlobalDispatcher returning the old dispatcher', () => {
  // Pinned directly: the setter returns void, so only a getter read can prove
  // the slot changed.
  const undici = makeUndiciStub()
  const old = undici.peek()
  const returned = undici.setGlobalDispatcher(new undici.Agent())

  assert.equal(returned, undefined, 'undici 8.x returns void here')
  assert.notEqual(undici.peek(), old, 'but the slot did change')

  const installer = makeInstaller(undici)
  installer.install()
  installer.disable()
  assert.notEqual(
    undici.peek() instanceof PoolRoutingDispatcher,
    true,
    'a void return must not stop the restore',
  )
})

test('disable() is idempotent and tolerates a never-installed instance', () => {
  const undici = makeUndiciStub()
  const before = undici.peek()
  const installer = makeInstaller(undici)

  installer.disable() // never installed
  assert.equal(undici.peek(), before)

  installer.install()
  installer.disable()
  installer.disable() // second call must be a no-op
  assert.equal(undici.peek(), before)
})

test('install() after disable() works again (re-enable cycle)', () => {
  const undici = makeUndiciStub()
  const before = undici.peek()
  const installer = makeInstaller(undici)

  installer.install()
  installer.disable()
  assert.equal(undici.peek(), before)

  installer.install()
  assert.ok(undici.peek() instanceof PoolRoutingDispatcher, 're-enable must install again')
  installer.disable()
  assert.equal(undici.peek(), before, 'and restore again')
})

test('a foreign dispatcher defers instead of short-circuiting it', () => {
  const undici = makeUndiciStub()
  class ForeignPluginDispatcher {
    dispatch() {
      return true
    }
  }
  undici.setGlobalDispatcher(new ForeignPluginDispatcher())
  const foreign = undici.peek()

  const installer = makeInstaller(undici)
  installer.install()

  assert.equal(installer.enabled, false, 'we must not steal a slot another plugin owns')
  assert.match(String(installer.deferredReason), /deferred/)
  assert.equal(undici.peek(), foreign, 'the foreign layer stays untouched')
})

test('the plugin fetch is saved and restored alongside the dispatcher', () => {
  const undici = makeUndiciStub()
  const builtinFetch = globalThis.fetch
  // makeUndiciStub already exposes a module fetch that differs from the
  // built-in one, which is exactly the condition the installer reacts to.
  assert.notEqual(undici.fetch, builtinFetch, 'fixture precondition: distinct fetch identity')

  const installer = makeInstaller(undici)
  installer.install()
  assert.equal(globalThis.fetch, undici.fetch, 'routing only works if the module fetch is in place')

  installer.disable()
  assert.equal(globalThis.fetch, builtinFetch, 'the built-in fetch must come back')
})

test('本地出口兜底: the installer carries it into the router and re-applies it live', () => {
  // The switch is a routing policy, not table membership: the installer owns
  // the value before a router exists (so the first install is already
  // strict), and forwards every change into the running layer.
  const undici = makeUndiciStub()
  const installer = new RoutingInstaller({
    pool: makePoolStub(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undici: undici as any,
    proxyHosts: ['opencode.ai'],
    logger: { info: () => {}, warn: () => {} },
  })
  assert.equal(installer.localFallback, false, 'absent means OFF — the strict default')

  installer.install()
  const router = undici.peek() as PoolRoutingDispatcher
  assert.equal(router.localFallback, false, 'the router starts strict')
  assert.equal(installer.localFallback, false, 'the getter reads the running router')

  installer.setLocalFallback(true)
  assert.equal(router.localFallback, true, 'a live flip reaches the installed layer')
  assert.equal(installer.localFallback, true)

  installer.setLocalFallback(false)
  assert.equal(router.localFallback, false, 'and back')
  installer.disable()
})

test('本机出口协议族: the installer carries it into the router and re-applies it live', () => {
  // Same shape as 本地出口兜底: the value is known before a router exists, so
  // the first install already dials the configured family, and every later
  // change reaches the running layer without a restart.
  const undici = makeUndiciStub()
  const installer = new RoutingInstaller({
    pool: makePoolStub(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    undici: undici as any,
    proxyHosts: ['opencode.ai'],
    logger: { info: () => {}, warn: () => {} },
  })
  assert.equal(installer.localIpFamily, 'auto', 'absent means auto — IPv6 where this machine has it')

  installer.install()
  const router = undici.peek() as PoolRoutingDispatcher
  assert.equal(router.localIpFamily, 'auto', 'the router starts on the shipped default')
  assert.equal(installer.localIpFamily, 'auto', 'the getter reads the running router')

  installer.setLocalIpFamily('ipv6')
  assert.equal(router.localIpFamily, 'ipv6', 'a live change reaches the installed layer')
  assert.equal(installer.localIpFamily, 'ipv6')

  installer.setLocalIpFamily('only-v4')
  assert.equal(router.localIpFamily, 'auto', 'an unknown spelling resolves back to the default')
  installer.disable()
})

// -- composing dispatchers (dsh-privacy-gateway coexistence) -------------------

/** Closed/destroyed as a composer publishes them. */
function isClosedLayer(dispatcher: unknown): boolean {
  const shape = dispatcher as { closed?: boolean; destroyed?: boolean } | null
  return shape?.closed === true || shape?.destroyed === true
}

type LayerRole = 'route' | 'proxy'
const RANK: Record<LayerRole, number> = { route: 0, proxy: 1 }

/**
 * dsh-privacy-gateway's MaskingDispatcher, reproduced from the installed
 * package (ADR-0012): layers carry a role, `route` sits above `proxy`, the
 * newest layer of a role goes first, a closed layer is skipped, re-chaining an
 * existing layer PROMOTES it, and when nothing is open `downstream()` falls
 * back to the last layer anyway — the trap that turns "we closed our layer"
 * into a host-wide outage.
 */
class ComposerStub {
  #layers: Array<{ d: unknown; role: LayerRole; seq: number }>
  #seq = 0

  constructor(initial: unknown) {
    this.#layers = [{ d: initial, role: 'proxy', seq: 0 }]
  }

  chainTo(next: unknown, options: { role?: LayerRole } = {}): void {
    if ((next as unknown) === (this as unknown)) return
    const had = this.#layers.find((layer) => layer.d === next)
    if (had) {
      had.seq = ++this.#seq
      if (options.role !== undefined) had.role = options.role
      return
    }
    this.#layers.push({ d: next, role: options.role ?? 'route', seq: ++this.#seq })
  }

  adopt(next: unknown): void {
    if (this.#layers.some((layer) => layer.d === next)) return
    this.chainTo(next, { role: 'proxy' })
  }

  release(next: unknown): boolean {
    const index = this.#layers.findIndex((layer) => layer.d === next)
    if (index < 0 || this.#layers.length === 1) return false
    this.#layers.splice(index, 1)
    return true
  }

  #ordered(): Array<{ d: unknown; role: LayerRole; seq: number }> {
    return [...this.#layers].sort((a, b) => RANK[a.role] - RANK[b.role] || b.seq - a.seq)
  }

  #next(after?: unknown): unknown {
    const order = this.#ordered()
    let i = after === undefined ? 0 : order.findIndex((layer) => layer.d === after) + 1
    for (; i < order.length; i += 1) {
      const layer = order[i]!
      if (layer.d !== after && !isClosedLayer(layer.d)) return layer.d
    }
    return undefined
  }

  downstream(): unknown {
    return this.#next() ?? this.#ordered().at(-1)!.d
  }

  below(d: unknown): unknown {
    return this.#next(d)
  }

  downstreams(): Array<{ dispatcher: unknown; role: LayerRole; closed: boolean }> {
    return this.#ordered().map((layer) => ({ dispatcher: layer.d, role: layer.role, closed: isClosedLayer(layer.d) }))
  }

  dispatch(options: unknown, handler: unknown): boolean {
    const next = this.downstream() as { dispatch?: (o: unknown, h: unknown) => boolean } | undefined
    if (typeof next?.dispatch !== 'function') return false
    return next.dispatch(options, handler)
  }
}

test('install() joins below a composing dispatcher, keeping masking outermost', () => {
  const undici = makeUndiciStub()
  const composer = new ComposerStub(undici.initial)
  undici.setGlobalDispatcher(composer)
  const setCallsBefore = undici.setCalls
  const fetchBefore = globalThis.fetch

  const installer = makeInstaller(undici)
  installer.install()

  assert.equal(installer.enabled, true, 'joining IS routing on — there is nothing to defer to')
  assert.equal(installer.composedUnder, 'ComposerStub')
  assert.equal(installer.deferredReason, null)
  assert.equal(undici.peek(), composer, 'the composer keeps the slot: it has to see the plaintext body first')
  assert.equal(undici.setCalls, setCallsBefore, 'joining never rewrites the slot')
  assert.equal(globalThis.fetch, fetchBefore, 'the slot already carries our traffic, so no fetch swap')
  assert.ok(
    composer.downstream() instanceof PoolRoutingDispatcher,
    'requests then reach the router, which picks the exit',
  )
})

test('disable() while joined closes this layer and leaves masking in place', () => {
  const undici = makeUndiciStub()
  const composer = new ComposerStub(undici.initial)
  undici.setGlobalDispatcher(composer)
  const installer = makeInstaller(undici)
  installer.install()
  const router = composer.downstream() as PoolRoutingDispatcher

  installer.disable()

  assert.equal(installer.enabled, false)
  assert.equal(installer.composedUnder, null)
  assert.equal(undici.peek(), composer, 'switching the pool off must not remove masking')
  assert.equal(router.closed, true, 'a composer skips a closed downstream…')
  assert.equal(router.destroyed, true, '…and undici-shaped code reads either field')
  assert.equal(composer.downstream(), undici.initial, 'requests fall through to what was below us')
})

test('a composer that does not adopt this layer is deferred, not reported as enabled', () => {
  const undici = makeUndiciStub()
  class StubbornComposer {
    readonly #below: unknown

    constructor(below: unknown) {
      this.#below = below
    }

    chainTo(): void {}

    downstream(): unknown {
      return this.#below
    }
  }
  const composer = new StubbornComposer(undici.initial)
  undici.setGlobalDispatcher(composer)

  const installer = makeInstaller(undici)
  installer.install()

  assert.equal(installer.enabled, false, 'claiming enabled here would report routing nobody performs')
  assert.match(String(installer.deferredReason), /StubbornComposer/)
  assert.equal(undici.peek(), composer)

  installer.install()
  assert.equal(installer.enabled, false, 'a refusal is not retried on every admission')
})

test('tearing the pool down never deletes a composer that wrapped it', () => {
  const undici = makeUndiciStub()
  const installer = makeInstaller(undici)
  installer.install()
  const ours = undici.peek() as PoolRoutingDispatcher
  // dsh-privacy-gateway installed after the pool: it takes the slot and chains
  // us below (that order is the one the gateway produces on its own).
  const composer = new ComposerStub(ours)
  undici.setGlobalDispatcher(composer)

  installer.disable()

  assert.equal(undici.peek(), composer, 'restoring our predecessor would have deleted masking')
  assert.equal(ours.closed, true)
})

test('a composer that hands the slot to this layer on dispose is still released on disable', () => {
  const undici = makeUndiciStub()
  const composer = new ComposerStub(undici.initial)
  undici.setGlobalDispatcher(composer)
  const installer = makeInstaller(undici)
  installer.install()
  const router = composer.downstream() as PoolRoutingDispatcher

  // installGateway().dispose(): setGlobalDispatcher(gateway.downstream())
  undici.setGlobalDispatcher(router)
  installer.install()
  assert.equal(installer.enabled, true)
  assert.equal(installer.composedUnder, null, 'we hold the slot now, so the join is over')

  installer.disable()
  assert.equal(router.closed, true)
  assert.notEqual(undici.peek(), router, 'the slot must not be left pointing at a closed layer')
  // The layer we were chained above — not a fresh Agent: it may carry a proxy
  // policy (dsh-http-proxy), and replacing it with a bare Agent would drop it.
  assert.equal(undici.peek(), undici.initial, 'the borrowed layer gets the slot back')
})

test('a layer replaced by another plugin is re-decided on the next install', () => {
  const undici = makeUndiciStub()
  const installer = makeInstaller(undici)
  installer.install()
  const ours = undici.peek() as PoolRoutingDispatcher

  class ForeignReplacement {
    dispatch(): boolean {
      return true
    }
  }
  const replacement = new ForeignReplacement()
  undici.setGlobalDispatcher(replacement)

  installer.install()

  assert.equal(installer.enabled, false, 'enabled must mean "in force", not "was enabled once"')
  assert.match(String(installer.deferredReason), /ForeignReplacement/)
  assert.equal(ours.closed, true, 'the stale layer is closed, not left holding sockets')
  assert.equal(undici.peek(), replacement, 'the occupant is still untouched')
})


test('a joined layer really carries requests: the composer hands them to the router', () => {
  // The other tests pin the wiring; this one sends requests through the
  // composer, because "joined" is only worth anything if `dispatch` actually
  // arrives — and if what the pool refuses leaves by the borrowed layer
  // instead of this machine.
  const undici = makeUndiciStub()
  const composer = new ComposerStub(undici.initial)
  undici.setGlobalDispatcher(composer)
  const installer = makeInstaller(undici)
  installer.install()

  const hop = (origin: string, path: string, handler: unknown): boolean =>
    (composer as unknown as { dispatch(o: unknown, h: unknown): boolean })
      .dispatch({ origin, path, method: 'GET' }, handler)

  hop('https://example.com/x', '/x', {})
  assert.deepEqual(undici.directHops, ['direct'], 'a host outside the pool rides the borrowed layer')

  const errors: string[] = []
  hop('https://opencode.ai', '/inference/v1/chat/completions', {
    onResponseError: (_controller: unknown, error: Error) => {
      errors.push(error.message)
    },
  })
  assert.equal(errors.length, 1, 'the router answered, so the composer really dispatched into it')
  assert.match(errors[0]!, /no usable pool exit/, 'and it failed closed rather than egressing here')
  assert.deepEqual(undici.directHops, ['direct'], 'nothing new left through a plain agent')
  assert.equal(installer.enabled, true)
})

// -- the scenarios that used to break the composition --------------------------

test('a composer installed AFTER the pool must not make it borrow its own corpse', () => {
  // The gateway may load second: its constructor wraps whatever dispatcher is
  // global, which is our router. On the next reconcile our layer is torn down —
  // and the composer's `downstream()` then answers our closed router, because a
  // composer with nothing open falls back to its last layer.
  const undici = makeUndiciStub()
  const installer = makeInstaller(undici)
  installer.install()
  const composer = new ComposerStub(undici.peek())
  undici.setGlobalDispatcher(composer)

  installer.install()

  assert.equal(installer.enabled, true)
  assert.equal(installer.composedUnder, 'ComposerStub')
  assert.equal(undici.peek(), composer, 'the composer keeps the slot')

  const before = undici.directHops.length
  const dispatched = (composer as unknown as { dispatch(o: unknown, h: unknown): boolean })
    .dispatch({ origin: 'https://example.com/x', path: '/x', method: 'GET' }, {})
  assert.equal(dispatched, true, 'a non-pool request must not land on a closed layer')
  assert.equal(undici.directHops.length, before + 1, 'it goes to a live layer below, never to the corpse')
})

test('a dispatcher adopted under this layer after the join receives the traffic', () => {
  // ADR-0012 lets a later plugin be adopted as a `proxy` layer. A hand-off
  // captured at join time would starve it while the status still claimed the
  // policy survived.
  const undici = makeUndiciStub()
  const composer = new ComposerStub(undici.initial)
  undici.setGlobalDispatcher(composer)
  const installer = makeInstaller(undici)
  installer.install()

  const adopted: string[] = []
  const late = {
    dispatch: () => {
      adopted.push('late')
      return true
    },
    close: async (): Promise<void> => {},
    destroy: async (): Promise<void> => {},
  }
  composer.adopt(late)

  const before = undici.directHops.length
  ;(composer as unknown as { dispatch(o: unknown, h: unknown): boolean })
    .dispatch({ origin: 'https://example.com/x', path: '/x', method: 'GET' }, {})
  assert.deepEqual(adopted, ['late'], 'the layer adopted after us carries what we do not')
  assert.equal(undici.directHops.length, before, 'and the machine does not dial instead')
})

test('disable() while the composer holds only this layer leaves something open', () => {
  // The outage case: our layer is the only one, `release()` refuses to empty
  // the chain, and the composer's all-closed fallback would hand every request
  // to our closed layer — masking included.
  const undici = makeUndiciStub()
  const composer = new ComposerStub(undici.peek())
  undici.setGlobalDispatcher(composer)
  const installer = makeInstaller(undici)
  installer.install()
  const router = composer.downstream() as PoolRoutingDispatcher
  assert.ok(router instanceof PoolRoutingDispatcher)

  const before = undici.directHops.length
  installer.disable()

  assert.equal(router.closed, true)
  assert.notEqual(composer.downstream(), router, 'the composer must not fall back to a closed layer')
  const dispatched = (composer as unknown as { dispatch(o: unknown, h: unknown): boolean })
    .dispatch({ origin: 'https://example.com/x', path: '/x', method: 'GET' }, {})
  assert.equal(dispatched, true, 'requests still complete after the pool is switched off')
  assert.equal(undici.directHops.length, before + 1, 'through the replacement layer, not our corpse')
})

test('leaving a composer releases this layer instead of leaving a closed one behind', () => {
  const undici = makeUndiciStub()
  const composer = new ComposerStub(undici.initial)
  undici.setGlobalDispatcher(composer)
  const installer = makeInstaller(undici)
  installer.install()
  assert.equal(composer.downstreams().length, 2)

  installer.disable()
  assert.equal(composer.downstreams().length, 1, 'no growth per enable/disable cycle')
  assert.equal(composer.downstream(), undici.initial)
})

test('routingInForce() reports an outranked layer, and install() takes the hop back', () => {
  // A second `route` layer chained later sorts first (newest within its role),
  // so requests stop reaching this router while `enabled` still says otherwise.
  const undici = makeUndiciStub()
  const composer = new ComposerStub(undici.initial)
  undici.setGlobalDispatcher(composer)
  const installer = makeInstaller(undici)
  installer.install()
  assert.equal(installer.routingInForce(), true)

  const rival = {
    dispatch: () => true,
    close: async (): Promise<void> => {},
    destroy: async (): Promise<void> => {},
  }
  composer.chainTo(rival, { role: 'route' })
  assert.equal(composer.downstream(), rival, 'the rival now takes the hop')
  assert.equal(installer.routingInForce(), false, 'and the installer says so instead of claiming routing')

  installer.install()
  assert.equal(installer.routingInForce(), true, 'the next install re-promotes this layer')
  assert.equal(installer.composedUnder, 'ComposerStub')
})
