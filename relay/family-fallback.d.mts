/**
 * Types for relay/family-fallback.mjs — the module is plain JS because the relay
 * child runs it in bun without a build step, and the test suite imports it
 * directly to pin the two decisions it makes.
 */

/** The families a direct egress directive can carry. */
export type DirectFamily = '4' | '6' | 'prefer6'

/** How long a quota refusal keeps steering new requests to the other family. */
export declare const FAMILY_REFUSAL_TTL_MS: number

/** The family to try when `family` answered a quota refusal, or null. */
export declare function alternateFamily(family: DirectFamily | undefined): DirectFamily | null

/** What to actually dial for a requested family, given recent refusals. */
export declare function familyFor(family: DirectFamily, refusals: Map<'4' | '6', number>, now: number): DirectFamily

/** Record that `family` answered a quota refusal, until `ttlMs` from `now`. */
export declare function noteFamilyRefusal(refusals: Map<'4' | '6', number>, family: DirectFamily, now: number, ttlMs?: number): void

/** Drop entries that have expired. */
export declare function pruneRefusals(refusals: Map<'4' | '6', number>, now: number): void
