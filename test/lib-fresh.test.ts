/**
 * `lib/` ships in git (neither install path runs a lifecycle script), so a
 * source edit committed without a rebuild would install stale code for every
 * later user — this test makes that impossible to merge. The comparison lives
 * in scripts/lib-manifest.mjs, shared with the build, so stamp and check
 * cannot drift apart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib-manifest.mjs')

test('committed lib/ matches src/ (rebuild and commit after source changes)', () => {
  const result = spawnSync(process.execPath, [CHECKER, '--check'], { encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `${result.stderr.trim() || result.stdout.trim() || `check exited ${result.status}`}`,
  )
})
