import { parseModelContextWindows, type ModelContextWindows } from '../model-context.ts'
import { parseRequestHeaders, type RequestHeaders } from '../request-headers.ts'

/** Header edits live at the entry root, alongside (never inside) ipPool. */
export function requestHeadersWriteOps(text: string, current: RequestHeaders, base: RequestHeaders) {
  const write = fieldWrite('requestHeaders', parseRequestHeaders(text), current, base)
  if (!write) return []
  return [write.op === 'unset'
    ? { op: 'unset' as const, path: ['requestHeaders'] }
    : { op: 'set' as const, path: ['requestHeaders'], value: write.value }]
}

/** Context-window edits are their own root node too (never inside ipPool). */
export function modelContextWriteOps(text: string, current: ModelContextWindows, base: ModelContextWindows) {
  const write = fieldWrite('modelContextWindows', parseModelContextWindows(text), current, base)
  if (!write) return []
  return [write.op === 'unset'
    ? { op: 'unset' as const, path: ['modelContextWindows'] }
    : { op: 'set' as const, path: ['modelContextWindows'], value: write.value }]
}

export interface FieldWrite { field: string; op: 'set' | 'unset'; value?: unknown }

/** Reverting an override to its inherited value must remove the override. */
export function fieldWrite(field: string, next: unknown, current: unknown, base: unknown): FieldWrite | undefined {
  if (JSON.stringify(next) === JSON.stringify(current)) return undefined
  if (JSON.stringify(next) === JSON.stringify(base)) return { field, op: 'unset' }
  return { field, op: 'set', value: next }
}

/** The usage-scope switch writes immediately, outside the draft save. */
export function usageScopeWriteOps(scope: 'total' | 'run') {
  return [{ op: 'set' as const, path: ['ipPool', 'usageScope'], value: scope }]
}

/** Keep a pool edit inside its entry and migrate the old flat URL alias. */
export function poolWriteOps(writes: FieldWrite[]) {
  return writes.flatMap((write) => {
    const edit = write.op === 'unset'
      ? { op: 'unset' as const, path: ['ipPool', write.field] }
      : { op: 'set' as const, path: ['ipPool', write.field], value: write.value }
    return write.field === 'subscription'
      ? [edit, { op: 'unset' as const, path: ['ipPool', 'subscriptions'] }]
      : [edit]
  })
}
