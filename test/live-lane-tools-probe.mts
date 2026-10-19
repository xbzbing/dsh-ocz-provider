/**
 * Live wire probe (2026-10-19): the two questions upstream PR #83 left open.
 *
 *   1. Is the v1 `/zen` lane really closed? Upstream main now tries `/zen`
 *      BEFORE `/inference` for the keyless lane, with the 1.19.3 AI-SDK
 *      User-Agent. We recorded `/zen/v1` chat as "403 for every shape" on
 *      2026-10-14, so either their first attempt always falls through, or our
 *      conclusion was over-general and we are leaving a lane on the table.
 *
 *   2. Does the gate validate tool definitions beyond `bash` and `read`?
 *      Upstream asserts every recognised name must carry the genuine
 *      definition (they ship 12 and rewrite any match); our 2026-10-14
 *      ablation measured "only the bash+read pair is validated, extra tools
 *      are ignored". Ours cannot both be true in general.
 *
 * Method: ONE real request through the real ZenAdapter (fetch spy, exactly the
 * capture technique the earlier probes used) gives the control body, then the
 * captured bytes are replayed with a single variable moved — the URL, the
 * User-Agent, or one tool entry. Every replay records the FINAL url as well as
 * the status, so a redirect cannot masquerade as a live lane. Egress is this
 * machine's IPv6 (the IPv4 address is refused by the lane), through the
 * plugin's own connect options.
 *
 * Run: node test/live-lane-tools-probe.mts
 *      PROBE_ONLY=zen-raw,inf-read-stub node test/live-lane-tools-probe.mts
 * Env: PROBE_MODEL (mimo-v2.6-flash-free), PROBE_GAP_MS (6000), PROBE_ONLY
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici'

import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import { localEgressConnectOptions } from '../src/pool/local-family.ts'

const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const GAP_MS = Number(process.env.PROBE_GAP_MS ?? 6000)
const ONLY = (process.env.PROBE_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const OUT = join(tmpdir(), 'oc2dsh-lane-tools-probe.json')

const INFERENCE = 'https://opencode.ai/inference/v1/chat/completions'
const ZEN = 'https://opencode.ai/zen/v1/chat/completions'
const ZEN_MODELS = 'https://opencode.ai/zen/v1/models'
/** The v1 lane's User-Agent: the AI SDK appends its provider-utils + runtime. */
const V1_UA = 'opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

const agent = new Agent({ connect: localEgressConnectOptions('auto') })
setGlobalDispatcher(agent)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Result {
  case: string
  status: number | string
  finalUrl?: string
  location?: string | null
  logId?: string | null
  cfRay?: string | null
  evidence?: string
  note: string
}

const results: Result[] = []
const wanted = (name: string): boolean => ONLY.length === 0 || ONLY.includes(name)

async function firstChunk(res: Awaited<ReturnType<typeof undiciFetch>>): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return '<no body>'
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 10_000)),
    ])
    if ('timeout' in first) return '<no chunk in 10s>'
    return new TextDecoder().decode(first.value ?? new Uint8Array()).slice(0, 160)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function record(label: string, res: Awaited<ReturnType<typeof undiciFetch>>, note: string, evidence: string): void {
  results.push({
    case: label,
    status: res.status,
    finalUrl: res.url,
    location: res.headers.get('location'),
    logId: res.headers.get('x-opencode-log-id'),
    cfRay: res.headers.get('cf-ray'),
    evidence,
    note,
  })
  console.log(`  ${label.padEnd(20)} ${String(res.status).padEnd(4)} ${evidence.slice(0, 74)}`)
  if (res.url && res.url !== ZEN && res.url !== INFERENCE && res.url !== ZEN_MODELS) {
    console.log(`  ${' '.repeat(20)} final url: ${res.url}`)
  }
}

async function post(label: string, url: string, headers: Headers, body: string, note: string, redirect?: RequestRedirect): Promise<void> {
  const res = await undiciFetch(url, { method: 'POST', headers, body, dispatcher: agent, ...(redirect ? { redirect } : {}) })
  const evidence = res.status === 200 ? await firstChunk(res) : (await res.text().catch(() => '<unreadable>')).replace(/\s+/g, ' ').slice(0, 220)
  record(label, res, note, evidence)
  await sleep(GAP_MS)
}

/** The same POST over a pinned IPv4 egress, to tell "lane" from "family". */
async function postOverIpv4(label: string, url: string, headers: Headers, body: string, note: string): Promise<void> {
  const ipv4 = new Agent({ connect: localEgressConnectOptions('ipv4') })
  try {
    const seen = /^ip=(.*)$/m.exec(await (await undiciFetch('https://www.cloudflare.com/cdn-cgi/trace', { dispatcher: ipv4 })).text())?.[1] ?? '?'
    const res = await undiciFetch(url, { method: 'POST', headers, body, dispatcher: ipv4 })
    const evidence = res.status === 200 ? await firstChunk(res) : (await res.text().catch(() => '<unreadable>')).replace(/\s+/g, ' ').slice(0, 220)
    record(label, res, `${note} · egress ${seen}`, evidence)
  } finally {
    await ipv4.close().catch(() => {})
  }
  await sleep(GAP_MS)
}

