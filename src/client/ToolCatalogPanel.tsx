/**
 * The stats modal's 工具名录 tab: every tool this host has shown the lane, the
 * wire name and description it rides with, and the one thing an operator needs
 * after a dsh upgrade — what moved since the last recorded baseline.
 *
 * The table edits the catalogue, it never edits the lane: a name change here is
 * a wire change, so the row states which description it will send (the official
 * client's own wording, the operator's, or dsh's) beside the action.
 */
import { useId, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IpPoolCardLocale } from './types.ts'
import type { ToolCatalogRowView, ToolCatalogView } from './types.ts'
import shared from './shared.module.css'
import form from './form.module.css'
import styles from './tool-catalog.module.css'

/** Clock label for the baseline stamp; 0 reads the not-recorded copy. */
function stamp(epoch: number, never: string): string {
  if (epoch <= 0) return never
  return new Date(epoch).toLocaleString()
}

/** The state badge: one word per diff bucket. */
function stateLabel(state: ToolCatalogRowView['state'], t: IpPoolCardLocale): string {
  if (state === 'added') return t('toolsStateAdded')
  if (state === 'drifted') return t('toolsStateDrifted')
  if (state === 'renamed') return t('toolsStateRenamed')
  if (state === 'gone') return t('toolsStateGone')
  return t('toolsStateOk')
}

/** Where the description text comes from, in one word. */
function sourceLabel(row: ToolCatalogRowView, t: IpPoolCardLocale): string {
  if (row.descriptionSource === 'custom') return t('toolsSourceCustom')
  if (row.descriptionSource === 'client') return t('toolsSourceClient')
  return t('toolsSourceHost')
}

export interface ToolCatalogPanelProps {
  view: ToolCatalogView | null
  t: IpPoolCardLocale
  /** A write is in flight; every editor button is disabled meanwhile. */
  busy: boolean
  /** Failure text for the last action; '' hides the line. */
  error: string
  onSave(name: string, wire: string, description: string): void
  onReset(name: string): void
  onRecord(): void
}

/**
 * @param props - the catalogue view plus the three write paths.
 * @returns the pane body (no tab chrome of its own).
 */
export function ToolCatalogPanel(props: ToolCatalogPanelProps): ReactNode {
  const { view, t, busy, error, onSave, onReset, onRecord } = props
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [wire, setWire] = useState('')
  const [description, setDescription] = useState('')
  const filterId = useId()

  if (view === null) {
    return <p className={shared.status}>{t('toolsLoading')}</p>
  }
  const needle = filter.trim().toLowerCase()
  const rows = needle === '' ? view.rows : view.rows.filter((row) => row.name.toLowerCase().includes(needle))
  const startEditing = (row: ToolCatalogRowView): void => {
    setEditing(row.name)
    setWire(row.wire === row.name ? '' : row.wire)
    setDescription(row.descriptionSource === 'custom' ? row.description : '')
  }
  const closeEditor = (): void => {
    setEditing(null)
    setWire('')
    setDescription('')
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerLine} data-testid="tool-catalog-version">
          {view.recorded
            ? t('toolsRecordedAt', { time: stamp(view.recordedAt, t('toolsNever')) })
            : t('toolsNotRecorded')}
        </span>
        <span className={styles.headerLine} data-testid="tool-catalog-version-current">
          {view.currentDshVersion === ''
            ? t('toolsVersionUnknown')
            : t('toolsCurrentVersion', { version: view.currentDshVersion })}
        </span>
        <span className={view.pending > 0 ? styles.chipPending : styles.chip} data-testid="tool-catalog-pending">
          {view.pending > 0 ? t('toolsPending', { count: String(view.pending) }) : t('toolsPendingNone')}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          data-testid="tool-catalog-record"
          title={t('toolsRecordHint')}
          onClick={onRecord}
        >
          {t('toolsRecordNow')}
        </Button>
      </div>
      {error !== '' && <p className={shared.status} role="status" data-testid="tool-catalog-error">{error}</p>}
      <label className={form.field}>
        <span className={form.fieldLabel}>{t('toolsFilterLabel')}</span>
        <Input
          className={form.fieldControl}
          id={filterId}
          value={filter}
          placeholder={t('toolsFilterPlaceholder')}
          disabled={busy}
          data-testid="tool-catalog-filter"
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('toolsColName')}</th>
              <th>{t('toolsColWire')}</th>
              <th>{t('toolsColDescription')}</th>
              <th>{t('toolsColState')}</th>
              <th aria-label={t('toolsColActions')} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ToolRow
                key={row.name}
                row={row}
                t={t}
                busy={busy}
                editing={editing === row.name}
                wire={wire}
                description={description}
                onWire={setWire}
                onDescription={setDescription}
                onEdit={() => startEditing(row)}
                onCancel={closeEditor}
                onSave={() => { onSave(row.name, wire, description) }}
                onReset={() => { onReset(row.name); closeEditor() }}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className={shared.status}>{t('toolsEmpty')}</p>}
      </div>
    </div>
  )
}

