import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FAMILY_REFUSAL_TTL_MS,
  alternateFamily,
  familyFor,
  noteFamilyRefusal,
  pruneRefusals,
} from '../relay/family-fallback.mjs'

/**
 * The free lane refuses an egress ADDRESS with an HTTP 429, which the
 * connect-level `prefer6` fallback never sees. These are the two decisions that
 * turn that into a working lane: which family to try next, and which family to
 * start on while a refusal is fresh.
 */

type DirectFamily = '4' | '6' | 'prefer6'

test('the other family is the one to try after a quota refusal', () => {
  assert.equal(alternateFamily('4'), '6')
  assert.equal(alternateFamily('6'), '4')
  // `prefer6` dials AAAA first, so IPv6 is the family that can be refused.
  assert.equal(alternateFamily('prefer6'), '4')
  // A plain `direct` carries no family: nothing to swap.
  assert.equal(alternateFamily(undefined), null)
})

test('a fresh refusal steers the next request to the other family', () => {
  const refusals = new Map<'4' | '6', number>()
  const now = 1_000
  assert.equal(familyFor('prefer6', refusals, now), 'prefer6', 'nothing refused yet')

  noteFamilyRefusal(refusals, 'prefer6', now)
  assert.equal(familyFor('prefer6', refusals, now), '4', 'IPv6 is out of quota')
  assert.equal(familyFor('6', refusals, now), '4')
  // A request pinned to IPv4 is untouched by an IPv6 refusal.
  assert.equal(familyFor('4', refusals, now), '4')

  // The refusal expires: the preferred family gets tried again.
  const later = now + FAMILY_REFUSAL_TTL_MS + 1
  assert.equal(familyFor('prefer6', refusals, later), 'prefer6')
})

test('the reverse refusal sends an IPv4 pin to IPv6', () => {
  const refusals = new Map<'4' | '6', number>()
  noteFamilyRefusal(refusals, '4', 0)
  assert.equal(familyFor('4', refusals, 0), '6')
  assert.equal(familyFor('prefer6', refusals, 0), 'prefer6', 'IPv6 is still preferred')
})

test('refusals are keyed by the family actually dialled', () => {
  const refusals = new Map<'4' | '6', number>()
  noteFamilyRefusal(refusals, 'prefer6', 5_000)
  // `prefer6` dials AAAA, so the refusal is remembered against IPv6 only.
  assert.equal(refusals.has('4'), false)
  assert.equal(refusals.get('6'), 5_000 + FAMILY_REFUSAL_TTL_MS)
})

test('pruning drops what has expired and keeps what has not', () => {
  const refusals = new Map<'4' | '6', number>([
    ['4', 100],
    ['6', 900],
  ])
  pruneRefusals(refusals, 500)
  assert.deepEqual([...refusals.keys()], ['6'])
  pruneRefusals(refusals, 901)
  assert.equal(refusals.size, 0)
})

/**
 * The union is what the relay actually does per request: dial what the memo
 * says, and after a refusal note it and try the alternate.
 */
test('relay decision sequence: refuse on the preferred family, then serve on the other', () => {
  const refusals = new Map<'4' | '6', number>()
  const now = 100
  // First request: nothing known, dial the preferred family and get a 429.
  const first = familyFor('prefer6' as DirectFamily, refusals, now)
  assert.equal(first, 'prefer6')
  noteFamilyRefusal(refusals, first, now)
  // The retry inside the same request goes to the alternate.
  assert.equal(alternateFamily(first), '4')
  // The NEXT request skips the doomed family entirely.
  assert.equal(familyFor('prefer6' as DirectFamily, refusals, now + 1), '4')
})
