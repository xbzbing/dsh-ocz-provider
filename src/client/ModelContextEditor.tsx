import { useId, type ReactNode } from 'react'
import type { IpPoolCardLocale } from './types.ts'
import shared from './shared.module.css'
import styles from './form.module.css'

/**
 * 模型上下文 editor body — no section chrome of its own: the collapsible
 * 「模型上下文」 group supplies the title, so this renders only the field, its
 * hint and the saved-entry count.
 */
export function ModelContextEditor(props: {
  text: string
  disabled: boolean
  t: IpPoolCardLocale
  onChange(text: string): void
}): ReactNode {
  const { text, disabled, t, onChange } = props
  const count = text.split('\n').filter((line) => line.trim() !== '').length
  const hintId = useId()
  return (
    <>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('modelContextLabel')}</span>
        <textarea
          className={styles.textarea}
          data-testid="field-modelContextWindows"
          aria-describedby={hintId}
          rows={4}
          spellCheck={false}
          disabled={disabled}
          value={text}
          placeholder={'mimo-v2.6-flash-free = 1048576\nbig-pickle = 1048576'}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <span id={hintId} className={styles.fieldHint}>{t('modelContextHint')}</span>
      <p className={shared.status} data-testid="model-context-count">
        {t('modelContextCount', { count: String(count) })}
      </p>
    </>
  )
}
