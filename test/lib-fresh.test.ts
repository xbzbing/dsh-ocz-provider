/**
 * `lib/` is gitignored and built on demand, so the artifact a `dsh plugin add`
 * copies is whatever the last build produced. This test pins that build to the
 * sources it came from: scripts/lib-manifest.mjs stamps the inputs at build
 * time and `--check` re-derives them, so a hand-edited or half-built `lib/`
 * fails before it can be installed. The comparison is shared with the build, so
 * stamp and check cannot drift apart.
 *
 * With no `lib/` at all (a fresh clone, before `pnpm build`) there is nothing
 * to compare: the repo-level test SKIPS. `pnpm verify` builds first, so the
 * gate always runs it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib-manifest.mjs')

/** Set when there is no build to check; node:test turns it into a skip. */
const NO_BUILD = {
  skip: existsSync(new URL('../lib/index.js', import.meta.url))
    ? false
    : 'lib/ is not built — run `pnpm build` first',
}

test('lib/ matches src/ and the lockfile it was built from', NO_BUILD, () => {
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
