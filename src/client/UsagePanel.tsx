/**
 * The exit-stats modal's 流量 tab (live request 2026-10-14): what this machine
 * spent, broken down the way the operator asked for — per day, per session, and
 * rolled up per project.
 *
 * Everything here reads the persistent ledger through /status (see
 * pool/usage-store.ts); the scope chip says which population is on screen
 * (总览 = the ledger, 本次重启 = this host process), because the switch that
 * chooses it lives on the settings card and the footer is pinned to 总览.
 *
 * Layout: a chip row (totals + tok/s), a bar list of the recent days, then the
 * top sessions and the project roll-up. Bars are plain divs scaled to the
 * heaviest day in the window — no chart dependency, and the table stays
 * readable at the modal's width.
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { IpPoolCardLocale } from './IpPoolCard.tsx'
import type { TokenTotalsView, UsageView } from './IpPoolCard.tsx'
import styles from './ip-pool.module.css'
import { compact, grandTotal } from './usage-format.ts'

/** `2026-10-14` → `10-14` (the year is noise in a 14-day window). */
function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day
}

/** Clock label for a stamp; 0 reads the never placeholder. */
function timeLabel(epoch: number, never: string): string {
  if (epoch <= 0) return never
  return new Date(epoch).toLocaleString()
}

export interface UsagePanelProps {
  usage: UsageView
  t: IpPoolCardLocale
  /**
   * Clear the ledger (live request 2026-10-14: 清空功能按钮). The panel owns the
   * two-step confirm — this is destructive and the button sits next to the
   * numbers it deletes — and the caller owns the bridge call plus the status
   * refresh. Resolves false when the host refused.
   */
  onClear: () => Promise<boolean>
  /** Days charted in the daily column chart (default 14). */
  windowDays?: number
}

/**
 * One ledger view: chips, daily bars, top sessions, project roll-up.
 * @param props - the ledger view, the bound locale, the chart window.
 * @returns the panel body (no tab chrome of its own).
 */
export function UsagePanel({ usage, t, onClear, windowDays = 14 }: UsagePanelProps): ReactNode {
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  /**
   * Which breakdown is on screen (live request 2026-10-18): the Top 会话
   * table and the 项目 roll-up are two views of the same ledger, so they
   * became underline tabs (the host workspace's own 对话/轨迹 idiom) rather
   * than two stacked sections. Default to sessions — the table is the
   * one an operator scans first.
   */
  const [breakdown, setBreakdown] = useState<'sessions' | 'projects'>('sessions')
  const days = usage.days.slice(-windowDays)
  const heaviest = days.reduce((max, row) => Math.max(max, row.tokens), 0)
  const scoped = usage.scoped
  // Recent (3-min window) speed: a live process-level gauge the host
  // computes; same number under every scope, hidden at 0 (live request
  // 2026-10-15, 纯替换口径).
  const speed = usage.recentSpeed ?? 0
  const sessions = usage.sessions
  const projects = usage.projects

  return (
    <div className={styles.usagePanel}>
      <div className={styles.statsSummary}>
        {/* Which population is on screen. The switch itself lives on the
            settings card; without this chip a run-scoped view and an all-time
            view look identical. */}
        <span className={`${styles.statsChip} ${styles.usageScopeChip}`}>
          {usage.scope === 'run' ? t('usageScopeRun') : t('usageScopeTotal')}
        </span>
        <span className={styles.statsChip}>{t('statsSummaryRequests', { count: scoped.requests.toLocaleString() })}</span>
        <span className={styles.statsChip}>{t('statsSummaryTokens', { count: compact(grandTotal(scoped)) })}</span>
        {speed > 0 && <span className={styles.statsChip}>{t('statsSummarySpeed', { count: speed.toLocaleString() })}</span>}
        <span className={styles.statsChip}>{t('usageSummarySessions', { count: sessions.length.toLocaleString() })}</span>
        <span className={styles.statsChip}>{t('usageSummaryDays', { count: usage.days.length.toLocaleString() })}</span>
        {/* 清空 (live request 2026-10-14). Two steps, because it is
            destructive and irreversible: the first click only arms it, and
            the armed state names exactly what goes away. */}
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
        <span className={styles.usageSectionTitle}>{t('usageDailyTitle')}</span>
        {days.length === 0
          ? <p className={styles.status}>{t('usageDailyEmpty')}</p>
          : (
            <ul className={styles.dayChart}>
              {days.map((row) => (
                <li
                  key={row.day}
                  className={styles.dayColumn}
                  title={`${shortDay(row.day)} · ${compact(row.tokens)} tok · ${t('usageRequestsShort', { count: row.requests.toLocaleString() })}`}
                >
                  {/* Bar height is the day's share of the heaviest day in the
                      window; the column carries the real token figure under
                      the date, so the bar only has to rank. The request count
                      lives in the hover title — a third number under every
                      column is what turns a chart back into a table. */}
                  <span className={styles.dayTrack}>
                    <span
                      className={styles.dayBar}
                      style={{ height: `${heaviest === 0 ? 0 : Math.round((row.tokens / heaviest) * 100)}%` }}
                    />
                  </span>
                  <span className={styles.dayLabel}>{shortDay(row.day)}</span>
                  <span className={styles.dayValue}>{compact(row.tokens)} tok</span>
                </li>
              ))}
            </ul>
          )}
      </div>

      {/* The two breakdowns as underline tabs (live request 2026-10-18: 用
          dsh 工作区那种切换方式). The titles live in the tabs themselves, so
          the old per-section headings are gone. */}
      <div className={styles.usageSection}>
        <div className={styles.usageTabs} role="tablist" aria-label={t('usageBreakdownTitle')}>
          {(['sessions', 'projects'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={breakdown === key}
              className={breakdown === key ? `${styles.usageTab} ${styles.usageTabActive}` : styles.usageTab}
              onClick={() => setBreakdown(key)}
            >
              {key === 'sessions' ? t('usageTopSessions') : t('usageProjectsTitle')}
            </button>
          ))}
        </div>
        {breakdown === 'sessions' ? (
          sessions.length === 0
            ? <p className={styles.status}>{t('usageSessionsEmpty')}</p>
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
                              has one (the read-time join in /status; live request
                              2026-10-14 — it used to show part of the prompt),
                              falling back to the recorded first user turn. The
                              full id rides the tooltip. */}
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
