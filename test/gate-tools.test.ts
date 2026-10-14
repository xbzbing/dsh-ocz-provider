import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FREE_LANE_GATE_TOOL_NAMES,
  GENUINE_GATE_TOOLS,
  freeLaneGateFlatTool,
  freeLaneGateTool,
  gateToolArgumentBridge,
  isGenuineFlatGateTool,
  isGenuineGateTool,
} from '../src/adapter/gate-tools.ts'

/**
 * The host tools as DSH declares them (`dsh-tool-bash` / `dsh-tool-fs`,
 * 0.1.1-rc.2): `timeoutMs` where the wire says `timeout`, `file_path` where the
 * wire says `filePath`, a REQUIRED `description` the wire schema has no field
 * for, and per-property `required: true` instead of a JSON-Schema array.
 */
const HOST_TOOLS = [
  {
    name: 'bash',
    parameters: {
      description: { type: 'string', required: true, description: 'Clear, concise description of what this command does.' },
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      workdir: { type: 'string', description: 'Working directory for this command.' },
    },
  },
  {
    name: 'read',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read.' },
      offset: { type: 'number', description: '1-based first line to return.' },
      limit: { type: 'number', description: 'Maximum number of lines to return.' },
    },
  },
  { name: 'webfetch', parameters: { url: { type: 'string', required: true } } },
]