/** One table row plus, while open, its editor beneath it. */
function ToolRow(props: {
  row: ToolCatalogRowView
  t: IpPoolCardLocale
  busy: boolean
  editing: boolean
  wire: string
  description: string
  onWire(value: string): void
  onDescription(value: string): void
  onEdit(): void
  onCancel(): void
  onSave(): void
  onReset(): void
}): ReactNode {
  const { row, t, busy, editing, wire, description, onWire, onDescription, onEdit, onCancel, onSave, onReset } = props
  const renamed = row.state === 'renamed' && row.renamedFrom !== undefined
  return (
    <>
      <tr className={row.state === 'ok' ? undefined : styles.rowPending} data-testid={`tool-row-${row.name}`}>
        <td className={styles.nameCell}>
          <span className={styles.toolName}>{row.name}</span>
          {renamed && <span className={styles.subtle}>{t('toolsRenamedFrom', { name: row.renamedFrom! })}</span>}
        </td>
        <td>
          {row.wire === row.name
            ? <span className={styles.subtle}>{t('toolsWireIdentity')}</span>
            : <code className={styles.wire}>{row.wire}</code>}
          {row.wireSource === 'custom' && <span className={styles.customMark}>{t('toolsCustomMark')}</span>}
        </td>
        <td>
          <span>{sourceLabel(row, t)}</span>
          <span className={styles.subtle}>{t('toolsChars', { count: String(row.chars) })}</span>
        </td>
        <td><span className={styles.badge} data-state={row.state}>{stateLabel(row.state, t)}</span></td>
        <td className={styles.actionCell}>
          {!editing && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onEdit} data-testid={`tool-edit-${row.name}`}>
              {t('toolsEdit')}
            </Button>
          )}
        </td>
      </tr>
      {editing && (
        <tr className={styles.editorRow}>
          <td colSpan={5}>
            <div className={styles.editor}>
              <label className={form.field}>
                <span className={form.fieldLabel}>{t('toolsWireLabel')}</span>
                <Input
                  className={form.fieldControl}
                  value={wire}
                  placeholder={row.name}
                  disabled={busy}
                  data-testid="tool-editor-wire"
                  onChange={(event) => onWire(event.target.value)}
                />
                <span className={form.fieldHint}>{t('toolsWireHint')}</span>
              </label>
              <label className={form.field}>
                <span className={form.fieldLabel}>{t('toolsDescriptionLabel')}</span>
                <textarea
                  className={form.textarea}
                  rows={5}
                  spellCheck={false}
                  value={description}
                  placeholder={t('toolsDescriptionPlaceholder')}
                  disabled={busy}
                  data-testid="tool-editor-description"
                  onChange={(event) => onDescription(event.target.value)}
                />
                <span className={form.fieldHint}>
                  {row.descriptionSource === 'client' ? t('toolsClientTextHint') : t('toolsDescriptionHint')}
                </span>
              </label>
              <div className={styles.editorActions}>
                <Button variant="primary" size="sm" disabled={busy} onClick={onSave} data-testid="tool-editor-save">
                  {t('toolsSave')}
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={onReset} data-testid="tool-editor-reset">
                  {t('toolsReset')}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel} data-testid="tool-editor-cancel">
                  {t('toolsCancel')}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
