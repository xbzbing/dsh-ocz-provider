/**
 * `lib/` ships in git (neither install path runs a lifecycle script), so a
 * source edit committed without a rebuild would install stale code for every
 * later user — this test makes that impossible to merge. The comparison lives
 * in scripts/lib-manifest.mjs, shared with the build, so stamp and check
 * cannot drift apart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib-manifest.mjs')

test('committed lib/ matches src/ (rebuild and commit after source changes)', () => {
  const result = spawnSync(process.execPath, [CHECKER, '--check'], { encoding: 'utf8' })
  assert.equal(
    result.status,
    0,
    `${result.stderr.trim() || result.stdout.trim() || `check exited ${result.status}`}`,
  )
})

test('the manifest catches stale inputs and edited or half-built outputs', async () => {
  const { checkBuildManifest, writeBuildManifest } = await import(pathToFileURL(CHECKER).href) as {
    checkBuildManifest: (root: string) => { code: number; message: string }
    writeBuildManifest: (root: string) => unknown
  }
  const root = mkdtempSync(join(tmpdir(), 'oc2dsh-manifest-'))
  try {
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'lib'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}\n')
    writeFileSync(join(root, 'package.json'), '{"name":"x"}\n')
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(join(root, 'lib', 'index.js'), 'export {}\n')
    writeFileSync(join(root, 'lib', 'client.js'), '//client\n')
    writeBuildManifest(root)
    assert.equal(checkBuildManifest(root).code, 0)

    writeFileSync(join(root, 'lib', 'client.js'), '//hand edit\n')
    assert.match(checkBuildManifest(root).message, /does not match its recorded build[\s\S]*lib\/client\.js/)
    writeFileSync(join(root, 'lib', 'client.js'), '//client\n')
    rmSync(join(root, 'lib', 'index.js'))
    assert.match(checkBuildManifest(root).message, /lib\/index\.js \(deleted\)/, 'a half-built lib/ fails')
    writeFileSync(join(root, 'lib', 'index.js'), 'export {}\n')
    assert.equal(checkBuildManifest(root).code, 0)

    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# bumped\n')
    assert.match(checkBuildManifest(root).message, /stale[\s\S]*pnpm-lock\.yaml/, 'a dependency change needs a rebuild')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
