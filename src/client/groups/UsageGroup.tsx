import type { ReactNode } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { Group, type GroupChrome } from '../fields/Group.tsx'
import type { IpPoolCardLocale, UsageScopeView, UsageView } from '../types.ts'
import { compact, grandTotal } from '../usage-format.ts'
import shared from '../shared.module.css'
import styles from '../form.module.css'

/**
 * 用量: the usage-scope switch plus the scoped totals. The switch is a view
 * switch written immediately by the card, not a draft edit.
 */
export function UsageGroup(props: {
  scope: UsageScopeView
  usage: UsageView | null | undefined
  disabled: boolean
  t: IpPoolCardLocale
  chrome: GroupChrome
  onScope: (next: UsageScopeView) => void
}): ReactNode {
  const { scope, usage, disabled, t, chrome, onScope } = props
  const summary = usage == null
    ? t('summaryUsageNone')
    : t('summaryUsage', {
      requests: usage.scoped.requests.toLocaleString(),
      tokens: compact(grandTotal(usage.scoped)),
    })
  return (
    <Group id="usage" title={t('groupUsage')} summary={summary} {...chrome}>
      <div data-testid="usage-section">
        {/* .field keeps the hint on its own line under the control. */}
        <div className={styles.field}>
          <span data-testid="usage-scope">
            <SegmentedControl<UsageScopeView>
              id="ip-pool-usage-scope"
              value={scope}
              options={[
                { value: 'total', label: t('usageScopeTotal') },
                { value: 'run', label: t('usageScopeRun') },
              ]}
              label={t('usageScopeLabel')}
              disabled={disabled}
              onChange={onScope}
            />
          </span>
          <span className={styles.fieldHint}>
            {t('usageScopeHint', { days: String(usage?.retentionDays ?? 90) })}
          </span>
        </div>
        {usage == null
          ? <span className={shared.status}>{t('usageNoStore')}</span>
          : (
            <div className={shared.statsSummary}>
              <span className={shared.statsChip}>{t('statsSummaryRequests', { count: usage.scoped.requests.toLocaleString() })}</span>
              <span className={shared.statsChip}>{t('statsSummaryTokens', { count: compact(grandTotal(usage.scoped)) })}</span>
              {(usage.recentSpeed ?? 0) > 0 && (
                <span className={shared.statsChip}>{t('statsSummarySpeed', { count: (usage.recentSpeed ?? 0).toLocaleString() })}</span>
              )}
              <span className={shared.statsChip}>{t('usageSummarySessions', { count: usage.sessions.length.toLocaleString() })}</span>
              <span className={shared.statsChip}>{t('usageSummaryDays', { count: usage.days.length.toLocaleString() })}</span>
            </div>
          )}
      </div>
    </Group>
  )
}
