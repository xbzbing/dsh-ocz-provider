import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseFillMedium, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { redactUrl } from '../form-model.ts'
import type { IpPoolCardLocale } from '../types.ts'
import styles from '../form.module.css'

/** Stable React keys for a list that may hold duplicates: value plus occurrence. */
function entryKeys(values: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return values.map((entry) => {
    const nth = seen.get(entry) ?? 0
    seen.set(entry, nth + 1)
    return `${nth}:${entry}`
  })
}

/**
 * One editable string list (manual proxies / subscription URLs / probe
 * contents): one capsule row per entry with a remove button, then an Input +
 * 添加 Button (Enter also adds). A duplicate add is refused with an inline
 * note; a fresh add flashes the new row. Removal is by position, so a stored
 * duplicate goes one row at a time.
 */
export function ListEditor(props: {
  label?: string
  /** Accessible name of the add input; defaults to `label`. */
  addLabel?: string
  hint: string
  values: string[]
  placeholder: string
  testId: string
  /** Show scheme + host only (subscription URLs carry tokens). */
  redacted?: boolean
  disabled?: boolean
  t: IpPoolCardLocale
  onChange: (next: string[]) => void
}): ReactNode {
  const { label, addLabel, hint, values, placeholder, testId, redacted, disabled, t, onChange } = props
  const [draft, setDraft] = useState('')
  const [dup, setDup] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (freshTimer.current !== null) clearTimeout(freshTimer.current) }, [])
  const add = (): void => {
    const entry = draft.trim()
    if (entry === '') return
    if (values.includes(entry)) {
      setDup(true)
      return
    }
    setDup(false)
    onChange([...values, entry])
    setDraft('')
    setFresh(entry)
    if (freshTimer.current !== null) clearTimeout(freshTimer.current)
    freshTimer.current = setTimeout(() => setFresh(null), 400)
  }
  const keys = entryKeys(values)
  return (
    <div className={styles.field} data-testid={testId}>
      {label !== undefined && label !== '' && <span className={styles.fieldLabel}>{label}</span>}
      <span className={styles.fieldHint}>{hint}</span>
      {values.length > 0 && (
        <ul className={styles.listItems}>
          {values.map((entry, index) => (
            <li key={keys[index]} className={entry === fresh ? `${styles.listItem} ${styles.listItemNew}` : styles.listItem}>
              <span className={styles.listItemText}>
                {redacted === true ? redactUrl(entry) : entry}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled === true}
                aria-label={t('listRemove')}
                title={t('listRemove')}
                onClick={() => { setDup(false); onChange(values.filter((_, at) => at !== index)) }}
              >
                <IconCloseFillMedium />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.listAddRow}>
        <Input
          className={styles.listAddInput}
          value={draft}
          placeholder={placeholder}
          aria-label={addLabel ?? label}
          disabled={disabled === true}
          onChange={(event) => { setDraft(event.target.value); if (dup) setDup(false) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }}
        />
        <Button variant="outline" size="sm" disabled={disabled === true || draft.trim() === ''} onClick={add}>
          {t('listAdd')}
        </Button>
      </div>
      {dup && <span className={styles.listDup} role="status">{t('listExists')}</span>}
    </div>
  )
}
