import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The plugin's on-disk state root — `~/.dsh/oc2dsh` unless `OC2DSH_HOME`
 * redirects it. It lives INSIDE the host's own `~/.dsh` root so one tree holds
 * everything this install persists and a profile backup/removal takes the
 * plugin's state with it: the usage ledger (`usage.json`), the catalog status
 * (`adapter-status.json`), the models.dev catalog cache and the sing-box
 * runtime dir. Read the env LAZILY, so a caller that sets it after import (a
 * test driving the real `apply()`) still gets the redirect instead of writing
 * the user's own ledger.
 *
 * Mirrors `adapter/messages.ts`'s `DSH_HOME` handling.
 */
export function stateDir(): string {
  const configured = process.env.OC2DSH_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.dsh', 'oc2dsh')
}
