import type { ReactNode } from 'react'
import { Button, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import { Group, type GroupFormProps } from '../fields/Group.tsx'
import { TextField } from '../fields/TextField.tsx'
import styles from '../form.module.css'

/** 调度行为: the pinned exit and the pin mode. */
export function SchedulingGroup(props: GroupFormProps & {
  saving: boolean
  /** 解除固定: the card routes it through the bridge when the pool runs. */
  onUnpin: () => void
}): ReactNode {
  const { form, edit, locked, t, chrome, saving, onUnpin } = props
  const summary = form.pinnedExitId !== ''
    ? t('summaryPinned', { target: form.pinnedExitId })
    : `${t('summaryAuto')}${form.pinnedStrict ? ` · ${t('pinnedModeAbsolute')}` : ''}`
  return (
    <Group id="scheduling" title={t('groupScheduling')} summary={summary} {...chrome}>
      <TextField
        label={t('pinnedAddress')}
        hint={t('pinnedAddressHint')}
        value={form.pinnedExitId}
        placeholder={t('manualPlaceholder')}
        testId="field-pinnedExitId"
        width="medium"
        disabled={locked}
        onChange={(value) => edit({ pinnedExitId: value })}
        action={form.pinnedExitId === '' ? undefined : (
          <Button
            variant="outline"
            size="sm"
            data-testid="unpin"
            disabled={saving}
            onClick={onUnpin}
          >
            {t('pinnedUnset')}
          </Button>
        )}
      />
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('pinnedStrict')}</span>
        <span data-testid="field-pinnedStrict">
          <SegmentedControl<'fallback' | 'absolute'>
            id="ip-pool-pin-mode"
            value={form.pinnedStrict ? 'absolute' : 'fallback'}
            options={[
              { value: 'fallback', label: t('pinnedModeFallback') },
              { value: 'absolute', label: t('pinnedModeAbsolute') },
            ]}
            label={t('pinnedStrict')}
            disabled={locked}
            onChange={(next) => edit({ pinnedStrict: next === 'absolute' })}
          />
        </span>
        <span className={styles.fieldHint}>{form.pinnedStrict ? t('pinnedStrictOn') : t('pinnedStrictOff')}</span>
      </div>
    </Group>
  )
}
