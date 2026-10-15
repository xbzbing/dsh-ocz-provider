/**
 * IP 池 page body: the editable form on the Plugins page. Two mounting eras
 * share one card: the DSH 0.2 `plugins.bundle.config` slot embeds it directly
 * on the bundle's detail page (设置 → 插件 → oc2dsh), and the
 * pre-0.2 `plugins.item` slot lists it as an official-plugin page. Either
 * way, configuration rides the settings provider's own ConfigForm (a
 * `ConfigFormSnapshot` plus `mutate`), so dsh-llm-proxy's loopback fallback
 * compat layer is deliberately absent (docs/ip-pool.md §5, 2026-09-05
 * revision). Runtime state and probe actions ride the plugin's own bridge
 * (/status, /models, /probe). Every setting applies live on save — no
 * restart (docs/ip-pool.md §5).
 *
 * Pool edits use `['ipPool', <field>]`; Zen header overrides use the separate
 * `['requestHeaders']` volatile dictionary. Both share one revision and save.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  DisclosureRow,
  IconChevronDownOutlineRegular,
  IconCloseFillMedium,
  Input,
  SegmentedControl,
  SettingsForm,
  StateDot,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.bundle.config'
// keyed entry, whose owner embeds this form on the bundle's detail page, and
// the legacy 'plugins.item' list entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the settings provider's `ConfigFormSnapshot`/`ConfigForm`, the
// faces this page reads and writes through.
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { en } from './locales.ts'
import styles from './ip-pool.module.css'
import { PinIcon, RotateIcon } from './icons.tsx'
import { fieldWrite, poolWriteOps, requestHeadersWriteOps, type FieldWrite } from './settings-writes.ts'
import { formatRequestHeaders, normalizeRequestHeaders, parseRequestHeaders } from '../request-headers.ts'
import { RequestHeadersEditor } from './RequestHeadersEditor.tsx'

/** The reactive values and commands this page reads and writes through. */
export interface ConfigPageForm {
  /** Accepted Host values, refreshed by the provider. */
  readonly state: ConfigFormSnapshot<Record<string, unknown>>
  /** Submit field edits together with the revision the editor read. */
  mutate(ops: readonly ConfigPathOp[], expectedRevision?: number): Promise<boolean>
}

/** One settings write, as the Host's path-op vocabulary spells it. */
export type ConfigPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Locale-bound copy for the `settings.ip-pool` namespace. */
export type IpPoolCardLocale = PropsLocale<'settings.ip-pool'>['t']

/**
 * The card's own contract: the view the owner asked for, the bound locale,
 * and — for `view: 'page'` — the settings form. Both mounting eras hand the
 * card a superset of this.
 */
export interface IpPoolCardOwnProps {
  readonly view: 'summary' | 'page'
  readonly t: IpPoolCardLocale
  readonly form?: ConfigPageForm
}

/**
 * Props the legacy `plugins.item` slot binds for the IP 池 page: the view it
 * asked for, the locale copy, and — for `view: 'page'` — the entry's settings
 * form.
 */
export type IpPoolCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.ip-pool'>

/** Copy of the form chrome (the shared SettingsForm labels). */
const formLabels = (t: IpPoolCardProps['t']): {
  unavailable: string
  readOnly: string
  saveFailed: string
  save: string
  saving: string
} => ({
  unavailable: t('statusUnavailable'),
  readOnly: t('readOnly'),
  saveFailed: t('saveError'),
  save: t('save'),
  saving: t('saving'),
})

/** The resolved ip-pool settings value (mirrors the schemastery schema). */
export interface IpPoolSettingsValue {
  enabled: boolean
  probeModels: string[]
  /** Probe-content pool; empty = the Host default ('hello'). */
  probeContents: string[]
  maxConcurrentProbes: number
  /** Whole-pool capacity: exits kept online at once (default 20). */
  poolSize: number
  manual: string[]
  subscription: { urls: string[]; refreshMs: number; userAgent: string }
  /** Previous composition spelling, migrated on a subscription edit. */
  subscriptions?: string[]
  singbox: { path: string }
  pinnedExitId: string
  pinnedStrict: boolean
  proxyHosts: string[]
  /** 'total' = the persisted ledger, 'run' = this host process. */
  usageScope: UsageScopeView
}

/** The two usage scopes the UI switches between. */
export type UsageScopeView = 'total' | 'run'

/** Bridge /status view (mirrors src/ip-pool-settings/bridge.ts). */
export interface PoolStatusView {
  zenUserAgent?: string
  enabled: boolean
  deferredReason: string
  state: 'healthy' | 'warning' | 'critical' | 'emergency'
  /** Which population produced `state`: the free-source machine while that
   *  source is on, the whole pool once it is off. */
  stateBasis: 'free' | 'pool'
  total: number
  bySource: Record<'free' | 'manual' | 'subscription' | 'goproxy', number>
  availableFree: number
  /** Usable exits across the whole pool, any source. */
  availableTotal: number
  targetSize: number
  /** Whole-pool capacity in force (settings `poolSize`, default 20). */
  poolSize: number
  /** The pin in force. `local` marks the 本机 sentinel (no exit at all);
   *  optional so a bundle can still read a host snapshot from before the
   *  field existed. */
  pinned: { id: string; strict: boolean; local?: boolean } | null
  proxyHosts: string[]
  exits: Array<{
    id: string
    source: string
    protocol: string
    pinned: boolean
    exitIP: string
    exitLocation: string
    latencyMs: number
    quality: string
    state: 'unknown' | 'ok' | 'dead'
    cooling: boolean
    cooldownUntil: number
    consecutiveLimited: number
    bannedModels: Array<{ model: string; state: 'suspect' | 'banned'; bannedAt: number }>
    passive: { ok: number; limited: number; refused: number; dead: number; transport: number }
    /** Sum of the passive buckets — the stats modal's sort key. */
    requests: number
    /** Epoch ms of the most recent dispatch (0 = never). */
    lastUsedAt: number
    inFlight: number
    /** Rejected by the upstream lane with no reserve left: kept as the last
     *  resort and listed last. Optional so an older host snapshot still parses. */
    demoted?: boolean
    tokens: TokenTotalsView
  }>
  prober: { queued: number; inFlight: number; enqueued: number; completed: number }
  subscription: { urlCount: number; pendingConversion: number; convertedAdmitted: number; plaintextAdmitted: number; lastFetch: number; lastError: string } | null
  /** Pool-host requests that fell back to direct, with their tokens. */
  direct: { requests: number; tokens: TokenTotalsView }
  /** Model traffic that egressed from this machine (non-pool hosts plus the
   *  direct fallbacks): the modal's 本机 row. Optional so a client bundle can
   *  talk to a host snapshot from before this field existed. */
  local?: { requests: number; tokens: TokenTotalsView; lastUsedAt: number }
  /** The persistent usage ledger (absent on a host from before it existed). */
  usage?: UsageView | null
  at: number
}

