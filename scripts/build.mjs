#!/usr/bin/env node
/**
 * Canonical build for the shipped plugin artifacts (`packages/plugin/lib`).
 *
 * Why this exists: the repository root IS the installable package — `dsh
 * plugin add file:<repo>` and `dsh plugin add github:<owner>/<repo>` both
 * resolve to it, and NEITHER runs a lifecycle script (pnpm runs none for
 * `file:` directory deps, and blocks a git-hosted build behind an
 * `allowBuilds` entry whose key contains the commit sha). So `lib/` is
 * committed to git and this script is the one command that refreshes it:
 * clean -> node half -> browser half -> manifest.
 *
 * The clean matters: `packages/plugin`'s own `build` carries `--no-clean` so
 * the two halves can share one `lib/`, which means running it repeatedly
 * leaves every superseded hashed chunk behind.
 *
 * Root scripts deliberately expose NO lifecycle hook (`prepare`/`prepack`/
 * `postinstall`) — their mere presence is what makes git-hosted installs
 * demand an allowBuilds entry.
 */
import { existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeBuildManifest } from './lib-manifest.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginDir = join(repoRoot, 'packages', 'plugin')

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) {
    console.error(`build: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// The root package carries only runtime dependencies; the build toolchain
// lives in packages/plugin's own install. Bootstrap it on demand so a fresh
// clone needs exactly `pnpm build`.
if (!existsSync(join(pluginDir, 'node_modules'))) {
  console.log('build: bootstrapping packages/plugin dependencies')
  run('pnpm', ['install'], pluginDir)
}

rmSync(join(pluginDir, 'lib'), { recursive: true, force: true })
run('pnpm', ['run', 'build'], pluginDir)
run('pnpm', ['run', 'build:client'], pluginDir)
writeBuildManifest(pluginDir)
console.log('build: packages/plugin/lib is up to date (committed to git — stage it with your source changes)')
