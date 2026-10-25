/**
 * Display-metadata contract (dsh-app-boot `readPluginMeta`, ref.
 * lib/package-meta.js): `locale/<lang>.json` meta maps and `package.json.icon`
 * resolve through Node's ESM exports WITHOUT evaluating plugin code, so both
 * must ship in-package and stay valid — a missing export or an out-of-package
 * icon path makes the display metadata silently absent (or surfaces a
 * metadataError diagnostic on the plugin card). The icon cap is 256 KiB,
 * relative and SVG/PNG/JPEG/WebP; locale files share the en.json directory.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  description?: string
  icon?: string
  files?: string[]
  exports?: Record<string, string>
}

test('locale dictionaries ship en + zh with non-empty title and description', () => {
  for (const lang of ['en', 'zh']) {
    const file = join(root, 'locale', `${lang}.json`)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { meta?: { title?: unknown; description?: unknown } }
    assert.equal(typeof parsed.meta?.title, 'string', `${lang}: meta.title must be a string`)
    assert.ok((parsed.meta?.title as string).trim() !== '', `${lang}: meta.title must be non-empty`)
    assert.equal(typeof parsed.meta?.description, 'string', `${lang}: meta.description must be a string`)
    assert.ok((parsed.meta?.description as string).trim() !== '', `${lang}: meta.description must be non-empty`)
  }
})

test('exports expose the locale directory to the metadata resolver', () => {
  // readPluginMeta resolves these through Node's ESM resolver; without an
  // export entry the whole display identity silently disappears.
  const entries = pkg.exports ?? {}
  const exposed = entries['./locale/*'] === './locale/*' || entries['./locale/en.json'] !== undefined
  assert.ok(exposed, 'package.json exports must expose ./locale/')
  assert.ok(entries['./package.json'] !== undefined, 'package.json itself must stay exported (the reader loads it)')
})

test('package.json.icon points at a small in-package image that files[] ships', () => {
  const icon = pkg.icon
  assert.equal(typeof icon, 'string', 'icon field declares the artwork')
  if (typeof icon !== 'string') return
  assert.ok(!/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon), 'icon must be a relative path, not a URL or data URL')
  const target = resolve(root, icon)
  assert.ok(target.startsWith(root + sep), 'icon must resolve inside the package directory')
  const stat = statSync(target)
  assert.ok(stat.isFile(), 'icon must be a regular file')
  assert.ok(stat.size <= 256 * 1024, 'icon must fit the 256 KiB metadata cap')
  assert.ok(['.svg', '.png', '.jpg', '.jpeg', '.webp'].some((ext) => icon.toLowerCase().endsWith(ext)), 'icon must be SVG/PNG/JPEG/WebP')
  const files = pkg.files ?? []
  assert.ok(files.includes('assets'), 'files[] must ship the assets directory')
  assert.ok(files.includes('locale'), 'files[] must ship the locale directory')
})
