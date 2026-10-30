import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconCloseFillMedium, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IpPoolCardLocale } from '../types.ts'
import styles from '../form.module.css'

/** One bridge /models row: S3-verified, or a live-catalog entry. */
export interface ProbeModelRow { id: string; verified: boolean }

/**
 * Probe-model picker over the bridge /models rows: selected models as
 * removable chips above a dropdown of the options. Empty selection = the
 * S3-first default (big-pickle).
 */
export function ModelPicker(props: {
  value: string[]
  hint: string
  models: ProbeModelRow[]
  loading: boolean
  disabled?: boolean
  t: IpPoolCardLocale
  onChange: (next: string[]) => void
}): ReactNode {
  const { value, hint, models, loading, disabled, t, onChange } = props
  const [open, setOpen] = useState(false)
  const toggle = (id: string): void => {
    onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id])
  }
  const triggerLabel = loading ? t('statusLoading') : models.length === 0 ? '—' : t('probeModelPick')
  const items = models.map((row) => ({
    id: row.id,
    label: (
      <>
        {row.id}
        {row.verified === false && <span className={styles.chipSub}> · {t('probeModelUnverified')}</span>}
      </>
    ),
  }))
  return (
    <div className={styles.field} data-testid="field-probeModels">
      <span className={styles.fieldLabel}>{t('probeModels')}</span>
      <span className={styles.fieldHint}>{hint}</span>
      {value.length > 0 && (
        <div className={styles.chipRow}>
          {value.map((id) => {
            const row = models.find((m) => m.id === id)
            return (
              <span key={id} className={styles.chip}>
                <span className={styles.chipText}>
                  {id}
                  {row?.verified === false && <span className={styles.chipSub}>{t('probeModelUnverified')}</span>}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled === true}
                  aria-label={t('listRemove')}
                  title={t('listRemove')}
                  onClick={() => toggle(id)}
                >
                  <IconCloseFillMedium />
                </Button>
              </span>
            )
          })}
        </div>
      )}
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={
          <Button
            variant="outline"
            size="sm"
            data-testid="probe-model-select"
            disabled={disabled === true || loading || models.length === 0}
            onClick={() => setOpen((current) => !current)}
          >
            {triggerLabel}
            <IconChevronDownOutlineRegular />
          </Button>
        }
        items={items}
        selectedIds={value}
        onSelect={(id) => {
          toggle(id)
          setOpen(false)
        }}
        align="start"
        side="bottom"
        portal
      />
      {value.length === 0 && (
        <span className={styles.fieldHint}>{t('probeModelsDefault')}</span>
      )}
    </div>
  )
}
