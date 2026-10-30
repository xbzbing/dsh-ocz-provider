import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * The project the official client would report for a directory: the
 * `x-opencode-project` id and the `<env>` block's workspace facts come from
 * this ONE resolution, so the header and the prompt always describe the same
 * place. Port of the 2.2.0 client's `Project.resolve` (AGENTS.md, free-lane gate):
 *
 *   nearest `.git`  -> sha1("git-remote:" + host/path of `origin`)
 *                      ?? `<git common dir>/opencode` file
 *                      ?? the repo's lexically-first root commit
 *                      ?? "global"
 *   nearest `.hg`   -> `.hg/opencode` file ?? first root changeset ?? "global"
 *   neither         -> sha1("directory:" + absolute path)
 */

export interface ProjectFacts {
  /** The directory asked about (absolute). */
  directory: string
  /** The project root the client calls "Workspace root folder". */
  root: string
  /** Which VCS the project sits in. */
  vcs: 'git' | 'hg' | undefined
  /** The prefix-less `ProjectID`: 40-hex or `global`. */
  id: string
}

/** The client's fallback id for a repository with no remote, file or commit. */
export const GLOBAL_PROJECT_ID = 'global'

/**
 * One resolution per directory per window. The request path never waits on a
 * spawn once a value exists: a stale entry is served while a background
 * resolution (async `execFile`) replaces it.
 */
