#!/usr/bin/env node
/**
 * Freshness manifest for the committed `lib/`.
 *
 * `lib/` is committed so `file:` / `github:` installs ship working code
 * without running any lifecycle script. The failure mode that commitment
 * buys is a contributor editing `src/` and forgetting to rebuild, which
 * would silently install stale code for everyone — so every build stamps the
 * exact input state it produced, and `--check` re-derives it and fails when
 * they no longer agree.
 *
 * Inputs are the source tree plus the browser bundle config (both halves'
 * inputs); the manifest itself and build outputs are deliberately excluded so
 * touching `lib/` is not itself a change that invalidates it.
 *
 * Usage:
 *   node scripts/lib-manifest.mjs          # stamp lib/.build-manifest.json
 *   node scripts/lib-manifest.mjs --check  # exit 1 when lib/ is stale
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo-relative paths that determine the bundle (both halves' inputs). */
const INPUTS = ['src', 'tsdown.config.ts', 'tsdown.client.config.ts']
const MANIFEST_VERSION = 1

/** Every input file under `root`, as posix-relative paths, sorted. */
function inputFiles(root) {
  const files = []
  for (const entry of INPUTS) {
    const abs = join(root, entry)
    if (!existsSync(abs)) continue
    if (statSync(abs).isFile()) {
      files.push(entry)
      continue
    }
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const child = join(dir, name)
        if (statSync(child).isDirectory()) walk(child)
        else files.push(relative(root, child).split(sep).join(posix.sep))
      }
    }
    walk(abs)
  }
  return files.sort()
}

/** `{ path: sha1 }` for every input file, keyed in sorted order. */
export function computeInputs(root) {
  const inputs = {}
  for (const rel of inputFiles(root)) {
    inputs[rel] = createHash('sha1').update(readFileSync(join(root, rel))).digest('hex')
  }
  return inputs
}

export function manifestPath(root) {
  return join(root, 'lib', '.build-manifest.json')
}

export function writeBuildManifest(root) {
  const manifest = { version: MANIFEST_VERSION, inputs: computeInputs(root) }
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

/** Exit status + message for `--check`. */
export function checkBuildManifest(root) {
  const path = manifestPath(root)
  if (!existsSync(path)) {
    return { code: 1, message: `lib/.build-manifest.json is missing — run \`pnpm build\` at the repo root and commit lib/` }
  }
  let recorded
  try {
    recorded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { code: 1, message: `lib/.build-manifest.json is unreadable (${error.message}) — run \`pnpm build\` at the repo root` }
  }
  const actual = computeInputs(root)
  if (recorded.version !== MANIFEST_VERSION) {
    return { code: 1, message: `manifest version ${recorded.version} != ${MANIFEST_VERSION} — run \`pnpm build\` at the repo root` }
  }
  const stale = []
  for (const [rel, hash] of Object.entries(actual)) {
    if (recorded.inputs?.[rel] !== hash) stale.push(rel)
  }
  for (const rel of Object.keys(recorded.inputs ?? {})) {
    if (!(rel in actual)) stale.push(`${rel} (deleted)`)
  }
  if (stale.length > 0) {
    return { code: 1, message: `lib/ is stale (source changed without a rebuild):\n  ${stale.join('\n  ')}\nRun \`pnpm build\` at the repo root and commit lib/.` }
  }
  return { code: 0, message: 'ok' }
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  if (process.argv.includes('--check')) {
    const { code, message } = checkBuildManifest(repoRoot)
    if (code !== 0) console.error(message)
    process.exit(code)
  }
  writeBuildManifest(repoRoot)
}
