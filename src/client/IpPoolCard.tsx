/**
 * IP 池 page body: the editable form on the Plugins page. The DSH 0.2
 * `plugins.bundle.config` slot embeds it on the bundle's detail page (设置 →
 * 插件 → oc2dsh), and the pre-0.2 `plugins.item` slot lists it as an
 * official-plugin page. Either way configuration rides the settings
 * provider's ConfigForm (a `ConfigFormSnapshot` plus `mutate`); runtime state
 * and actions ride the plugin's own bridge (/status, /models, /probe, /exit).
 * Every setting applies live on save (docs/ip-pool.md §5).
 *
 * Pool edits use `['ipPool', <field>]`; Zen header overrides the separate
 * `['requestHeaders']` volatile dictionary, and per-model context windows the
 * `['modelContextWindows']` node. All share one revision and save. Pins never
 * write settings directly: they go through the bridge's /exit action.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, useState } from 'react'
import type { ReactNode } from 'react'
import { SettingsForm, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.bundle.config'
// keyed entry and the legacy 'plugins.item' list entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the settings provider's `ConfigFormSnapshot`/`ConfigForm`.
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { IpPoolKey } from './locales.ts'
import { bridgeErrorText, exitAction, postBridge, probeAction, type BridgeReply, type ProbeScope } from './bridge-client.ts'
import { ExitTable } from './ExitTable.tsx'
import { Group, loadGroupState, GROUP_STATE_KEY, type GroupChrome } from './fields/Group.tsx'
import { LocalFamilyPicker } from './fields/LocalFamilyPicker.tsx'
import type { ProbeModelRow } from './fields/ModelPicker.tsx'
import {
  diffWrites, emptyForm, FIELD_GROUP, followServed, formFromValue, liveConflicts, pristineDraft,
  servedBase, servedSection, validateForm,
  type FormField, type FormState, type GroupId, type PoolDraft,
} from './form-model.ts'
import { ProbeGroup } from './groups/ProbeGroup.tsx'
import { SchedulingGroup } from './groups/SchedulingGroup.tsx'
import { SourcesGroup } from './groups/SourcesGroup.tsx'
import { UsageGroup } from './groups/UsageGroup.tsx'
import { ModelContextEditor } from './ModelContextEditor.tsx'
import { OverviewBar } from './OverviewBar.tsx'
import { RequestHeadersEditor } from './RequestHeadersEditor.tsx'
import { modelContextWriteOps, poolWriteOps, requestHeadersWriteOps, usageScopeWriteOps } from './settings-writes.ts'
import type { ConfigPageForm, ConfigPathOp, IpPoolCardLocale, UsageScopeView } from './types.ts'
import { usePoolStatus } from './usePoolStatus.ts'
import { formatModelContextWindows, sanitizeModelContextWindows } from '../model-context.ts'
import { formatRequestHeaders, normalizeRequestHeaders, parseRequestHeaders } from '../request-headers.ts'
import shared from './shared.module.css'
import styles from './form.module.css'

export type { ConfigPageForm, ConfigPathOp, IpPoolCardLocale, IpPoolSettingsValue } from './types.ts'

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

/** Props the legacy `plugins.item` slot binds for the IP 池 page. */
export type IpPoolCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.ip-pool'>

