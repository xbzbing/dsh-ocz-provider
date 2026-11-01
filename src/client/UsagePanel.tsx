/**
 * The exit-stats modal's 流量 tab: what this machine spent, broken down per
 * day, per session, and rolled up per project.
 *
 * Everything here reads the persistent ledger through /status (see
 * pool/usage-store.ts); the scope chip says which population is on screen
 * (总览 = the ledger, 本次重启 = this host process), because the switch that
 * chooses it lives on the settings card and the footer is pinned to 总览.
 *
 * Layout: a chip row (totals + tok/s), a bar list of the last 30 calendar days,
 * then the top sessions and the project roll-up. Bars are plain elements scaled
 * to the heaviest day in the window — no chart dependency, and the table stays
 * readable at the modal's width.
 *
 * The chart owns its own axis: every day of the window gets a column, and a day
 * the ledger never wrote (host off) is a zero bucket, so a 30-day trend keeps
 * its real spacing instead of collapsing the gaps.
 */
import { useId, useState, type ReactNode } from 'react'
import { Button, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'

import type { IpPoolCardLocale, UsageView } from './types.ts'
import shared from './shared.module.css'
import styles from './usage-panel.module.css'
import { compact, grandTotal } from './usage-format.ts'
import { chartDays, shortDay } from './usage-window.ts'

/** Clock label for a stamp; 0 reads the never placeholder. */
function timeLabel(epoch: number, never: string): string {
  if (epoch <= 0) return never
  return new Date(epoch).toLocaleString()
}

export interface UsagePanelProps {
  usage: UsageView
  t: IpPoolCardLocale
  /**
   * Clear the ledger. The panel owns the two-step confirm — this is
   * destructive and the button sits next to the numbers it deletes — and the
   * caller owns the bridge call plus the status refresh. Resolves false when
   * the host refused.
   */
  onClear: () => Promise<boolean>
  /**
   * Days charted in the daily column chart. The chart is a fixed window, not
   * "the days the ledger happens to hold": 30 columns at the modal's width is
   * what the daily trend was asked for.
   */
  windowDays?: number
}

/**
 * One ledger view: chips, daily bars, top sessions, project roll-up.
 * @param props - the ledger view, the bound locale, the chart window.
 * @returns the panel body (no tab chrome of its own).
 */
export function UsagePanel({ usage, t, onClear, windowDays = 30 }: UsagePanelProps): ReactNode {
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  /** Which breakdown is on screen; sessions first, the view an operator scans first. */
  const [breakdown, setBreakdown] = useState<'sessions' | 'projects'>('sessions')
  const tabBase = useId()
  const breakdownTabs: [SegmentedTab<'sessions' | 'projects'>, SegmentedTab<'sessions' | 'projects'>] = [
    { value: 'sessions', label: t('usageTopSessions'), id: `${tabBase}-tab-sessions`, panelId: `${tabBase}-panel-sessions` },
    { value: 'projects', label: t('usageProjectsTitle'), id: `${tabBase}-tab-projects`, panelId: `${tabBase}-panel-projects` },
  ]
  const activeBreakdown = breakdownTabs[breakdown === 'projects' ? 1 : 0]
  const days = chartDays(usage.days, windowDays, new Date())
  /** A 30-day axis is too narrow for the per-column token figure; the hover title carries it. */
  const dense = days.length > 14
  /** Date ticks: ~10 across the window, because one label per column wraps at this width. */
  const labelStep = Math.max(1, Math.round(days.length / 10))
  const heaviest = days.reduce((max, row) => Math.max(max, row.tokens), 0)
  const scoped = usage.scoped
  // Recent (3-min window) speed: a live process-level gauge the host
  // computes; same number under every scope, hidden at 0.
  const speed = usage.recentSpeed ?? 0
  const sessions = usage.sessions
  const projects = usage.projects

  return (
    <div className={styles.usagePanel}>
      <div className={shared.statsSummary}>
        {/* Which population is on screen. The switch itself lives on the
            settings card; without this chip a run-scoped view and an all-time
            view look identical. */}
        <span className={`${shared.statsChip} ${styles.usageScopeChip}`}>
          {usage.scope === 'run' ? t('usageScopeRun') : t('usageScopeTotal')}
        </span>
        <span className={shared.statsChip}>{t('statsSummaryRequests', { count: scoped.requests.toLocaleString() })}</span>
        <span className={shared.statsChip}>{t('statsSummaryTokens', { count: compact(grandTotal(scoped)) })}</span>
        {speed > 0 && <span className={shared.statsChip}>{t('statsSummarySpeed', { count: speed.toLocaleString() })}</span>}
        <span className={shared.statsChip}>{t('usageSummarySessions', { count: sessions.length.toLocaleString() })}</span>
        <span className={shared.statsChip}>{t('usageSummaryDays', { count: usage.days.length.toLocaleString() })}</span>
        {/* 清空: two steps, because it is destructive and irreversible — the
            first click only arms it, and the armed state names exactly what
            goes away. */}
        <span className={styles.usageClear}>
          {confirming ? (
            <>
              <span className={styles.usageClearPrompt}>{t('usageClearConfirm')}</span>
              <button
                type="button"
                className={styles.usageClearDanger}
                data-testid="usage-clear-confirm"
                disabled={clearing}
                onClick={() => {
                  setClearing(true)
                  void onClear().finally(() => { setClearing(false); setConfirming(false) })
                }}
              >
                {t('usageClearYes')}
              </button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="usage-clear-cancel"
                disabled={clearing}
                onClick={() => setConfirming(false)}
              >
                {t('usageClearCancel')}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              data-testid="usage-clear"
              title={t('usageClearHint')}
              onClick={() => setConfirming(true)}
            >
              {t('usageClear')}
            </Button>
          )}
        </span>
      </div>

      <div className={styles.usageSection}>
        <span className={styles.usageSectionTitle}>
          {t('usageDailyTitle')}
          {days.length > 0 && (
            <span className={styles.usageSectionWindow}>{t('usageDailyWindow', { days: String(days.length) })}</span>
          )}
        </span>
        {/* Two empty states: nothing in the window at all, versus a ledger that
            has older days but none inside the last 30 — the second must not read
            as "no data ever recorded". */}
        {days.length === 0
          ? (
            <p className={shared.status}>
              {usage.days.length > 0
                ? t('usageDailyEmptyWindow', { days: String(windowDays) })
                : t('usageDailyEmpty')}
            </p>
          )
          : (
            <ul className={`${styles.dayChart} ${dense ? styles.dayChartDense : ''}`}>
              {days.map((row, index) => {
                const labelled = index % labelStep === 0 || index === days.length - 1
                const requests = t('usageRequestsShort', { count: row.requests.toLocaleString() })
                const detail = `${shortDay(row.day)} · ${row.tokens.toLocaleString()} tok · ${requests}`
                const share = heaviest === 0 ? 0 : Math.round((row.tokens / heaviest) * 100)
                return (
                  <li
                    key={row.day}
                    className={styles.dayColumn}
                    // The readout is a hover popover, so the same sentence has to
                    // exist for assistive tech (and as the no-CSS fallback).
                    aria-label={detail}
                  >
                    <span className={styles.dayTrack}>
                      <span className={styles.dayBar} style={{ height: `${share}%` }} />
                      {/* Sits on the hovered bar's OWN top, so a 2px day answers
                          right above the baseline instead of 88px up. The
                          first/last columns pull it inward, or it would overflow
                          the scrolling pane. */}
                      <span
                        className={`${styles.dayTip} ${index < 3 ? styles.dayTipStart : ''} ${index >= days.length - 3 ? styles.dayTipEnd : ''}`}
                        style={{ bottom: `calc(${share}% + 8px)` }}
                        aria-hidden="true"
                      >
                        <span className={styles.dayTipDate}>{shortDay(row.day)}</span>
                        <span>{t('usageTipTokens', { count: row.tokens.toLocaleString() })}</span>
                        <span>{t('usageTipRequests', { count: row.requests.toLocaleString() })}</span>
                      </span>
                    </span>
                    {/* Every column carries a label box of the SAME height, filled
                        or not: an empty one used to collapse, and with the chart
                        bottom-aligned that floated those columns 14px up — the
                        bars' bottoms have to sit on one line (live 2026-11-01). */}
                    <span className={styles.dayLabel}>{labelled ? shortDay(row.day) : '\u00A0'}</span>
                    {!dense && <span className={styles.dayValue}>{compact(row.tokens)} tok</span>}
                  </li>
                )
              })}
            </ul>
          )}
      </div>

      {/* The two breakdowns as platform tabs (arrow keys, one tab stop); the
          titles live in the tabs themselves. */}
      <div className={styles.usageSection}>
        <SegmentedTabs
          items={breakdownTabs}
          value={breakdown}
          onChange={setBreakdown}
          label={t('usageBreakdownTitle')}
          className={styles.usageTabs}
        />
        <div role="tabpanel" id={activeBreakdown.panelId} aria-labelledby={activeBreakdown.id}>
        {breakdown === 'sessions' ? (
          sessions.length === 0
            ? <p className={shared.status}>{t('usageSessionsEmpty')}</p>
            : (
              <div className={styles.usageTableWrap}>
                <table className={styles.usageTable}>
                  <thead>
                    <tr>
                      <th>{t('usageColSession')}</th>
                      <th>{t('usageColProject')}</th>
                      <th>{t('statsColRequests')}</th>
                      <th>{t('usageColTokens')}</th>
                      <th>{t('statsColLastUsed')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((row) => (
                      <tr key={row.id}>
                        <td>
                          {/* The label is the HOST's session title when the host
                              has one (the read-time join in /status), falling
                              back to the recorded first user turn. The full id
                              rides the tooltip. */}
                          <span className={styles.sessionLabel} title={row.id}>
                            {row.label !== '' ? row.label : t('usageUnlabeled')}
                          </span>
                        </td>
                        <td>
                          {row.project === null
                            ? t('statsNever')
                            : <span className={styles.projectLabel} title={row.project.path}>{row.project.title}</span>}
                        </td>
                        <td>{row.requests.toLocaleString()}</td>
                        <td>{compact(row.tokens)}</td>
                        <td>{timeLabel(row.lastAt, t('statsNever'))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        ) : (
          <ul className={styles.projectList}>
            {projects.map((row) => (
              <li key={row.id} className={styles.projectRow}>
                <span className={styles.projectLabel} title={row.path}>{row.title}</span>
                <span className={styles.projectMeta}>
                  {t('usageProjectMeta', {
                    sessions: row.sessions.toLocaleString(),
                    tokens: compact(row.tokens),
                    requests: row.requests.toLocaleString(),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
        </div>
      </div>

      <p className={styles.usageFootnote}>
        {t('usageFootnote', {
          sessions: usage.stored.sessions.toLocaleString(),
          days: usage.stored.days.toLocaleString(),
          retention: usage.retentionDays.toLocaleString(),
        })}
      </p>
    </div>
  )
}
