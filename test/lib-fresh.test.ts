/**
 * Guards the committed build output.
 *
 * `lib/` ships in git so `dsh plugin add file:<repo>` and
 * `dsh plugin add github:<owner>/<repo>` install working code — neither path
 * runs a lifecycle script, so nothing else would ever build it. The price of
 * that is that a source edit committed without a rebuild silently installs
 * stale code for every later user; this test is what makes that impossible to
 * merge.
 *
 * The comparison itself lives in scripts/lib-manifest.mjs (shared with the
 * build), so the stamp and the check can never drift apart.
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
