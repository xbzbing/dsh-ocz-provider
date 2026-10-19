/**
 * Live availability probe for the CONFIGURED EXITS (2026-10-19): does the
 * OpenCode free lane serve the anonymous recipe from each exit's IP?
 *
 * The pool answers "is this exit healthy for the lane" with its own smoke
 * (pool/admission.ts), but when an operator asks why a subscription node
 * "does not work" the useful answer is per exit and on the real path:
 *
 *   1. egress identity — the exit's public IP / country (a Cloudflare trace
 *      through the same dispatcher the lane request will use);
 *   2. the REAL adapter request — ZenAdapter over a ProxyAgent pinned to that
 *      exit, with the lane ladder live, so the recorded wire shows which origin
 *      answered and with what status (a 403 FreeTierError here is the gate
 *      refusing that IP; `Connection error.` is the exit never getting there).
 *
 * Exits come from the sing-box config this plugin generated (one socks5
 * inbound per subscription node) plus any `--proxy=` arguments.
 *
 * Run: node test/live-exit-availability-probe.mts [--proxy=http://127.0.0.1:1087 …]
 * Env: PROBE_MODEL (mimo-v2.6-flash-free), PROBE_TIMEOUT_MS (25000),
 *      PROBE_SKIP_SUBSCRIPTION=1 to probe only the `--proxy=` exits
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici'

import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import { stateDir } from '../src/paths.ts'

const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 25_000)
const OUT = join(tmpdir(), 'oc2dsh-exit-availability.json')

interface Candidate {
  label: string
  uri: string
  node?: string
  server?: string
}

/** The subscription exits: one socks5 inbound per node in our sing-box config. */
function subscriptionExits(): Candidate[] {
  const path = join(stateDir(), 'singbox', 'singbox-config.json')
  let config: { inbounds?: Array<{ tag?: string; listen_port?: number }>; outbounds?: Array<{ tag?: string; server?: string; server_port?: number }> }
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as typeof config
  } catch {
    return []
  }
  const outbound = new Map((config.outbounds ?? []).map((entry) => [entry.tag ?? '', entry]))
  const exits: Candidate[] = []
  for (const inbound of config.inbounds ?? []) {
    const port = inbound.listen_port
    if (typeof port !== 'number' || port <= 0) continue
    const tag = inbound.tag ?? ''
    const node = outbound.get(tag.replace(/^in-/, 'out-'))
    exits.push({
      label: `sing-box ${port}${node?.server !== undefined ? ` (${node.server})` : ''}`,
      uri: `socks5://127.0.0.1:${port}`,
      ...(tag !== '' ? { node: tag } : {}),
      ...(node?.server !== undefined ? { server: node.server } : {}),
    })
  }
  return exits.sort((a, b) => a.uri.localeCompare(b.uri))
}

interface Result {
  label: string
  uri: string
  egress?: string
  location?: string
  colo?: string
  wire: Array<{ url: string; status?: number }>
  text?: string
  finish?: string
  error?: string
}

const results: Result[] = []
const realFetch = globalThis.fetch

async function probe(candidate: Candidate): Promise<void> {
  const result: Result = { label: candidate.label, uri: candidate.uri, wire: [] }
  results.push(result)
  const agent = new ProxyAgent({ uri: candidate.uri })
  const previousFetch = globalThis.fetch
  setGlobalDispatcher(agent)
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const entry: { url: string; status?: number } = { url }
    result.wire.push(entry)
    const response = await previousFetch(input, init)
    entry.status = response.status
    return response
  }
  try {
    // 1. egress identity through the very dispatcher the lane request uses.
    try {
      const trace = await previousFetch('https://www.cloudflare.com/cdn-cgi/trace')
      const text = await trace.text()
      result.egress = /^ip=(.*)$/m.exec(text)?.[1]
      result.location = /^loc=(.*)$/m.exec(text)?.[1]
      result.colo = /^colo=(.*)$/m.exec(text)?.[1]
    } catch (error) {
      result.error = `trace: ${String((error as Error)?.message ?? error).slice(0, 80)}`
    }
    // 2. the real adapter request (its own ladder included).
    const adapter = new ZenAdapter(
      {
        list: () => [MODEL],
        decision: () => ({ allowed: true, source: 'probe', known: true }),
        reasoningCapability: () => undefined,
        limits: () => undefined,
        modalities: () => undefined,
      } as never,
      {},
    )
    const controller = new AbortController()
    const killer = setTimeout(() => controller.abort(new Error('probe timeout')), TIMEOUT_MS)
    try {
      for await (const chunk of adapter.stream({
        provider: 'oc2dsh',
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
        system: 'You are a terse assistant.',
        maxTokens: 8,
        signal: controller.signal,
      } as never)) {
        if (chunk.type === 'text-delta' && (result.text ?? '') === '') result.text = chunk.text.slice(0, 24)
        if (chunk.type === 'finish') {
          result.finish = chunk.reason.kind === 'error'
            ? `error ${chunk.reason.failure.code}: ${chunk.reason.failure.message.slice(0, 150)}`
            : chunk.reason.kind
        }
      }
    } finally {
      clearTimeout(killer)
      try { controller.abort(new Error('probe done')) } catch { /* already aborted */ }
    }
  } catch (error) {
    const message = String((error as Error)?.message ?? error).replace(/\s+/g, ' ').slice(0, 150)
    result.error = result.error === undefined ? message : `${result.error} | ${message}`
  } finally {
    globalThis.fetch = previousFetch
    await agent.close().catch(() => {})
  }
  const wire = result.wire.map((entry) => `${entry.url.replace(/^https:\/\/opencode\.ai/, '')}=${entry.status ?? 'ERR'}`).join(' ')
  console.log(
    `${candidate.uri.padEnd(28)} ${String(result.egress ?? '—').padEnd(16)} ${String(result.location ?? '—').padEnd(3)} ` +
    `${wire.padEnd(46)} ${result.text !== undefined ? `text=${JSON.stringify(result.text)}` : (result.finish ?? result.error ?? '')}`,
  )
}

const cli = process.argv.slice(2).filter((arg) => arg.startsWith('--proxy=')).map((arg) => arg.slice('--proxy='.length))
const candidates: Candidate[] = [
  ...(process.env.PROBE_SKIP_SUBSCRIPTION === '1' ? [] : subscriptionExits()),
  ...cli.map((uri) => ({ label: `manual ${uri}`, uri })),
]

console.log(`${candidates.length} exits · model ${MODEL} · ladder = /inference then /zen\n`)
globalThis.fetch = realFetch
for (const candidate of candidates) await probe(candidate)

writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), model: MODEL, results }, null, 2))
appendFileSync(join(tmpdir(), 'oc2dsh-exit-availability.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), model: MODEL, results })}\n`)
console.log(`\n${OUT}`)