const CACHE_TTL_MS = 60_000
const GIT_TIMEOUT_MS = 2_000
const cache = new Map<string, { at: number; facts: ProjectFacts }>()
const inflight = new Map<string, Promise<ProjectFacts>>()
/** Bumped by resetProjectCache so a resolution started before it cannot land after it. */
let generation = 0

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** One VCS command the resolution needs; stdout, or undefined on any failure. */
interface Command {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

function spawnOptions(step: Command): { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; timeout: number } {
  return { cwd: step.cwd, env: step.env === undefined ? process.env : { ...process.env, ...step.env }, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }
}

function runSync(step: Command): string | undefined {
  try {
    return execFileSync(step.command, step.args, { ...spawnOptions(step), stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

function runAsync(step: Command): Promise<string | undefined> {
  return new Promise((done) => {
    try {
      const child = execFile(step.command, step.args, spawnOptions(step), (error, stdout) => done(error === null ? stdout : undefined))
      child.stdin?.end()
    } catch {
      done(undefined)
    }
  })
}

/** The resolution yields each command it needs, so one algorithm serves both drivers. */
type Resolution = Generator<Command, ProjectFacts | undefined, string | undefined>

function readTrimmed(path: string): string | undefined {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** First `.git` or `.hg` entry walking up from `start`, nearest wins. */
function findVcsMarker(start: string): string | undefined {
  let current = start
  for (let depth = 0; depth < 128; depth += 1) {
    for (const marker of ['.git', '.hg']) {
      const candidate = join(current, marker)
      if (existsSync(candidate)) return candidate
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/**
 * `host/path` of a remote URL, the client's normalization: scheme URLs keep
 * hostname + pathname (`file:` is ignored), scp-style `user@host:path` is
 * split on the colon, and a trailing `.git` / slashes are dropped.
 */
export function normalizeRemote(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  let url: URL | undefined
  try {
    url = new URL(value)
  } catch {
    url = undefined
  }
  if (url !== undefined) {
    if (url.protocol === 'file:') return undefined
    return joinRemote(url.hostname, url.pathname)
  }
  const scp = /^([^@/:]+@)?([^/:]+):(.+)$/.exec(value)
  return scp === null ? undefined : joinRemote(scp[2]!, scp[3]!)
}

function joinRemote(host: string, path: string): string | undefined {
  const trimmed = path.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '')
  if (host === '' || trimmed === '') return undefined
  return `${host.toLowerCase()}/${trimmed}`
}

function* resolveGit(marker: string): Resolution {
  const base = dirname(marker)
  const out = yield { command: 'git', args: ['rev-parse', '--show-toplevel', '--git-common-dir'], cwd: base }
  if (out === undefined) return undefined
  const [toplevel, commonRaw] = out.split('\n').map((line) => line.trim())
  if (toplevel === undefined || toplevel === '' || commonRaw === undefined || commonRaw === '') return undefined
  const commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(base, commonRaw)
  const remote = yield { command: 'git', args: ['remote', 'get-url', 'origin'], cwd: toplevel }
  const normalized = remote === undefined ? undefined : normalizeRemote(remote)
  const fromRemote = normalized === undefined ? undefined : sha1(`git-remote:${normalized}`)
  const fromFile = readTrimmed(join(commonDir, 'opencode'))
  const roots = yield { command: 'git', args: ['rev-list', '--max-parents=0', 'HEAD'], cwd: toplevel }
  const fromRoot = roots?.split('\n').map((line) => line.trim()).filter(Boolean).sort()[0]
  return { directory: '', root: toplevel, vcs: 'git', id: fromRemote ?? fromFile ?? fromRoot ?? GLOBAL_PROJECT_ID }
}

function* resolveHg(marker: string): Resolution {
  const root = dirname(marker)
  const fromFile = readTrimmed(join(marker, 'opencode'))
  const roots = fromFile === undefined
    ? yield { command: 'hg', args: ['log', '-r', 'roots(all())', '-T', '{node}\n'], cwd: root, env: { HGPLAIN: '1' } }
    : undefined
  const fromRoot = roots?.split('\n').map((line) => line.trim()).filter(Boolean).sort()[0]
  return { directory: '', root, vcs: 'hg', id: fromFile ?? fromRoot ?? GLOBAL_PROJECT_ID }
}

function* resolution(absolute: string): Generator<Command, ProjectFacts, string | undefined> {
  const marker = findVcsMarker(absolute)
  let facts: ProjectFacts | undefined
  if (marker !== undefined && marker.endsWith('.git')) facts = yield* resolveGit(marker)
  else if (marker !== undefined) facts = yield* resolveHg(marker)
  return facts !== undefined
    ? { ...facts, directory: absolute }
    : { directory: absolute, root: absolute, vcs: undefined, id: sha1(`directory:${absolute}`) }
}

function store(absolute: string, facts: ProjectFacts, startedIn = generation): ProjectFacts {
  if (startedIn === generation) cache.set(absolute, { at: Date.now(), facts })
  return facts
}

/** Background resolution, deduped per directory. Never rejects. */
function refresh(absolute: string): Promise<ProjectFacts> {
  const running = inflight.get(absolute)
  if (running !== undefined) return running
  const startedIn = generation
  const task = (async () => {
    const steps = resolution(absolute)
    let next = steps.next()
    while (next.done !== true) next = steps.next(await runAsync(next.value))
    return store(absolute, next.value, startedIn)
  })().finally(() => { if (inflight.get(absolute) === task) inflight.delete(absolute) })
  inflight.set(absolute, task)
  return task
}

function cached(absolute: string): ProjectFacts | undefined {
  const hit = cache.get(absolute)
  if (hit === undefined) return undefined
  if (Date.now() - hit.at >= CACHE_TTL_MS) void refresh(absolute)
  return hit.facts
}

/**
 * The project for one directory. A cached value (stale ones included) is
 * answered at once; only a directory never resolved before spawns inline.
 */
export function resolveProject(directory: string): ProjectFacts {
  const absolute = resolve(directory)
  const hit = cached(absolute)
  if (hit !== undefined) return hit
  const steps = resolution(absolute)
  let next = steps.next()
  while (next.done !== true) next = steps.next(runSync(next.value))
  return store(absolute, next.value)
}

/** {@link resolveProject} without blocking: a cold directory is resolved through async spawns. */
export async function resolveProjectAsync(directory: string): Promise<ProjectFacts> {
  const absolute = resolve(directory)
  return cached(absolute) ?? refresh(absolute)
}

/** The process' working directory, or `/` when it is gone. */
export function hostDirectory(): string {
  try {
    return process.cwd()
  } catch {
    return '/'
  }
}

/** The project of this host process (what the wire and the `<env>` block report). */
export function hostProject(): ProjectFacts {
  return resolveProject(hostDirectory())
}

/** Resolve this host's project off the event loop; awaited before a request is built. */
export function hostProjectAsync(): Promise<ProjectFacts> {
  return resolveProjectAsync(hostDirectory())
}

/**
 * The client's temp directory line value: `realpath(os.tmpdir())/opencode`
 * (the client creates it first; an absent one is reported unresolved).
 */
export function clientTempDirectory(): string {
  const base = tmpdir()
  try {
    if (statSync(base).isDirectory()) return join(realpathSync(base), 'opencode')
  } catch {
    // An unreadable temp root is reported as the OS names it.
  }
  return join(base, 'opencode')
}

/** Drop cached resolutions (tests only). */
export function resetProjectCache(): void {
  generation += 1
  cache.clear()
  inflight.clear()
}
