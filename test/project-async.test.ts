import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resetProjectCache, resolveProject, resolveProjectAsync } from '../src/adapter/project.ts'

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

test('the async resolution yields exactly what the sync one does', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'oc2dsh-project-async-')))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/team/app.git'], { cwd: dir, stdio: 'ignore' })
    resetProjectCache()
    const viaAsync = await resolveProjectAsync(dir)
    assert.equal(viaAsync.id, sha1('git-remote:example.com/team/app'))
    assert.equal(viaAsync.vcs, 'git')
    // the sync read is now a cache hit returning the same facts
    assert.equal(resolveProject(dir), viaAsync)
    resetProjectCache()
    assert.deepEqual(resolveProject(dir), viaAsync)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent cold async reads share one resolution', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'oc2dsh-project-async-')))
  try {
    resetProjectCache()
    const [a, b] = await Promise.all([resolveProjectAsync(dir), resolveProjectAsync(dir)])
    assert.equal(a, b)
    assert.equal(a.id, sha1(`directory:${dir}`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
