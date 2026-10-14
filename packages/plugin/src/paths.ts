import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The plugin's on-disk state root — `~/.opencode2dsh` unless overridden.
 *
 * Everything the plugin persists outside the host lives under here: the usage
 * ledger (`usage.json`), the catalog status (`adapter-status.json`), the
 * sing-box runtime dir, and the sidecar's config paths. `OPENCODE2DSH_HOME`
 * redirects the whole root, which is what a test that drives the REAL entry
 * (`apply()`) needs: the production wiring installs the production ledger, so
 * without a redirect a test run writes the user's own 流量统计 (live bug
 * 2026-10-14: the watchdog scenarios stream a sample request through
 * `apply()`, and every `pnpm test` added a row to the user's ledger — 36
 * phantom "hi" requests by the time it was spotted).
 *
 * Mirrors `adapter/messages.ts`'s `DSH_HOME` handling: read the env lazily, so
 * a caller that sets it after import (tests) still gets the redirect.
 */
export function stateDir(): string {
  const configured = process.env.OPENCODE2DSH_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.opencode2dsh')
}
