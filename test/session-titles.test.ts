/**
 * The host session-title join (live request 2026-10-14): the 流量 tab's
 * Top 会话 rows must show the session's TITLE (what the sidebar calls it),
 * with the recorded first-prompt label only as the fallback.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionTitleResolver, TITLE_HIT_TTL_MS, TITLE_MISS_TTL_MS } from '../src/pool/session-titles.ts'

/** A fake ctx.sessionQuery whose answers and call count the test controls. */
function fakeQuery() {
  const titles = new Map<string, string>()
  const calls: string[][] = []
  let fail = false
  return {
    calls,
    failNext(value: boolean) { fail = value },
    setTitle(id: string, title: string) { titles.set(id, title) },
    async readTitleSnapshots(ids: readonly string[]) {
      calls.push([...ids])
      if (fail) throw new Error('corpus exploded')
      return ids.map((sessionId) => {
        const title = titles.get(sessionId)
        return title === undefined
          ? { sessionId, status: 'rejected', reason: new Error('not titled') }
          : { sessionId, status: 'fulfilled', value: { title: { title } } }
      })
    },
  }
}

test('resolved titles are served from cache until the hit TTL passes', async () => {
  const query = fakeQuery()
  query.setTitle('ses_1', '修弹窗 toast')
  let clock = 1_000
  const resolve = makeSessionTitleResolver(query, { now: () => clock })

  const first = await resolve(['ses_1'])
  assert.equal(first.get('ses_1'), '修弹窗 toast', 'the host title rides the first batch')
  const second = await resolve(['ses_1'])
  assert.equal(second.get('ses_1'), '修弹窗 toast')
  assert.equal(query.calls.length, 1, 'a resolved title is reused without re-querying the host')

  clock += TITLE_HIT_TTL_MS + 1
  const third = await resolve(['ses_1'])
  assert.equal(third.get('ses_1'), '修弹窗 toast')
  assert.equal(query.calls.length, 2, 'the hit TTL still expires — renames eventually show up')
})

test('a missing title is a miss: retried soon, absent from the map', async () => {
  const query = fakeQuery()
  let clock = 5_000
  const resolve = makeSessionTitleResolver(query, { now: () => clock })

  const before = await resolve(['ses_new'])
  assert.equal(before.has('ses_new'), false, 'untitled sessions stay out of the map so the recorded label shows')
  await resolve(['ses_new'])
  assert.equal(query.calls.length, 1, 'within the miss TTL the absence is cached too — no host hammering')

  clock += TITLE_MISS_TTL_MS + 1
  query.setTitle('ses_new', '刚生成的标题')
  const after = await resolve(['ses_new'])
  assert.equal(after.get('ses_new'), '刚生成的标题', 'the miss TTL is what notices a title that landed later')
  assert.equal(query.calls.length, 2)
})

test('a failing host query degrades to empty, never rejects', async () => {
  const query = fakeQuery()
  query.setTitle('ses_1', 'stable title')
  const resolve = makeSessionTitleResolver(query)

  await resolve(['ses_1'])
  query.failNext(true)
  const during = await resolve(['ses_1'])
  assert.equal(during.get('ses_1'), 'stable title', 'the cached hit survives the failure')

  const cold = makeSessionTitleResolver(query)
  query.failNext(true)
  const empty = await cold(['ses_2'])
  assert.equal(empty.size, 0, 'a cold failure yields no titles instead of throwing — /status must still answer')
})

test('duplicate and empty ids are deduplicated before the host is queried', async () => {
  const query = fakeQuery()
  query.setTitle('ses_1', 't')
  const resolve = makeSessionTitleResolver(query)
  await resolve(['ses_1', '', 'ses_1', 'ses_1'])
  assert.deepEqual(query.calls, [['ses_1']], 'one host call, empty ids dropped')
})
