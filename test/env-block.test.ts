import test from 'node:test'
import assert from 'node:assert/strict'

import { hasEnvBlock, hostEnvFacts, renderEnvBlock, withEnvBlock } from '../src/adapter/env-block.ts'
import { ensureFreeLaneShape, ensureResponsesFreeLaneShape } from '../src/adapter/messages.ts'
import { FREE_LANE_GATE_TOOL_NAMES, freeLaneGateTool } from '../src/adapter/gate-tools.ts'

/**
 * The `<env>` half of the free-lane gate: the lane answers 429 to any request
 * whose system prompt carries no non-empty `<env>` block, with the same status
 * it uses for a spent quota. These tests pin the two properties that rests on —
 * an empty block is NOT a block, and the block is only ever appended, never
 * substituted for the harness prompt.
 */

const FACTS = {
  workingDirectory: '/tmp/ws',
  workspaceRoot: '/tmp/root',
  isGitRepo: true,
  platform: 'darwin',
  preferTempDir: '/private/tmp',
}

test('renderEnvBlock reproduces the official block layout', () => {
  const block = renderEnvBlock(FACTS)
  assert.equal(
    block,
    [
      '<env>',
      '  Working directory: /tmp/ws',
      '  Workspace root folder: /tmp/root',
      '  Is directory a git repo: yes',
      '  Platform: darwin',
      '  Prefer /private/tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.',
      '</env>',
    ].join('\n'),
  )
  assert.equal(hasEnvBlock(block), true)
})

test('renderEnvBlock omits the optional lines it has no value for', () => {
  const block = renderEnvBlock({ workingDirectory: '/w', platform: 'linux' })
  assert.equal(block, ['<env>', '  Working directory: /w', '  Platform: linux', '</env>'].join('\n'))
  assert.equal(hasEnvBlock(block), true)
})

test('hostEnvFacts reports this process honestly', () => {
  const facts = hostEnvFacts()
  assert.equal(typeof facts.workingDirectory, 'string')
  assert.equal(facts.platform, process.platform)
  assert.deepEqual(facts.isGitRepo, true, 'the suite runs inside this git worktree')
})

/** Tags alone are not a block: an empty block is one of the refused 429 shapes. */
test('hasEnvBlock rejects the shapes the lane refuses', () => {
  assert.equal(hasEnvBlock(''), false)
  assert.equal(hasEnvBlock('no block here'), false)
  assert.equal(hasEnvBlock('<env></env>'), false, 'empty block = 429 (probed)')
  assert.equal(hasEnvBlock('<env>\n</env>'), false, 'blank line is not content')
  assert.equal(hasEnvBlock('<env>\n   \n\t\n</env>'), false)
  assert.equal(hasEnvBlock('<env>\n  Working directory: /tmp/x\n'), false, 'unterminated block')
  assert.equal(hasEnvBlock('<env>\n  Working directory: /tmp/x\n</env>'), true)
})

test('withEnvBlock appends once and is idempotent', () => {
  const once = withEnvBlock('be helpful', FACTS)
  assert.equal(once, `be helpful\n\n${renderEnvBlock(FACTS)}`)
  assert.equal(withEnvBlock(once, FACTS), once, 'no second block')
  assert.equal(withEnvBlock('', FACTS), renderEnvBlock(FACTS), 'an empty prompt becomes the block')
  // A block the harness itself carried (or a probe body) is left alone.
  const foreign = 'prompt\n<env>\n  Working directory: /elsewhere\n</env>'
  assert.equal(withEnvBlock(foreign, FACTS), foreign)
})

test('ensureFreeLaneShape appends the env block to a system prompt', () => {
  const payload = {
    model: 'm',
    messages: [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'ping' },
    ],
    tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
  }
  const next = ensureFreeLaneShape(payload) as Record<string, unknown>
  const messages = next.messages as Array<{ role: string; content: string }>
  assert.equal(messages.length, 2, 'no extra message: the block rides the system slot')
  assert.equal(messages[0]!.role, 'system')
  assert.match(messages[0]!.content, /^you are helpful\n\n<env>\n/)
  assert.equal(messages[1]!.content, 'ping', 'the user turn is untouched')
  // The input payload is not mutated (pi-ai keeps using it on the next retry).
  assert.equal((payload.messages[0] as { content: string }).content, 'you are helpful')
})

test('ensureFreeLaneShape inserts a system message when the body has none', () => {
  const next = ensureFreeLaneShape({
    model: 'm',
    messages: [{ role: 'user', content: 'ping' }],
    tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
  }) as Record<string, unknown>
  const messages = next.messages as Array<{ role: string; content: string }>
  assert.equal(messages.length, 2)
  assert.equal(messages[0]!.role, 'system')
  assert.match(messages[0]!.content, /^<env>\n/)
  assert.equal(messages[1]!.content, 'ping')
})

test('ensureFreeLaneShape leaves an already-shaped body alone', () => {
  const payload = {
    model: 'm',
    messages: [
      { role: 'system', content: withEnvBlock('prompt') },
      { role: 'user', content: 'ping' },
    ],
    tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
  }
  assert.equal(ensureFreeLaneShape(payload), undefined, 'nothing to rewrite -> original payload kept')
})

test('ensureFreeLaneShape shapes an empty env block instead of accepting it', () => {
  const next = ensureFreeLaneShape({
    model: 'm',
    messages: [{ role: 'system', content: 'prompt\n\n<env>\n</env>' }],
    tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
  }) as Record<string, unknown>
  const content = (next.messages as Array<{ content: string }>)[0]!.content
  assert.match(content, /Working directory: /, 'a real line was added')
})

test('ensureFreeLaneShape appends the block to array-shaped system content', () => {
  const next = ensureFreeLaneShape({
    model: 'm',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'prompt' }] }],
    tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
  }) as Record<string, unknown>
  const parts = (next.messages as Array<{ content: Array<{ type: string; text: string }> }>)[0]!.content
  assert.equal(parts.length, 2)
  assert.equal(parts[0]!.text, 'prompt')
  assert.match(parts[1]!.text, /^<env>\n/)
})

test('ensureResponsesFreeLaneShape shapes instructions and the input system slot', () => {
  const withInstructions = ensureResponsesFreeLaneShape({
    model: 'm',
    instructions: 'be brief',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
  }) as Record<string, unknown>
  assert.match(String(withInstructions.instructions), /^be brief\n\n<env>\n/)
  const flat = withInstructions.input as Array<{ role: string }>
  assert.equal(flat.length, 1, 'instructions carry the block; the input array is untouched')

  const withSystemInput = ensureResponsesFreeLaneShape({
    model: 'm',
    input: [
      { role: 'system', content: [{ type: 'input_text', text: 'be brief' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
    tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
  }) as Record<string, unknown>
  const parts = (withSystemInput.input as Array<{ content: Array<{ type: string; text: string }> }>)[0]!.content
  assert.equal(parts.length, 2)
  assert.equal(parts[1]!.type, 'input_text', 'Responses parts keep their own spelling')
  assert.match(parts[1]!.text, /^<env>\n/)
})
