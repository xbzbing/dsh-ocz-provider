import { useId, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { PinIcon, RotateIcon } from './icons.tsx'
import type { ExitRowView, IpPoolCardLocale, PoolStatusView } from './types.ts'
import shared from './shared.module.css'
import styles from './exit-table.module.css'

/** The state cell: a semantic StateDot plus the label beside it. */
function StateCell(props: { exit: ExitRowView; t: IpPoolCardLocale }): ReactNode {
  const { exit, t } = props
  const cell = (state: 'error' | 'warning' | 'done' | 'idle', label: string): ReactNode => (
    <span className={styles.stateCell}><StateDot state={state} />{label}</span>
  )
  if (exit.state === 'dead') return cell('error', t('stateDead'))
  // The upstream IP flag outranks cooling: it is a reputation verdict that
  // survives rotations, not a minutes-long quota wait.
  if (exit.note === 'abusive') return cell('warning', t('stateAbusive'))
  // Demoted = kept but ranked last (refused upstream, no reserve left).
  if (exit.demoted === true) return cell('warning', t('stateDemoted'))
  if (exit.cooling) return cell('warning', t('stateCooling'))
  if (exit.state === 'ok') return cell('done', t('stateOk'))
  return cell('idle', t('stateUnknown'))
}

/** The 真实流量 cell: compact symbols on screen, the spelled-out counts for hover and screen readers. */
function PassiveCell(props: { passive: ExitRowView['passive']; t: IpPoolCardLocale }): ReactNode {
  const { passive, t } = props
  const failed = passive.dead + passive.transport
  if (passive.ok === 0 && passive.limited === 0 && passive.refused === 0 && failed === 0) return <>—</>
  const label = t('exitPassiveLabel', {
    ok: String(passive.ok),
    limited: String(passive.limited),
    refused: String(passive.refused),
    failed: String(failed),
  })
  return (
    <span title={label}>
      <span aria-hidden="true">{`✓${passive.ok} 429:${passive.limited} 401/403:${passive.refused} ✗:${failed}`}</span>
      <span className={shared.srOnly}>{label}</span>
    </span>
  )
}

/** The settings card's exit table plus the folded model-ban list. */
export function ExitTable(props: {
  status: PoolStatusView | null
  t: IpPoolCardLocale
  busy: boolean
  onProbe: (exitId: string) => void
  onPin: (exitId: string) => void
  onRotate: (exitId: string) => void
}): ReactNode {
  const { status, t, onProbe, onPin, onRotate, busy } = props
  const [bansOpen, setBansOpen] = useState(false)
  const bansId = useId()
  if (status === null) return null
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
                <td className={shared.mono}>{exit.id}{exit.pinned ? ` · ${t('exitPinnedMark')}` : ''}</td>
                <td>{exit.source}</td>
                <td>{exit.latencyMs > 0 ? `${exit.latencyMs}ms` : '—'}</td>
                <td>{exit.latencyMs > 0 ? exit.quality : '—'}</td>
                {/* Location as a hover tooltip on the IP, not a column. */}
                <td className={shared.mono} title={exit.exitLocation || undefined}>{exit.exitIP || '—'}</td>
                <td><StateCell exit={exit} t={t} /></td>
                <td className={shared.mono}><PassiveCell passive={exit.passive} t={t} /></td>
                <td>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => onProbe(exit.id)}>{t('exitProbe')}</Button>
                  {/* The same icon pair as the stats modal: 固定 (padlock) and
                      轮换 (circular arrow). Nothing is deleted: a reserve takes
                      the slot, or the row sinks to the tail. */}
                  <span className={shared.actionGroup}>
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
              <tr><td colSpan={8} className={shared.status}>{t('statusUnavailable')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className={styles.section}>
        <button
          type="button"
          className={styles.collapseToggle}
          aria-expanded={bansOpen}
          aria-controls={bansId}
          onClick={() => setBansOpen((open) => !open)}
        >
          {t(bansOpen ? 'collapse' : 'expand')} · {t('sectionBans')} ({allBans.length})
        </button>
        <div id={bansId} hidden={!bansOpen}>
          {bansOpen && (allBans.length === 0
            ? <span className={shared.status}>{t('bansEmpty')}</span>
            : (
              <ul className={styles.rowList}>
                {allBans.map((ban) => (
                  <li key={`${ban.exitId}|${ban.model}`} className={styles.row}>
                    <span className={styles.rowLabel}>
                      <span className={ban.state === 'banned' ? styles.stateDead : styles.stateCooling}>
                        {ban.state === 'banned' ? t('banBanned') : t('banSuspect')}
                      </span>
                      {' · '}
                      <span className={shared.mono}>{ban.exitId}</span>
                      {' × '}
                      <span className={shared.mono}>{ban.model}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
    </>
  )
}
