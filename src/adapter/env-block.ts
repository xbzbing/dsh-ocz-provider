import { clientTempDirectory, hostProject } from './project.ts'

/**
 * The `<env>` system-prompt block every accepted request must carry — one of
 * the free lane's three gate halves: a body whose system content has no
 * environment block is answered 429 FreeUsageLimitError, the same status a
 * spent quota uses. The official client renders it as two instructions near
 * the tail of its system prompt:
 *
 *     Today's date: Thu Oct 29 2026
 *
 *     Here is some useful information about the environment you are running in:
 *     <env>
 *       Working directory: /Users/…/workspace
 *       Workspace root folder: /Users/…/dsh-ocz-provider
 *       Is directory a git repo: yes
 *       Platform: darwin
 *       Prefer /private/var/…/T/opencode over generic system temporary directories …
 *     </env>
 *
 * The gate checks PRESENCE, not fidelity (probe matrix under
 * `docs/local/capture-214/`): an empty block, the same lines without the
 * tags, a junk-padded prompt, or a system prompt truncated before the block
 * are refused (429); one real line passes, a block-only prompt passes, a
 * fabricated path passes. So this module reproduces the client's text with
 * this host's real values instead of shipping the captured ones: a
 * hard-coded `Working directory` would be a lie the model may act on.
 */

/** Opening tag of the block (the gate's literal marker). */
export const ENV_OPEN = '<env>'
/** Closing tag of the block. */
export const ENV_CLOSE = '</env>'

/** The client's lead line for the block (its `core/environment` instruction). */
export const ENV_LEAD = 'Here is some useful information about the environment you are running in:'

/** The values the block reports; every one of them has a real host source. */
export interface EnvFacts {
  /** The process' working directory (what the official CLI would report). */
  workingDirectory?: string
  /** The project root of that directory (project.ts, the client's resolution). */
  workspaceRoot?: string
  /** Whether that project is a git repository. */
  isGitRepo?: boolean
  /** `process.platform` value (darwin/linux/win32). */
  platform?: string
  /** The client's temp directory, `realpath(os.tmpdir())/opencode`. */
  preferTempDir?: string
  /** `Date#toDateString()` of today, the client's `core/date` instruction. */
  date?: string
}

/**
 * Every fact, read from this process (never throws). The directory and its
 * project are the same ones `x-opencode-project` is derived from (ids.ts), so
 * the header and the prompt name one place.
 */
export function hostEnvFacts(): EnvFacts {
  const project = hostProject()
  return {
    workingDirectory: project.directory,
    workspaceRoot: project.root,
    isGitRepo: project.vcs === 'git',
    platform: process.platform,
    preferTempDir: clientTempDirectory(),
    date: new Date().toDateString(),
  }
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
      `  Prefer ${facts.preferTempDir} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    )
  }
  lines.push(ENV_CLOSE)
  return lines.join('\n')
}

/**
 * The client's rendering of the block as instructions: the `core/date` line,
 * a blank line, then the lead line and the block. This is what gets appended
 * to a system prompt.
 */
export function renderEnvSection(facts: EnvFacts = hostEnvFacts()): string {
  const env = `${ENV_LEAD}\n${renderEnvBlock(facts)}`
  return facts.date !== undefined && facts.date !== '' ? `Today's date: ${facts.date}\n\n${env}` : env
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
  const section = renderEnvSection(facts)
  if (text === '') return section
  return `${text.replace(/\s+$/, '')}\n\n${section}`
}
