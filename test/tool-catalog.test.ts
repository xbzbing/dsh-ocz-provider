/**
 * The known-tools catalogue: the merge order that decides a tool's wire shape,
 * the upgrade diff, and what survives a restart. Driven through the real file
 * in a temp directory — the baseline only earns its keep if it outlives the
 * process it was recorded in.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ToolCatalog,
  descriptionHash,
  diffToolSets,
  hostVersion,
  observedToolsFrom,
  resetHostVersionCache,
  resolveToolShape,
  toolAliases,
  toolFingerprint,
} from '../src/tool-catalog.ts'
import { makeBridgeHandlers } from '../src/ip-pool-settings/handlers.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tool-catalog-'))
}

const tool = (name: string, description: string): { name: string; description: string } => ({ name, description })

test('a built-in rename carries the client description under the WIRE name', () => {
  const shape = resolveToolShape('edit')
  assert.equal(shape.wire, 'file_edit')
  assert.equal(shape.wireSource, 'builtin')
  // The lane matched the text under the wire spelling, not the host name.
  assert.equal(shape.descriptionSource, 'client')
  assert.match(shape.description ?? '', /^Edit the contents of a file/)
})

test('a tool the client never ships keeps its name and the host text', () => {
  const shape = resolveToolShape('create_goal')
  assert.equal(shape.wire, 'create_goal')
  assert.equal(shape.wireSource, 'identity')
  assert.equal(shape.description, undefined)
  assert.equal(shape.descriptionSource, 'host')
})

test('an override outranks the built-in table, and an empty field restores it', () => {
  const overrides = { edit: { wire: 'zzz_edit', description: 'host-side wording' } }
  const custom = resolveToolShape('edit', overrides)
  assert.equal(custom.wire, 'zzz_edit')
  assert.equal(custom.wireSource, 'custom')
  assert.equal(custom.description, 'host-side wording')
  assert.equal(custom.descriptionSource, 'custom')

  // Empty strings mean "no override": the wire name still moves, the text does
  // not, so a cleared description falls back to the client's own wording.
  const cleared = resolveToolShape('edit', { edit: { wire: 'zzz_edit', description: '' } })
  assert.equal(cleared.wire, 'zzz_edit')
  assert.equal(cleared.descriptionSource, 'client')
})

test('the reply alias table carries live overrides and retired spellings', () => {
  const aliases = toolAliases({ working_directory: { wire: 'cwd2' } }, { cwd: 'working_directory', zzz_old: 'edit' })
  assert.equal(aliases['cwd2'], 'working_directory')
  // A retired spelling still resolves: a call already on the wire must survive
  // an alias change mid-session.
  assert.equal(aliases.cwd, 'working_directory')
  assert.equal(aliases.zzz_old, 'edit')
  // Built-in mappings stay reachable.
  assert.equal(aliases.file_edit, 'edit')
})

test('the diff names a rename instead of an add plus a remove', () => {
  const baseline = {
    bash: { chars: 10, descHash: descriptionHash('run a command') },
    read: { chars: 10, descHash: descriptionHash('read a file') },
    gone: { chars: 10, descHash: descriptionHash('dropped entirely') },
  }
  const current = {
    shell: { descHash: descriptionHash('run a command') },
    read: { descHash: descriptionHash('read a file') },
    fresh: { descHash: descriptionHash('brand new') },
  }
  const diff = diffToolSets(baseline, current)
  assert.deepEqual(diff.renamed, [{ from: 'bash', to: 'shell' }])
  assert.deepEqual(diff.added, ['fresh'])
  assert.deepEqual(diff.removed, ['gone'])
  assert.deepEqual(diff.drifted, [])
})

test('a same-name description rewrite is drift, not a rename', () => {
  const baseline = { skill: { chars: 5, descHash: descriptionHash('old text') } }
  const current = { skill: { descHash: descriptionHash('new text') } }
  const diff = diffToolSets(baseline, current)
  assert.deepEqual(diff.drifted, ['skill'])
  assert.deepEqual(diff.renamed, [])
})

test('the fingerprint ignores order and moves with the set', () => {
  assert.equal(toolFingerprint(['b', 'a']), toolFingerprint(['a', 'b']))
  assert.notEqual(toolFingerprint(['a', 'b']), toolFingerprint(['a', 'b', 'c']))
})

test('both lane shapes parse into one observation list', () => {
  assert.deepEqual(observedToolsFrom([{ name: 'read', description: 'x' }], true), [tool('read', 'x')])
  assert.deepEqual(
    observedToolsFrom([{ type: 'function', function: { name: 'read', description: 'x' } }], false),
    [tool('read', 'x')],
  )
  // An entry without a name is not a tool; a missing description is empty text.
  assert.deepEqual(observedToolsFrom([{ description: 'x' }, { name: 'a' }], true), [tool('a', '')])
})

test('without a baseline nothing reads as added', () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir })
    // A fresh install knows today's set from the registry only: flagging all of
    // it as "new" would be noise, so the diff waits for a recorded baseline.
    const view = catalog.view([tool('read', 'r'), tool('write', 'w')])
    assert.equal(view.recorded, false)
    assert.equal(view.pending, 0)
    assert.deepEqual(view.rows.map((row) => row.state), ['ok', 'ok'])
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the first observation records the baseline, and an upgrade shows as pending', async () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir, now: () => 1_000 })
    catalog.observe([tool('bash', 'run a command'), tool('read', 'read a file')])
    const first = catalog.view()
    assert.equal(first.recorded, true)
    assert.equal(first.pending, 0)
    assert.equal(first.rows.length, 2)

    // A later observation only updates what was seen: the baseline stays put,
    // so the upgrade is still visible.
    catalog.observe([tool('shell', 'run a command'), tool('read', 'read a file')])
    const after = catalog.view()
    // A rename is ONE change: the new name is flagged, the dropped one only
    // shows (as `gone`) so its override can be cleared.
    assert.equal(after.pending, 1)
    assert.equal(after.rows.find((row) => row.name === 'shell')?.state, 'renamed')
    assert.equal(after.rows.find((row) => row.name === 'shell')?.renamedFrom, 'bash')
    await catalog.flush()
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the row carries the text that rode the wire, so the editor can prefill it', async () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir, now: () => 5_000 })
    const text = 'Edit an existing UTF-8 text file by replacing literal text.'
    catalog.observe([tool('edit', text)])
    const row = catalog.view().rows.find((entry) => entry.name === 'edit')!
    // The built-in client wording wins on the wire, and the row shows exactly
    // that — an editor that prefilled an empty box would hide it.
    assert.equal(row.descriptionSource, 'client')
    assert.match(row.description, /^Edit the contents of a file/)
    // A tool with no built-in text keeps the observation's own wording.
    catalog.observe([tool('create_goal', 'Goal text'), tool('edit', text)])
    const plain = catalog.view().rows.find((entry) => entry.name === 'create_goal')!
    assert.equal(plain.descriptionSource, 'host')
    assert.equal(plain.description, 'Goal text')
    await catalog.flush()
    const onDisk = JSON.parse(readFileSync(join(dir, 'tool-catalog.json'), 'utf8')) as {
      seen: Record<string, { description?: string }>
    }
    assert.equal(onDisk.seen.create_goal?.description, 'Goal text')
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a document that kept only digests borrows the registry text', () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir })
    catalog.observe([tool('cache_search', 'host wording')])
    // Simulate the older document: drop the stored text.
    ;(catalog.document().seen.cache_search as { description?: string }).description = undefined
    const row = catalog.view([tool('cache_search', 'host wording')]).rows.find((entry) => entry.name === 'cache_search')!
    assert.equal(row.description, 'host wording')
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the registry view is an early warning, never a replacement for an observation', () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir })
    catalog.observe([tool('read', 'read a file')])
    catalog.observeRegistered([tool('read', 'registry wording'), tool('apply_patch', 'patch files')])
    const view = catalog.view()
    const read = view.rows.find((row) => row.name === 'read')
    // The observed entry keeps its own wording: only a real request is evidence.
    assert.equal(read?.source, 'observed')
    // The registry-only tool still shows, flagged as new against the baseline.
    assert.equal(view.rows.find((row) => row.name === 'apply_patch')?.state, 'added')
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a wire name another tool already uses is refused', () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir })
    catalog.observe([tool('read', 'r'), tool('write', 'w'), tool('edit', 'e')])
    // `file_edit` is the built-in wire name of `edit`.
    assert.deepEqual(catalog.saveOverride('write', { wire: 'file_edit' }), { ok: false, reason: 'wire-taken' })
    assert.deepEqual(catalog.saveOverride('write', { wire: 'bad name!' }), { ok: false, reason: 'wire-invalid' })
    assert.deepEqual(catalog.saveOverride('nope', { wire: 'x' }), { ok: false, reason: 'tool-unknown' })
    assert.deepEqual(catalog.saveOverride('write', { wire: 'write_file' }), { ok: true })
    assert.equal(catalog.resolve('write').wire, 'write_file')
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('changing a wire name retires the old spelling for the reply path', async () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir })
    catalog.observe([tool('working_directory', 'cwd tool')])
    assert.equal(catalog.aliases().cwd, 'working_directory')
    assert.deepEqual(catalog.saveOverride('working_directory', { wire: 'pwd' }), { ok: true })
    const aliases = catalog.aliases()
    assert.equal(aliases.pwd, 'working_directory')
    // The name that already rode the wire still resolves.
    assert.equal(aliases.cwd, 'working_directory')
    await catalog.flush()
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resetting an override restores the built-in shape', () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir })
    catalog.observe([tool('edit', 'e')])
    catalog.saveOverride('edit', { wire: 'zzz_edit', description: 'custom' })
    catalog.resetOverride('edit')
    const shape = catalog.resolve('edit')
    assert.equal(shape.wire, 'file_edit')
    assert.equal(shape.descriptionSource, 'client')
    assert.equal(catalog.aliases().zzz_edit, 'edit')
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the baseline and the overrides survive a restart', async () => {
  const dir = tempDir()
  try {
    const first = new ToolCatalog({ dir, now: () => 2_000 })
    first.observe([tool('read', 'r'), tool('edit', 'e')])
    first.saveOverride('edit', { wire: 'zzz_edit' })
    await first.flush()
    first.dispose()

    const onDisk = JSON.parse(readFileSync(join(dir, 'tool-catalog.json'), 'utf8')) as { recordedAt: number; baseline: Record<string, unknown>; overrides: Record<string, unknown> }
    assert.equal(onDisk.recordedAt, 2_000)
    assert.deepEqual(Object.keys(onDisk.baseline).sort(), ['edit', 'read'])
    assert.equal((onDisk.overrides.edit as { wire?: string }).wire, 'zzz_edit')

    const second = new ToolCatalog({ dir })
    assert.equal(second.view().recorded, true)
    assert.equal(second.resolve('edit').wire, 'zzz_edit')
    second.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recording the baseline again accepts the current set', async () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir, now: () => 3_000 })
    catalog.observe([tool('bash', 'run a command')])
    catalog.observe([tool('shell', 'run a command')])
    assert.equal(catalog.view().pending, 1)
    const view = catalog.recordBaseline()
    assert.equal(view.pending, 0)
    assert.equal(view.recordedAt, 3_000)
    await catalog.flush()
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable document starts empty instead of throwing', () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir })
    // Nothing on disk: the first view is empty rather than a failure.
    const view = catalog.view()
    assert.equal(view.recorded, false)
    assert.deepEqual(view.rows, [])
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the host version comes from the install dir the host exports', () => {
  const previous = process.env.DSH_INSTALL_DIR
  try {
    process.env.DSH_INSTALL_DIR = tmpdir()
    resetHostVersionCache()
    // No package.json there: unknown, never a throw.
    assert.equal(hostVersion(), '')
    delete process.env.DSH_INSTALL_DIR
    resetHostVersionCache()
    assert.equal(hostVersion(), '')
  } finally {
    if (previous === undefined) delete process.env.DSH_INSTALL_DIR
    else process.env.DSH_INSTALL_DIR = previous
    resetHostVersionCache()
  }
})

test('the /tools bridge reads, saves, resets and records through the catalogue', async () => {
  const dir = tempDir()
  try {
    const catalog = new ToolCatalog({ dir, now: () => 4_000 })
    const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }), {
      toolCatalog: catalog,
      // The registry join is optional: a host without it still answers.
      registeredTools: () => [tool('read', 'read a file'), tool('apply_patch', 'patch files')],
    })
    const read = await handlers.tools({})
    assert.equal(read.ok, true)
    const view = (read as { value: { rows: Array<{ name: string; state: string }>; pending: number } }).value
    assert.deepEqual(view.rows.map((row) => row.name), ['apply_patch', 'read'])

    const saved = await handlers.tools({ action: 'save', name: 'read', wire: 'file_read' })
    assert.equal(saved.ok, true)
    assert.equal(catalog.resolve('read').wire, 'file_read')

    // A refused write comes back with the reason as the code, so the pane can
    // print the host's own sentence.
    const taken = await handlers.tools({ action: 'save', name: 'apply_patch', wire: 'file_edit' })
    assert.equal(taken.ok, false)
    assert.equal((taken as { code: string }).code, 'wire-taken')

    const reset = await handlers.tools({ action: 'reset', name: 'read' })
    assert.equal(reset.ok, true)
    assert.equal(catalog.resolve('read').wire, 'read')

    const recorded = await handlers.tools({ action: 'record' })
    assert.equal(recorded.ok, true)
    assert.equal((recorded as { value: { pending: number } }).value.pending, 0)

    const bad = await handlers.tools({ action: 'nonsense' })
    assert.equal(bad.ok, false)
    catalog.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