// --- egress identity, so the results are interpretable ----------------------
const traceText = await (await undiciFetch('https://www.cloudflare.com/cdn-cgi/trace', { dispatcher: agent })).text()
const egressIP = /^ip=(.*)$/m.exec(traceText)?.[1] ?? '?'
const egressLoc = /^loc=(.*)$/m.exec(traceText)?.[1] ?? '?'
console.log(`egress ${egressIP} (loc=${egressLoc}) · model ${MODEL}${ONLY.length > 0 ? ` · only ${ONLY.join(',')}` : ''}\n`)

// --- control: one real adapter request, captured ----------------------------
const realFetch = globalThis.fetch
let captured: { url: string; headers: Headers; body: string } | undefined
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers = new Headers(init?.headers ?? (typeof input === 'object' ? input.headers : undefined))
  const body = typeof init?.body === 'string' ? init.body : '<unexpected body shape>'
  const res = await realFetch(input, init)
  captured ??= { url, headers, body }
  record('control (adapter)', res, 'the real path, IPv6 egress', `${url} · ${body.length}B`)
  return res
}

try {
  const catalog = {
    list: () => [MODEL],
    decision: () => ({ allowed: true, source: 'probe', known: true }),
    reasoningCapability: () => undefined,
    limits: () => undefined,
    modalities: () => undefined,
  }
  const adapter = new ZenAdapter(catalog as never, {})
  const controller = new AbortController()
  const killer = setTimeout(() => controller.abort(new Error('probe timeout')), 30_000)
  try {
    for await (const chunk of adapter.stream({
      provider: 'oc2dsh',
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: 'You are a terse assistant.',
      maxTokens: 16,
      signal: controller.signal,
    } as never)) {
      if (chunk.type === 'text-delta') break
    }
  } catch (error) {
    console.log(`  control error: ${String((error as Error)?.message ?? error).slice(0, 200)}`)
  } finally {
    clearTimeout(killer)
    try { controller.abort(new Error('probe done')) } catch { /* already aborted */ }
  }
} finally {
  globalThis.fetch = realFetch
}

if (captured === undefined) {
  console.error('no request was captured — aborting')
  process.exit(1)
}

const baseHeaders = captured.headers
for (const name of ['content-length', 'host']) baseHeaders.delete(name)
await sleep(GAP_MS)

const stub = (name: string): Record<string, unknown> => ({
  type: 'function',
  function: { name, description: `Agent tool ${name}`, parameters: { type: 'object', properties: {} } },
})

/** The captured body with one tool entry replaced by a stub, added, or dropped. */
function bodyWith(action: 'replace' | 'append' | 'drop', name: string): string {
  const payload = JSON.parse(captured!.body) as { tools?: Array<{ function?: { name?: string } }> }
  const tools = payload.tools ?? []
  if (action === 'replace') payload.tools = tools.map((tool) => (tool.function?.name === name ? stub(name) : tool))
  else if (action === 'append') payload.tools = [...tools, stub(name)]
  else payload.tools = tools.filter((tool) => tool.function?.name !== name)
  return JSON.stringify(payload)
}

function bodyWithBothStubs(): string {
  const payload = JSON.parse(captured!.body) as { tools?: Array<{ function?: { name?: string } }> }
  payload.tools = (payload.tools ?? []).map((tool) => stub(tool.function?.name ?? 'unknown'))
  return JSON.stringify(payload)
}

function bodyWithoutTools(): string {
  const payload = JSON.parse(captured!.body) as Record<string, unknown>
  delete payload.tools
  return JSON.stringify(payload)
}

/** The captured body with the gate tools removed and `names` put in their place. */
function bodyWithToolsOnly(names: string[]): string {
  const payload = JSON.parse(captured!.body) as Record<string, unknown>
  payload.tools = names.map((name) => stub(name))
  return JSON.stringify(payload)
}

