/**
 * Test-hygiene guard: a test that drives the production entry must not write
 * the operator's own state root.
 *
 * `apply()` is the production wiring — it installs the real on-disk ledger and
 * points the catalog status, the sing-box dir and the sidecar configs at the
 * plugin's state root (`~/.dsh/opencode-zen2dsh`). A test file that calls it and then
 * streams a request therefore accounts that request in the USER's own 流量统计:
 * the bug of 2026-10-14, which surfaced as a phantom 「hi」 session with 36
 * requests and 0 tokens (test/watchdog-config.test.ts streams a real sample
 * request through `apply()`, once per scenario, on every run).
 *
 * Redirecting `OPENCODE_ZEN_HOME` is the fix (src/paths.ts). This guard turns
 * the redirect from a habit into a rule: every file that imports the entry at
 * runtime must set it, so the next production-entry test cannot silently
 * re-open the hole. A type-only import cannot install anything and is exempt.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** A runtime (non-`import type`) import of the plugin entry. */
const ENTRY_IMPORT = /(^|\n)import (?!type )[^\n]*from '\.\.\/src\/index\.ts'/

test('every test that drives the production entry redirects the state root', () => {
  const checked: string[] = []
  const offenders: string[] = []
  for (const file of readdirSync(here).filter((name) => name.endsWith('.test.ts'))) {
    const source = readFileSync(join(here, file), 'utf8')
    if (!ENTRY_IMPORT.test(source)) continue
    checked.push(file)
    if (!source.includes('OPENCODE_ZEN_HOME')) offenders.push(file)
  }
  // Sanity: if this ever finds nothing, the scan stopped matching reality and
  // the guard would pass vacuously — the exact failure mode it exists to stop.
  assert.ok(checked.length >= 2, `no production-entry tests matched (looked for a runtime import of ../src/index.ts) — got ${JSON.stringify(checked)}`)
  assert.deepEqual(offenders, [], 'these files call apply() without redirecting OPENCODE_ZEN_HOME (src/paths.ts), so a test run would write the user\'s own ledger')
})
