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
import type { ReactNode } from 'react'

import type { IpPoolCardLocale } from './IpPoolCard.tsx'
import type { TokenTotalsView, UsageView } from './IpPoolCard.tsx'
import styles from './ip-pool.module.css'

/** The all-in token figure the UI shows (input + output + cache read/write). */
function grandTotal(tokens: TokenTotalsView): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
}

/** Compact token label: 1_234_567 → 1.2M, 856 → 856. */
function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** Output speed in tok/s over a cumulative decode window (0 = nothing timed). */
function speedOf(outputTokens: number, outputMs: number): number {
  if (outputMs <= 0 || outputTokens <= 0) return 0
  return Math.round((outputTokens * 1000) / outputMs)
}

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
  /** Days charted in the bar list (default 14). */
  windowDays?: number
}

/**
 * One ledger view: chips, daily bars, top sessions, project roll-up.
 * @param props - the ledger view, the bound locale, the chart window.
 * @returns the panel body (no tab chrome of its own).
 */
export function UsagePanel({ usage, t, windowDays = 14 }: UsagePanelProps): ReactNode {
  const days = usage.days.slice(-windowDays)
  const heaviest = days.reduce((max, row) => Math.max(max, row.tokens), 0)
  const scoped = usage.scoped
  const speed = speedOf(scoped.outputTokens, scoped.outputMs ?? 0)
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
      </div>

      <div className={styles.usageSection}>
        <span className={styles.usageSectionTitle}>{t('usageDailyTitle')}</span>
        {days.length === 0
          ? <p className={styles.status}>{t('usageDailyEmpty')}</p>
          : (
            <ul className={styles.dayList}>
              {days.map((row) => (
                <li key={row.day} className={styles.dayRow}>
                  <span className={styles.dayLabel}>{shortDay(row.day)}</span>
                  {/* Bar width is the day's share of the heaviest day in the
                      window; the value column carries the real number so the
                      bar only has to rank. */}
                  <span className={styles.dayTrack}>
                    <span
                      className={styles.dayBar}
                      style={{ width: `${heaviest === 0 ? 0 : Math.max(2, Math.round((row.tokens / heaviest) * 100))}%` }}
                    />
                  </span>
                  <span className={styles.dayValue}>{compact(row.tokens)} tok</span>
                  <span className={styles.dayRequests}>{t('usageRequestsShort', { count: row.requests.toLocaleString() })}</span>
                </li>
              ))}
            </ul>
          )}
      </div>

      <div className={styles.usageSection}>
        <span className={styles.usageSectionTitle}>{t('usageTopSessions')}</span>
        {sessions.length === 0
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
                        {/* The label is the conversation's first user turn —
                            without it the row is an opaque id. The full id
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
          )}
      </div>

      {projects.length > 0 && (
        <div className={styles.usageSection}>
          <span className={styles.usageSectionTitle}>{t('usageProjectsTitle')}</span>
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
        </div>
      )}

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
