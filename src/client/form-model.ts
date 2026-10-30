/**
 * The settings card's pure form model: defaults, the served section, the
 * draft <-> served mapping, validation, and the per-field rule that lets a
 * pristine draft follow writes made elsewhere (the stats modal, another tab)
 * while a dirty field that changed underneath is flagged as a conflict.
 * No React, no DOM: test/client-form-model.test.ts drives it directly.
 */
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { isManualProxyEntry } from '../proxy-entry.ts'
import { fieldWrite, type FieldWrite } from './settings-writes.ts'
import type { IpPoolSettingsValue, LocalIpFamilyView, UsageScopeView } from './types.ts'

/**
 * Host schema defaults, spelled as literals: the browser bundle never imports
 * a Host module (DEFAULT_SUBSCRIPTION_USER_AGENT in src/pool/subscription.ts
 * would drag the YAML parser in).
 */
export const DEFAULTS: IpPoolSettingsValue = {
  enabled: false,
  probeModels: [],
  probeContents: [],
  maxConcurrentProbes: 3,
  poolSize: 10,
  manual: [],
  subscription: { urls: [], refreshMs: 30 * 60_000, userAgent: 'clash-verge/v2.4.2' },
  singbox: { path: 'sing-box' },
  pinnedExitId: '',
  pinnedStrict: false,
  proxyHosts: [],
  // Off: a pool miss fails rather than egressing from this machine.
  localFallback: false,
  // Prefer IPv6 when this machine has a routable one.
  localIpFamily: 'auto',
  usageScope: 'total',
}

/** Draft form state (strings for inputs; arrays kept as string lists). */
export interface FormState {
  enabled: boolean
  manual: string[]
  subscriptionUrls: string[]
  refreshMs: string
  userAgent: string
  singboxPath: string
  pinnedExitId: string
  pinnedStrict: boolean
  localFallback: boolean
  localIpFamily: LocalIpFamilyView
  probeModels: string[]
  probeContents: string[]
  maxConcurrentProbes: string
  poolSize: string
  usageScope: UsageScopeView
}

export type FormField = keyof FormState

/** The collapsible group ids, in display order. */
export type GroupId = 'sources' | 'scheduling' | 'probe' | 'usage' | 'headers' | 'models' | 'exits'

/** Which group shows each field; null = a top-level row outside every group. */
export const FIELD_GROUP: Record<FormField, GroupId | null> = {
  enabled: null,
  localFallback: null,
  localIpFamily: null,
  manual: 'sources',
  subscriptionUrls: 'sources',
  refreshMs: 'sources',
  userAgent: 'sources',
  singboxPath: 'sources',
  pinnedExitId: 'scheduling',
  pinnedStrict: 'scheduling',
  probeModels: 'probe',
  probeContents: 'probe',
  maxConcurrentProbes: 'probe',
  poolSize: 'probe',
  usageScope: 'usage',
}

const FIELDS = Object.keys(FIELD_GROUP) as FormField[]

export function emptyForm(): FormState {
  return formFromValue(DEFAULTS)
}

export function formFromValue(value: IpPoolSettingsValue): FormState {
  return {
    enabled: value.enabled,
    manual: [...value.manual],
    subscriptionUrls: [...value.subscription.urls],
    refreshMs: String(value.subscription.refreshMs),
    userAgent: value.subscription.userAgent,
    singboxPath: value.singbox.path,
    pinnedExitId: value.pinnedExitId,
    pinnedStrict: value.pinnedStrict,
    localFallback: value.localFallback === true,
    localIpFamily: value.localIpFamily === 'ipv4' || value.localIpFamily === 'ipv6' ? value.localIpFamily : 'auto',
    probeModels: [...value.probeModels],
    probeContents: [...(value.probeContents ?? [])],
    maxConcurrentProbes: String(value.maxConcurrentProbes),
    poolSize: String(value.poolSize ?? DEFAULTS.poolSize),
    usageScope: value.usageScope === 'run' ? 'run' : 'total',
  }
}

/** The served entry's value: the `ipPool` volatile node is the whole form. */
export interface ServedEntry {
  ipPool?: Partial<IpPoolSettingsValue>
}

type Snapshot = ConfigFormSnapshot<Record<string, unknown>> | undefined

/**
 * The ip-pool section of the served value, with defaults filled. A missing
 * section reads as the documented defaults so the form still renders.
 */
export function servedSection(state: Snapshot): IpPoolSettingsValue {
  const served = (state?.value as ServedEntry | undefined)?.ipPool
  // The legacy flat `subscriptions` key always serves an implicit `[]`; it may
  // only stand in when the canonical nested list is empty.
  const nestedUrls = served?.subscription?.urls ?? []
  const legacyUrls = served?.subscriptions ?? []
  return {
    ...DEFAULTS, ...served,
    subscription: { ...DEFAULTS.subscription, ...served?.subscription, ...(nestedUrls.length > 0 ? {} : { urls: legacyUrls }) },
    singbox: { ...DEFAULTS.singbox, ...served?.singbox },
  }
}

/** The composition-side (base) ip-pool section, for the values a reset returns to. */
export function servedBase(state: Snapshot): Partial<IpPoolSettingsValue> {
  return servedSection({ ...state, value: state?.base } as ConfigFormSnapshot<Record<string, unknown>>)
}

