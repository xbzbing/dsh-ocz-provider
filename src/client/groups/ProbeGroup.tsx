import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Group, type GroupFormProps } from '../fields/Group.tsx'
import { ListEditor } from '../fields/ListEditor.tsx'
import { ModelPicker, type ProbeModelRow } from '../fields/ModelPicker.tsx'
import { TextField } from '../fields/TextField.tsx'
import type { FormValidationFailure } from '../form-model.ts'
import type { PoolStatusView } from '../types.ts'
import styles from '../form.module.css'

/** 探活: probe models and contents, concurrency, pool size, 批量探活. */
export function ProbeGroup(props: GroupFormProps & {
  validation: FormValidationFailure | null
  models: ProbeModelRow[]
  modelsLoading: boolean
  prober: PoolStatusView['prober'] | undefined
  /** The pool runtime is running, so /probe can act. */
  poolRunning: boolean
  actionBusy: boolean
  onProbeAll: () => void
}): ReactNode {
  const { form, edit, locked, t, chrome, validation, models, modelsLoading, prober, poolRunning, actionBusy, onProbeAll } = props
  const rangeInvalid = validation?.group === 'probe' && validation.reason === 'invalidRange'
  const probing = prober !== undefined && prober.queued + prober.inFlight > 0
  const summary = [
    form.probeModels.length === 0 ? t('summaryModelsDefault') : t('summaryModelsCount', { count: String(form.probeModels.length) }),
    form.probeContents.length > 0 ? t('summaryContentsCount', { count: String(form.probeContents.length) }) : '',
    t('summaryConcurrency', { count: form.maxConcurrentProbes }),
    t('summaryCapacity', { count: form.poolSize }),
  ].filter((part) => part !== '').join(' · ')
  return (
    <Group id="probe" title={t('groupProbe')} summary={summary} {...chrome}>
      <ModelPicker
        value={form.probeModels}
        hint={t('probeModelsHint')}
        models={models}
        loading={modelsLoading}
        disabled={locked}
        t={t}
        onChange={(next) => edit({ probeModels: next })}
      />
      {/* The smoke's user turn: one line drawn per probe; empty = 'hello'. */}
      <ListEditor
        label={t('probeContents')}
        hint={t('probeContentsHint')}
        values={form.probeContents}
        placeholder={t('probeContentsPlaceholder')}
        testId="field-probeContents"
        disabled={locked}
        t={t}
        onChange={(next) => edit({ probeContents: next })}
      />
      <div className={styles.fieldRow}>
        <TextField
          label={t('probeConcurrency')}
          hint={t('probeConcurrencyHint')}
          value={form.maxConcurrentProbes}
          testId="field-maxConcurrentProbes"
          type="number"
          min={1}
          max={8}
          step={1}
          width="narrow"
          invalid={rangeInvalid}
          disabled={locked}
          onChange={(value) => edit({ maxConcurrentProbes: value })}
        />
        <TextField
          label={t('poolSize')}
          hint={t('poolSizeHint')}
          value={form.poolSize}
          testId="field-poolSize"
          type="number"
          min={1}
          max={100}
          step={1}
          width="narrow"
          invalid={rangeInvalid}
          disabled={locked}
          onChange={(value) => edit({ poolSize: value })}
        />
      </div>
      <div>
        <Button
          variant="outline"
          size="sm"
          data-testid="probe-all"
          disabled={actionBusy || !poolRunning}
          onClick={onProbeAll}
        >
          {probing
            ? t('probeRunning').replace('{done}', String(prober.completed)).replace('{total}', String(prober.enqueued))
            : t('probeAll')}
        </Button>
      </div>
    </Group>
  )
}