/** Copy of the form chrome (the shared SettingsForm labels). */
const formLabels = (t: IpPoolCardLocale): {
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

/** The label each draft field carries on the page, for the conflict message. */
const FIELD_LABEL: Record<FormField, IpPoolKey> = {
  enabled: 'enabled',
  localFallback: 'localFallback',
  localIpFamily: 'localIpFamily',
  manual: 'sectionManual',
  subscriptionUrls: 'sectionSubscription',
  refreshMs: 'subscriptionRefreshMs',
  userAgent: 'subscriptionUserAgent',
  singboxPath: 'singboxPath',
  pinnedExitId: 'pinnedAddress',
  pinnedStrict: 'pinnedStrict',
  probeModels: 'probeModels',
  probeContents: 'probeContents',
  maxConcurrentProbes: 'probeConcurrency',
  poolSize: 'poolSize',
  usageScope: 'usageScopeLabel',
}

/** A save blocker: the message plus the group that must reveal it (null = top-level row). */
interface ValidationFailure { message: string; group: GroupId | null }

/** The card body. */
function CardBody(props: { settings: ConfigPageForm | undefined; t: IpPoolCardLocale }): ReactNode {
  const { settings, t } = props
  const snapshot = settings?.state
  const ready = snapshot?.status === 'ready'
  const [pool, setPool] = useState<PoolDraft>(() => pristineDraft(emptyForm()))
  const form = pool.draft
  const [headersText, setHeadersText] = useState('')
  const [contextText, setContextText] = useState('')
  const [headerConflict, setHeaderConflict] = useState(false)
  const acceptedHeadersRef = useRef('')
  const contextHydratedRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  /** The last save's failure: the only error that flips the SettingsForm chrome. */
  const [error, setError] = useState<string | null>(null)
  /** The last bridge action's failure or warning, shown inline. */
  const [actionError, setActionError] = useState<string | null>(null)
  const [probeModelRows, setProbeModelRows] = useState<ProbeModelRow[]>([])
  const [probeModelsLoading, setProbeModelsLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [groups, setGroups] = useState<Record<GroupId, boolean>>(() => loadGroupState())
  const [highlightGroup, setHighlightGroup] = useState<GroupId | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 1s while probing, 3s otherwise; not gated on the pool switch, because the
  // usage ledger also records traffic with the pool off.
  const { status, error: statusError, refresh } = usePoolStatus((current) =>
    !ready ? null : current !== null && current.prober.queued + current.prober.inFlight > 0 ? 1_000 : 3_000)
  /** The pool runtime is running: what the bridge actions and the exit views need. */
  const poolRunning = status?.enabled === true

  useEffect(() => {
    try { localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(groups)) } catch { /* private mode: fold state is disposable */ }
  }, [groups])
  useEffect(() => () => { if (highlightTimer.current !== null) clearTimeout(highlightTimer.current) }, [])

  const served = servedSection(snapshot)
  const servedForm = useMemo(() => formFromValue(servedSection(snapshot)), [snapshot?.value]) // eslint-disable-line react-hooks/exhaustive-deps

  // Follow served values per field while that field is pristine; a dirty field
  // that changed underneath becomes a conflict instead of a silent revert.
  useEffect(() => {
    if (!ready) return
    setPool((current) => followServed(current, servedForm))
    if (!contextHydratedRef.current) {
      contextHydratedRef.current = true
      // Lenient on purpose: a hand-edited profile patch must not blank the
      // card, and the draft is re-validated strictly on save.
      setContextText(formatModelContextWindows(sanitizeModelContextWindows(snapshot?.value?.modelContextWindows ?? {})))
    }
  }, [ready, servedForm]) // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [snapshot?.status, snapshot?.value]) // eslint-disable-line react-hooks/exhaustive-deps

  // Probe-model options: the static S3 list first, live catalog rows merged in.
  useEffect(() => {
    let cancelled = false
    setProbeModelsLoading(true)
    void postBridge<{ models: ProbeModelRow[] }>('/models').then((reply) => {
      if (cancelled) return
      if (reply.ok && reply.value != null) setProbeModelRows(reply.value.models)
      setProbeModelsLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const conflicts = liveConflicts(pool)
  const writes = diffWrites(form, served, servedBase(snapshot))
  let headerOps: ConfigPathOp[] = []
  let headerFailure: ValidationFailure | null = headerConflict
    ? { message: t('requestHeadersConflict'), group: 'headers' }
    : null
  try {
    headerOps = requestHeadersWriteOps(headersText,
      normalizeRequestHeaders(snapshot?.value?.requestHeaders ?? {}),
      normalizeRequestHeaders((snapshot?.base as Record<string, unknown> | undefined)?.requestHeaders ?? {}))
  } catch { headerFailure = { message: t('requestHeadersInvalid'), group: 'headers' } }
  const conflictFailure: ValidationFailure | null = conflicts.length === 0
    ? null
    : { message: t('poolConflict', { field: conflicts.map((field) => t(FIELD_LABEL[field])).join(' · ') }), group: FIELD_GROUP[conflicts[0]!] }
  let contextOps: ConfigPathOp[] = []
  let contextFailure: ValidationFailure | null = null
  try {
    contextOps = modelContextWriteOps(
      contextText,
      sanitizeModelContextWindows(snapshot?.value?.modelContextWindows ?? {}),
      sanitizeModelContextWindows((snapshot?.base as Record<string, unknown> | undefined)?.modelContextWindows ?? {}),
    )
  } catch { contextFailure = { message: t('modelContextInvalid'), group: 'models' } }
  const formFailure = validateForm(form)
  const blocker = headerFailure ?? conflictFailure ?? contextFailure
  /** The field-level failure, only while it is the one on screen. */
  const shownFormFailure = blocker === null ? formFailure : null
  const validation = blocker
    ?? (formFailure === null ? null : { message: t(formFailure.reason), group: formFailure.group })
  const dirty = writes.length > 0 || headerOps.length > 0 || contextOps.length > 0 || validation !== null
  const available = ready && settings !== undefined
  const writable = available && snapshot.writable
  const locked = !writable || saving

  // A validation failure force-opens its group (with a brief highlight) so the
  // erroring row is never hidden inside a folded section. Rides above the
  // loading early-return to keep the hook order stable.
  useEffect(() => {
    const group = validation?.group
    if (group == null) return
    setGroups((current) => (current[group] ? current : { ...current, [group]: true }))
    setHighlightGroup(group)
    if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlightGroup(null), 1200)
  }, [validation?.group, validation?.message]) // eslint-disable-line react-hooks/exhaustive-deps

  if (snapshot?.status === 'loading') {
    return <p className={shared.status}>{t('statusLoading')}</p>
  }

  /** Patch the draft; any edit retires the saved note. */
  const edit = (patch: Partial<FormState>): void => {
    setSaved(false)
    setPool((current) => ({ ...current, draft: { ...current.draft, ...patch } }))
  }

  const chrome = (group: GroupId): GroupChrome => ({
    open: groups[group],
    highlight: highlightGroup === group,
    onToggle: () => setGroups((current) => ({ ...current, [group]: !current[group] })),
  })

  const handleSave = async (): Promise<void> => {
    if (!writable || validation !== null || settings === undefined || snapshot === undefined) {
      setSaved(false)
      setError(validation?.message ?? t('saveError'))
      return
    }
    if (writes.length === 0 && headerOps.length === 0 && contextOps.length === 0) {
      setSaved(true)
      setError(null)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const ok = await settings.mutate(
        [...headerOps, ...contextOps, ...poolWriteOps(writes)],
        snapshot.revision,
      )
      setSaved(ok)
      setError(ok ? null : t('saveError'))
      if (ok && headerOps.length > 0) await refresh()
    } catch (err) {
      setSaved(false)
      setError(err instanceof Error ? err.message : t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  /** The shared SettingsForm discard: drop the draft, keep the served values. */
  const handleDiscard = (): void => {
    setPool(pristineDraft(servedForm))
    const headers = formatRequestHeaders(normalizeRequestHeaders(snapshot?.value?.requestHeaders ?? {}))
    acceptedHeadersRef.current = headers
    setHeadersText(headers)
    setContextText(formatModelContextWindows(sanitizeModelContextWindows(snapshot?.value?.modelContextWindows ?? {})))
    setHeaderConflict(false)
    setSaved(false)
    setError(null)
    setActionError(null)
  }

  const shell: SettingsFormShell = {
    available,
    writable,
    dirty,
    invalid: validation !== null,
    saving,
    failed: error !== null,
  }

  /**
   * Run one bridge action, report a failure (the host's own message when it
   * has one) or a warning, then re-read /status. Returns the reply.
   */
  const runAction = async <T,>(send: () => Promise<BridgeReply<T>>, warn?: (value: T) => string | null): Promise<BridgeReply<T>> => {
    setActionBusy(true)
    setActionError(null)
    try {
      const reply = await send()
      if (!reply.ok) setActionError(bridgeErrorText(reply, t('statsActionFailed')))
      else if (warn !== undefined && reply.value != null) setActionError(warn(reply.value))
      await refresh()
      return reply
    } finally {
      setActionBusy(false)
    }
  }

  const probe = (scope: ProbeScope): void => { void runAction(() => probeAction(scope)) }

  /** A read-only profile still pins live; the pin is lost on restart. */
  const volatile = (value: { persisted?: boolean }): string | null =>
    value.persisted === false ? t('statsActionVolatile') : null

  /** Pin from the table through the bridge, which checks the listener first. */
  const pinExit = (exitId: string): void => { void runAction(() => exitAction('pin', exitId), volatile) }

  /**
   * 解除固定. With the pool running the bridge unpins live and persists; with
   * it off there is nothing live to unpin, so the field is cleared in the
   * draft and lands on save.
   */
  const unpin = async (): Promise<void> => {
    if (!poolRunning) {
      edit({ pinnedExitId: '' })
      return
    }
    const reply = await runAction(() => exitAction('unpin'), volatile)
    if (reply.ok) edit({ pinnedExitId: '' })
  }

  /** 轮换: the bridge promotes a reserve into the slot or sinks the row. */
  const rotateExit = (exitId: string): void => {
    void runAction(() => exitAction('rotate', exitId), (value) => (value.busy === true ? t('statsActionBusy') : null))
  }

  /**
   * Switch the usage scope, written IMMEDIATELY: it is a view switch whose
   * numbers come from the bridge, not a configuration edit to save later.
   */
  const setUsageScope = async (next: UsageScopeView): Promise<void> => {
    if (!writable || settings === undefined || snapshot === undefined) return
    setActionBusy(true)
    setActionError(null)
    try {
      const accepted = await settings.mutate(usageScopeWriteOps(next), snapshot.revision)
      if (!accepted) throw new Error(t('saveError'))
      setPool((current) => ({ ...current, draft: { ...current.draft, usageScope: next } }))
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t('saveError'))
    } finally {
      setActionBusy(false)
    }
  }

  const headersLineCount = headersText.split('\n').filter((line) => line.trim() !== '').length
  const headersSummary = headersLineCount === 0 ? t('summaryHeadersDefault') : t('summaryHeadersCustom', { count: String(headersLineCount) })
  const contextLineCount = contextText.split('\n').filter((line) => line.trim() !== '').length
  const contextSummary = contextLineCount === 0
    ? t('summaryContextDefault')
    : t('summaryContextCustom', { count: String(contextLineCount) })
  const exitsSummary = status === null
    ? t('summaryUnset')
    : t('footerUsable', { usable: String(status.availableTotal), total: String(status.total) })

  return (
    <SettingsForm labels={formLabels(t)} state={shell} onSave={() => { void handleSave() }} onDiscard={handleDiscard}>
    <div className={styles.body} data-testid="ip-pool-form">
      {/* Master switch: the page's primary control, status strip right under.
          The switch leads the row and the text follows it. */}
      <div className={styles.settingRow}>
        <span className={styles.settingRowControl} data-testid="field-enabled">
          <Switch
            checked={form.enabled}
            label={t('enabled')}
            disabled={locked}
            onChange={(next) => edit({ enabled: next })}
          />
        </span>
        <div className={styles.settingRowText}>
          <span className={styles.settingRowTitle}>{t('enabled')}</span>
          <span className={styles.fieldHint}>{t('enabledHint')}</span>
        </div>
      </div>
      {/* Gated on the running pool, not the draft switch: an unsaved toggle
          has nothing to show yet. */}
      <OverviewBar status={poolRunning ? status : null} t={t} />

      {/* 本地出口兜底: what a pool MISS means. Off (the default) fails the
          request so this machine's IP never reaches the upstream; On falls
          back to a direct connection. A 本机 pin is honoured either way. */}
      <div className={styles.settingRow}>
        <span className={styles.settingRowControl} data-testid="field-localFallback">
          <Switch
            checked={form.localFallback}
            label={t('localFallback')}
            disabled={locked}
            onChange={(next) => edit({ localFallback: next })}
          />
        </span>
        <div className={styles.settingRowText}>
          <span className={styles.settingRowTitle}>{t('localFallback')}</span>
          <span className={styles.fieldHint}>{t('localFallbackHint')}</span>
        </div>
      </div>

      {/* 本机出口协议族: the family the LOCAL egress (a 本机 pin, or the
          fallback after a pool miss) dials with. */}
      <div className={styles.settingRow}>
        <span className={styles.settingRowControl} data-testid="field-localIpFamily">
          <LocalFamilyPicker
            value={form.localIpFamily}
            disabled={locked}
            t={t}
            onChange={(next) => edit({ localIpFamily: next })}
          />
        </span>
        <div className={styles.settingRowText}>
          <span className={styles.settingRowTitle}>{t('localIpFamily')}</span>
          <span className={styles.fieldHint}>{t('localIpFamilyHint')}</span>
        </div>
      </div>

      <SourcesGroup
        form={form}
        edit={edit}
        locked={locked}
        t={t}
        chrome={chrome('sources')}
        validation={shownFormFailure}
        subscription={status?.subscription}
        poolRunning={poolRunning}
        actionBusy={actionBusy}
        onRefreshSubscriptions={() => probe({ scope: 'subscription' })}
      />

      <SchedulingGroup
        form={form}
        edit={edit}
        locked={locked}
        t={t}
        chrome={chrome('scheduling')}
        saving={saving || actionBusy}
        onUnpin={() => { void unpin() }}
      />

      <ProbeGroup
        form={form}
        edit={edit}
        locked={locked}
        t={t}
        chrome={chrome('probe')}
        validation={shownFormFailure}
        models={probeModelRows}
        modelsLoading={probeModelsLoading}
        prober={status?.prober}
        poolRunning={poolRunning}
        actionBusy={actionBusy}
        onProbeAll={() => probe({ scope: 'all' })}
      />

      <UsageGroup
        scope={form.usageScope}
        usage={status?.usage}
        disabled={actionBusy || !writable}
        t={t}
        chrome={chrome('usage')}
        onScope={(next) => { void setUsageScope(next) }}
      />

      <Group id="headers" title={t('groupHeaders')} summary={headersSummary} {...chrome('headers')}>
        <RequestHeadersEditor
          text={headersText}
          effectiveUserAgent={status?.zenUserAgent}
          disabled={locked}
          t={t}
          onChange={(text) => { setSaved(false); setHeadersText(text) }}
        />
      </Group>

      <Group id="models" title={t('groupModels')} summary={contextSummary} {...chrome('models')}>
        <ModelContextEditor
          text={contextText}
          disabled={locked}
          t={t}
          onChange={(text) => { setSaved(false); setContextText(text) }}
        />
      </Group>

      {poolRunning && (
        <Group id="exits" title={t('groupExits')} summary={exitsSummary} {...chrome('exits')}>
          <ExitTable
            status={status}
            t={t}
            busy={actionBusy}
            onProbe={(id) => probe({ scope: 'exit', exitId: id })}
            onPin={pinExit}
            onRotate={rotateExit}
          />
        </Group>
      )}

      {validation !== null && <span role="alert" className={styles.saveStatusError}>{validation.message}</span>}
      {actionError !== null && <span role="status" className={styles.saveStatusError} data-testid="action-error">{actionError}</span>}
      {statusError !== null && <span className={styles.saveStatusError}>{t('refreshError')}</span>}
      {saved && error === null && <span className={`${styles.saveStatus} ${styles.saveStatusOk}`}>{t('saved')}</span>}

      <p className={styles.compliance}>{t('copyCompliance')}</p>
    </div>
    </SettingsForm>
  )
}

/**
 * The IP 池 page on the Plugins page. The page owns the card chrome and the
 * save control: `view: 'summary'` returns the one-liner under the entry
 * title, `view: 'page'` the form bound to the entry's served settings.
 */
export function IpPoolCard(props: IpPoolCardOwnProps): ReactNode {
  const { form, t, view } = props
  if (view === 'summary') return <>{t('description')}</>
  return <CardBody settings={form} t={t} />
}

/**
 * A `plugins.bundle.config` entry bound to one settings controller. The DSH
 * 0.2 bundle page hands its slot NO `form`, so the registration closes over
 * the settings provider's controller for the served entry and subscribes here
 * (getSnapshot is stable until the next acceptance; subscribe fires on
 * replacements).
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
