import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { clientTempDirectory, GLOBAL_PROJECT_ID, normalizeRemote, resetProjectCache, resolveProject } from '../src/adapter/project.ts'
import { deriveRequestIDs, disguiseHeaders, resetSessionIDCache, traceIDFor } from '../src/adapter/ids.ts'
import { chatApiPath, ZEN_FALLBACK_BASE_URL, ZEN_PRIMARY_BASE_URL } from '../src/adapter/lane.ts'

/**
 * The project half of the client fingerprint: `x-opencode-project` and the
 * `<env>` block's workspace facts come from one port of the 2.2.0 client's
 * `Project.resolve`. Repositories are built in temp dirs so the cases do not
 * depend on this checkout's remote.
 */

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
}

async function scratch(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'oc2dsh-project-')))
}

test('normalizeRemote follows the client: host/path, scp style, no .git, no file:', () => {
  assert.equal(normalizeRemote('git@github.com:xbzbing/dsh-ocz-provider.git'), 'github.com/xbzbing/dsh-ocz-provider')
  assert.equal(normalizeRemote('https://GitHub.com/xbzbing/dsh-ocz-provider.git/'), 'github.com/xbzbing/dsh-ocz-provider')
  assert.equal(normalizeRemote('ssh://git@github.com/xbzbing/dsh-ocz-provider'), 'github.com/xbzbing/dsh-ocz-provider')
  assert.equal(normalizeRemote('file:///srv/repo.git'), undefined)
  assert.equal(normalizeRemote('   '), undefined)
  // The id the 2.2.0 client sent from this repository (TLS capture).
  assert.equal(sha1(`git-remote:${normalizeRemote('git@github.com:xbzbing/dsh-ocz-provider.git')}`), '2752b498507aba026b4d114783abe85b6f8509fb')
})

test('a git repo with an origin hashes the remote; the root is the worktree', async () => {
  const dir = await scratch()
  try {
    git(dir, 'init', '-q')
    git(dir, 'remote', 'add', 'origin', 'git@example.com:team/app.git')
    await mkdir(join(dir, 'src'))
    resetProjectCache()
    const project = resolveProject(join(dir, 'src'))
    assert.equal(project.id, sha1('git-remote:example.com/team/app'))
    assert.equal(project.root, dir)
    assert.equal(project.directory, join(dir, 'src'))
    assert.equal(project.vcs, 'git')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('without a remote: the opencode id file, then the root commit, then global', async () => {
  const dir = await scratch()
  try {
    git(dir, 'init', '-q')
    resetProjectCache()
    assert.equal(resolveProject(dir).id, GLOBAL_PROJECT_ID, 'empty repository')
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'root')
    const root = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    resetProjectCache()
    assert.equal(resolveProject(dir).id, root)
    await writeFile(join(dir, '.git', 'opencode'), 'cafebabe\n')
    resetProjectCache()
    assert.equal(resolveProject(dir).id, 'cafebabe', 'the id file outranks the root commit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a directory outside any repository hashes its absolute path', async () => {
  const dir = await scratch()
  try {
    resetProjectCache()
    const project = resolveProject(dir)
    assert.equal(project.id, sha1(`directory:${dir}`))
    assert.equal(project.root, dir)
    assert.equal(project.vcs, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the temp directory line names <realpath tmpdir>/opencode', async () => {
  assert.equal(clientTempDirectory(), join(await realpath(tmpdir()), 'opencode'))
})

test('one trace per conversation, a fresh span per request', () => {
  resetSessionIDCache()
  const ids = deriveRequestIDs([{ role: 'user', content: 'trace me' }])
  const first = disguiseHeaders(ids)
  const second = disguiseHeaders(deriveRequestIDs([{ role: 'user', content: 'trace me' }]))
  const trace = traceIDFor(ids.session)
  assert.match(trace, /^[0-9a-f]{32}$/)
  assert.equal(first['b3']!.split('-')[0], trace)
  assert.equal(second['b3']!.split('-')[0], trace, 'the same conversation keeps its trace')
  assert.notEqual(first['b3']!.split('-')[1], second['b3']!.split('-')[1], 'each request is a new span')
  const other = disguiseHeaders(deriveRequestIDs([{ role: 'user', content: 'another conversation' }]))
  assert.notEqual(other['b3']!.split('-')[0], trace)
})

test('chats use the family path on /inference only', () => {
  assert.equal(chatApiPath(ZEN_PRIMARY_BASE_URL), '/openai/v1')
  assert.equal(chatApiPath(`${ZEN_PRIMARY_BASE_URL}/`), '/openai/v1')
  assert.equal(chatApiPath(ZEN_FALLBACK_BASE_URL), '/v1', '/zen has no family route (404)')
  assert.equal(chatApiPath('https://zen.test'), '/v1', 'fixtures and operator bases stay flat')
})
