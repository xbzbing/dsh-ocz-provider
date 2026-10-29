import { execFileSync } from 'node:child_process'
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

/** Resolutions are cheap to keep and git spawns are not; one per directory per window. */
const CACHE_TTL_MS = 60_000
const GIT_TIMEOUT_MS = 2_000
const cache = new Map<string, { at: number; facts: ProjectFacts }>()

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync(command, args, {
      cwd,
      env: env === undefined ? process.env : { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    })
  } catch {
    return undefined
  }
}

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

function resolveGit(marker: string): ProjectFacts | undefined {
  const base = dirname(marker)
  const out = run('git', ['rev-parse', '--show-toplevel', '--git-common-dir'], base)
  if (out === undefined) return undefined
  const [toplevel, commonRaw] = out.split('\n').map((line) => line.trim())
  if (toplevel === undefined || toplevel === '' || commonRaw === undefined || commonRaw === '') return undefined
  const commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(base, commonRaw)
  const remote = run('git', ['remote', 'get-url', 'origin'], toplevel)
  const normalized = remote === undefined ? undefined : normalizeRemote(remote)
  const fromRemote = normalized === undefined ? undefined : sha1(`git-remote:${normalized}`)
  const fromFile = readTrimmed(join(commonDir, 'opencode'))
  const roots = run('git', ['rev-list', '--max-parents=0', 'HEAD'], toplevel)
  const fromRoot = roots?.split('\n').map((line) => line.trim()).filter(Boolean).sort()[0]
  return { directory: '', root: toplevel, vcs: 'git', id: fromRemote ?? fromFile ?? fromRoot ?? GLOBAL_PROJECT_ID }
}

function resolveHg(marker: string): ProjectFacts {
  const root = dirname(marker)
  const fromFile = readTrimmed(join(marker, 'opencode'))
  const roots = fromFile === undefined
    ? run('hg', ['log', '-r', 'roots(all())', '-T', '{node}\n'], root, { HGPLAIN: '1' })
    : undefined
  const fromRoot = roots?.split('\n').map((line) => line.trim()).filter(Boolean).sort()[0]
  return { directory: '', root, vcs: 'hg', id: fromFile ?? fromRoot ?? GLOBAL_PROJECT_ID }
}

/** Resolve (and cache) the project for one directory. Never throws. */
export function resolveProject(directory: string): ProjectFacts {
  const absolute = resolve(directory)
  const hit = cache.get(absolute)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.facts
  const marker = findVcsMarker(absolute)
  let facts: ProjectFacts | undefined
  if (marker !== undefined && marker.endsWith('.git')) facts = resolveGit(marker)
  else if (marker !== undefined) facts = resolveHg(marker)
  const resolved: ProjectFacts = facts !== undefined
    ? { ...facts, directory: absolute }
    : { directory: absolute, root: absolute, vcs: undefined, id: sha1(`directory:${absolute}`) }
  cache.set(absolute, { at: Date.now(), facts: resolved })
  return resolved
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
  cache.clear()
}
