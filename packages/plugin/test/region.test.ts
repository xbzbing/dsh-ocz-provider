/**
 * The 地区 column's code mapping (live request 2026-10-14). Input is the
 * `exitLocation` admission.ts builds from the ip-api echo, whose first token
 * is the ISO alpha-2 country code.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { regionCode } from '../src/client/region.ts'

test('region codes use the operator\'s own anchors', () => {
  // The request spelled these two out: 香港 → HK, 新加坡 → SGP.
  assert.equal(regionCode('HK Central'), 'HK')
  assert.equal(regionCode('SG Singapore'), 'SGP')
})

test('every live location shape from this host maps to a code', () => {
  // Measured on the live pool 2026-10-14 (10 exits).
  assert.deepEqual(
    [
      'HK Central',
      'HK Wan Chai',
      'TW Taipei',
      'SG Singapore',
      'IN Navi Mumbai',
      'US Los Angeles',
      'DE Frankfurt am Main',
      'FR Paris',
      'KR Seoul',
    ].map(regionCode),
    ['HK', 'HK', 'TW', 'SGP', 'IND', 'USA', 'DEU', 'FRA', 'KOR'],
  )
})

test('an unmapped country falls back to its own alpha-2 code', () => {
  // A new airport location must still read as something: the raw code beats a
  // blank cell, and the IP tooltip carries the full string either way.
  assert.equal(regionCode('ZZ Nowhere'), 'ZZ')
  assert.equal(regionCode('hk central'), 'HK', 'case is normalized')
})

test('a location with no country code yields no code', () => {
  // Never-probed exits and sources that report a bare city land here; the
  // caller renders its own placeholder instead of inventing a region.
  assert.equal(regionCode(''), '')
  assert.equal(regionCode('   '), '')
  assert.equal(regionCode('Frankfurt am Main'), '')
})
