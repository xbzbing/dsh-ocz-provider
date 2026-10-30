import type { ReactNode } from 'react'
import { DisclosureRow, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FormState, GroupId } from '../form-model.ts'
import type { IpPoolCardLocale } from '../types.ts'
import styles from '../form.module.css'

/** First-visit fold state: high-frequency groups open, advanced ones folded. */
const GROUP_DEFAULTS: Record<GroupId, boolean> = {
  sources: true,
  scheduling: false,
  probe: false,
  usage: true,
  headers: false,
  models: false,
  exits: true,
}

/** localStorage key holding the operator's fold preferences (schema v1). */
export const GROUP_STATE_KEY = 'oc2dsh:form-groups:v1'

/** Read the persisted fold map; a missing/corrupt entry falls back to defaults. */
export function loadGroupState(): Record<GroupId, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_STATE_KEY)
    if (raw === null) return { ...GROUP_DEFAULTS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...GROUP_DEFAULTS }
    return { ...GROUP_DEFAULTS, ...(parsed as Partial<Record<GroupId, boolean>>) }
  } catch {
    return { ...GROUP_DEFAULTS }
  }
}

/** Fold state and highlight for one group, as the card hands it down. */
export interface GroupChrome {
  open: boolean
  highlight: boolean
  onToggle: () => void
}

/** What every draft-editing group receives from the card. */
export interface GroupFormProps {
  form: FormState
  /** Patch the draft (clears the saved note). */
  edit: (patch: Partial<FormState>) => void
  /** Read-only profile or a save in flight. */
  locked: boolean
  t: IpPoolCardLocale
  chrome: GroupChrome
}

/**
 * One collapsible settings group: a DisclosureRow header with the title and a
 * folded-state summary, and a body that stays MOUNTED while folded
 * (display:none) so half-typed list drafts and focus survive a fold.
 */
export function Group(props: GroupChrome & {
  id: GroupId
  title: string
  summary: string
  children: ReactNode
}): ReactNode {
  const { id, title, summary, open, highlight, onToggle, children } = props
  return (
    <section
      className={highlight ? `${styles.group} ${styles.groupHighlight}` : styles.group}
      data-group={id}
    >
      <DisclosureRow
        icon={<IconChevronDownOutlineRegular />}
        title={title}
        open={open}
        expandable
        expandOnRowClick
        onToggle={onToggle}
        collapsedContent={<span className={styles.groupSummary}>{summary}</span>}
      />
      <div className={open ? styles.groupBody : styles.groupBodyHidden}>
        {children}
      </div>
    </section>
  )
}