/**
 * The persistent usage ledger as /status serves it (mirrors
 * src/ip-pool-settings/bridge.ts UsageView). Optional on the view so a bundle
 * can still read a host snapshot from before the ledger existed.
 */
export interface UsageView {
  scope: UsageScopeView
  retentionDays: number
  /** When this process started (the run scope's origin). */
  runSince: number
  /** All-time persisted totals — the footer's 总览 figure. */
  total: TokenTotalsView
  /** Totals for the scope being shown. */
  scoped: TokenTotalsView
  days: Array<{ day: string; requests: number; tokens: number; outputTokens: number; outputMs: number }>
  sessions: Array<{
    id: string
    label: string
    requests: number
    tokens: number
    outputTokens: number
    outputMs: number
    firstAt: number
    lastAt: number
    project: { id: string; title: string; path: string } | null
  }>
  projects: Array<{ id: string; title: string; path: string; requests: number; tokens: number; sessions: number; lastAt: number }>
  stored: { sessions: number; days: number; exits: number }
}

/** Per-exit token totals (mirrors src/pool/usage.ts TokenTotals). */
export interface TokenTotalsView {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** Cumulative decode window (ms); the tok/s denominator. Hosts from
   *  before this field existed serve the view without it. */
  outputMs?: number
}

/** The bridge prefix (same-origin, loopback-only on the host). */
export const BRIDGE_PREFIX = '/api/oc2dsh/ip-pool'

/**
 * The field inside the served entry that holds the editable section: the
 * `ipPool` volatile node in the plugin's Config schema. Every write path is
 * `['ipPool', <field>]`, because the Host's volatile form keeps the node's
 * field name in front of the fields it makes editable.
 */
const IP_POOL_FIELD = 'ipPool'

const DEFAULTS: IpPoolSettingsValue = {
  enabled: false,
  probeModels: [],
  // Literal by policy: the browser bundle never imports a Host module, so every
  // default here is spelled out (DEFAULT_SMOKE_CONTENT in src/pool/smoke-content.ts).
  probeContents: [],
  maxConcurrentProbes: 3,
  poolSize: 10,
  manual: [],
  // Mirrors the Host schema default (docs §5.1, DEFAULT_SUBSCRIPTION_USER_AGENT
  // in src/pool/subscription.ts). Spelled as a literal here on purpose: the
  // browser bundle must not import a Host module (it would drag the YAML
  // parser in), which is why every default on this line is already a literal.
  subscription: { urls: [], refreshMs: 30 * 60_000, userAgent: 'clash-verge/v2.4.2' },
  singbox: { path: 'sing-box' },
  pinnedExitId: '',
  pinnedStrict: false,
  proxyHosts: [],
  usageScope: 'total',
}

/** Compact all-in token label for the usage chips (input+output+cache). */
function usageTokens(tokens: TokenTotalsView): string {
  const value = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** Output speed over a cumulative decode window (0 = nothing timed). */
function usageSpeed(tokens: TokenTotalsView): number {
  const ms = tokens.outputMs ?? 0
  if (ms <= 0 || tokens.outputTokens <= 0) return 0
  return Math.round((tokens.outputTokens * 1000) / ms)
}

/** Subscription URLs never render in full — the settings doc is the only
 *  place they exist in plaintext (docs §5.1 redaction boundary). */
function redactUrl(url: string): string {
  if (url.length <= 24) return url
  return url.slice(0, 12) + '…' + url.slice(-6)
}

/** Draft form state (strings for inputs; arrays kept as string lists). */
interface FormState {
  enabled: boolean
  manual: string[]
  subscriptionUrls: string[]
  refreshMs: string
  userAgent: string
  singboxPath: string
  pinnedExitId: string
  pinnedStrict: boolean
  probeModels: string[]
  probeContents: string[]
  maxConcurrentProbes: string
  poolSize: string
  usageScope: UsageScopeView
}

function emptyForm(): FormState {
  return {
    enabled: DEFAULTS.enabled,
    manual: [],
    subscriptionUrls: [],
    refreshMs: String(DEFAULTS.subscription.refreshMs),
    userAgent: DEFAULTS.subscription.userAgent,
    singboxPath: DEFAULTS.singbox.path,
    pinnedExitId: '',
    pinnedStrict: DEFAULTS.pinnedStrict,
    probeModels: [],
    probeContents: [],
    maxConcurrentProbes: String(DEFAULTS.maxConcurrentProbes),
    poolSize: String(DEFAULTS.poolSize),
    usageScope: DEFAULTS.usageScope,
  }
}

function formFromValue(value: IpPoolSettingsValue): FormState {
  return {
    enabled: value.enabled,
    manual: [...value.manual],
    subscriptionUrls: [...value.subscription.urls],
    refreshMs: String(value.subscription.refreshMs),
    userAgent: value.subscription.userAgent,
    singboxPath: value.singbox.path,
    pinnedExitId: value.pinnedExitId,
    pinnedStrict: value.pinnedStrict,
    probeModels: [...value.probeModels],
    probeContents: [...(value.probeContents ?? [])],
    maxConcurrentProbes: String(value.maxConcurrentProbes),
    poolSize: String(value.poolSize ?? DEFAULTS.poolSize),
    usageScope: value.usageScope === 'run' ? 'run' : 'total',
  }
}

/** The served entry's value: the `ipPool` volatile node is the whole form. */
interface ServedEntry {
  ipPool?: Partial<IpPoolSettingsValue>
}

/** Field writes landing the form on the resolved value, in write order. */

/**
 * The ip-pool section of the served value, with defaults filled. A missing
 * section (an empty document, or a namespace the Host serves empty) reads as
 * the documented defaults so the form still renders.
 */
function servedSection(state: ConfigFormSnapshot<Record<string, unknown>> | undefined): IpPoolSettingsValue {
  const served = (state?.value as ServedEntry | undefined)?.ipPool
  // The Host's `Schema.array()` gives the legacy flat key an implicit `[]`, so
  // it is ALWAYS present in a served value; letting it win would render an
  // empty subscription list even right after a successful save. It may only
  // stand in when the canonical nested list carries nothing.
  const nestedUrls = served?.subscription?.urls ?? []
  const legacyUrls = served?.subscriptions ?? []
  return {
    ...DEFAULTS, ...served,
    subscription: { ...DEFAULTS.subscription, ...served?.subscription, ...(nestedUrls.length > 0 ? {} : { urls: legacyUrls }) },
    singbox: { ...DEFAULTS.singbox, ...served?.singbox },
  }
}

/** The composition-side (base) ip-pool section, for the values a reset returns to. */
function servedBase(state: ConfigFormSnapshot<Record<string, unknown>> | undefined): Partial<IpPoolSettingsValue> {
  return servedSection({ ...state, value: state?.base } as ConfigFormSnapshot<Record<string, unknown>>)
}

function diffWrites(form: FormState, value: IpPoolSettingsValue, base: Partial<IpPoolSettingsValue>): FieldWrite[] {
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
  push('probeModels', form.probeModels, value.probeModels, base.probeModels)
  push('probeContents', form.probeContents, value.probeContents, base.probeContents)
  push('maxConcurrentProbes', Number(form.maxConcurrentProbes), value.maxConcurrentProbes, base.maxConcurrentProbes)
  push('poolSize', Number(form.poolSize), value.poolSize, base.poolSize)
  push('usageScope', form.usageScope, value.usageScope, base.usageScope)
  return writes
}

/** Clearing the UA field restores the default instead of writing an empty
 *  header — the Host schema and the runtime both treat empty as "default",
 *  and this keeps a cleared field from looking like a pending change. */
function normalizedUserAgent(value: string): string {
  const trimmed = value.trim()
  return trimmed === '' ? DEFAULTS.subscription.userAgent : trimmed
}

/** One labeled input (the Input primitive carries the box chrome). */
function TextField(props: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  testId?: string
  type?: 'text' | 'number'
  min?: number
  max?: number
  step?: number
  invalid?: boolean
  disabled?: boolean
  /** A trailing action on the label line (立即刷新 / 解除固定); falsy = none. */
  action?: ReactNode
}): ReactNode {
  const { label, hint, value, onChange, placeholder, testId, type = 'text', min, max, step, invalid, disabled, action } = props
  return (
    <label className={styles.field}>
      {action == null
        ? <span className={styles.fieldLabel}>{label}</span>
        : (
          <span className={styles.fieldHead}>
            <span className={styles.fieldLabel}>{label}</span>
            <span className={styles.fieldHeadAction}>{action}</span>
          </span>
        )}
      <Input
        className={invalid === true ? `${styles.fieldControl} ${styles.inputWrapInvalid}` : styles.fieldControl}
        type={type}
        value={value}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint !== undefined && <span className={styles.fieldHint}>{hint}</span>}
    </label>
  )
}

