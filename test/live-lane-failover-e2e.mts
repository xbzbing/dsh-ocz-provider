/**
 * Live acceptance for the lane origin ladder (2026-10-19).
 *
 * Drives the REAL adapter through a REAL broken primary door: the ladder is
 * `[https://opencode.ai/inference-does-not-exist, https://opencode.ai/zen]`,
 * so the first rung answers 404 (an origin-shaped failure) and the answer can
 * only come from the console rung. A control run on the ordinary ladder proves
 * nothing changed for the happy path, and the catalog listing is asked of the
 * same broken pair.
 *
 * Run: node test/live-lane-failover-e2e.mts
 * Env: PROBE_MODEL (mimo-v2.6-flash-free)
 */
import { Agent, setGlobalDispatcher } from 'undici'

import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import { fetchZenModels } from '../src/adapter/catalog.ts'
import { opencodeUserAgent } from '../src/adapter/ids.ts'
import { localEgressConnectOptions } from '../src/pool/local-family.ts'

const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const DEAD = 'https://opencode.ai/inference-does-not-exist'
const CONSOLE = 'https://opencode.ai/zen'

const agent = new Agent({ connect: localEgressConnectOptions('auto') })
setGlobalDispatcher(agent)

const traceText = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text()
console.log(`egress ${/^ip=(.*)$/m.exec(traceText)?.[1] ?? '?'} · model ${MODEL}\n`)

const realFetch = globalThis.fetch
const wire: Array<{ url: string; status?: number }> = []
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const entry = { url } as { url: string; status?: number }
  wire.push(entry)
  const response = await realFetch(input, init)
  entry.status = response.status
  return response
}

async function runLadder(label: string, primary: string, fallback?: string): Promise<void> {
  wire.length = 0
  const adapter = new ZenAdapter(
    {
      list: () => [MODEL],
      decision: () => ({ allowed: true, source: 'probe', known: true }),
      reasoningCapability: () => undefined,
      limits: () => undefined,
      modalities: () => undefined,
    } as never,
    { zenBaseUrl: primary, fallbackBaseUrl: fallback },
  )
  const controller = new AbortController()
  const killer = setTimeout(() => controller.abort(new Error('probe timeout')), 45_000)
  let text = ''
  let finish = ''
  try {
    for await (const chunk of adapter.stream({
      provider: 'oc2dsh',
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }],
      system: 'You are a terse assistant.',
      maxTokens: 16,
      signal: controller.signal,
    } as never)) {
      if (chunk.type === 'text-delta' && text === '') text = chunk.text.slice(0, 40)
      if (chunk.type === 'finish') finish = `${chunk.reason.kind}${chunk.reason.kind === 'error' ? `: ${chunk.reason.failure.code} ${chunk.reason.failure.message.slice(0, 120)}` : ''}`
    }
  } catch (error) {
    finish = `threw: ${String((error as Error)?.message ?? error).slice(0, 160)}`
  } finally {
    clearTimeout(killer)
    try { controller.abort(new Error('probe done')) } catch { /* already aborted */ }
  }
  console.log(`${label}`)
  for (const entry of wire) console.log(`  ${String(entry.status ?? 'ERR').padEnd(4)} ${entry.url}`)
  console.log(`  first text: ${text === '' ? '<none>' : JSON.stringify(text)}`)
  console.log(`  finish: ${finish}\n`)
}

await runLadder('control — the ordinary ladder (primary = /inference)', 'https://opencode.ai/inference')
await runLadder('failover — primary 404s, the console rung must answer', DEAD, CONSOLE)

// The catalog walks the same ladder (a GET, same broken pair).
const catalogWire: string[] = []
const ids = await fetchZenModels(DEAD, (async (url: string | URL | Request) => {
  catalogWire.push(String(url))
  return realFetch(url as never)
}) as typeof fetch, opencodeUserAgent(), CONSOLE)
console.log(`catalog — broken primary then the console rung: ${ids.length} models`)
for (const url of catalogWire) console.log(`  ${url}`)

globalThis.fetch = realFetch
await agent.close()