const baseTools = (JSON.parse(captured.body) as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
console.log(`\ncaptured body: ${captured.body.length}B, tools = ${baseTools.map((t) => t.function?.name).join(', ')}\n`)

interface Case {
  name: string
  run: () => Promise<void>
}

const cases: Case[] = [
  {
    name: 'zen-models',
    run: async () => {
      // The directory route on the same origin: green here + red on chat means
      // the 403 is the gate, not the origin being gone.
      const res = await undiciFetch(ZEN_MODELS, {
        headers: { authorization: 'Bearer public', accept: 'application/json' },
        dispatcher: agent,
      })
      const list = (await res.json().catch(() => ({ data: [] }))) as { data?: unknown[] }
      record('zen-models', res, 'GET /zen/v1/models (directory)', `${list.data?.length ?? 0} models`)
      await sleep(GAP_MS)
    },
  },
  { name: 'zen-our-ua', run: () => post('zen-our-ua', ZEN, baseHeaders, captured!.body, 'our recipe on /zen') },
  {
    name: 'zen-v1-ua',
    run: async () => {
      const headers = new Headers(baseHeaders)
      headers.set('user-agent', V1_UA)
      await post('zen-v1-ua', ZEN, headers, captured!.body, 'upstream v1 UA on /zen')
    },
  },
  {
    name: 'zen-v1-ua-accept',
    run: async () => {
      const headers = new Headers(baseHeaders)
      headers.set('user-agent', V1_UA)
      headers.set('accept', '*/*')
      await post('zen-v1-ua-accept', ZEN, headers, captured!.body, 'upstream v1 UA + Accept */*')
    },
  },
  {
    name: 'zen-raw',
    run: () => post('zen-raw', ZEN, baseHeaders, captured!.body, 'no redirect following: raw /zen answer', 'manual'),
  },
  { name: 'inf-bash-stub', run: () => post('inf-bash-stub', INFERENCE, baseHeaders, bodyWith('replace', 'bash'), 'positive control: bash definition gutted') },
  { name: 'inf-read-stub', run: () => post('inf-read-stub', INFERENCE, baseHeaders, bodyWith('replace', 'read'), 'read definition gutted') },
  { name: 'inf-both-stub', run: () => post('inf-both-stub', INFERENCE, baseHeaders, bodyWithBothStubs(), 'both gate definitions gutted') },
  { name: 'inf-no-tools', run: () => post('inf-no-tools', INFERENCE, baseHeaders, bodyWithoutTools(), 'no tools array at all') },
  { name: 'inf-bash-dropped', run: () => post('inf-bash-dropped', INFERENCE, baseHeaders, bodyWith('drop', 'bash'), 'read alone') },
  { name: 'inf-unrelated-only', run: () => post('inf-unrelated-only', INFERENCE, baseHeaders, bodyWithToolsOnly(['get_weather']), 'one unrelated tool, no gate names') },
  { name: 'inf-edit-only', run: () => post('inf-edit-only', INFERENCE, baseHeaders, bodyWithToolsOnly(['edit']), 'a recognised name that is neither bash nor read') },
  { name: 'inf-bash-only', run: () => post('inf-bash-only', INFERENCE, baseHeaders, bodyWithToolsOnly(['bash']), 'bash alone, stub definition') },
  { name: 'inf-shell-only', run: () => post('inf-shell-only', INFERENCE, baseHeaders, bodyWithToolsOnly(['shell']), 'the 2.x spelling alone, stub definition') },
  { name: 'zen-ipv4', run: () => postOverIpv4('zen-ipv4', ZEN, baseHeaders, captured!.body, 'the /zen lane over the refused IPv4 egress') },
  { name: 'inf-ipv4', run: () => postOverIpv4('inf-ipv4', INFERENCE, baseHeaders, captured!.body, 'the /inference lane over the refused IPv4 egress') },
  {
    name: 'inf-genuine-v1ua',
    run: async () => {
      const headers = new Headers(baseHeaders)
      headers.set('user-agent', V1_UA)
      await post('inf-genuine-v1ua', INFERENCE, headers, captured!.body, 'genuine tools under the v1 AI-SDK UA')
    },
  },
  {
    name: 'inf-both-stub-v1ua',
    run: async () => {
      const headers = new Headers(baseHeaders)
      headers.set('user-agent', V1_UA)
      await post('inf-both-stub-v1ua', INFERENCE, headers, bodyWithBothStubs(), 'gutted tools under the v1 AI-SDK UA')
    },
  },
  {
    name: 'inf-both-stub-1xua',
    run: async () => {
      const headers = new Headers(baseHeaders)
      headers.set('user-agent', `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`)
      await post('inf-both-stub-1xua', INFERENCE, headers, bodyWithBothStubs(), 'gutted tools under the 1.18.31 UA we used on 10-14')
    },
  },
  { name: 'inf-empty-tools', run: () => post('inf-empty-tools', INFERENCE, baseHeaders, bodyWithToolsOnly([]), 'empty tools array') },
  { name: 'inf-edit-stub', run: () => post('inf-edit-stub', INFERENCE, baseHeaders, bodyWith('append', 'edit'), 'extra recognised name, stub definition') },
  { name: 'inf-shell-stub', run: () => post('inf-shell-stub', INFERENCE, baseHeaders, bodyWith('append', 'shell'), 'extra 2.x recognised name, stub definition') },
]

for (const item of cases) {
  if (!wanted(item.name)) continue
  console.log(`  ${item.name}:`)
  await item.run()
  console.log('')
}

// --- report -----------------------------------------------------------------
const summary = { at: new Date().toISOString(), model: MODEL, egressIP, egressLoc, results }
writeFileSync(OUT, JSON.stringify(summary, null, 2))
appendFileSync(join(tmpdir(), 'oc2dsh-lane-tools-probes.jsonl'), `${JSON.stringify(summary)}\n`)
console.log(OUT)
await agent.close()
process.exit(0)
