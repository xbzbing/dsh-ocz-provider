/**
 * The plugin's own log file.
 *
 * The host keeps plugin `info`/`warn` in an in-process buffer, so the lines that
 * explain a pool change ("dropped N exit(s) whose listener the new conversion no
 * longer serves") are gone once the host restarts — which is exactly how the
 * 2026-11-08 exit-table collapse went unexplained until the port sets were
 * diffed by hand. These tests pin the file, its shape and its rotation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LOG_FILE_NAME, logFilePath, mirrorLogToFile } from '../src/log-file.ts'

function collect(): { lines: string[]; sink: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void } } {
  const lines: string[] = []
  return {
    lines,
    sink: {
      info: (...args: unknown[]) => lines.push(['info', ...args].map(String).join(' ')),
      warn: (...args: unknown[]) => lines.push(['warn', ...args].map(String).join(' ')),
      error: (...args: unknown[]) => lines.push(['error', ...args].map(String).join(' ')),
    },
  }
}

test('every level is written to the file and still reaches the host logger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-log-'))
  try {
    const { lines, sink } = collect()
    const logger = mirrorLogToFile(sink, { dir, flushMs: 5 })
    logger.info('oc2dsh: pool admitted %d exits', 3)
    logger.warn('oc2dsh: dropped 2 exit(s) whose listener the new conversion no longer serves (a, b)')
    logger.error('oc2dsh: sing-box exited unexpectedly (code 1)')
    logger.flush()

    assert.equal(lines.length, 3, 'the host logger got every line')
    const body = readFileSync(join(dir, LOG_FILE_NAME), 'utf8').trimEnd().split('\n')
    assert.equal(body.length, 3)
    assert.match(body[0]!, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[info\] oc2dsh: pool admitted 3 exits$/, 'util.format applies, stamped with level')
    assert.match(body[1]!, /\[warn\] oc2dsh: dropped 2 exit\(s\).*no longer serves \(a, b\)$/)
    assert.match(body[2]!, /\[error\] oc2dsh: sing-box exited unexpectedly \(code 1\)$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lines are batched, not written one syscall per log line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-log-'))
  try {
    const { sink } = collect()
    const logger = mirrorLogToFile(sink, { dir, flushMs: 20 })
    logger.info('one')
    // Nothing on disk until the batch flushes: the request path never waits.
    assert.equal(existsSync(join(dir, LOG_FILE_NAME)), false, 'no synchronous write per line')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.match(readFileSync(join(dir, LOG_FILE_NAME), 'utf8'), /one/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the active file rotates and keeps the configured generations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-log-'))
  try {
    const { sink } = collect()
    const file = join(dir, LOG_FILE_NAME)
    // Start just under the cap so the next batch crosses it.
    writeFileSync(file, 'x'.repeat(60), 'utf8')
    const logger = mirrorLogToFile(sink, { dir, maxBytes: 64, keep: 2, flushMs: 5 })
    logger.info('first generation')
    logger.flush()
    logger.info('second generation')
    logger.flush()

    assert.ok(statSync(file).size > 0, 'the active file is fresh again')
    assert.match(readFileSync(`${file}.1`, 'utf8'), /first generation/, 'the previous active file moved to .1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a burst larger than one page flushes immediately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-log-'))
  try {
    const { sink } = collect()
    const logger = mirrorLogToFile(sink, { dir, flushMs: 60_000 })
    for (let index = 0; index < 300; index += 1) logger.info('line %d', index)
    // 256 lines crossed the page boundary mid-burst: the buffer never grows
    // without bound while the timer sits far in the future.
    const body = readFileSync(join(dir, LOG_FILE_NAME), 'utf8')
    assert.ok(body.split('\n').length > 200, `burst flushed (${body.split('\n').length} lines)`)
    logger.flush()
    assert.equal(readFileSync(join(dir, LOG_FILE_NAME), 'utf8').trimEnd().split('\n').length, 300, 'nothing was lost')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory that cannot be written never fails the caller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-log-'))
  try {
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'x', 'utf8')
    const { lines, sink } = collect()
    const logger = mirrorLogToFile(sink, { dir: join(blocker, 'logs'), flushMs: 5 })
    assert.doesNotThrow(() => {
      logger.warn('still goes to the host logger')
      logger.flush()
    })
    assert.equal(lines.length, 1, 'the host logger is the source of truth when the file cannot be written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the default path lives under the plugin state root', () => {
  const previous = process.env.OC2DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-home-'))
  try {
    process.env.OC2DSH_HOME = dir
    assert.equal(logFilePath(), join(dir, 'logs', LOG_FILE_NAME), 'the log rides the state dir (and its env override)')
    const { sink } = collect()
    const logger = mirrorLogToFile(sink, { flushMs: 5 })
    logger.info('default path')
    logger.flush()
    assert.deepEqual(readdirSync(join(dir, 'logs')), [LOG_FILE_NAME])
  } finally {
    if (previous === undefined) delete process.env.OC2DSH_HOME
    else process.env.OC2DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
