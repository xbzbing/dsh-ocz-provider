import type { TokenTotalsView } from './IpPoolCard.tsx'

/**
 * Shared token-display formatting for the IP-pool client surfaces (the footer
 * entry, the exit-stats modal, the usage panel). These three helpers were
 * duplicated verbatim across ExitStatsEntry.tsx and UsagePanel.tsx; they read
 * the same bridge-shaped `TokenTotalsView` and must stay in lockstep so the
 * footer, modal and panel never disagree about the same number.
 */

/** The all-in token figure the UI shows (input + output + cache read/write). */
export function grandTotal(tokens: TokenTotalsView): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
}

/** Compact token label: 1_234_567 → 1.2M, 856 → 856. */
export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * Output speed in tok/s: output tokens over the recorded decode window.
 * A bucket with no timed response (nothing ever streamed, or a host from
 * before the field existed) reads 0 and the caller hides the note.
 */
export function outputSpeed(tokens: TokenTotalsView): number {
  const ms = tokens.outputMs ?? 0
  if (ms <= 0 || tokens.outputTokens <= 0) return 0
  return Math.round((tokens.outputTokens * 1000) / ms)
}