/** An empty UA field means the default, so clearing it is not a pending change. */
export function normalizedUserAgent(value: string): string {
  const trimmed = value.trim()
  return trimmed === '' ? DEFAULTS.subscription.userAgent : trimmed
}

/** Field writes landing the form on the resolved value, in write order. */
export function diffWrites(form: FormState, value: IpPoolSettingsValue, base: Partial<IpPoolSettingsValue>): FieldWrite[] {
  const writes: FieldWrite[] = []
  const push = (field: string, next: unknown, current: unknown, baseValue: unknown): void => {
    const edit = fieldWrite(field, next, current, baseValue)
    if (edit !== undefined) writes.push(edit)
  }
  push('enabled', form.enabled, value.enabled, base.enabled)
  push('manual', form.manual, value.manual, base.manual)
  push('subscription', { urls: form.subscriptionUrls, refreshMs: Number(form.refreshMs), userAgent: normalizedUserAgent(form.userAgent) }, value.subscription, base.subscription)
  push('singbox', { path: form.singboxPath }, value.singbox, base.singbox)
  push('pinnedExitId', form.pinnedExitId, value.pinnedExitId, base.pinnedExitId)
  push('pinnedStrict', form.pinnedStrict, value.pinnedStrict, base.pinnedStrict)
  push('localFallback', form.localFallback, value.localFallback, base.localFallback)
  push('localIpFamily', form.localIpFamily, value.localIpFamily, base.localIpFamily)
  push('probeModels', form.probeModels, value.probeModels, base.probeModels)
  push('probeContents', form.probeContents, value.probeContents, base.probeContents)
  push('maxConcurrentProbes', Number(form.maxConcurrentProbes), value.maxConcurrentProbes, base.maxConcurrentProbes)
  push('poolSize', Number(form.poolSize), value.poolSize, base.poolSize)
  push('usageScope', form.usageScope, value.usageScope, base.usageScope)
  return writes
}

/** Why a draft cannot be saved; the reason is a locale key. */
export interface FormValidationFailure {
  reason: 'invalidRange' | 'invalidProxy' | 'invalidUrl' | 'invalidModel'
  group: GroupId
}

const isInteger = (text: string): boolean => /^\d+$/.test(text.trim())

/** The first draft problem, or null when the draft can be saved. */
export function validateForm(form: FormState): FormValidationFailure | null {
  const conc = Number(form.maxConcurrentProbes)
  if (!isInteger(form.maxConcurrentProbes) || conc < 1 || conc > 8) return { reason: 'invalidRange', group: 'probe' }
  const poolSize = Number(form.poolSize)
  if (!isInteger(form.poolSize) || poolSize < 1 || poolSize > 100) return { reason: 'invalidRange', group: 'probe' }
  const refresh = Number(form.refreshMs)
  if (!isInteger(form.refreshMs) || refresh < 60_000) return { reason: 'invalidRange', group: 'sources' }
  // The server's own parser decides, so a stored entry the pool accepts never blocks a save.
  if (!form.manual.every(isManualProxyEntry)) return { reason: 'invalidProxy', group: 'sources' }
  if (!form.subscriptionUrls.every((url) => /^https?:\/\/.+/.test(url))) return { reason: 'invalidUrl', group: 'sources' }
  if (form.probeModels.some((model) => model.trim() === '')) return { reason: 'invalidModel', group: 'probe' }
  return null
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The pool draft plus what it was last reconciled against. `accepted` is the
 * served form the draft last followed; `conflicts` lists dirty fields whose
 * served value changed underneath them.
 */
export interface PoolDraft {
  draft: FormState
  accepted: FormState
  conflicts: readonly FormField[]
}

/** A pristine draft of the served form (initial load, 丢弃). */
export function pristineDraft(served: FormState): PoolDraft {
  return { draft: served, accepted: served, conflicts: [] }
}

/**
 * Reconcile the draft with a new served form, field by field: a pristine
 * field (draft = last accepted) or one already equal to the new value follows
 * it; a dirty field whose served value moved is recorded as a conflict and
 * keeps the operator's edit, so a later save can never silently revert it.
 */
export function followServed(current: PoolDraft, served: FormState): PoolDraft {
  if (same(current.accepted, served)) return current
  const draft = { ...current.draft }
  const conflicts = new Set(current.conflicts)
  for (const field of FIELDS) {
    const mine = current.draft[field]
    if (same(mine, current.accepted[field]) || same(mine, served[field])) {
      (draft as Record<FormField, unknown>)[field] = served[field]
      conflicts.delete(field)
    } else if (!same(served[field], current.accepted[field])) {
      conflicts.add(field)
    }
  }
  return { draft, accepted: served, conflicts: [...conflicts] }
}

/** Conflicts still standing: a field edited back to the served value is resolved. */
export function liveConflicts(pool: PoolDraft): FormField[] {
  return pool.conflicts.filter((field) => !same(pool.draft[field], pool.accepted[field]))
}

/**
 * Subscription URLs never render in full: the settings document is the only
 * place they exist in plaintext. Only scheme and host survive; any path,
 * query or credentials (where tokens live) collapse to an ellipsis.
 */
export function redactUrl(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#@]*@)?([^/?#]*)(.*)$/i.exec(url.trim())
  if (match === null) return '…'
  const [, scheme, host, rest] = match
  return `${scheme}${host}${rest !== '' && rest !== '/' ? '/…' : ''}`
}
