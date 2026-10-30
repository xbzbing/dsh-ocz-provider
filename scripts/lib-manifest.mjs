#!/usr/bin/env node
/**
 * Freshness manifest for the committed `lib/`: every build stamps the exact
 * input state it produced, and `--check` re-derives it and fails when the two
 * no longer agree — the guard against editing `src/` and forgetting to rebuild,
 * which would install stale code for everyone. Inputs are the source tree, both
 * bundle configs, and package.json + pnpm-lock.yaml (the client bundle inlines
 * dependencies). Outputs are every file under `lib/` except the manifest:
 * builds are byte-identical for identical inputs (AGENTS.md), so a hand-edited
 * or half-built `lib/` fails the check too.
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
const INPUTS = ['src', 'tsdown.config.ts', 'tsdown.client.config.ts', 'package.json', 'pnpm-lock.yaml']
const OUTPUT_DIR = 'lib'
const MANIFEST_NAME = '.build-manifest.json'
const MANIFEST_VERSION = 2

/** Every file under the `entries` paths of `root`, as posix-relative paths, sorted. */
function listFiles(root, entries) {
  const files = []
  for (const entry of entries) {
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

/** `{ path: sha1 }` for `files`, keyed in sorted order. */
function hashFiles(root, files) {
  const hashes = {}
  for (const rel of files) {
    hashes[rel] = createHash('sha1').update(readFileSync(join(root, rel))).digest('hex')
  }
  return hashes
}

/** `{ path: sha1 }` for every input file. */
export function computeInputs(root) {
  return hashFiles(root, listFiles(root, INPUTS))
}

/** `{ path: sha1 }` for every build output (the manifest itself excluded). */
export function computeOutputs(root) {
  const manifest = `${OUTPUT_DIR}/${MANIFEST_NAME}`
  return hashFiles(root, listFiles(root, [OUTPUT_DIR]).filter((rel) => rel !== manifest))
}

export function manifestPath(root) {
  return join(root, OUTPUT_DIR, MANIFEST_NAME)
}

export function writeBuildManifest(root) {
  const manifest = { version: MANIFEST_VERSION, inputs: computeInputs(root), outputs: computeOutputs(root) }
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
  if (recorded.version !== MANIFEST_VERSION) {
    return { code: 1, message: `manifest version ${recorded.version} != ${MANIFEST_VERSION} — run \`pnpm build\` at the repo root` }
  }
  const stale = differences(recorded.inputs, computeInputs(root))
  if (stale.length > 0) {
    return { code: 1, message: `lib/ is stale (source changed without a rebuild):\n  ${stale.join('\n  ')}\nRun \`pnpm build\` at the repo root and commit lib/.` }
  }
  const altered = differences(recorded.outputs, computeOutputs(root))
  if (altered.length > 0) {
    return { code: 1, message: `lib/ does not match its recorded build (edited by hand or half-built):\n  ${altered.join('\n  ')}\nRun \`pnpm build\` at the repo root and commit lib/.` }
  }
  return { code: 0, message: 'ok' }
}

/** Paths whose hash differs between `recorded` and `actual`, plus additions and deletions. */
function differences(recorded, actual) {
  const changed = []
  for (const [rel, hash] of Object.entries(actual)) {
    if (recorded?.[rel] === undefined) changed.push(`${rel} (added)`)
    else if (recorded[rel] !== hash) changed.push(rel)
  }
  for (const rel of Object.keys(recorded ?? {})) {
    if (!(rel in actual)) changed.push(`${rel} (deleted)`)
  }
  return changed
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
