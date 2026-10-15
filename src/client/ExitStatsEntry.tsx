/**
 * Sidebar footer entry (bottom-left) + exit-stats modal.
 *
 * The trigger follows the usage-billing footer-card pattern: a headline
 * number (usable exits) with a request-count subline, click to open a
 * centered modal. The modal lists every pool exit sorted BY REQUEST COUNT —
 * the "which exit is actually being used" answer the settings card cannot
 * show at a glance — with per-exit tokens, latency, in-flight markers and
 * last-used stamps, plus pool-wide totals and the direct-fallback bucket.
 *
 * Data rides the plugin's own loopback bridge (the same /status POST the
 * settings card polls), so this entry works whether or not the settings card
 * is mounted and never touches host internals. Counters are process-lifetime:
 * they reset when the host restarts, and the modal says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the sidebar's SlotMap merge (the 'sidebar.footer.action' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BRIDGE_PREFIX, type PoolStatusView, type TokenTotalsView } from './IpPoolCard.tsx'
import { PinIcon, RotateIcon, UnpinIcon } from './icons.tsx'
import { regionCode } from './region.ts'
import { UsagePanel } from './UsagePanel.tsx'
import { compact, grandTotal } from './usage-format.ts'
import styles from './ip-pool.module.css'

/**
 * The display total: input + output + cacheRead + cacheWrite. The tracker's
 * `totalTokens` is the net-new figure (input is normalized to exclude the
 * cache buckets upstream), which read ~3x smaller than the Agent's own
 * all-in count (live 2026-10-13) — the footer and the modal show the
 * all-in number so the two agree; the breakdown stays in the table notes.
 * (The number itself lives in usage-format.ts so the footer, modal and
 * usage panel render the same figure.)
 */

/** Cache share of one bucket, for the per-row note (0 hides the note). */
function cacheTotal(tokens: TokenTotalsView): number {
  return tokens.cacheReadTokens + tokens.cacheWriteTokens
}

export type ExitStatsEntryProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'settings.ip-pool'>

/**
 * The outcome toast's two clocks (live request 2026-10-14: the old note above
 * the table never disappeared on its own). HOLD is full-opacity reading time;
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

/** An exit is "usable" exactly where the pool's pick() would consider it:
 *  probed healthy and not cooling (bans are per-model, so they don't hide a
 *  whole row). */
function isUsable(exit: PoolStatusView['exits'][number]): boolean {
  return exit.state === 'ok' && !exit.cooling
}

/** The sortable columns: request count, the three token buckets, latency. */
type SortKey = 'requests' | 'input' | 'output' | 'cache' | 'latency'

/**
 * One row action the modal can send. `pin-local` is the 本机 row's button:
 * the host owns the sentinel value, so the bundle names the intent, never the
 * spelling (mirrors SETTINGS_NAMESPACE's literal-only rule in client/index.ts).
 *
 * `rotate` was called `remove` until 2026-10-14, when the operator corrected
 * the vocabulary: nothing is deleted — the row is rotated (a reserve takes its
 * place, or it sinks to the pool tail).
 */
type ExitAction = 'pin' | 'pin-local' | 'unpin' | 'rotate'

/** The /exit response's value shape. */
interface ExitActionResult {
  pinned?: string
  local?: boolean
  persisted?: boolean
  /** A reserve was promoted into the rotated row's slot. */
  promoted?: boolean
  /** A rotation round held the rebuild mutex: nothing moved. */
  busy?: boolean
}

