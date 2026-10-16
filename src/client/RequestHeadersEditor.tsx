import type { ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IpPoolCardLocale } from './IpPoolCard.tsx'
import styles from './ip-pool.module.css'

/**
 * Zen headers editor body — no section chrome of its own: the collapsible
 * 「Zen 请求头」 group supplies the title, so this renders only the field,
 * its hint and the effective-UA readout.
 */
export function RequestHeadersEditor(props: {
  text: string
  effectiveUserAgent?: string
  effectiveClient?: string
  desktopMode: boolean
  disabled: boolean
  t: IpPoolCardLocale
  onChange(text: string): void
  onDesktopModeChange(next: boolean): void
}): ReactNode {
  const { text, effectiveUserAgent, effectiveClient, desktopMode, disabled, t, onChange, onDesktopModeChange } = props
  return (
    <>
      <div className={styles.settingRow}>
        <div className={styles.settingRowText}>
          <span className={styles.settingRowTitle}>{t('requestHeadersDesktopMode')}</span>
          <span className={styles.fieldHint}>{t('requestHeadersDesktopModeHint')}</span>
        </div>
        <span className={styles.settingRowControl} data-testid="field-desktopMode">
          <Switch
            checked={desktopMode}
            label={t('requestHeadersDesktopMode')}
            disabled={disabled}
            onChange={onDesktopModeChange}
          />
        </span>
      </div>
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
          placeholder={'User-Agent: opencode/1.19.3 ai/6.0.168 ai-sdk/openai-compatible/2.0.41\nx-opencode-client: desktop'}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <span id="zen-headers-hint" className={styles.fieldHint}>{t('requestHeadersHint')}</span>
      <p className={styles.status} data-testid="zen-effective-user-agent" aria-live="polite">
        {t('requestHeadersEffectiveUA')} <code className={styles.headerValue}>{effectiveUserAgent ?? t('statusLoading')}</code>
      </p>
      <p className={styles.status} data-testid="zen-effective-client" aria-live="polite">
        {t('requestHeadersEffectiveClient')} <code className={styles.headerValue}>{effectiveClient ?? t('statusLoading')}</code>
      </p>
    </>
  )
}