test('the genuine gate tools are the pair the gate validates', () => {
  assert.deepEqual([...FREE_LANE_GATE_TOOL_NAMES], ['bash', 'read'])
  for (const name of FREE_LANE_GATE_TOOL_NAMES) {
    const tool = GENUINE_GATE_TOOLS[name]
    assert.equal(tool.type, 'function')
    assert.equal(tool.function.name, name)
    // The gate matches a SUBSTRING of the description, so shipping a short
    // paraphrase fails (measured: truncating bash's to 120 chars -> 403).
    assert.ok(tool.function.description.length > 1000, `${name} ships the genuine description`)
    const parameters = tool.function.parameters as {
      $schema?: unknown
      type?: unknown
      properties?: Record<string, unknown>
      required?: unknown
    }
    assert.equal(parameters.type, 'object')
    // `$schema` is part of what the gate compares byte for byte.
    assert.equal(parameters.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.ok(Array.isArray(parameters.required) && parameters.required.length > 0)
    for (const key of parameters.required as string[]) {
      assert.ok(Object.hasOwn(parameters.properties ?? {}, key), `${name}.${key} is declared`)
    }
  }
  assert.deepEqual((GENUINE_GATE_TOOLS.bash.function.parameters as { required: string[] }).required, ['command'])
  assert.deepEqual((GENUINE_GATE_TOOLS.read.function.parameters as { required: string[] }).required, ['filePath'])
})

test('freeLaneGateTool hands out detached copies', () => {
  const first = freeLaneGateTool('bash')
  first.function.description = 'mutated'
  assert.notEqual(GENUINE_GATE_TOOLS.bash.function.description, 'mutated', 'the constant is not writable through a copy')
  assert.deepEqual(freeLaneGateTool('bash').function, GENUINE_GATE_TOOLS.bash.function)
})

test('isGenuineGateTool mirrors the gate: substring description, exact parameters', () => {
  const genuine = freeLaneGateTool('bash')
  assert.ok(isGenuineGateTool('bash', genuine))
  assert.ok(
    isGenuineGateTool('bash', { ...genuine, function: { ...genuine.function, description: `X${genuine.function.description} (copy)` } }),
    'a description that CONTAINS the genuine text passes (measured 2026-10-14)',
  )
  assert.ok(
    !isGenuineGateTool('bash', { ...genuine, function: { ...genuine.function, description: genuine.function.description.slice(0, 120) } }),
    'a truncated one does not (measured: 403)',
  )
  assert.ok(
    !isGenuineGateTool('bash', { ...genuine, function: { ...genuine.function, parameters: { type: 'object', properties: {} } } }),
    'parameters are compared, not just their shape (measured: 403)',
  )
  assert.ok(!isGenuineGateTool('webfetch', genuine), 'only the gate names are known')
  assert.ok(!isGenuineGateTool('bash', null))
})

test('isGenuineFlatGateTool checks the responses spelling', () => {
  const flat = freeLaneGateFlatTool('read')
  assert.equal(flat.type, 'function')
  assert.equal(flat.name, 'read')
  assert.ok(isGenuineFlatGateTool('read', flat))
  assert.ok(!isGenuineFlatGateTool('read', { ...flat, parameters: {} }))
})

test('gateToolArgumentBridge maps the wire names onto the host declarations', () => {
  const bridge = gateToolArgumentBridge(HOST_TOOLS)
  assert.notEqual(bridge, undefined)
  assert.deepEqual([...bridge!.names].sort(), ['bash', 'read'])

  // read: the wire's filePath is the host's file_path
  assert.deepEqual(bridge!.rewrite('read', { filePath: '/tmp/a.txt', offset: 2, limit: 5 }), {
    file_path: '/tmp/a.txt',
    offset: 2,
    limit: 5,
  })
  // bash: timeout -> timeoutMs, and the host's REQUIRED description is
  // synthesized from the command because the wire schema has no such field
  assert.deepEqual(bridge!.rewrite('bash', { command: 'ls -la', timeout: 5000, workdir: '/tmp' }), {
    command: 'ls -la',
    timeoutMs: 5000,
    workdir: '/tmp',
    description: 'ls -la',
  })
  // a description the model did send wins over the synthesized one
  assert.deepEqual(bridge!.rewrite('bash', { command: 'ls', description: 'List files', timeout: 1000 }), {
    command: 'ls',
    description: 'List files',
    timeoutMs: 1000,
  })
  // arguments that already match the host shape are reported as unchanged
  assert.equal(bridge!.rewrite('bash', { command: 'ls', description: 'List files' }), undefined)
  // the synthesized description is the command's first line, bounded
  assert.equal(
    (bridge!.rewrite('bash', { command: 'echo a\necho b' }) as Record<string, unknown>).description,
    'echo a',
  )
  // tools outside the gate pair are never touched
  assert.equal(bridge!.rewrite('webfetch', { url: 'https://x' }), undefined)
})

test('gateToolArgumentBridge reports no change when the host shape already matches', () => {
  const alreadyMatching = [
    { name: 'read', parameters: { filePath: { type: 'string', required: true }, offset: { type: 'number' }, limit: { type: 'number' } } },
  ]
  const bridge = gateToolArgumentBridge(alreadyMatching)
  assert.notEqual(bridge, undefined)
  assert.equal(bridge!.rewrite('read', { filePath: '/tmp/a.txt' }), undefined, 'same shape = the stream is left alone')
})

test('gateToolArgumentBridge is absent when the host declares no gate tool', () => {
  assert.equal(gateToolArgumentBridge([]), undefined)
  assert.equal(gateToolArgumentBridge(undefined), undefined)
  assert.equal(gateToolArgumentBridge([{ name: 'webfetch', parameters: {} }]), undefined)
})

test('gateToolArgumentBridge drops a wire argument the host does not declare', () => {
  const bridge = gateToolArgumentBridge([
    { name: 'bash', parameters: { command: { type: 'string', required: true }, description: { type: 'string', required: true } } },
  ])
  assert.deepEqual(bridge!.rewrite('bash', { command: 'ls', workdir: '/tmp' }), { command: 'ls', description: 'ls' })
})

test('gateToolArgumentBridge reads a JSON-Schema required array too', () => {
  const bridge = gateToolArgumentBridge([
    {
      name: 'read',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' }, offset: { type: 'integer' } },
        required: ['file_path'],
      },
    },
  ])
  assert.deepEqual(bridge!.rewrite('read', { filePath: '/tmp/a', offset: 3 }), { file_path: '/tmp/a', offset: 3 })
})
