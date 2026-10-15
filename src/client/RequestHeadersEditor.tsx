import type { ReactNode } from 'react'
import type { IpPoolCardLocale } from './IpPoolCard.tsx'
import styles from './ip-pool.module.css'

/** Zen headers have their own section, independent of the IP pool's enabled state. */
export function RequestHeadersEditor(props: {
  text: string
  effectiveUserAgent?: string
  disabled: boolean
  t: IpPoolCardLocale
  onChange(text: string): void
}): ReactNode {
  const { text, effectiveUserAgent, disabled, t, onChange } = props
  return (
    <section className={styles.section} aria-labelledby="zen-headers-title">
      <h3 id="zen-headers-title" className={styles.sectionTitle}>{t('requestHeadersTitle')}</h3>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('requestHeadersLabel')}</span>
        <textarea
          className={styles.textarea}
          data-testid="field-requestHeaders"
          aria-describedby="zen-headers-hint"
          rows={4}
          spellCheck={false}
          disabled={disabled}
          value={text}
          placeholder={'User-Agent: opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/node.js/24\nx-opencode-client: desktop'}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <span id="zen-headers-hint" className={styles.fieldHint}>{t('requestHeadersHint')}</span>
      <p className={styles.status} data-testid="zen-effective-user-agent" aria-live="polite">
        {t('requestHeadersEffectiveUA')} <code className={styles.headerValue}>{effectiveUserAgent ?? t('statusLoading')}</code>
      </p>
    </section>
  )
}