/**
 * One editable string list (manual proxies / subscription URLs / probe
 * contents). Items are one-per-line capsule rows with a remove button; the
 * add row is an Input + 添加 Button (Enter also adds). A duplicate add is
 * refused with an inline note; a fresh add flashes the new row so the append
 * is visible at the bottom of a long list.
 */
function ListEditor(props: {
  label?: string
  hint: string
  values: string[]
  placeholder: string
  testId: string
  redacted?: boolean
  disabled?: boolean
  t: IpPoolCardProps['t']
  onChange: (next: string[]) => void
}): ReactNode {
  const { label, hint, values, placeholder, testId, redacted, disabled, t, onChange } = props
  const [draft, setDraft] = useState('')
  const [dup, setDup] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (freshTimer.current !== null) clearTimeout(freshTimer.current) }, [])
  const add = (): void => {
    const entry = draft.trim()
    if (entry === '') return
    if (values.includes(entry)) {
      setDup(true)
      return
    }
    setDup(false)
    onChange([...values, entry])
    setDraft('')
    setFresh(entry)
    if (freshTimer.current !== null) clearTimeout(freshTimer.current)
    freshTimer.current = setTimeout(() => setFresh(null), 400)
  }
  return (
    <div className={styles.field} data-testid={testId}>
      {label !== undefined && label !== '' && <span className={styles.fieldLabel}>{label}</span>}
      <span className={styles.fieldHint}>{hint}</span>
      {values.length > 0 && (
        <ul className={styles.listItems}>
          {values.map((entry) => (
            <li key={entry} className={entry === fresh ? `${styles.listItem} ${styles.listItemNew}` : styles.listItem}>
              <span className={styles.listItemText} title={redacted ? entry : undefined}>
                {redacted ? redactUrl(entry) : entry}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled === true}
                aria-label={t('listRemove')}
                title={t('listRemove')}
                onClick={() => { setDup(false); onChange(values.filter((v) => v !== entry)) }}
              >
                <IconCloseFillMedium />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.listAddRow}>
        <Input
          className={styles.listAddInput}
          value={draft}
          placeholder={placeholder}
          disabled={disabled === true}
          onChange={(event) => { setDraft(event.target.value); if (dup) setDup(false) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }}
        />
        <Button variant="outline" size="sm" disabled={disabled === true || draft.trim() === ''} onClick={add}>
          {t('listAdd')}
        </Button>
      </div>
      {dup && <span className={styles.listDup} role="status">{t('listExists')}</span>}
    </div>
  )
}

/**
 * Probe-model picker over the bridge /models rows: selected models as
 * removable chips above a dropdown of S3-verified + live-catalog options
 * (docs §5.2 探活模型). Empty selection = the S3-first default (big-pickle).
 */
function ModelPicker(props: {
  value: string[]
  hint: string
  models: Array<{ id: string; verified: boolean }>
  loading: boolean
  disabled?: boolean
  t: IpPoolCardProps['t']
  onChange: (next: string[]) => void
}): ReactNode {
  const { value, hint, models, loading, disabled, t, onChange } = props
  const toggle = (id: string): void => {
    onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id])
  }
  const options = models.filter((row) => !value.includes(row.id))
  return (
    <div className={styles.field} data-testid="field-probeModels">
      <span className={styles.fieldLabel}>{t('probeModels')}</span>
      <span className={styles.fieldHint}>{hint}</span>
      {value.length > 0 && (
        <div className={styles.chipRow}>
          {value.map((id) => {
            const row = models.find((m) => m.id === id)
            return (
              <span key={id} className={styles.chip}>
                <span className={styles.chipText}>
                  {id}
                  {row?.verified === false && <span className={styles.chipSub}>{t('probeModelUnverified')}</span>}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled === true}
                  aria-label={t('listRemove')}
                  title={t('listRemove')}
                  onClick={() => toggle(id)}
                >
                  <IconCloseFillMedium />
                </Button>
              </span>
            )
          })}
        </div>
      )}
      <select
        className={styles.select}
        data-testid="probe-model-select"
        value=""
        disabled={disabled === true || options.length === 0}
        onChange={(event) => {
          const id = event.target.value
          if (id !== '') toggle(id)
          // native select re-shows the list while focused; value stays ''
          // so the placeholder keeps prompting for the next pick
        }}
      >
        <option value="">{loading ? t('statusLoading') : options.length === 0 ? '—' : t('probeModelPick')}</option>
        {options.map((row) => (
          <option key={row.id} value={row.id}>{row.id}{row.verified === false ? ` · ${t('probeModelUnverified')}` : ''}</option>
        ))}
      </select>
      {value.length === 0 && (
        <span className={styles.fieldHint}>{t('probeModelsDefault')}</span>
      )}
    </div>
  )
}

