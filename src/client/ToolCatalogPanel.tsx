/**
 * The stats modal's 工具名录 tab: every tool this host has shown the lane, the
 * wire name and description it rides with, and the one thing an operator needs
 * after a dsh upgrade — what moved since the last recorded baseline.
 *
 * The table edits the catalogue, it never edits the lane: a name change here is
 * a wire change, so the editor opens the CURRENT text (built-in or operator's)
 * and states which of the two the row will send. Saving the built-in value back
 * clears the override, so "custom" keeps meaning something.
 */
import { useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IpPoolCardLocale, ToolCatalogRowView, ToolCatalogView } from './types.ts'
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
  /** The row whose editor is open; null = closed. */
  const [editing, setEditing] = useState<ToolCatalogRowView | null>(null)

  if (view === null) {
    return <p className={shared.status}>{t('toolsLoading')}</p>
  }
  const needle = filter.trim().toLowerCase()
  const rows = needle === '' ? view.rows : view.rows.filter((row) => row.name.toLowerCase().includes(needle))

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
              <tr key={row.name} className={row.state === 'ok' ? undefined : styles.rowPending} data-testid={`tool-row-${row.name}`}>
                <td>
                  <div className={styles.nameCell}>
                    <span className={styles.toolName}>{row.name}</span>
                    {row.state === 'renamed' && row.renamedFrom !== undefined && (
                      <span className={styles.subtle}>{t('toolsRenamedFrom', { name: row.renamedFrom })}</span>
                    )}
                  </div>
                </td>
                <td>
                  {row.wire === row.name
                    ? <span className={styles.subtle}>{t('toolsWireIdentity')}</span>
                    : <code className={styles.wire}>{row.wire}</code>}
                  {row.wireSource === 'custom' && <span className={styles.customMark}>{t('toolsCustomMark')}</span>}
                </td>
                <td>
                  <div className={styles.nameCell}>
                    <span>{sourceLabel(row, t)}</span>
                    <span className={styles.subtle}>{t('toolsChars', { count: String(row.chars) })}</span>
                  </div>
                </td>
                <td><span className={styles.badge} data-state={row.state}>{stateLabel(row.state, t)}</span></td>
                <td className={styles.actionCell}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    data-testid={`tool-edit-${row.name}`}
                    onClick={() => setEditing(row)}
                  >
                    {t('toolsEdit')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className={shared.status}>{t('toolsEmpty')}</p>}
      </div>
      {editing !== null && (
        <ToolEditor
          // Remount per tool: the draft must start from THIS row's text, never
          // from the previous row's edits.
          key={editing.name}
          row={editing}
          t={t}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(wire, description) => {
            // A field that still equals its built-in value is sent empty, and
            // empty is what deletes the override on the host.
            const trimmed = wire.trim()
            onSave(
              editing.name,
              trimmed === editing.builtinWire ? '' : trimmed,
              description === (editing.builtinDescription ?? '') ? '' : description,
            )
            setEditing(null)
          }}
          onReset={() => {
            onReset(editing.name)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * One tool's editor, prefilled with the text that would ride the wire today.
 * Saving a field that already equals its built-in value sends nothing for that
 * field, which is how the override is cleared.
 */
function ToolEditor(props: {
  row: ToolCatalogRowView
  t: IpPoolCardLocale
  busy: boolean
  onCancel(): void
  onSave(wire: string, description: string): void
  onReset(): void
}): ReactNode {
  const { row, t, busy, onCancel, onSave, onReset } = props
  const [wire, setWire] = useState(row.wire)
  const [description, setDescription] = useState(row.description)
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('toolsEditorTitle', { name: row.name })}
      closeLabel={t('toolsCancel')}
      description={t('toolsEditorDescription', { state: stateLabel(row.state, t), source: sourceLabel(row, t) })}
      className={styles.editorModal}
      footer={(
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel} data-testid="tool-editor-cancel">
            {t('toolsCancel')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={onReset} data-testid="tool-editor-reset">
            {t('toolsReset')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => onSave(wire, description)}
            data-testid="tool-editor-save"
          >
            {t('toolsSave')}
          </Button>
        </>
      )}
    >
      <div className={styles.editor}>
        <label className={form.field}>
          <span className={form.fieldLabel}>{t('toolsWireLabel')}</span>
          <Input
            className={form.fieldControl}
            value={wire}
            disabled={busy}
            data-modal-autofocus
            data-testid="tool-editor-wire"
            onChange={(event) => setWire(event.target.value)}
          />
          <span className={form.fieldHint}>
            {t('toolsWireBuiltin', { wire: row.builtinWire })}
            {row.builtinWire !== row.name ? ` ${t('toolsWireHint')}` : ''}
          </span>
        </label>
        <label className={form.field}>
          <span className={form.fieldLabel}>{t('toolsDescriptionLabel')}</span>
          <textarea
            className={form.textarea}
            rows={12}
            spellCheck={false}
            value={description}
            disabled={busy}
            data-testid="tool-editor-description"
            onChange={(event) => setDescription(event.target.value)}
          />
          <span className={form.fieldHint}>
            {row.builtinDescription === undefined
              ? t('toolsDescriptionHint')
              : t('toolsDescriptionBuiltin', { count: String(row.builtinDescription.length) })}
          </span>
        </label>
        {/* The one rule an operator cannot see from the text itself. */}
        {row.descriptionSource === 'client' && (
          <p className={shared.status}>{t('toolsClientTextHint')}</p>
        )}
      </div>
    </Modal>
  )
}
