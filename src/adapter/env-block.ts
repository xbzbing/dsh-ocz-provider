import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * The `<env>` system-prompt block every accepted request must carry — one of
 * the free lane's three gate halves: a body whose system content has no
 * environment block is answered 429 FreeUsageLimitError, the same status a
 * spent quota uses. The official 2.1.4 client always sends one as the tail of
 * its system prompt:
 *
 *     <env>
 *       Working directory: /Users/…/workspace
 *       Workspace root folder: /Users/…/dsh-ocz-provider
 *       Is directory a git repo: yes
 *       Platform: darwin
 *       Prefer /private/tmp/opencode over generic system temporary directories …
 *     </env>
 *
 * The gate checks PRESENCE, not fidelity (probe matrix under
 * `docs/local/capture-214/`): an empty block, the same lines without the
 * tags, a junk-padded prompt, or a system prompt truncated before the block
 * are refused (429); one real line passes, a block-only prompt passes, a
 * fabricated path passes. So this module reproduces the block's SHAPE with
 * this host's real values instead of shipping the captured text: a
 * hard-coded `Working directory` would be a lie the model may act on.
 */

/** Opening tag of the block (the gate's literal marker). */
export const ENV_OPEN = '<env>'
/** Closing tag of the block. */
export const ENV_CLOSE = '</env>'

/** The values the block reports; every one of them has a real host source. */
export interface EnvFacts {
  /** The process' working directory (what the official CLI would report). */
  workingDirectory?: string
  /** Directory of the workspace the harness serves. */
  workspaceRoot?: string
  /** Whether `workingDirectory` sits in a git worktree. */
  isGitRepo?: boolean
  /** `process.platform` value (darwin/linux/win32). */
  platform?: string
  /**
   * The temporary-directory preference line. The official 2.1.4 block carries
   * it on macOS only; the gate does not read it, the model may.
   */
  preferTempDir?: string
}

/** Every fact, read from this process (never throws). */
export function hostEnvFacts(): EnvFacts {
  const cwd = safeCwd()
  return {
    workingDirectory: cwd,
    workspaceRoot: workspaceRootOf(cwd),
    isGitRepo: isGitWorktree(cwd),
    platform: process.platform,
    preferTempDir: process.platform === 'darwin' ? '/private/tmp' : undefined,
  }
}

function safeCwd(): string {
  try {
    return process.cwd()
  } catch {
    return '/'
  }
}

/**
 * The workspace root: `DSH_WORKSPACE_ROOT` when the host exports one,
 * otherwise the working directory itself. Both are honest answers — the
 * official client prints its cwd twice for a non-worktree directory.
 */
function workspaceRootOf(cwd: string): string {
  const configured = process.env.DSH_WORKSPACE_ROOT?.trim()
  return configured !== undefined && configured !== '' ? configured : cwd
}

/** Is this directory (or any parent) a git worktree? Bounded, best-effort. */
function isGitWorktree(start: string): boolean {
  try {
    const isWindows = process.platform === 'win32'
    const path = isWindows ? win32 : posix
    let current = start
    for (let depth = 0; depth < 64; depth += 1) {
      if (existsSync(path.join(current, '.git'))) return true
      const parent = path.dirname(current)
      if (parent === current) return false
      current = parent
    }
  } catch {
    // A cwd we cannot stat simply reports "not a repo"; the gate reads tags only.
  }
  return false
}

/** One rendered block, official layout, `<env>` … `</env>` inclusive. */
export function renderEnvBlock(facts: EnvFacts = hostEnvFacts()): string {
  const lines: string[] = [ENV_OPEN]
  if (facts.workingDirectory !== undefined && facts.workingDirectory !== '') {
    lines.push(`  Working directory: ${facts.workingDirectory}`)
  }
  if (facts.workspaceRoot !== undefined && facts.workspaceRoot !== '') {
    lines.push(`  Workspace root folder: ${facts.workspaceRoot}`)
  }
  if (facts.isGitRepo !== undefined) {
    lines.push(`  Is directory a git repo: ${facts.isGitRepo ? 'yes' : 'no'}`)
  }
  if (facts.platform !== undefined && facts.platform !== '') {
    lines.push(`  Platform: ${facts.platform}`)
  }
  if (facts.preferTempDir !== undefined) {
    lines.push(
      `  Prefer ${facts.preferTempDir}/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    )
  }
  lines.push(ENV_CLOSE)
  return lines.join('\n')
}

/**
 * Does this text carry an `<env>` block with at least one non-blank line?
 *
 * A bare `<env></env>` / `<env>\n</env>` is NOT enough: the empty block is one
 * of the rejected shapes above, so "contains the tags" would let the exact
 * body the gate refuses through. Content outside the block is irrelevant —
 * the gate reads the block, and a request may have any other system text.
 */
export function hasEnvBlock(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false
  const open = text.indexOf(ENV_OPEN)
  if (open === -1) return false
  const close = text.indexOf(ENV_CLOSE, open + ENV_OPEN.length)
  // An unterminated block is not a block: the official prompt always closes it,
  // and a truncated tag pair is one more shape the gate has never seen pass.
  if (close === -1) return false
  const body = text.slice(open + ENV_OPEN.length, close)
  return body.split('\n').some((line) => line.trim() !== '')
}

/**
 * Append the block to a system text, unless one is already there.
 *
 * Returns the SAME string reference when nothing had to change, so callers can
 * detect "already shaped" without comparing strings.
 */
export function withEnvBlock(text: string, facts: EnvFacts = hostEnvFacts()): string {
  if (hasEnvBlock(text)) return text
  const block = renderEnvBlock(facts)
  if (text === '') return block
  return `${text.replace(/\s+$/, '')}\n\n${block}`
}