/** Pool overview strip: Tag status badge + counts + pinned badge. */
function OverviewBar(props: { status: PoolStatusView | null; t: IpPoolCardProps['t'] }): ReactNode {
  const { status, t } = props
  if (status === null) return null
  const stateLabel: Record<PoolStatusView['state'], string> = {
    healthy: t('poolStateHealthy'),
    warning: t('poolStateWarning'),
    critical: t('poolStateCritical'),
    emergency: t('poolStateEmergency'),
  }
  const stateTone: Record<PoolStatusView['state'], 'success' | 'warning' | 'danger'> = {
    healthy: 'success',
    warning: 'warning',
    critical: 'danger',
    emergency: 'danger',
  }
  return (
    <div className={styles.overviewBar} data-testid="ip-pool-overview">
      <Tag tone={stateTone[status.state]}>{stateLabel[status.state]}</Tag>
      {status.deferredReason !== '' && (
        <Tag tone="danger">{t('deferredNotice').replace('{reason}', status.deferredReason)}</Tag>
      )}
      {/* The headline number is the WHOLE pool's usable count (the free-source
          subset was dropped from the copy when the page stopped configuring
          free sources — d388ffa). */}
      <span>{t('poolAvailable')
        .replace('{available}', String(status.availableTotal))
        .replace('{total}', String(status.total))
        .replace('{poolSize}', String(status.poolSize ?? status.targetSize))}</span>
      <span>
        {t('poolSources')
          .replace('{manual}', String(status.bySource.manual))
          .replace('{subscription}', String(status.bySource.subscription))}
      </span>
      {status.pinned !== null && (
        <Tag tone="info">
          {/* A pin to the 本机 sentinel has no exit address to show, so the
              badge says what it does instead (2026-10-14). */}
          {status.pinned.local === true ? t('pinnedBadgeLocal') : t('pinnedBadge')}
          {status.pinned.strict && status.pinned.local !== true ? ' (' + t('pinnedStrict') + ')' : ''}
        </Tag>
      )}
    </div>
  )
}

