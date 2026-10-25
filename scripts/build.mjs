#!/usr/bin/env node
/**
 * Canonical build for the shipped plugin artifacts (`lib/`): clean -> node
 * half -> browser half -> manifest. The root package exposes NO lifecycle hook
 * (`prepare`/`prepack`/`postinstall`) on purpose — their presence alone makes
 * git-hosted installs demand an `allowBuilds` entry — so `lib/` is committed
 * and refreshed only here. The clean matters: both halves run tsdown with
 * `clean: false` so they can share one `lib/`.
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
