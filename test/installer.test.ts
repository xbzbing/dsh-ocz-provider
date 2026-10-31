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
  class Agent {
    destroyed = false
    dispatch(_options: unknown, _handler: unknown): boolean {
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

/**
 * A composer shaped like dsh-privacy-gateway's MaskingDispatcher: it keeps the
 * global slot and hands each request to the NEWEST layer chained after it,
 * skipping a closed one. `chainTo` dedupes by identity, exactly like the real
 * one, so a layer already in the list can never be promoted again.
 */
class ComposerStub {
  readonly #downstream: unknown[]

  constructor(initial: unknown) {
    this.#downstream = [initial]
  }

  chainTo(next: unknown): void {
    if ((next as unknown) === (this as unknown) || this.#downstream.includes(next)) return
    this.#downstream.push(next)
  }

  downstream(): unknown {
    for (let i = this.#downstream.length - 1; i >= 0; i -= 1) {
      const candidate = this.#downstream[i] as { closed?: boolean; destroyed?: boolean } | null
      if (candidate?.closed !== true && candidate?.destroyed !== true) return candidate
    }
    return this.#downstream[0]
  }

  dispatch(): boolean {
    return true
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
  assert.ok(undici.peek() instanceof undici.Agent, 'undici gets its own default back')
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