/** The exit table + ban list. */
function ExitTable(props: { status: PoolStatusView | null; t: IpPoolCardProps['t']; onProbe: (exitId: string) => void; onPin: (exitId: string) => void; onRotate: (exitId: string) => void; busy: boolean }): ReactNode {
  const { status, t, onProbe, onPin, onRotate, busy } = props
  const [bansOpen, setBansOpen] = useState(false)
  if (status === null) return null
  const stateCell = (exit: PoolStatusView['exits'][number]): ReactNode => {
    // StateDot carries the semantic colour; the label stays as text beside it.
    if (exit.state === 'dead') return <span className={styles.stateCell}><StateDot state="error" />{t('stateDead')}</span>
    // A demoted exit is kept but ranked last (upstream refused it and no
    // reserve was left): saying so beats reading it as a healthy row.
    if (exit.demoted === true) return <span className={styles.stateCell}><StateDot state="warning" />{t('stateDemoted')}</span>
    if (exit.cooling) return <span className={styles.stateCell}><StateDot state="warning" />{t('stateCooling')}</span>
    if (exit.state === 'ok') return <span className={styles.stateCell}><StateDot state="done" />{t('stateOk')}</span>
    return <span className={styles.stateCell}><StateDot state="idle" />{t('stateUnknown')}</span>
  }
  const allBans = status.exits.flatMap((exit) =>
    exit.bannedModels.map((ban) => ({ exitId: exit.id, ...ban })),
  )
  return (
    <>
      <div className={styles.table} data-testid="ip-pool-exits">
        <table className={styles.tableGrid}>
          <thead>
            <tr>
              <th>{t('exitAddress')}</th>
              <th>{t('exitSource')}</th>
              <th>{t('exitLatency')}</th>
              <th>{t('exitQuality')}</th>
              <th>{t('exitIp')}</th>
              <th>{t('exitState')}</th>
              <th>{t('exitPassive')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.exits.map((exit) => (
              <tr key={exit.id}>
                <td className={styles.mono}>{exit.id}{exit.pinned ? ` · ${t('exitPinnedMark')}` : ''}</td>
                <td>{exit.source}</td>
                <td>{exit.latencyMs > 0 ? `${exit.latencyMs}ms` : '—'}</td>
                <td>{exit.latencyMs > 0 ? exit.quality : '—'}</td>
                {/* Location as a hover tooltip on the IP, not a column. */}
                <td className={styles.mono} title={exit.exitLocation || undefined}>{exit.exitIP || '—'}</td>
                <td>{stateCell(exit)}</td>
                <td className={styles.mono}>
                  {exit.passive.ok > 0 || exit.passive.limited > 0 || exit.passive.refused > 0 || exit.passive.dead > 0 || exit.passive.transport > 0
                    ? `✓${exit.passive.ok} 429:${exit.passive.limited} 401/403:${exit.passive.refused} ✗:${exit.passive.dead + exit.passive.transport}`
                    : '—'}
                </td>
                <td>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => onProbe(exit.id)}>{t('exitProbe')}</Button>
                  {/* Icon actions, the same pair the stats modal carries
                      (2026-10-14): 固定 (padlock) and 轮换 (circular arrow).
                      The word 删除 was wrong — nothing is deleted: a reserve
                      takes the slot, or the row sinks to the tail. */}
                  <span className={styles.actionGroup}>
                    {!exit.pinned && (
                      <button
                        type="button"
                        className={styles.rowIcon}
                        disabled={busy}
                        title={t('statsPinHint')}
                        aria-label={t('exitPin')}
                        onClick={() => onPin(exit.id)}
                      >
                        <PinIcon />
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.rowIcon}
                      disabled={busy}
                      title={t('statsRotateHint')}
                      aria-label={t('statsRotate')}
                      onClick={() => onRotate(exit.id)}
                    >
                      <RotateIcon />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {status.exits.length === 0 && (
              <tr><td colSpan={8} className={styles.status}>{t('statusUnavailable')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className={styles.section}>
        <button type="button" className={styles.collapseToggle} onClick={() => setBansOpen((open) => !open)}>
          {t(bansOpen ? 'collapse' : 'expand')} · {t('sectionBans')} ({allBans.length})
        </button>
        {bansOpen && (allBans.length === 0
          ? <span className={styles.status}>{t('bansEmpty')}</span>
          : (
            <ul className={styles.rowList}>
              {allBans.map((ban) => (
                <li key={`${ban.exitId}|${ban.model}`} className={styles.row}>
                  <span className={styles.rowLabel}>
                    <span className={ban.state === 'banned' ? styles.stateDead : styles.stateCooling}>
                      {ban.state === 'banned' ? t('banBanned') : t('banSuspect')}
                    </span>
                    {' · '}
                    <span className={styles.mono}>{ban.exitId}</span>
                    {' × '}
                    <span className={styles.mono}>{ban.model}</span>
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </>
  )
}

/** The collapsible group ids, in display order. */
type GroupId = 'sources' | 'scheduling' | 'probe' | 'usage' | 'headers' | 'exits'

/** First-visit fold state: high-frequency groups open, advanced ones folded. */
const GROUP_DEFAULTS: Record<GroupId, boolean> = {
  sources: true,
  scheduling: false,
  probe: false,
  usage: true,
  headers: false,
  exits: true,
}

/** localStorage key holding the operator's fold preferences (schema v1). */
const GROUP_STATE_KEY = 'oc2dsh:form-groups:v1'

/** Read the persisted fold map; a missing/corrupt entry falls back to defaults. */
function loadGroupState(): Record<GroupId, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_STATE_KEY)
    if (raw === null) return { ...GROUP_DEFAULTS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...GROUP_DEFAULTS }
    return { ...GROUP_DEFAULTS, ...(parsed as Partial<Record<GroupId, boolean>>) }
  } catch {
    return { ...GROUP_DEFAULTS }
  }
}

/** Validation outcome: the message plus the group that must reveal it. */
interface ValidationFailure { message: string; group: GroupId }

/**
 * One collapsible settings group: a DisclosureRow header carrying the title
 * plus a folded-state summary, and a body that stays MOUNTED while folded
 * (display:none) so half-typed list drafts and focus survive a fold.
 */
function Group(props: {
  id: GroupId
  title: string
  summary: string
  open: boolean
  highlight: boolean
  onToggle: () => void
  children: ReactNode
}): ReactNode {
  const { id, title, summary, open, highlight, onToggle, children } = props
  return (
    <section
      className={highlight ? `${styles.group} ${styles.groupHighlight}` : styles.group}
      data-group={id}
    >
      <DisclosureRow
        icon={<IconChevronDownOutlineRegular />}
        title={title}
        open={open}
        expandable
        expandOnRowClick
        onToggle={onToggle}
        collapsedContent={<span className={styles.groupSummary}>{summary}</span>}
      />
      <div className={open ? styles.groupBody : styles.groupBodyHidden}>
        {children}
      </div>
    </section>
  )
}

/** The card body. */
function CardBody(props: { settings: ConfigPageForm | undefined; t: IpPoolCardProps['t'] }): ReactNode {
  const { settings, t } = props
  const snapshot = settings?.state
  const [form, setForm] = useState<FormState>(() => emptyForm())
  const [headersText, setHeadersText] = useState('')
  const [headerConflict, setHeaderConflict] = useState(false)
  const acceptedHeadersRef = useRef('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<PoolStatusView | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [probeModelRows, setProbeModelRows] = useState<Array<{ id: string; verified: boolean }>>([])
  const [probeModelsLoading, setProbeModelsLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [groups, setGroups] = useState<Record<GroupId, boolean>>(() => loadGroupState())
  const [highlightGroup, setHighlightGroup] = useState<GroupId | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hydratedRef = useRef(false)
  const formRef = useRef(form)
  formRef.current = form

  // Persist fold preferences across sessions.
  useEffect(() => {
    try { localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(groups)) } catch { /* private mode: fold state is disposable */ }
  }, [groups])
  useEffect(() => () => { if (highlightTimer.current !== null) clearTimeout(highlightTimer.current) }, [])

  // The served section, with defaults filled.
  const served = servedSection(snapshot)
  const servedRef = useRef(served)
  servedRef.current = served

  // Hydrate the draft once from the first ready snapshot.
  useEffect(() => {
    if (snapshot?.status === 'ready' && !hydratedRef.current) {
      hydratedRef.current = true
      setForm(formFromValue(servedRef.current))
      const headers = formatRequestHeaders(normalizeRequestHeaders(snapshot.value?.requestHeaders ?? {}))
      acceptedHeadersRef.current = headers
      setHeadersText(headers)
    }
  }, [snapshot?.status, snapshot?.value])

  // Follow external header saves only while pristine. A competing save must
  // never turn an unrelated IP-pool edit into a stale header overwrite.
  useEffect(() => {
    if (snapshot?.status !== 'ready') return
    const next = formatRequestHeaders(normalizeRequestHeaders(snapshot.value?.requestHeaders ?? {}))
    let draft = headersText
    try { draft = formatRequestHeaders(parseRequestHeaders(headersText)) } catch { /* Keep invalid drafts editable. */ }
    if (headersText === acceptedHeadersRef.current || draft === next) {
      acceptedHeadersRef.current = next
      setHeadersText(next)
      setHeaderConflict(false)
    } else if (next !== acceptedHeadersRef.current) {
      setHeaderConflict(true)
    }
  }, [snapshot?.status, snapshot?.value])

  // Fetch the probe-model options from the bridge once the body shows
  // (static S3 list first; live catalog rows merge in as they warm up).
  useEffect(() => {
    let cancelled = false
    setProbeModelsLoading(true)
    fetch(`${BRIDGE_PREFIX}/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((response) => response.json() as Promise<{ ok: boolean; value?: { models: Array<{ id: string; verified: boolean }> } }>)
      .then((body) => {
        if (!cancelled && body.ok && body.value) setProbeModelRows(body.value.models)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setProbeModelsLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Poll the bridge /status: 1s while probing, 3s otherwise (docs §5.3).
  const probing = status !== null && status.prober.queued + status.prober.inFlight > 0
  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${BRIDGE_PREFIX}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const body = await response.json() as { ok: boolean; value?: PoolStatusView }
      if (body.ok && body.value) {
        setStatus(body.value)
        setStatusError(null)
      } else {
        setStatusError(t('refreshError'))
      }
    } catch {
      setStatusError(t('refreshError'))
    }
  }, [t])
  useEffect(() => {
    // Deliberately NOT gated on form.enabled: the usage ledger answers "what
    // did this machine spend", which stays true with the pool switched off
    // (every request then lands in the 本机 bucket), and the 用量统计 section
    // below needs it either way (live request 2026-10-14).
    if (snapshot?.status !== 'ready' || !hydratedRef.current) return
    void refreshStatus()
    const interval = setInterval(() => void refreshStatus(), probing ? 1_000 : 3_000)
    return () => clearInterval(interval)
  }, [snapshot?.status, probing, refreshStatus, hydratedRef.current]) // eslint-disable-line react-hooks/exhaustive-deps

  // NOTE: everything above the loading early-return is hooks; the validation
  // block below is pure computation plus one effect, so the effect rides
  // ABOVE the early-return to keep the hook order stable across renders.
  const validate = (): ValidationFailure | null => {
    const conc = Number(form.maxConcurrentProbes)
    if (!/^\d+$/.test(form.maxConcurrentProbes.trim()) || conc < 1 || conc > 8) return { message: t('invalidRange'), group: 'probe' }
    const poolSize = Number(form.poolSize)
    if (!/^\d+$/.test(form.poolSize.trim()) || poolSize < 1 || poolSize > 100) return { message: t('invalidRange'), group: 'probe' }
    const refresh = Number(form.refreshMs)
    if (!/^\d+$/.test(form.refreshMs.trim()) || refresh < 60_000) return { message: t('invalidRange'), group: 'sources' }
    for (const entry of form.manual) {
      if (!/^https?:\/\/[^\s:]+:\d{1,5}$|^socks5:\/\/[^\s:]+:\d{1,5}$|^socks5h?:\/\/\[[^\]]+\]:\d{1,5}$/.test(entry)) return { message: t('invalidProxy'), group: 'sources' }
    }
    for (const url of form.subscriptionUrls) {
      if (!/^https?:\/\/.+/.test(url)) return { message: t('invalidUrl'), group: 'sources' }
    }
    for (const model of form.probeModels) {
      if (model.trim() === '') return { message: t('invalidModel'), group: 'probe' }
    }
    return null
  }

  const writes = diffWrites(formRef.current, served, servedBase(snapshot))
  let headerOps: ConfigPathOp[] = []
  let headerFailure: ValidationFailure | null = headerConflict
    ? { message: t('requestHeadersConflict'), group: 'headers' }
    : null
  try {
    headerOps = requestHeadersWriteOps(headersText,
      normalizeRequestHeaders(snapshot?.value?.requestHeaders ?? {}),
      normalizeRequestHeaders((snapshot?.base as Record<string, unknown> | undefined)?.requestHeaders ?? {}))
  } catch { headerFailure = { message: t('requestHeadersInvalid'), group: 'headers' } }
  const validation = headerFailure ?? validate()
  const dirty = writes.length > 0 || headerOps.length > 0 || validation !== null
  const available = snapshot?.status === 'ready' && settings !== undefined
  const writable = available && snapshot.writable

  // A validation failure force-opens its group (with a brief highlight) so
  // the erroring row is never hidden inside a folded section.
  useEffect(() => {
    if (validation === null) return
    const group = validation.group
    setGroups((current) => (current[group] ? current : { ...current, [group]: true }))
    setHighlightGroup(group)
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlightGroup(null), 1200)
  }, [validation?.group, validation?.message]) // eslint-disable-line react-hooks/exhaustive-deps

  if (snapshot?.status === 'loading') {
    return <p className={styles.status}>{t('statusLoading')}</p>
  }

  /** Toggle one group's fold state. */
  const toggleGroup = (group: GroupId): void => {
    setGroups((current) => ({ ...current, [group]: !current[group] }))
  }

  const handleSave = async (): Promise<void> => {
    if (!writable || validation !== null || settings === undefined || snapshot === undefined) {
      setSaved(false)
      setError(validation?.message ?? t('saveError'))
      return
    }
    if (writes.length === 0 && headerOps.length === 0) {
      setSaved(true)
      setError(null)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const ok = await settings.mutate(
        [...headerOps, ...poolWriteOps(writes)],
        snapshot.revision,
      )
      setSaved(ok)
      setError(ok ? null : t('saveError'))
      if (ok && headerOps.length > 0) await refreshStatus()
    } catch (err) {
      setSaved(false)
      setError(err instanceof Error ? err.message : t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  /** The shared SettingsForm discard: drop the draft, keep the served values. */
  const handleDiscard = (): void => {
    setForm(formFromValue(servedRef.current))
    const headers = formatRequestHeaders(normalizeRequestHeaders(snapshot?.value?.requestHeaders ?? {}))
    acceptedHeadersRef.current = headers
    setHeadersText(headers)
    setHeaderConflict(false)
    setSaved(false)
    setError(null)
  }

  const shell: SettingsFormShell = {
    available,
    writable,
    dirty,
    invalid: validation !== null,
    saving,
    failed: error !== null,
  }

  /** One bridge action (/probe). */
  const bridgeAction = async (body: { scope: 'all' | 'subscription' } | { scope: 'exit'; exitId: string }): Promise<void> => {
    setActionBusy(true)
    try {
      await fetch(`${BRIDGE_PREFIX}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      await refreshStatus()
    } catch {
      setStatusError(t('refreshError'))
    } finally {
      setActionBusy(false)
    }
  }

  /** Pin an exit from the table: writes pinnedExitId and saves immediately. */
  const pinExit = async (exitId: string): Promise<void> => {
    if (!writable || settings === undefined || snapshot === undefined) return
    setActionBusy(true)
    try {
      const accepted = await settings.mutate([{ op: 'set', path: [IP_POOL_FIELD, 'pinnedExitId'], value: exitId }], snapshot.revision)
      if (!accepted) throw new Error(t('saveError'))
      setForm((current) => ({ ...current, pinnedExitId: exitId }))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'))
    } finally {
      setActionBusy(false)
    }
  }

  /**
   * 轮换 one exit out of the table. The bridge owns the whole decision (promote
   * a reserve into its slot, or sink the row to the tail), so the card only
   * re-reads /status after it.
   */
  const rotateExit = async (exitId: string): Promise<void> => {
    setActionBusy(true)
    try {
      await fetch(`${BRIDGE_PREFIX}/exit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rotate', exitId }),
      })
      await refreshStatus()
    } catch {
      setStatusError(t('refreshError'))
    } finally {
      setActionBusy(false)
    }
  }

  /**
   * Switch the usage scope. Written IMMEDIATELY rather than as a form draft:
   * it is a view switch, not a configuration edit, and the numbers it governs
   * are read from the bridge — requiring a 保存 press to re-read them would be
   * a strange two-step for a control whose whole job is to change what you see.
   */
  const setUsageScope = async (next: UsageScopeView): Promise<void> => {
    if (!writable || settings === undefined || snapshot === undefined) return
    setActionBusy(true)
    try {
      const accepted = await settings.mutate(
        [{ op: 'set', path: [IP_POOL_FIELD, 'usageScope'], value: next }],
        snapshot.revision,
      )
      if (!accepted) throw new Error(t('saveError'))
      setForm((current) => ({ ...current, usageScope: next }))
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'))
    } finally {
      setActionBusy(false)
    }
  }

  const probeDone = status !== null ? status.prober.completed : 0
  const probeTotal = status !== null ? status.prober.enqueued : 0

  // Collapsed-state summaries read the DRAFT (not the saved value): folding
  // the page must still confirm what you just edited.
  const sourcesSummary = [
    form.manual.length > 0 ? t('summaryProxies', { count: String(form.manual.length) }) : '',
    form.subscriptionUrls.length > 0 ? t('summarySubscriptions', { count: String(form.subscriptionUrls.length) }) : '',
  ].filter((part) => part !== '').join(' · ') || t('summaryUnset')
  const schedulingSummary = form.pinnedExitId !== ''
    ? t('summaryPinned', { target: form.pinnedExitId })
    : `${t('summaryAuto')}${form.pinnedStrict ? ` · ${t('pinnedModeAbsolute')}` : ''}`
  const probeSummary = [
    form.probeModels.length === 0 ? t('summaryModelsDefault') : t('summaryModelsCount', { count: String(form.probeModels.length) }),
    form.probeContents.length > 0 ? t('summaryContentsCount', { count: String(form.probeContents.length) }) : '',
    t('summaryConcurrency', { count: form.maxConcurrentProbes }),
    t('summaryCapacity', { count: form.poolSize }),
  ].filter((part) => part !== '').join(' · ')
  const usageSummary = status?.usage == null
    ? t('summaryUsageNone')
    : t('summaryUsage', {
      requests: status.usage.scoped.requests.toLocaleString(),
      tokens: usageTokens(status.usage.scoped),
    })
  const headersLineCount = headersText.split('\n').filter((line) => line.trim() !== '').length
  const headersSummary = headersLineCount === 0 ? t('summaryHeadersDefault') : t('summaryHeadersCustom', { count: String(headersLineCount) })
  const exitsSummary = status === null
    ? t('summaryUnset')
    : t('footerUsable', { usable: String(status.availableTotal), total: String(status.total) })

  return (
    <SettingsForm labels={formLabels(t)} state={shell} onSave={() => { void handleSave() }} onDiscard={handleDiscard}>
    <div className={styles.body} data-testid="ip-pool-form">
      {/* Master switch: the page's primary control, status strip right under. */}
      <div className={styles.settingRow}>
        <div className={styles.settingRowText}>
          <span className={styles.settingRowTitle}>{t('enabled')}</span>
          <span className={styles.fieldHint}>{t('enabledHint')}</span>
        </div>
        <span className={styles.settingRowControl} data-testid="field-enabled">
          <Switch
            checked={form.enabled}
            label={t('enabled')}
            disabled={!writable || saving}
            onChange={(next) => { setSaved(false); setForm({ ...form, enabled: next }) }}
          />
        </span>
      </div>
      <OverviewBar status={form.enabled ? status : null} t={t} />

      <Group
        id="sources"
        title={t('groupSources')}
        summary={sourcesSummary}
        open={groups.sources}
        highlight={highlightGroup === 'sources'}
        onToggle={() => toggleGroup('sources')}
      >
        <span className={styles.fieldLabel}>{t('sectionManual')}</span>
        <ListEditor
          hint={t('manualHint')}
          values={form.manual}
          placeholder={t('manualPlaceholder')}
          testId="field-manual"
          disabled={!writable || saving}
          t={t}
          onChange={(next) => { setSaved(false); setForm({ ...form, manual: next }) }}
        />
        <span className={styles.fieldLabel}>{t('sectionSubscription')}</span>
        <ListEditor
          hint={t('subscriptionHint')}
          values={form.subscriptionUrls}
          placeholder={t('subscriptionPlaceholder')}
          testId="field-subscriptions"
          redacted
          disabled={!writable || saving}
          t={t}
          onChange={(next) => { setSaved(false); setForm({ ...form, subscriptionUrls: next }) }}
        />
        <TextField
          label={t('subscriptionRefreshMs')}
          hint={t('subscriptionRefreshMsHint')}
          value={form.refreshMs}
          testId="field-refreshMs"
          type="number"
          min={60_000}
          step={1}
          invalid={validation?.group === 'sources' && validation.message === t('invalidRange')}
          disabled={!writable || saving}
          onChange={(value) => { setSaved(false); setForm({ ...form, refreshMs: value }) }}
          action={(
            <Button
              variant="outline"
              size="sm"
              data-testid="refresh-subscriptions"
              disabled={actionBusy || !form.enabled}
              onClick={() => { void bridgeAction({ scope: 'subscription' }) }}
            >
              {t('subscriptionRefreshNow')}
            </Button>
          )}
        />
        <TextField
          label={t('subscriptionUserAgent')}
          hint={t('subscriptionUserAgentHint')}
          value={form.userAgent}
          testId="field-subscriptionUserAgent"
          disabled={!writable || saving}
          onChange={(value) => { setSaved(false); setForm({ ...form, userAgent: value }) }}
        />
        {status?.subscription !== null && status?.subscription !== undefined && (
          <span className={styles.status}>
            {t('sectionSubscription')}: {status.subscription.pendingConversion} 待转换 · {status.subscription.convertedAdmitted} 已转换入池
            {status.subscription.lastError !== '' ? ` · ${status.subscription.lastError}` : ''}
          </span>
        )}
        <TextField
          label={t('singboxPath')}
          hint={t('singboxPathHint')}
          value={form.singboxPath}
          testId="field-singboxPath"
          disabled={!writable || saving}
          onChange={(value) => { setSaved(false); setForm({ ...form, singboxPath: value }) }}
        />
      </Group>

      <Group
        id="scheduling"
        title={t('groupScheduling')}
        summary={schedulingSummary}
        open={groups.scheduling}
        highlight={highlightGroup === 'scheduling'}
        onToggle={() => toggleGroup('scheduling')}
      >
        <TextField
          label={t('pinnedAddress')}
          hint={t('pinnedAddressHint')}
          value={form.pinnedExitId}
          placeholder={t('manualPlaceholder')}
          testId="field-pinnedExitId"
          disabled={!writable || saving}
          onChange={(value) => { setSaved(false); setForm({ ...form, pinnedExitId: value }) }}
          action={form.pinnedExitId === '' ? undefined : (
            <Button
              variant="outline"
              size="sm"
              data-testid="unpin"
              disabled={saving}
              onClick={() => { setSaved(false); setForm({ ...form, pinnedExitId: '' }) }}
            >
              {t('pinnedUnset')}
            </Button>
          )}
        />
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('pinnedStrict')}</span>
          <span data-testid="field-pinnedStrict">
            <SegmentedControl<'fallback' | 'absolute'>
              id="ip-pool-pin-mode"
              value={form.pinnedStrict ? 'absolute' : 'fallback'}
              options={[
                { value: 'fallback', label: t('pinnedModeFallback') },
                { value: 'absolute', label: t('pinnedModeAbsolute') },
              ]}
              label={t('pinnedStrict')}
              disabled={!writable || saving}
              onChange={(next) => { setSaved(false); setForm({ ...form, pinnedStrict: next === 'absolute' }) }}
            />
          </span>
          <span className={styles.fieldHint}>{form.pinnedStrict ? t('pinnedStrictOn') : t('pinnedStrictOff')}</span>
        </div>
      </Group>

      <Group
        id="probe"
        title={t('groupProbe')}
        summary={probeSummary}
        open={groups.probe}
        highlight={highlightGroup === 'probe'}
        onToggle={() => toggleGroup('probe')}
      >
        <ModelPicker
          value={form.probeModels}
          hint={t('probeModelsHint')}
          models={probeModelRows}
          loading={probeModelsLoading}
          disabled={!writable || saving}
          t={t}
          onChange={(next) => { setSaved(false); setForm({ ...form, probeModels: next }) }}
        />
        {/* The smoke's user turn (live request 2026-10-14): a pool of
            one-liners, one picked at random per probe; empty = 'hello'. */}
        <ListEditor
          label={t('probeContents')}
          hint={t('probeContentsHint')}
          values={form.probeContents}
          placeholder={t('probeContentsPlaceholder')}
          testId="field-probeContents"
          disabled={!writable || saving}
          t={t}
          onChange={(next) => { setSaved(false); setForm({ ...form, probeContents: next }) }}
        />
        <div className={styles.fieldRow}>
          <TextField
            label={t('probeConcurrency')}
            hint={t('probeConcurrencyHint')}
            value={form.maxConcurrentProbes}
            testId="field-maxConcurrentProbes"
            type="number"
            min={1}
            max={8}
            step={1}
            invalid={validation?.group === 'probe' && validation.message === t('invalidRange')}
            disabled={!writable || saving}
            onChange={(value) => { setSaved(false); setForm({ ...form, maxConcurrentProbes: value }) }}
          />
          <TextField
            label={t('poolSize')}
            hint={t('poolSizeHint')}
            value={form.poolSize}
            testId="field-poolSize"
            type="number"
            min={1}
            max={100}
            step={1}
            invalid={validation?.group === 'probe' && validation.message === t('invalidRange')}
            disabled={!writable || saving}
            onChange={(value) => { setSaved(false); setForm({ ...form, poolSize: value }) }}
          />
        </div>
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid="probe-all"
            disabled={actionBusy || !form.enabled}
            onClick={() => { void bridgeAction({ scope: 'all' }) }}
          >
            {probing ? t('probeRunning').replace('{done}', String(probeDone)).replace('{total}', String(probeTotal)) : t('probeAll')}
          </Button>
        </div>
      </Group>

      <Group
        id="usage"
        title={t('groupUsage')}
        summary={usageSummary}
        open={groups.usage}
        highlight={highlightGroup === 'usage'}
        onToggle={() => toggleGroup('usage')}
      >
        <div data-testid="usage-section">
          <span data-testid="usage-scope">
            <SegmentedControl<UsageScopeView>
              id="ip-pool-usage-scope"
              value={form.usageScope}
              options={[
                { value: 'total', label: t('usageScopeTotal') },
                { value: 'run', label: t('usageScopeRun') },
              ]}
              label={t('usageScopeLabel')}
              disabled={actionBusy || !writable}
              onChange={(next) => { void setUsageScope(next) }}
            />
          </span>
          <span className={styles.fieldHint}>
            {t('usageScopeHint', { days: String(status?.usage?.retentionDays ?? 90) })}
          </span>
          {status?.usage == null
            ? <span className={styles.status}>{t('usageNoStore')}</span>
            : (
              <div className={styles.statsSummary}>
                <span className={styles.statsChip}>{t('statsSummaryRequests', { count: status.usage.scoped.requests.toLocaleString() })}</span>
                <span className={styles.statsChip}>
                  {t('statsSummaryTokens', { count: usageTokens(status.usage.scoped) })}
                </span>
                {usageSpeed(status.usage.scoped) > 0 && (
                  <span className={styles.statsChip}>{t('statsSummarySpeed', { count: usageSpeed(status.usage.scoped).toLocaleString() })}</span>
                )}
                <span className={styles.statsChip}>{t('usageSummarySessions', { count: status.usage.sessions.length.toLocaleString() })}</span>
                <span className={styles.statsChip}>{t('usageSummaryDays', { count: status.usage.days.length.toLocaleString() })}</span>
              </div>
            )}
        </div>
      </Group>

      <Group
        id="headers"
        title={t('groupHeaders')}
        summary={headersSummary}
        open={groups.headers}
        highlight={highlightGroup === 'headers'}
        onToggle={() => toggleGroup('headers')}
      >
        <RequestHeadersEditor
          text={headersText}
          effectiveUserAgent={status?.zenUserAgent}
          disabled={!writable || saving}
          t={t}
          onChange={(text) => { setSaved(false); setHeadersText(text) }}
        />
      </Group>

      {form.enabled && (
        <Group
          id="exits"
          title={t('groupExits')}
          summary={exitsSummary}
          open={groups.exits}
          highlight={highlightGroup === 'exits'}
          onToggle={() => toggleGroup('exits')}
        >
          <ExitTable
            status={status}
            t={t}
            busy={actionBusy}
            onProbe={(id) => { void bridgeAction({ scope: 'exit', exitId: id }) }}
            onPin={(id) => { void pinExit(id) }}
            onRotate={(id) => { void rotateExit(id) }}
          />
        </Group>
      )}

      {validation !== null && <span role="alert" className={styles.saveStatusError}>{validation.message}</span>}
      {statusError !== null && <span className={styles.saveStatusError}>{statusError}</span>}
      {saved && error === null && <span className={`${styles.saveStatus} ${styles.saveStatusOk}`}>{t('saved')}</span>}

      <p className={styles.compliance}>{t('copyCompliance')}</p>
    </div>
    </SettingsForm>
  )
}

/**
 * The IP 池 page on the Plugins page.
 *
 * The Plugins page owns the card chrome and the save control: for
 * `view: 'summary'` this returns the one-liner the page shows under the entry
 * title, and for `view: 'page'` it returns the form bound to the entry's
 * served settings.
 */
export function IpPoolCard(props: IpPoolCardOwnProps): ReactNode {
  const { form, t, view } = props
  if (view === 'summary') return <>{t('description')}</>
  return <CardBody settings={form} t={t} />
}

/**
 * A `plugins.bundle.config` entry bound to one settings controller: the DSH
 * 0.2 bundle page embeds the configuration directly on the bundle's detail
 * page (设置 → 插件 → oc2dsh lands straight on this form),
 * but unlike the row/item slots its render site hands over NO `form` — the
 * page draws the section and nothing else. The registration therefore closes
 * over the settings provider's own controller for the served entry and
 * subscribes here, which is the same snapshot/mutate pair the page would
 * have bound (config-form.d.ts: getSnapshot is stable until the next
 * acceptance, subscribe fires on replacements).
 */
export function bundleConfigCard(controller: ConfigForm<Record<string, unknown>>): (props: { view: 'summary' | 'page'; t: IpPoolCardLocale }) => ReactNode {
  return function BundleConfigCard(props): ReactNode {
    const { view, t } = props
    const snapshot = useSyncExternalStore(
      useCallback((listener: () => void) => controller.subscribe(listener), [controller]),
      useCallback(() => controller.getSnapshot(), [controller]),
    )
    const form = useMemo(() => ({
      state: snapshot,
      mutate: (ops: readonly ConfigPathOp[], expectedRevision?: number) => controller.mutate(ops, expectedRevision),
    }), [controller, snapshot])
    if (view === 'summary') return <>{t('description')}</>
    return <CardBody settings={form} t={t} />
  }
}
