/**
 * Reasoning-effort vocabulary: the picker ladder resolveModel advertises, its
 * chat wire spelling (`reasoning_effort`) and the Responses `reasoning.effort`
 * normalization.
 */

import type { HarnessGenerateOptions } from './messages.ts'

/**
 * Reasoning-effort vocabulary the adapter owns end to end (dsh-llm treats the
 * ids as opaque: whatever resolveModel advertises comes back on
 * GenerateOptions.reasoningEffort). The ladder mirrors pi-ai's ThinkingLevel
 * so selected levels pass through untouched; `off` is the only id that maps
 * to a different wire spelling.
 */
export const REASONING_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** The ladder as plain strings, for membership tests on untrusted ids. */
export const EFFORT_LEVELS: readonly string[] = REASONING_EFFORT_LADDER

/** The effort the host selected: `reasoningEffort`, else the older `reasoning` field. */
export function selectedEffort(options: HarnessGenerateOptions): string | undefined {
  if (typeof options.reasoningEffort === 'string') return options.reasoningEffort
  return typeof options.reasoning === 'string' ? options.reasoning : undefined
}

/** Levels offered for reasoning models whose metadata declares no ladder. */
const DEFAULT_EFFORT_LADDER: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high']

/** Selectable reasoning effort as dsh-llm's resolveModel contract describes it. */
export interface ZenReasoningEffort {
  id: string
  name: string
  description?: string
}

/**
 * Turn the catalog's models.dev capability into the advertised effort list.
 * A declared ladder (models.dev `reasoning_options` effort values) wins — its
 * values are the upstream-honored spellings, with metadata `none` folded into
 * our `off`. Without a declaration, a reasoning model gets the standard
 * ladder the Zen gateway accepts for every model. Non-reasoning models
 * advertise nothing (the picker then offers only the provider default).
 */
export function reasoningEfforts(capability: { reasoning: boolean; effortValues: string[] } | undefined): ZenReasoningEffort[] | undefined {
  if (!capability?.reasoning) return undefined
  const declared: string[] = []
  for (const value of capability.effortValues) {
    const level = value === 'none' ? 'off' : value
    if (EFFORT_LEVELS.includes(level) && !declared.includes(level)) declared.push(level)
  }
  const levels = declared.length > 0
    ? declared.sort((a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b))
    : DEFAULT_EFFORT_LADDER
  return levels.map((level) => ({ id: level, name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` }))
}

/**
 * The `reasoning_effort` wire value for a selected effort id. The Zen gateway
 * validates the field against `minimal|low|medium|high|xhigh|max|none`
 * (any other value is a hard 400), and `none` is the
 * only spelling that stops the always-think free models from thinking — a
 * mere omission keeps the provider default. So `off` maps to wire `none`,
 * ladder levels pass through verbatim, and unknown ids (never advertised)
 * inject nothing rather than risk the 400.
 */
export function reasoningEffortWire(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  if (id === 'off') return 'none'
  return EFFORT_LEVELS.includes(id) ? id : undefined
}

export function normalizeResponsesEffort(value: string | undefined): string | undefined {
  if (!value || value === 'off' || value === 'none') return undefined
  return EFFORT_LEVELS.includes(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize pi-ai's mixed reasoning shapes before a Responses request. */
export function normalizeResponsesPayload(payload: unknown, requestedEffort?: string): unknown | undefined {
  if (!isRecord(payload)) return undefined

  const next = { ...payload }
  const legacyEffort = typeof next.reasoning_effort === 'string' ? next.reasoning_effort : undefined
  delete next.reasoning_effort

  const reasoning = isRecord(next.reasoning) ? { ...next.reasoning } : {}
  const existingEffort = normalizeResponsesEffort(typeof reasoning.effort === 'string' ? reasoning.effort : undefined)
  const effort = normalizeResponsesEffort(requestedEffort) ?? existingEffort ?? normalizeResponsesEffort(legacyEffort)
  if (effort) reasoning.effort = effort
  else delete reasoning.effort

  if (Object.keys(reasoning).length > 0) next.reasoning = reasoning
  else delete next.reasoning
  return next
}
