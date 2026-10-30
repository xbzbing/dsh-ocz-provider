import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Group, type GroupFormProps } from '../fields/Group.tsx'
import { ListEditor } from '../fields/ListEditor.tsx'
import { TextField } from '../fields/TextField.tsx'
import type { FormValidationFailure } from '../form-model.ts'
import type { PoolStatusView } from '../types.ts'
import shared from '../shared.module.css'
import styles from '../form.module.css'

/** 出口来源: manual proxies, subscriptions and their fetch/convert settings. */
export function SourcesGroup(props: GroupFormProps & {
  validation: FormValidationFailure | null
  subscription: PoolStatusView['subscription'] | undefined
  /** The pool runtime is running, so /probe can act. */
  poolRunning: boolean
  actionBusy: boolean
  onRefreshSubscriptions: () => void
}): ReactNode {
  const { form, edit, locked, t, chrome, validation, subscription, poolRunning, actionBusy, onRefreshSubscriptions } = props
  // Folded summaries read the DRAFT, so folding still confirms the edit.
  const summary = [
    form.manual.length > 0 ? t('summaryProxies', { count: String(form.manual.length) }) : '',
    form.subscriptionUrls.length > 0 ? t('summarySubscriptions', { count: String(form.subscriptionUrls.length) }) : '',
  ].filter((part) => part !== '').join(' · ') || t('summaryUnset')
  return (
    <Group id="sources" title={t('groupSources')} summary={summary} {...chrome}>
      <span className={styles.fieldLabel}>{t('sectionManual')}</span>
      <ListEditor
        addLabel={t('sectionManual')}
        hint={t('manualHint')}
        values={form.manual}
        placeholder={t('manualPlaceholder')}
        testId="field-manual"
        disabled={locked}
        t={t}
        onChange={(next) => edit({ manual: next })}
      />
      <span className={styles.fieldLabel}>{t('sectionSubscription')}</span>
      <ListEditor
        addLabel={t('sectionSubscription')}
        hint={t('subscriptionHint')}
        values={form.subscriptionUrls}
        placeholder={t('subscriptionPlaceholder')}
        testId="field-subscriptions"
        redacted
        disabled={locked}
        t={t}
        onChange={(next) => edit({ subscriptionUrls: next })}
      />
      <TextField
        label={t('subscriptionRefreshMs')}
        hint={t('subscriptionRefreshMsHint')}
        value={form.refreshMs}
        testId="field-refreshMs"
        type="number"
        min={60_000}
        step={1}
        width="medium"
        invalid={validation?.group === 'sources' && validation.reason === 'invalidRange'}
        disabled={locked}
        onChange={(value) => edit({ refreshMs: value })}
        action={(
          <Button
            variant="outline"
            size="sm"
            data-testid="refresh-subscriptions"
            disabled={actionBusy || !poolRunning}
            onClick={onRefreshSubscriptions}
          >
            {t('subscriptionRefreshNow')}
          </Button>
        )}
      />
      <TextField
        label={t('subscriptionUserAgent')}
        hint={t('subscriptionUserAgentHint')}
        value={form.userAgent}
        testId="field-subscriptionUserAgent"
        width="medium"
        disabled={locked}
        onChange={(value) => edit({ userAgent: value })}
      />
      {subscription != null && (
        <span className={shared.status}>
          {t('subscriptionStatus', {
            label: t('sectionSubscription'),
            pending: String(subscription.pendingConversion),
            admitted: String(subscription.convertedAdmitted),
          })}
          {subscription.lastError !== '' ? ` · ${subscription.lastError}` : ''}
        </span>
      )}
      <TextField
        label={t('singboxPath')}
        hint={t('singboxPathHint')}
        value={form.singboxPath}
        testId="field-singboxPath"
        width="medium"
        disabled={locked}
        onChange={(value) => edit({ singboxPath: value })}
      />
    </Group>
  )
}