/** One exit's value under a sort key. */
function sortMetric(exit: PoolStatusView['exits'][number], key: SortKey): number {
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
  const [status, setStatus] = useState<PoolStatusView | null>(null)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  /** Headline ordering contract: newest click wins, request count is home. */
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'requests', dir: 'desc' })
  /** Which pane the modal shows: the exit table, or the traffic breakdown. */
  const [tab, setTab] = useState<'exits' | 'usage'>('exits')
  /** The row action in flight (its key), so every button disables together. */
  const [busy, setBusy] = useState('')
  /**
   * The last action's outcome, shown as a toast DOCKED at the modal's
   * bottom-right corner (live request 2026-10-14). It used to be a note
   * above the table that stayed until the next action — the green
   * "操作成功" line never went away on its own. `seq` restarts the show
   * cycle when the same text fires twice in a row.
   */
  const [note, setNote] = useState<{ text: string; warn: boolean; seq: number } | null>(null)
  const noteSeq = useRef(0)

  /** Show one outcome toast; every success/failure line funnels through here. */
  const showNote = useCallback((text: string, warn: boolean): void => {
    noteSeq.current += 1
    setNote({ text, warn, seq: noteSeq.current })
  }, [])

  // Auto-dismiss: the toast fades out (CSS delay matches) and unmounts, so no
  // outcome text survives into the next glance at the table.
  useEffect(() => {
    if (note === null) return
    const timer = window.setTimeout(() => setNote(null), TOAST_HOLD_MS + TOAST_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [note])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`${BRIDGE_PREFIX}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const body = await response.json() as { ok: boolean; value?: PoolStatusView }
      if (body.ok && body.value) {
        setStatus(body.value)
        setFailed(false)
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    }
  }, [])

  // The button carries live numbers too: poll gently while closed, tighter
  // while the modal is open (mirrors the settings card's 3s cadence).
  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), open ? 2_000 : 10_000)
    return () => clearInterval(interval)
  }, [open, refresh])

  /**
   * One row action (固定 / 取消固定 / 轮换) over the bridge. The bridge owns the
   * settings write, the live pin and the candidate refill, so this stays a
   * POST plus a re-read — and it reports what actually happened, because
   * "deleted" means two different things (a reserve took the slot, or the row
   * sank to the tail).
   */
  /**
   * Clear the usage ledger (live request 2026-10-14: 清空功能按钮). Same
   * loopback route family as the row actions; the modal re-reads /status
   * afterwards so the chips, the bar list and the footer all drop to zero
   * together.
   */
  const clearUsage = useCallback(async (): Promise<boolean> => {
    setNote(null)
    try {
      const response = await fetch(`${BRIDGE_PREFIX}/usage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
      const body = await response.json() as { ok: boolean; value?: { cleared?: boolean } }
      if (!body.ok || body.value?.cleared !== true) {
        showNote(t('statsActionFailed'), true)
        return false
      }
      showNote(t('usageCleared'), false)
      await refresh()
      return true
    } catch {
      showNote(t('statsActionFailed'), true)
      return false
    }
  }, [refresh, showNote, t])

  const runExitAction = useCallback(async (action: ExitAction, exitId?: string): Promise<void> => {
    setBusy(`${action}:${exitId ?? ''}`)
    setNote(null)
    try {
      const response = await fetch(`${BRIDGE_PREFIX}/exit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'pin-local' || action === 'unpin' ? { action } : { action, exitId }),
      })
      const body = await response.json() as { ok: boolean; value?: ExitActionResult }
      if (!body.ok || body.value === undefined) {
        showNote(t('statsActionFailed'), true)
        return
      }
      const value = body.value
      // A 轮换 that met a running round changed nothing: saying "rotated" there
      // would be a lie, and the operator can just click again.
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
      // A read-only profile still pins live, but the click has to say so: the
      // pin would be lost on the next restart.
      showNote(value.persisted === false
        ? `${text} · ${t('statsActionVolatile')}`
        : text, value.persisted === false)
    } catch {
      showNote(t('statsActionFailed'), true)
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
    // Pool-wide recent (3-min window) output speed, computed host-side from
    // the process tracker's rolling ring (live request 2026-10-15: 口径改为
    // 最近 3 分钟平均, replacing the all-time mean that never moved).
    const speed = status?.recentSpeed ?? 0
    return { requests, tokens, inFlight, speed }
  }, [status])

  /**
   * The footer's own numbers (live request 2026-10-14: 左下角显示总览). The
   * ledger's ALL-TIME totals, never the scope the card's switch selected: the
   * footer is the glanceable "what have I spent" figure, and it has to mean the
   * same thing regardless of what the modal was last left on. Falls back to the
   * live totals when the host serves no ledger.
   */
  const overview = useMemo(() => {
    const ledger = status?.usage
    if (ledger === null || ledger === undefined) return totals
    const all = ledger.total
    const allIn = grandTotal(all)
    return {
      requests: all.requests,
      tokens: allIn,
      inFlight: totals.inFlight,
      // The footer's speed is the same recent-window gauge as the modal's —
      // a live number, not a lifetime average (live request 2026-10-15).
      speed: status?.recentSpeed ?? 0,
    }
  }, [status, totals])

  const usable = status?.availableTotal ?? 0
  const total = status?.total ?? 0
  /**
   * The pool being switched off means no traffic goes through an exit at all,
   * so the exit table is not a view of anything in use — rendering it anyway
   * is how "0/13 available" read as a broken pool instead of "you turned it
   * off" (live 2026-10-13). Off lists the local row alone, exactly what the
   * operator asked for.
   */
  const poolOff = status !== null && status.enabled === false

  // Sorted by the clicked column — request count descending is the home
  // position. An unprobed exit (latency 0) sinks to the bottom under every
  // latency direction: "unknown" is not "fastest".
  //
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

  return (
    <>
      <button
        type="button"
        className={wide ? styles.footerEntry : `${styles.footerEntry} ${styles.footerEntryCompact}`}
        onClick={() => setOpen(true)}
        title={t('footerTitle')}
        aria-haspopup="dialog"
      >
        <span className={styles.footerIcon} aria-hidden="true">◈</span>
        {wide && (
          <span className={styles.footerText}>
            <span className={styles.footerMain}>
              {status === null
                ? t('footerDisabled')
                : poolOff
                  // Pool off = every request leaves from this machine: the
                  // count that matters is "本地直连", not a dead "0/13".
                  ? t('footerLocal')
                  : <>{usable}<span className={styles.footerUnit}> / {total} {t('footerLabel')}</span></>}
            </span>
            <span className={styles.footerSub}>
              {t('footerRequests', { count: overview.requests.toLocaleString() })}
              {' · '}
              {compact(overview.tokens)} tok
              {/* The pool's own decode speed (live request 2026-10-14). Hidden
                  at 0 — nothing has streamed yet, and "0 tok/s" reads as a
                  stall rather than an empty counter. */}
              {overview.speed > 0 && <>{' · '}{t('footerSpeed', { count: overview.speed.toLocaleString() })}</>}
            </span>
          </span>
        )}
        {/*
          Two footer buttons share this row (another plugin's trigger sits on
          the left), and a shared row leaves each button about half as wide —
          the request/token pair stops fitting and the operator asked for just
          the token count there (live 2026-10-13). Which variant is live is a
          layout question, not a state question, so it is answered by the
          button's OWN width through a container query: the wide sidebar keeps
          both numbers when this button has the row to itself, and falls back
          to the compact label the moment a second button squeezes it. The
          rail (wide === false, 56px) always takes the single-line span.
          Live 2026-10-15: the squeezed label became two lines — TODAY's
          tokens on top (what this machine spent since midnight), the
          recent-window tok/s underneath — while the rail keeps its one-line
          all-time count.
        */}
        {wide ? (
          <span
            className={styles.footerCompactOnNarrow}
            title={`${t('footerRequests', { count: overview.requests.toLocaleString() })} · ${compact(status?.todayTokens ?? 0)} tok${overview.speed > 0 ? ` · ${t('footerSpeed', { count: overview.speed.toLocaleString() })}` : ''}`}
          >
            <span className={styles.footerCompactLine}>
              {status === null ? '—' : `${compact(status.todayTokens ?? 0)} tok`}
            </span>
            {/* Hidden at 0 like everywhere else: an empty window means no
                recent traffic, and "0 tok/s" would read as a stall. */}
            {status !== null && overview.speed > 0 && (
              <span className={styles.footerCompactLine}>
                {t('footerSpeed', { count: overview.speed.toLocaleString() })}
              </span>
            )}
          </span>
        ) : (
          <span
            className={styles.footerCompact}
            title={`${t('footerRequests', { count: overview.requests.toLocaleString() })} · ${compact(overview.tokens)} tok${overview.speed > 0 ? ` · ${t('footerSpeed', { count: overview.speed.toLocaleString() })}` : ''}`}
          >
            {status === null ? '—' : `${compact(overview.tokens)} tok`}
          </span>
        )}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('statsTitle')}
        closeLabel={t('statsClose')}
        description={t('statsDescription')}
        className={styles.statsModal}
        contentClassName={styles.statsContent}
      >
        {/* Two panes: the per-exit table, and the persisted traffic
            breakdown (live request 2026-10-14). The tab bar sits above the
            chips so switching panes never moves the modal's own controls. */}
        <div className={styles.tabBar} role="tablist" aria-label={t('statsTitle')}>
          {(['exits', 'usage'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setTab(key)}
            >
              {key === 'exits' ? t('tabExits') : t('tabUsage')}
            </button>
          ))}
        </div>
        {tab === 'usage' ? (
          status?.usage == null
            ? <p className={styles.status}>{t('usageNoStore')}</p>
            : <UsagePanel usage={status.usage} t={t} onClear={clearUsage} />
        ) : (
        <>
        <div className={styles.statsSummary}>
          <span className={styles.statsChip}>{poolOff ? t('footerDisabled') : t('footerUsable', { usable, total })}</span>
          <span className={styles.statsChip}>{t('statsSummaryRequests', { count: totals.requests.toLocaleString() })}</span>
          <span className={styles.statsChip}>{t('statsSummaryTokens', { count: compact(totals.tokens) })}</span>
          {totals.speed > 0 && (
            <span className={styles.statsChip}>{t('statsSummarySpeed', { count: totals.speed.toLocaleString() })}</span>
          )}
          <span className={styles.statsChip}>{t('statsSummaryInflight', { count: totals.inFlight })}</span>
          <span className={styles.statsChip}>{t('statsSummaryLocal', { count: (status?.local?.requests ?? 0).toLocaleString() })}</span>
          <span className={styles.statsChip}>{t('statsSummaryDirect', { count: status?.direct.requests ?? 0 })}</span>
        </div>
        {poolOff && <p className={styles.status}>{t('statsPoolOff')}</p>}
        {!poolOff && rows.length === 0 && (status?.local?.requests ?? 0) === 0 ? (
          <p className={styles.status}>{failed && status === null ? t('statsError') : t('statsEmpty')}</p>
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
                      {/* The location rides the IP cell as a tooltip instead of
                          taking a column of its own (live request 2026-10-14):
                          it is reference data you look up per row, and the table
                          is dense enough that the column cost more than it gave. */}
                      <td className={styles.mono} title={exit.exitLocation || undefined}>
                        {/* An exit that was never verified has no exit IP. The
                            local SOCKS5 endpoint used to be printed here as if
                            it were one (live 2026-10-13: half the table read
                            127.0.0.1:30xxx), so it now sits after an explicit
                            dash, muted, as the debuggable handle it really is. */}
                        {exit.exitIP !== '' ? exit.exitIP : t('statsNever')}
                        {exit.pinned ? ` · ${t('exitPinnedMark')}` : ''}
                        {exit.exitIP === '' && <span className={styles.statsEndpoint}>{exit.id}</span>}
                      </td>
                      {/* Region code, not the full "HK Central": that string is
                          still one hover away on the IP cell (live request
                          2026-10-14). */}
                      <td className={styles.statsRegion} title={exit.exitLocation || undefined}>
                        {regionCode(exit.exitLocation) || t('statsNever')}
                      </td>
                      <td>
                        <span className={`${styles.statsDot} ${dotClass}`} aria-hidden="true" />
                        {stateLabel}
                      </td>
                      <td>{exit.requests.toLocaleString()}</td>
                      <td>{compact(exit.tokens.inputTokens)}</td>
                      <td>
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
                      {/* Two ICON actions (live request 2026-10-14): 固定 pins
                          the whole pool's traffic to this exit (the settings
                          field, written through the bridge) and 轮换 hands the
                          row to the candidate list — a reserve takes the slot,
                          or the row sinks to the tail when there is none. The
                          words live in the tooltip and the aria-label. */}
                      <td className={styles.statsActions}>
                        <span className={styles.actionGroup}>
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
                  <td className={styles.mono}>{t('statsLocalIp')}</td>
                  <td>{t('statsNever')}</td>
                  <td>
                    {/* Green, like a usable exit: this machine IS a working
                        egress, and the old grey dot read as a fault (live
                        request 2026-10-14: "本机的状态也用绿色"). */}
                    <span className={`${styles.statsDot} ${styles.statsDotOk}`} aria-hidden="true" />
                    {t('statsLocalState')}
                  </td>
                  <td>{(status?.local?.requests ?? 0).toLocaleString()}</td>
                  <td>{status?.local === undefined ? t('statsNever') : compact(status.local.tokens.inputTokens)}</td>
                  <td>
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
                  {/* 固定 on the 本机 row pins local egress itself: every request
                      stays on this machine, no exit at all. */}
                  <td className={styles.statsActions}>
                    <span className={styles.actionGroup}>
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
        {/*
          The outcome toast (live request 2026-10-14): docks at the modal's
          own bottom-right corner and dismisses itself — the old note above
          the table stayed green until the next click. Absolute positioning
          anchors to the dialog card (the nearest positioned ancestor), so it
          rides the modal even while the content region scrolls beneath it,
          and `key` restarts the show cycle when the same text fires twice.
        */}
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
