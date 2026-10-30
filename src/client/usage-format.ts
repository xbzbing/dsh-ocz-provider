import type { TokenTotalsView } from './types.ts'

/**
 * Shared token-display formatting for the IP-pool client surfaces (the footer
 * entry, the exit-stats modal, the usage panel). The helpers read the same
 * bridge-shaped `TokenTotalsView` and must stay in lockstep so the footer,
 * modal and panel never disagree about the same number.
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

// tok/s is deliberately NOT computed here: the display number is the host-side
// recent 3-min window (pool/usage.ts speed fields), and the client only renders
// what /status computed.
