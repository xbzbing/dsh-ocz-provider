#!/usr/bin/env node
/**
 * Canonical build for the shipped plugin artifacts (`lib/`).
 *
 * Why this exists: the repository root IS the installable package — `dsh
 * plugin add file:<repo>` and `dsh plugin add github:<owner>/<repo>` both
 * resolve to it, and NEITHER runs a lifecycle script (pnpm runs none for
 * `file:` directory deps, and blocks a git-hosted build behind an
 * `allowBuilds` entry whose key contains the commit sha). So `lib/` is
 * committed to git and this script is the one command that refreshes it:
 * clean -> node half -> browser half -> manifest.
 *
 * The clean matters: both halves run tsdown with `clean: false` so they can
 * share one `lib/`.
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

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) {
    console.error(`build: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// A fresh clone needs exactly `pnpm build`: bootstrap the toolchain on demand.
if (!existsSync(join(repoRoot, 'node_modules'))) {
  console.log('build: bootstrapping dependencies')
  run('pnpm', ['install'], repoRoot)
}

rmSync(join(repoRoot, 'lib'), { recursive: true, force: true })
run('pnpm', ['run', 'build:node'], repoRoot)
run('pnpm', ['run', 'build:client'], repoRoot)
writeBuildManifest(repoRoot)
console.log('build: lib/ is up to date (committed to git — stage it with your source changes)')
