/**
 * Sidebar footer entry (bottom-left) + exit-stats modal: a headline number
 * (usable exits) with a request-count subline, click to open a centered modal
 * that lists every pool exit sorted BY REQUEST COUNT — per-exit tokens,
 * latency, in-flight markers and last-used stamps, plus pool-wide totals and
 * the 本机 row. Data rides the shared /status poller (usePoolStatus), so the
 * entry works whether or not the settings card is mounted. Request counts are
 * process-lifetime; per-exit tokens follow the card's usage scope (default:
 * the persisted ledger).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, Modal, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the sidebar's SlotMap merge (the 'sidebar.footer.action' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { bridgeErrorText, exitAction, postBridge, probeAction, type ExitAction } from './bridge-client.ts'
import type { ExitRowView, TokenTotalsView } from './types.ts'
import { PinIcon, RotateIcon, UnpinIcon } from './icons.tsx'
import { regionCode } from './region.ts'
import { UsagePanel } from './UsagePanel.tsx'
import { compact, grandTotal } from './usage-format.ts'
import { usePoolStatus } from './usePoolStatus.ts'
import shared from './shared.module.css'
import footer from './footer.module.css'
import styles from './stats-modal.module.css'

/** Cache share of one bucket, for the per-row note (0 hides the note). */
function cacheTotal(tokens: TokenTotalsView): number {
  return tokens.cacheReadTokens + tokens.cacheWriteTokens
}

export type ExitStatsEntryProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'settings.ip-pool'>

/**
 * The outcome toast's two clocks: HOLD is full-opacity reading time;
 * FADE matches the stylesheet's dismiss animation so the element unmounts
 * exactly when it stops being visible.
 */
const TOAST_HOLD_MS = 3_000
const TOAST_FADE_MS = 300

/** Clock label for a last-used stamp; 0 reads the never placeholder. */
function timeLabel(epoch: number, never: string): string {
  if (epoch <= 0) return never
  return new Date(epoch).toLocaleTimeString()
}

/** An exit row reads "usable" when it is probed healthy (state ok) and not
 *  cooling; bans are per-model, so they never hide a whole row. */
function isUsable(exit: ExitRowView): boolean {
  return exit.state === 'ok' && !exit.cooling
}

/** The sortable columns: request count, the three token buckets, latency. */
type SortKey = 'requests' | 'input' | 'output' | 'cache' | 'latency'

/** One exit's value under a sort key. */
function sortMetric(exit: ExitRowView, key: SortKey): number {
  if (key === 'input') return exit.tokens.inputTokens
  if (key === 'output') return exit.tokens.outputTokens
  if (key === 'cache') return cacheTotal(exit.tokens)
  return exit.requests
}

/**
 * The footer entry: one register()-mounted button plus its modal.
 * @param props - sidebar column state, locale-bound `t`, standard seats.
 * @returns the button and (when open) the portaled stats dialog.
 */
