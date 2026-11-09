/**
 * Pid records and stale-child sweeps for the processes this plugin spawns.
 *
 * Nothing on POSIX kills a child when its parent dies, and sing-box does not
 * watch its parent at all: a host killed with SIGKILL leaves it holding the
 * 30001-and-up loopback ports, so the next `sing-box run` dies on EADDRINUSE
 * and every converted exit stays unreachable until the leftover is removed by
 * hand. Each spawn therefore writes a `{pid, marker}` record beside the state
 * it serves, and the first launch in a process ends a matching leftover before
 * spawning.
 *
 * The marker is what makes the sweep safe: a recycled pid is only signalled
 * when its command line still carries our own path, so the sweep can never
 * kill a stranger that inherited the number.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface ChildRecord {
  pid: number
  /** ISO timestamp, diagnostics only. */
  startedAt: string
  /** Text that must appear in the live command line for the pid to be ours. */
  marker: string
  /** Executable basename; the only evidence available on Windows. */
  binary: string
}

export interface ChildSweep {
  /** Expected command-line fragment of the process being swept. */
  marker: string
  /** Binary path whose basename Windows compares against `tasklist`. */
  binary?: string
  signal?: NodeJS.Signals
  graceMs?: number
  logger?: { warn(message: string): void }
}

/** Where a child's pid record lives; the caller owns the path. */
export function childRecordPath(directory: string, name: string): string {
  return join(directory, `${name}.json`)
}

/** Write the record atomically; a read-only state dir costs the sweep, not the spawn. */
export async function writeChildRecord(path: string, record: ChildRecord): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
    await rm(path, { force: true })
    await rename(tmp, path)
  } catch {
    // Advisory metadata: losing it only means a leftover is not swept.
  }
}

/** Remove the record, unless it belongs to another pid. */
export async function clearChildRecord(path: string, pid?: number): Promise<void> {
  if (pid !== undefined) {
    const record = await readRecord(path)
    if (record !== null && record.pid !== pid) return
  }
  try {
    await rm(path, { force: true })
  } catch {
    // already gone
  }
}

/** End a matching leftover and remove its record; true when one was ended. */
export async function sweepChildRecord(path: string, sweep: ChildSweep): Promise<boolean> {
  const record = await readRecord(path)
  if (record === null) return false
  if (record.pid === process.pid || !alive(record.pid) || !owns(record, sweep)) {
    await clearChildRecord(path)
    return false
  }
  sweep.logger?.warn(`oc2dsh: ending stale ${basename(path, '.json')} child (pid ${record.pid}) left by a previous host`)
  await terminate(record.pid, sweep)
  await clearChildRecord(path)
  return true
}

/**
 * Sweep a given record path at most once per process. The guard is process
 * wide, so an HMR reload of the plugin does not re-run it against the child
 * the lease just adopted.
 */
export async function sweepChildRecordOnce(path: string, sweep: ChildSweep): Promise<boolean> {
  const box = sweptBox()
  if (box.done.has(path)) return false
  box.done.add(path)
  return sweepChildRecord(path, sweep)
}

/** Forget the once-per-process guard (tests drive several state dirs). */
export function resetSweepGuard(): void {
  sweptBox().done.clear()
}

async function readRecord(path: string): Promise<ChildRecord | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const { pid, marker, startedAt, binary } = parsed as Record<string, unknown>
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof marker !== 'string' || marker === '') return null
  return {
    pid,
    marker,
    startedAt: typeof startedAt === 'string' ? startedAt : '',
    binary: typeof binary === 'string' ? binary : '',
  }
}

/** Is the pid a live process? EPERM means it exists but belongs to another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The process command line, or null where the platform has no cheap answer. */
function commandOf(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim()
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    }
  } catch {
    return null
  }
  return null
}

/** The executable name Windows reports for a pid (tasklist has no command line). */
function imageNameOf(pid: number): string | null {
  try {
    const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    const first = csv.split(/\r?\n/).find((line) => line.trim() !== '')
    const image = first?.split('","')[0]?.replace(/^"/, '')
    return image === undefined || image === '' ? null : image
  } catch {
    return null
  }
}

/** Does the live pid still carry our marker (or, on Windows, our binary)? */
function owns(record: ChildRecord, sweep: ChildSweep): boolean {
  const command = commandOf(record.pid)
  if (command !== null) return command.includes(record.marker)
  if (process.platform === 'win32' && sweep.binary !== undefined) {
    const image = imageNameOf(record.pid)
    const expected = basename(sweep.binary).toLowerCase().replace(/\.exe$/, '')
    return image !== null && image.toLowerCase().replace(/\.exe$/, '') === expected
  }
  // No evidence means no kill: an unverifiable pid is a possible stranger.
  return false
}

async function terminate(pid: number, sweep: ChildSweep): Promise<void> {
  const graceMs = sweep.graceMs ?? 5_000
  if (process.platform === 'win32') {
    await taskkill(['/T', '/PID', String(pid)])
    if (await waitsGone(pid, graceMs)) return
    await taskkill(['/T', '/F', '/PID', String(pid)])
  } else {
    send(pid, sweep.signal ?? 'SIGTERM')
    if (await waitsGone(pid, graceMs)) return
    send(pid, 'SIGKILL')
  }
  await waitsGone(pid, 1_000)
}

function send(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // already gone
  }
}

async function waitsGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !alive(pid)
}

function taskkill(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill', args, { stdio: 'ignore' })
    killer.once('exit', () => resolve())
    killer.once('error', () => resolve())
  })
}

interface SweptBox {
  done: Set<string>
}

const SWEPT_KEY = Symbol.for('oc2dsh.child-records.swept')

/** The guard lives on `globalThis`: HMR replaces this module, not the process. */
function sweptBox(): SweptBox {
  const holder = globalThis as unknown as Record<symbol, SweptBox | undefined>
  const existing = holder[SWEPT_KEY]
  if (existing !== undefined) return existing
  const box: SweptBox = { done: new Set() }
  holder[SWEPT_KEY] = box
  return box
}
