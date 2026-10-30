import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULTS, diffWrites, emptyForm, followServed, formFromValue, liveConflicts, pristineDraft,
  redactUrl, servedBase, servedSection, validateForm, type FormState,
} from '../src/client/form-model.ts'
import { usageScopeWriteOps } from '../src/client/settings-writes.ts'

type Snapshot = Parameters<typeof servedSection>[0]
const snapshot = (value: unknown, base: unknown = {}): Snapshot =>
  ({ status: 'ready', value, base, revision: 1, writable: true }) as unknown as Snapshot

const form = (patch: Partial<FormState> = {}): FormState => ({ ...emptyForm(), ...patch })

test('servedSection fills defaults and prefers the nested subscription list', () => {
  assert.deepEqual(servedSection(undefined), DEFAULTS)
  const legacyOnly = servedSection(snapshot({ ipPool: { subscriptions: ['https://a.test/s'], subscription: { urls: [] } } }))
  assert.deepEqual(legacyOnly.subscription.urls, ['https://a.test/s'])
  const both = servedSection(snapshot({ ipPool: { subscriptions: [], subscription: { urls: ['https://b.test/s'] } } }))
  assert.deepEqual(both.subscription.urls, ['https://b.test/s'])
  assert.equal(both.subscription.userAgent, DEFAULTS.subscription.userAgent)
  assert.equal(servedBase(snapshot({}, { ipPool: { poolSize: 4 } })).poolSize, 4)
})

test('diffWrites emits nothing for an untouched draft and unsets a value reset to base', () => {
  const served = servedSection(snapshot({ ipPool: { poolSize: 20 } }))
  const base = servedBase(snapshot({}, { ipPool: { poolSize: 10 } }))
  assert.deepEqual(diffWrites(formFromValue(served), served, base), [])
  assert.deepEqual(diffWrites({ ...formFromValue(served), poolSize: '10' }, served, base), [{ field: 'poolSize', op: 'unset' }])
  assert.deepEqual(diffWrites({ ...formFromValue(served), poolSize: '30' }, served, base), [{ field: 'poolSize', op: 'set', value: 30 }])
})

test('diffWrites treats a cleared fetch UA as the default, not an edit', () => {
  const served = servedSection(undefined)
  assert.deepEqual(diffWrites({ ...formFromValue(served), userAgent: '  ' }, served, {}), [])
})

test('validateForm accepts every manual entry the server parser accepts', () => {
  for (const entry of ['127.0.0.1:7897', 'http://h.test:1', 'https://h.test:443', 'socks4://h:1080', 'socks5h://[::1]:1080', 'socks5://[fd00::1]:9']) {
    assert.equal(validateForm(form({ manual: [entry] })), null, entry)
  }
  for (const entry of ['ftp://h:1', 'http://user:pw@h:1', 'h', 'http://h:99999']) {
    assert.deepEqual(validateForm(form({ manual: [entry] })), { reason: 'invalidProxy', group: 'sources' }, entry)
  }
})

test('validateForm range-checks the numeric fields and their groups', () => {
  assert.deepEqual(validateForm(form({ maxConcurrentProbes: '9' })), { reason: 'invalidRange', group: 'probe' })
  assert.deepEqual(validateForm(form({ poolSize: '0' })), { reason: 'invalidRange', group: 'probe' })
  assert.deepEqual(validateForm(form({ refreshMs: '59999' })), { reason: 'invalidRange', group: 'sources' })
  assert.deepEqual(validateForm(form({ subscriptionUrls: ['ftp://x'] })), { reason: 'invalidUrl', group: 'sources' })
  assert.deepEqual(validateForm(form({ probeModels: [' '] })), { reason: 'invalidModel', group: 'probe' })
  assert.equal(validateForm(form()), null)
})

test('a pristine field follows an external write (a pin made in the stats modal)', () => {
  const start = pristineDraft(form())
  const next = followServed(start, form({ pinnedExitId: 'http://127.0.0.1:30033' }))
  assert.equal(next.draft.pinnedExitId, 'http://127.0.0.1:30033')
  assert.deepEqual(liveConflicts(next), [])
  assert.deepEqual(diffWrites(next.draft, servedSection(snapshot({ ipPool: { pinnedExitId: 'http://127.0.0.1:30033' } })), {}), [])
})

test('an unrelated dirty field survives an external write without a conflict', () => {
  const dirty = { ...pristineDraft(form()), draft: form({ poolSize: '20' }) }
  const next = followServed(dirty, form({ pinnedExitId: 'local' }))
  assert.equal(next.draft.poolSize, '20')
  assert.equal(next.draft.pinnedExitId, 'local')
  assert.deepEqual(liveConflicts(next), [])
})

test('a dirty field changed underneath is flagged instead of silently reverted', () => {
  const dirty = { ...pristineDraft(form()), draft: form({ pinnedExitId: 'http://a.test:1' }) }
  const next = followServed(dirty, form({ pinnedExitId: 'http://b.test:2' }))
  assert.equal(next.draft.pinnedExitId, 'http://a.test:1')
  assert.deepEqual(liveConflicts(next), ['pinnedExitId'])
  // The conflict stands across later unrelated writes, and resolves once the
  // draft matches the served value again.
  const later = followServed(next, form({ pinnedExitId: 'http://b.test:2', poolSize: '5' }))
  assert.deepEqual(liveConflicts(later), ['pinnedExitId'])
  assert.equal(later.draft.poolSize, '5')
  const resolved = { ...later, draft: { ...later.draft, pinnedExitId: 'http://b.test:2' } }
  assert.deepEqual(liveConflicts(resolved), [])
})

test('a dirty field that the external write matches is accepted quietly', () => {
  const dirty = { ...pristineDraft(form()), draft: form({ enabled: true }) }
  const next = followServed(dirty, form({ enabled: true }))
  assert.equal(next.draft.enabled, true)
  assert.deepEqual(liveConflicts(next), [])
  assert.equal(followServed(next, form({ enabled: true })), next, 'an unchanged served form is a no-op')
})

test('redactUrl keeps only scheme and host', () => {
  assert.equal(redactUrl('https://sub.example.test/api/v1/client/subscribe?token=abcdef123456'), 'https://sub.example.test/…')
  assert.equal(redactUrl('https://user:secret@sub.example.test/link/TOKEN'), 'https://sub.example.test/…')
  assert.equal(redactUrl('https://sub.example.test'), 'https://sub.example.test')
  assert.equal(redactUrl('not a url token123'), '…')
})

test('the usage-scope switch writes inside ipPool', () => {
  assert.deepEqual(usageScopeWriteOps('run'), [{ op: 'set', path: ['ipPool', 'usageScope'], value: 'run' }])
})
