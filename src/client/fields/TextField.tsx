import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from '../form.module.css'

/** One labeled input (the Input primitive carries the box chrome). */
export function TextField(props: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  testId?: string
  type?: 'text' | 'number'
  min?: number
  max?: number
  step?: number
  invalid?: boolean
  disabled?: boolean
  /** A trailing action on the label line (立即刷新 / 解除固定); falsy = none. */
  action?: ReactNode
  /** Width tier: `narrow` for bare numbers, `medium` for paths/URLs/UA; omitted = full column. */
  width?: 'narrow' | 'medium'
}): ReactNode {
  const { label, hint, value, onChange, placeholder, testId, type = 'text', min, max, step, invalid, disabled, action, width } = props
  const widthClass = width === 'narrow' ? styles.fieldControlNarrow : width === 'medium' ? styles.fieldControlMedium : undefined
  const controlClass = [styles.fieldControl, widthClass, invalid === true ? styles.inputWrapInvalid : undefined].filter(Boolean).join(' ')
  return (
    <label className={styles.field}>
      {action == null
        ? <span className={styles.fieldLabel}>{label}</span>
        : (
          <span className={styles.fieldHead}>
            <span className={styles.fieldLabel}>{label}</span>
            <span className={styles.fieldHeadAction}>{action}</span>
          </span>
        )}
      <Input
        className={controlClass}
        type={type}
        value={value}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint !== undefined && <span className={styles.fieldHint}>{hint}</span>}
    </label>
  )
}
