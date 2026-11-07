import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

import { stateDir } from './paths.ts'

/** The host logger this plugin consumes (cordis `ctx.logger` shape). */
export interface LogSink {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface FileLogOptions {
  /** Directory override (tests); defaults to `<stateDir>/logs`. */
  dir?: string
  /** Rotate once the active file passes this size (default 2 MiB). */
  maxBytes?: number
  /** Rotated generations kept beside the active file (default 3). */
  keep?: number
  /** Flush delay for buffered lines (default 250ms). */
  flushMs?: number
}

export const LOG_FILE_NAME = 'oc2dsh.log'

/** Where the plugin's log lives: `<stateDir>/logs/oc2dsh.log`. */
export function logFilePath(options: FileLogOptions = {}): string {
  return join(options.dir ?? join(stateDir(), 'logs'), LOG_FILE_NAME)
}

/**
 * Mirror the host logger into the plugin's own log file.
 *
 * The host keeps plugin `info`/`warn`/`error` in an in-process buffer (stderr
 * only when the host was started from a terminal), so the lines that explain a
 * pool change — "dropped N exit(s) whose listener the new conversion no longer
 * serves", "onboarding kept X of Y screened" — are gone once the process
 * restarts. This file is the record that outlives it.
 *
 * Everything here is best-effort: writing must never fail a request path, so
 * lines are buffered and flushed in batches, and every filesystem error is
 * swallowed (the host logger still got the line).
 */
export function mirrorLogToFile(base: LogSink, options: FileLogOptions = {}): LogSink & { flush(): void } {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  const keep = Math.max(1, options.keep ?? 3)
  const flushMs = options.flushMs ?? 250
  let pending: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSize: number | null = null

  const rotate = (file: string): void => {
    for (let index = keep - 1; index >= 1; index -= 1) {
      try {
        renameSync(`${file}.${index}`, `${file}.${index + 1}`)
      } catch {
        /* no such generation yet */
      }
    }
    try {
      renameSync(file, `${file}.1`)
    } catch {
      /* the active file vanished between the size check and here */
    }
    lastSize = 0
  }

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const lines = pending
    pending = []
    const file = logFilePath(options)
    try {
      mkdirSync(join(options.dir ?? join(stateDir(), 'logs')), { recursive: true })
      if (lastSize === null) {
        try {
          lastSize = statSync(file).size
        } catch {
          lastSize = 0
        }
      }
      const body = `${lines.join('\n')}\n`
      if (lastSize >= maxBytes) rotate(file)
      appendFileSync(file, body, 'utf8')
      lastSize += Buffer.byteLength(body)
    } catch {
      /* logging is never allowed to fail the caller */
    }
  }

  const queue = (level: 'info' | 'warn' | 'error', args: unknown[]): void => {
    const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '')
    pending.push(`[${stamp}] [${level}] ${format(...args)}`)
    // A burst must not grow the buffer without bound: flush immediately past
    // a page, otherwise batch for one tick.
    if (pending.length >= 256) flush()
    else if (timer === null) {
      timer = setTimeout(flush, flushMs)
      timer.unref?.()
    }
  }

  return {
    info(...args: unknown[]): void {
      base.info(...args)
      queue('info', args)
    },
    warn(...args: unknown[]): void {
      base.warn(...args)
      queue('warn', args)
    },
    error(...args: unknown[]): void {
      base.error(...args)
      queue('error', args)
    },
    /** Write what is buffered now (shutdown, tests). */
    flush,
  }
}
