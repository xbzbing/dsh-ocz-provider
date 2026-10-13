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
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the sidebar's SlotMap merge (the 'sidebar.footer.action' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BRIDGE_PREFIX, type PoolStatusView, type TokenTotalsView } from './IpPoolCard.tsx'
import styles from './ip-pool.module.css'

/**
 * The display total: input + output + cacheRead + cacheWrite. The tracker's
 * `totalTokens` is the net-new figure (input is normalized to exclude the
 * cache buckets upstream), which read ~3x smaller than the Agent's own
 * all-in count (live 2026-10-13) — the footer and the modal show the
 * all-in number so the two agree; the breakdown stays in the table notes.
 */
function grandTotal(tokens: TokenTotalsView): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
}

/** Cache share of one bucket, for the per-row note (0 hides the note). */
function cacheTotal(tokens: TokenTotalsView): number {
  return tokens.cacheReadTokens + tokens.cacheWriteTokens
}

/**
 * Output speed in tok/s: output tokens over the recorded decode window.
 * A bucket with no timed response (nothing ever streamed, or a host from
 * before the field existed) reads 0 and the caller hides the note.
 */
function outputSpeed(tokens: TokenTotalsView): number {
  const ms = tokens.outputMs ?? 0
  if (ms <= 0 || tokens.outputTokens <= 0) return 0
  return Math.round((tokens.outputTokens * 1000) / ms)
}

export type ExitStatsEntryProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'settings.ip-pool'>

/** Compact token label: 1_234_567 → 1.2M, 856 → 856. */
function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

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

  const totals = useMemo(() => {
    const localRequests = status?.local?.requests ?? 0
    const localTokens = status?.local?.tokens
    const exits = status?.exits ?? []
    const requests = exits.reduce((sum, exit) => sum + exit.requests, 0) + localRequests
    const tokens = exits.reduce((sum, exit) => sum + grandTotal(exit.tokens), 0) + (localTokens === undefined ? 0 : grandTotal(localTokens))
    const inFlight = exits.reduce((sum, exit) => sum + exit.inFlight, 0)
    // Pool-wide output speed: the weighted mean over every timed response
    // (sum output tokens / sum decode window), not an average of averages.
    const outputTokens = exits.reduce((sum, exit) => sum + exit.tokens.outputTokens, 0) + (localTokens?.outputTokens ?? 0)
    const outputMs = exits.reduce((sum, exit) => sum + (exit.tokens.outputMs ?? 0), 0) + (localTokens?.outputMs ?? 0)
    const speed = outputMs > 0 && outputTokens > 0 ? Math.round((outputTokens * 1000) / outputMs) : 0
    return { requests, tokens, inFlight, speed }
  }, [status])

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
  // The pool slot is stamped BEFORE the sort: it is the exit's position in the
  // pool's own order (the onboarding rank, fastest first), so `#` keeps
  // identifying the same slot when the operator sorts by requests or latency.
  // A number that renumbered itself on every sort click would answer a
  // different question than the column is asked.
  const rows = useMemo(() => {
    if (poolOff) return []
    const unknown = Number.POSITIVE_INFINITY
    return (status?.exits ?? [])
      .map((exit, index) => ({ ...exit, slot: index + 1 }))
      .sort((left, right) => {
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
              {t('footerRequests', { count: totals.requests.toLocaleString() })}
              {' · '}
              {compact(totals.tokens)} tok
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
          to the token count the moment a second button squeezes it. The rail
          (wide === false, 56px) always takes the compact span.
        */}
        <span
          className={wide ? styles.footerCompactOnNarrow : styles.footerCompact}
          title={`${t('footerRequests', { count: totals.requests.toLocaleString() })} · ${compact(totals.tokens)} tok`}
        >
          {status === null ? '—' : `${compact(totals.tokens)} tok`}
        </span>
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
                  <th className={styles.statsIndex}>{t('statsColIndex')}</th>
                  <th>{t('statsColIp')}</th>
                  <th>{t('statsColLocation')}</th>
                  <th>{t('statsColState')}</th>
                  {sortableHeader('requests', t('statsColRequests'))}
                  {sortableHeader('input', t('statsColInput'))}
                  {sortableHeader('output', t('statsColOutput'))}
                  {sortableHeader('cache', t('statsColCache'))}
                  {sortableHeader('latency', t('statsColLatency'))}
                  <th>{t('statsColLastUsed')}</th>
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
                      <td className={styles.statsIndex}>{exit.slot}</td>
                      <td className={styles.mono}>
                        {/* An exit that was never verified has no exit IP. The
                            local SOCKS5 endpoint used to be printed here as if
                            it were one (live 2026-10-13: half the table read
                            127.0.0.1:30xxx), so it now sits after an explicit
                            dash, muted, as the debuggable handle it really is. */}
                        {exit.exitIP !== '' ? exit.exitIP : t('statsNever')}
                        {exit.pinned ? ` · ${t('exitPinnedMark')}` : ''}
                        {exit.exitIP === '' && <span className={styles.statsEndpoint}>{exit.id}</span>}
                      </td>
                      <td>{exit.exitLocation || '—'}</td>
                      <td>
                        <span className={`${styles.statsDot} ${dotClass}`} aria-hidden="true" />
                        {stateLabel}
                      </td>
                      <td>{exit.requests.toLocaleString()}</td>
                      <td>{compact(exit.tokens.inputTokens)}</td>
                      <td>
                        {compact(exit.tokens.outputTokens)}
                        {outputSpeed(exit.tokens) > 0 && (
                          <span className={styles.statsEndpoint}>{t('statsSpeedNote', { count: outputSpeed(exit.tokens).toLocaleString() })}</span>
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
                    </tr>
                  )
                })}
                <tr className={styles.statsRowLocal} data-local-egress>
                  <td className={styles.statsIndex}>—</td>
                  <td className={styles.mono}>{t('statsLocalIp')}</td>
                  <td>{t('statsLocalLocation')}</td>
                  <td>
                    <span className={`${styles.statsDot} ${styles.statsDotLocal}`} aria-hidden="true" />
                    {t('statsLocalState')}
                  </td>
                  <td>{(status?.local?.requests ?? 0).toLocaleString()}</td>
                  <td>{status?.local === undefined ? t('statsNever') : compact(status.local.tokens.inputTokens)}</td>
                  <td>
                    {status?.local === undefined ? t('statsNever') : (
                      <>
                        {compact(status.local.tokens.outputTokens)}
                        {outputSpeed(status.local.tokens) > 0 && (
                          <span className={styles.statsEndpoint}>{t('statsSpeedNote', { count: outputSpeed(status.local.tokens).toLocaleString() })}</span>
                        )}
                      </>
                    )}
                  </td>
                  <td>{status?.local === undefined || cacheTotal(status.local.tokens) === 0 ? '—' : compact(cacheTotal(status.local.tokens))}</td>
                  <td>{t('statsNever')}</td>
                  <td>{timeLabel(status?.local?.lastUsedAt ?? 0, t('statsNever'))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </>
  )
}