export function ExitStatsEntry({ wide, t }: ExitStatsEntryProps) {
  const [open, setOpen] = useState(false)
  // Gentle while closed (the button carries live numbers too), tighter while open.
  const { status, error, updatedAt, refresh } = usePoolStatus(open ? 2_000 : 10_000)
  const stale = error !== null && status !== null
  /** Headline ordering contract: newest click wins, request count is home. */
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'requests', dir: 'desc' })
  /** Which pane the modal shows: the exit table, or the traffic breakdown. */
  const [tab, setTab] = useState<'exits' | 'usage'>('exits')
  /** The pane's own scroll container; a pane switch resets its offset. */
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (paneRef.current !== null) paneRef.current.scrollTop = 0
  }, [tab])
  /** The row action in flight (its key), so every button disables together. */
  const [busy, setBusy] = useState('')
  /**
   * The last action's outcome, shown as a toast DOCKED at the modal's
   * bottom-right corner and dismissed on its own clock. `seq` restarts the
   * show cycle when the same text fires twice in a row.
   */
  const [note, setNote] = useState<{ text: string; warn: boolean; seq: number } | null>(null)
  const noteSeq = useRef(0)

  /** Show one outcome toast; every success/failure line funnels through here. */
  const showNote = useCallback((text: string, warn: boolean): void => {
    noteSeq.current += 1
    setNote({ text, warn, seq: noteSeq.current })
  }, [])

  useEffect(() => {
    if (note === null) return
    const timer = window.setTimeout(() => setNote(null), TOAST_HOLD_MS + TOAST_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [note])

  /** 清空: drop the usage ledger, then re-read so every figure drops together. */
  const clearUsage = useCallback(async (): Promise<boolean> => {
    setNote(null)
    const reply = await postBridge<{ cleared?: boolean }>('/usage', { action: 'reset' })
    if (!reply.ok || reply.value?.cleared !== true) {
      showNote(reply.ok ? t('statsActionFailed') : bridgeErrorText(reply, t('statsActionFailed')), true)
      return false
    }
    showNote(t('usageCleared'), false)
    await refresh()
    return true
  }, [refresh, showNote, t])

  /**
   * 订阅「立即刷新」: the same /probe scope the settings card sends. The POST
   * answers only when the refresh round ends, so the busy flag covers the whole
   * pull; the follow-up /status read shows the converted rows.
   */
  const refreshSubscriptions = useCallback(async (): Promise<void> => {
    setBusy('refresh-subscriptions')
    setNote(null)
    try {
      const reply = await probeAction({ scope: 'subscription' })
      showNote(reply.ok ? t('statsSubscriptionRefreshed') : bridgeErrorText(reply, t('statsActionFailed')), !reply.ok)
    } finally {
      setBusy('')
      await refresh()
    }
  }, [refresh, showNote, t])

  /**
   * One row action (固定 / 取消固定 / 轮换) over the bridge, which owns the
   * listener check, the settings write and the live pin. The toast reports what
   * actually happened, including the host's refusal text (e.g. an unreachable
   * exit) and a rotation's two outcomes.
   */
  const runExitAction = useCallback(async (action: ExitAction, exitId?: string): Promise<void> => {
    setBusy(`${action}:${exitId ?? ''}`)
    setNote(null)
    try {
      const reply = await exitAction(action, exitId)
      if (!reply.ok || reply.value == null) {
        showNote(reply.ok ? t('statsActionFailed') : bridgeErrorText(reply, t('statsActionFailed')), true)
        return
      }
      const value = reply.value
      // A 轮换 that met a running round changed nothing.
      if (action === 'rotate' && value.busy === true) {
        showNote(t('statsActionBusy'), true)
        return
      }
      const text = action === 'rotate'
        ? (value.promoted === true ? t('statsActionReplaced') : t('statsActionDemoted'))
        : action === 'unpin'
          ? t('statsActionUnpinned')
          : action === 'pin-local'
            ? t('statsActionPinnedLocal')
            : t('statsActionPinned')
      // A read-only profile still pins live, but the pin is lost on restart.
      showNote(value.persisted === false
        ? `${text} · ${t('statsActionVolatile')}`
        : text, value.persisted === false)
    } finally {
      setBusy('')
      await refresh()
    }
  }, [refresh, showNote, t])

  const totals = useMemo(() => {
    const localRequests = status?.local?.requests ?? 0
    const localTokens = status?.local?.tokens
    const exits = status?.exits ?? []
    const requests = exits.reduce((sum, exit) => sum + exit.requests, 0) + localRequests
    const tokens = exits.reduce((sum, exit) => sum + grandTotal(exit.tokens), 0) + (localTokens === undefined ? 0 : grandTotal(localTokens))
    const inFlight = exits.reduce((sum, exit) => sum + exit.inFlight, 0)
    // Pool-wide recent (3-min window) output speed, computed host-side.
    const speed = status?.recentSpeed ?? 0
    return { requests, tokens, inFlight, speed }
  }, [status])

  /**
   * The footer's own numbers: the ledger's ALL-TIME request total, TODAY's
   * token spend (`todayTokens`, never the card's scope) and the recent-window
   * speed. Falls back to the live totals when the host serves no ledger.
   */
  const overview = useMemo(() => {
    if (status === null) return totals
    const ledger = status.usage
    if (ledger === null || ledger === undefined) return totals
    return {
      requests: ledger.total.requests,
      tokens: status.todayTokens ?? 0,
      inFlight: totals.inFlight,
      speed: status.recentSpeed ?? 0,
    }
  }, [status, totals])

  const usable = status?.availableTotal ?? 0
  const total = status?.total ?? 0
  /** Pool off = no traffic goes through an exit: the table shows the 本机 row alone. */
  const poolOff = status !== null && status.enabled === false
  /** The 订阅 refresh button exists only while subscriptions are configured. */
  const hasSubscriptions = (status?.subscription?.urlCount ?? 0) > 0

  // Sorted by the clicked column — request count descending is the home
  // position. An unprobed exit (latency 0) sinks to the bottom under every
  // latency direction: "unknown" is not "fastest".
  const rows = useMemo(() => {
    if (poolOff) return []
    const unknown = Number.POSITIVE_INFINITY
    return [...(status?.exits ?? [])].sort((left, right) => {
      if (sort.key === 'latency') {
        const a = left.latencyMs > 0 ? left.latencyMs : unknown
        const b = right.latencyMs > 0 ? right.latencyMs : unknown
        if (a === b) return right.requests - left.requests || left.id.localeCompare(right.id)
        if (a === unknown) return 1
        if (b === unknown) return -1
        return sort.dir === 'asc' ? a - b : b - a
      }
      const directed = sortMetric(left, sort.key) - sortMetric(right, sort.key)
      return (sort.dir === 'asc' ? directed : -directed)
        || right.requests - left.requests
        || left.id.localeCompare(right.id)
    })
  }, [status, poolOff, sort])

  /** One sortable column header: click once for that column descending, again to flip. */
  const sortableHeader = (key: SortKey, label: string): ReactNode => (
    <th aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={styles.statsSortButton}
        onClick={() => setSort((current) => ({ key, dir: current.key === key && current.dir === 'desc' ? 'asc' : 'desc' }))}
      >
        {label}
        <span className={styles.statsSortArrow} aria-hidden="true">
          {sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  )

  /** The two panes as platform tabs, each linked to the panel rendered below. */
  const tabs: [SegmentedTab<'exits' | 'usage'>, SegmentedTab<'exits' | 'usage'>] = [
    { value: 'exits', label: t('tabExits'), id: 'oc2dsh-stats-tab-exits', panelId: 'oc2dsh-stats-panel-exits' },
    { value: 'usage', label: t('tabUsage'), id: 'oc2dsh-stats-tab-usage', panelId: 'oc2dsh-stats-panel-usage' },
  ]
  const activeTab = tabs[tab === 'usage' ? 1 : 0]
  const staleText = stale ? t('statsStale', { time: timeLabel(updatedAt, t('statsNever')) }) : ''
  const footerSummary = `${t('footerRequests', { count: overview.requests.toLocaleString() })} · ${compact(overview.tokens)} tok${overview.speed > 0 ? ` · ${t('footerSpeed', { count: overview.speed.toLocaleString() })}` : ''}`

  return (
    <>
      <button
        type="button"
        className={wide ? footer.footerEntry : `${footer.footerEntry} ${footer.footerEntryCompact}`}
        onClick={() => setOpen(true)}
        title={stale ? `${t('footerTitle')} · ${staleText}` : t('footerTitle')}
        aria-haspopup="dialog"
      >
        <span className={stale ? `${footer.footerIcon} ${footer.footerStale}` : footer.footerIcon} aria-hidden="true">◈</span>
        {wide && (
          <span className={footer.footerText}>
            <span className={footer.footerMain}>
              {status === null
                ? t('footerDisabled')
                : poolOff
                  // Pool off = every request leaves from this machine.
                  ? t('footerLocal')
                  : <>{usable}<span className={footer.footerUnit}> / {total} {t('footerLabel')}</span></>}
            </span>
            <span className={footer.footerSub}>
              {t('footerRequests', { count: overview.requests.toLocaleString() })}
              {' · '}
              {compact(overview.tokens)} tok
              {/* Hidden at 0: "0 tok/s" reads as a stall, not an empty counter. */}
              {overview.speed > 0 && <>{' · '}{t('footerSpeed', { count: overview.speed.toLocaleString() })}</>}
            </span>
          </span>
        )}
        {/*
          A second footer trigger can halve this button's width, so the wide
          variant switches to the compact label by the button's OWN width
          (container query, footer.module.css); the rail always takes the
          single-line span. Every variant renders today's tokens.
        */}
        {wide ? (
          <span className={footer.footerCompactOnNarrow} title={footerSummary}>
            <span className={footer.footerCompactLine}>
              {status === null ? '—' : `${compact(overview.tokens)} tok`}
            </span>
            {status !== null && overview.speed > 0 && (
              <span className={footer.footerCompactLine}>
                {t('footerSpeed', { count: overview.speed.toLocaleString() })}
              </span>
            )}
          </span>
        ) : (
          <span className={footer.footerCompact} title={footerSummary}>
            {status === null ? '—' : `${compact(overview.tokens)} tok`}
          </span>
        )}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('statsTitle')}
        closeLabel={t('statsClose')}
        description={tab === 'usage'
          ? t('statsDescriptionUsage', { days: String(status?.usage?.retentionDays ?? 90) })
          : t('statsDescription')}
        className={styles.statsModal}
        contentClassName={styles.statsContent}
      >
        {/* The tab bar sits OUTSIDE the scrolling pane, so tall content cannot
            drag it out of the card; the description follows the active pane. */}
        <SegmentedTabs
          items={tabs}
          value={tab}
          onChange={setTab}
          label={t('statsTabsLabel')}
          className={styles.statsTabs}
        />
        <div
          ref={paneRef}
          className={styles.statsPane}
          role="tabpanel"
          id={activeTab.panelId}
          aria-labelledby={activeTab.id}
        >
        {/* A later refresh failed: the numbers below are the last good ones. */}
        {stale && <p className={shared.statusStale} role="status" data-testid="stats-stale">{staleText}</p>}
        {tab === 'usage' ? (
          status?.usage == null
            ? <p className={shared.status}>{error !== null && status === null ? t('statsError') : t('usageNoStore')}</p>
            : <UsagePanel usage={status.usage} t={t} onClear={clearUsage} />
        ) : (
        <>
        <div className={shared.statsSummary}>
          <span className={shared.statsChip}>{poolOff ? t('footerDisabled') : t('footerUsable', { usable, total })}</span>
          <span className={shared.statsChip}>{t('statsSummaryRequests', { count: totals.requests.toLocaleString() })}</span>
          <span className={shared.statsChip}>{t('statsSummaryTokens', { count: compact(totals.tokens) })}</span>
          {totals.speed > 0 && (
            <span className={shared.statsChip}>{t('statsSummarySpeed', { count: totals.speed.toLocaleString() })}</span>
          )}
          <span className={shared.statsChip}>{t('statsSummaryInflight', { count: totals.inFlight })}</span>
          <span className={shared.statsChip}>{t('statsSummaryLocal', { count: (status?.local?.requests ?? 0).toLocaleString() })}</span>
          <span className={shared.statsChip}>{t('statsSummaryDirect', { count: status?.direct.requests ?? 0 })}</span>
          {/* 订阅 refresh belongs to the exit view, at the row's trailing edge. */}
          {hasSubscriptions && (
            <Button
              variant="outline"
              size="sm"
              className={styles.statsSummaryAction}
              data-testid="stats-refresh-subscriptions"
              disabled={busy !== ''}
              title={t('statsRefreshSubscriptionsHint')}
              onClick={() => { void refreshSubscriptions() }}
            >
              {t('subscriptionRefreshNow')}
            </Button>
          )}
        </div>
        {poolOff && (
          <p className={shared.status}>
            {/* Three different faults used to share one sentence: the switch is
                off, the routing layer yielded to another dispatcher plugin (R1),
                or the pool never assembled at all. */}
            {status?.deferredReason !== undefined && status.deferredReason !== ''
              ? t('statsPoolDeferred', { reason: status.deferredReason })
              : status?.runtimeReady === false
                ? t('statsPoolNotReady')
                : t('statsPoolOff')}
          </p>
        )}
        {!poolOff && (status?.composedUnder ?? '') !== '' && (
          <p className={shared.status}>
            {/* Both layers live on one request: the composer masks the body
                first, then this router picks the exit. Worth saying out loud —
                it is the difference between "the pool yielded" and "both work". */}
            {t('statsPoolComposed', { under: status?.composedUnder ?? '' })}
          </p>
        )}
        {!poolOff && rows.length === 0 && (status?.local?.requests ?? 0) === 0 ? (
          <p className={shared.status}>{error !== null && status === null ? t('statsError') : t('statsEmpty')}</p>
        ) : (
          <div className={styles.statsWrap}>
            <table className={styles.statsTable}>
              <thead>
                <tr>
                  <th>{t('statsColIp')}</th>
                  <th>{t('statsColRegion')}</th>
                  <th>{t('statsColState')}</th>
                  {sortableHeader('requests', t('statsColRequests'))}
                  {sortableHeader('input', t('statsColInput'))}
                  {sortableHeader('output', t('statsColOutput'))}
                  {sortableHeader('cache', t('statsColCache'))}
                  {sortableHeader('latency', t('statsColLatency'))}
                  <th>{t('statsColLastUsed')}</th>
                  <th>{t('statsColActions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((exit) => {
                  const usableRow = isUsable(exit) && exit.demoted !== true
                  const dotClass = usableRow
                    ? styles.statsDotOk
                    : exit.state === 'dead'
                      ? styles.statsDotBad
                      : styles.statsDotWarn
                  const stateLabel = exit.demoted === true
                    ? t('stateDemoted')
                    : usableRow
                      ? t('statsStateUsable')
                      : exit.cooling
                        ? t('stateCooling')
                        : exit.state === 'dead'
                          ? t('stateDead')
                          : t('statsStateUnverified')
                  return (
                    <tr key={exit.id} className={usableRow ? undefined : styles.statsRowMuted}>
                      {/* The location rides the IP cell as a tooltip. */}
                      <td className={shared.mono} title={exit.exitLocation || undefined}>
                        {/* A never-verified exit has no exit IP: its local
                            endpoint (the row id) follows the dash, muted. */}
                        {exit.exitIP !== '' ? exit.exitIP : t('statsNever')}
                        {exit.pinned ? ` · ${t('exitPinnedMark')}` : ''}
                        {exit.exitIP === '' && <span className={styles.statsEndpoint}>{exit.id}</span>}
                      </td>
                      <td className={styles.statsRegion} title={exit.exitLocation || undefined}>
                        {regionCode(exit.exitLocation) || t('statsNever')}
                      </td>
                      <td>
                        <span className={`${styles.statsDot} ${dotClass}`} aria-hidden="true" />
                        {stateLabel}
                      </td>
                      <td>{exit.requests.toLocaleString()}</td>
                      <td>{compact(exit.tokens.inputTokens)}</td>
                      <td className={styles.statsOutputCell}>
                        {compact(exit.tokens.outputTokens)}
                        {(exit.speed ?? 0) > 0 && (
                          <span className={styles.statsEndpoint}>{t('statsSpeedNote', { count: (exit.speed ?? 0).toLocaleString() })}</span>
                        )}
                      </td>
                      <td>{cacheTotal(exit.tokens) > 0 ? compact(cacheTotal(exit.tokens)) : '—'}</td>
                      <td>{exit.latencyMs > 0 ? `${exit.latencyMs}ms` : t('statsNever')}</td>
                      <td>
                        {exit.inFlight > 0 && (
                          <span className={styles.statsInflight}>{t('statsInflight', { count: exit.inFlight })}</span>
                        )}
                        {timeLabel(exit.lastUsedAt, t('statsNever'))}
                      </td>
                      {/* Two ICON actions: 固定 pins the pool's traffic to this
                          exit (through the bridge); 轮换 hands the row to the
                          candidate list. The words live in tooltip and label. */}
                      <td className={styles.statsActions}>
                        <span className={shared.actionGroup}>
                        {exit.pinned ? (
                          <button
                            type="button"
                            className={`${styles.rowAction} ${styles.rowActionActive}`}
                            disabled={busy !== ''}
                            title={t('statsUnpinHint')}
                            aria-label={t('statsUnpin')}
                            onClick={() => { void runExitAction('unpin') }}
                          >
                            <UnpinIcon />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={styles.rowAction}
                            disabled={busy !== ''}
                            title={t('statsPinHint')}
                            aria-label={t('statsPin')}
                            onClick={() => { void runExitAction('pin', exit.id) }}
                          >
                            <PinIcon />
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.rowAction}
                          disabled={busy !== ''}
                          title={t('statsRotateHint')}
                          aria-label={t('statsRotate')}
                          onClick={() => { void runExitAction('rotate', exit.id) }}
                        >
                          <RotateIcon />
                        </button>
                        </span>
                      </td>
                    </tr>
                  )
                })}
                <tr className={styles.statsRowLocal} data-local-egress>
                  <td className={shared.mono}>{t('statsLocalIp')}</td>
                  <td>{t('statsNever')}</td>
                  <td>
                    {/* Green, like a usable exit: this machine IS a working egress. */}
                    <span className={`${styles.statsDot} ${styles.statsDotOk}`} aria-hidden="true" />
                    {t('statsLocalState')}
                  </td>
                  <td>{(status?.local?.requests ?? 0).toLocaleString()}</td>
                  <td>{status?.local === undefined ? t('statsNever') : compact(status.local.tokens.inputTokens)}</td>
                  <td className={styles.statsOutputCell}>
                    {status?.local === undefined ? t('statsNever') : (
                      <>
                        {compact(status.local.tokens.outputTokens)}
                        {(status.local.speed ?? 0) > 0 && (
                          <span className={styles.statsEndpoint}>{t('statsSpeedNote', { count: (status.local.speed ?? 0).toLocaleString() })}</span>
                        )}
                      </>
                    )}
                  </td>
                  <td>{status?.local === undefined || cacheTotal(status.local.tokens) === 0 ? '—' : compact(cacheTotal(status.local.tokens))}</td>
                  <td>{t('statsNever')}</td>
                  <td>{timeLabel(status?.local?.lastUsedAt ?? 0, t('statsNever'))}</td>
                  {/* 固定 on the 本机 row pins local egress itself: no exit at all. */}
                  <td className={styles.statsActions}>
                    <span className={shared.actionGroup}>
                    {status?.pinned?.local === true ? (
                      <button
                        type="button"
                        className={`${styles.rowAction} ${styles.rowActionActive}`}
                        disabled={busy !== ''}
                        title={t('statsUnpinHint')}
                        aria-label={t('statsUnpin')}
                        onClick={() => { void runExitAction('unpin') }}
                      >
                        <UnpinIcon />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.rowAction}
                        disabled={busy !== ''}
                        title={t('statsPinLocalHint')}
                        aria-label={t('statsPin')}
                        onClick={() => { void runExitAction('pin-local') }}
                      >
                        <PinIcon />
                      </button>
                    )}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        </>
        )}
        </div>
        {/* The outcome toast docks at the modal card's bottom-right corner;
            `key` restarts the show cycle when the same text fires twice. */}
        {note !== null && (
          <div
            key={note.seq}
            className={note.warn ? `${styles.statsToast} ${styles.statsToastWarn}` : styles.statsToast}
            style={{ '--stats-toast-hold': `${TOAST_HOLD_MS}ms` } as CSSProperties}
            role="status"
          >
            {note.text}
          </div>
        )}
      </Modal>
    </>
  )
}
