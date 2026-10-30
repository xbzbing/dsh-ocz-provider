import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IpPoolCardLocale, PoolStatusView } from './types.ts'
import styles from './form.module.css'

/** Pool overview strip: counts plus deferred / pinned / pin-skipped badges. */
export function OverviewBar(props: { status: PoolStatusView | null; t: IpPoolCardLocale }): ReactNode {
  const { status, t } = props
  if (status === null) return null
  return (
    <div className={styles.overviewBar} data-testid="ip-pool-overview">
      {status.deferredReason !== '' && (
        <Tag tone="danger">{t('deferredNotice').replace('{reason}', status.deferredReason)}</Tag>
      )}
      <span>{t('poolAvailable')
        .replace('{available}', String(status.availableTotal))
        .replace('{total}', String(status.total))
        .replace('{poolSize}', String(status.poolSize))}</span>
      <span>
        {t('poolSources')
          .replace('{manual}', String(status.bySource.manual))
          .replace('{subscription}', String(status.bySource.subscription))}
      </span>
      {status.pinned !== null && (
        <Tag tone="info">
          {/* A 本机 pin has no exit address, so the badge says what it does. */}
          {status.pinned.local === true ? t('pinnedBadgeLocal') : t('pinnedBadge')}
          {status.pinned.strict && status.pinned.local !== true ? ' (' + t('pinnedStrict') + ')' : ''}
        </Tag>
      )}
      {/* The pin badge stays while its row is out of service, so the strip
          must also say the requests are going elsewhere. */}
      {status.pinned !== null && status.pinned.local !== true && status.pinnedSkip != null && (
        <Tag tone="danger">
          {t(status.pinnedSkip === 'dead' ? 'pinnedSkipDead' : 'pinnedSkipCooling')
            .replace('{id}', status.pinned.id)}
        </Tag>
      )}
    </div>
  )
}
