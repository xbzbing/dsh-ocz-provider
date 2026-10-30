import { useId, type ReactNode } from 'react'
import type { IpPoolCardLocale } from './types.ts'
import shared from './shared.module.css'
import styles from './form.module.css'

/**
 * Zen headers editor body — no section chrome of its own: the collapsible
 * 「Zen 请求头」 group supplies the title, so this renders only the field,
 * its hint and the effective-UA readout.
 */
export function RequestHeadersEditor(props: {
  text: string
  effectiveUserAgent?: string
  disabled: boolean
  t: IpPoolCardLocale
  onChange(text: string): void
}): ReactNode {
  const { text, effectiveUserAgent, disabled, t, onChange } = props
  const hintId = useId()
  return (
    <>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('requestHeadersLabel')}</span>
        <textarea
          className={styles.textarea}
          data-testid="field-requestHeaders"
          aria-describedby={hintId}
          rows={4}
          spellCheck={false}
          disabled={disabled}
          value={text}
          placeholder={'User-Agent: opencode/latest/2.2.0/cli'}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <span id={hintId} className={styles.fieldHint}>{t('requestHeadersHint')}</span>
      <p className={shared.status} data-testid="zen-effective-user-agent" aria-live="polite">
        {t('requestHeadersEffectiveUA')} <code className={styles.headerValue}>{effectiveUserAgent ?? t('statusLoading')}</code>
      </p>
    </>
  )
}
