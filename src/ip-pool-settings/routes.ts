/**
 * The bridge's HTTP face: exact POST routes under {@link IP_POOL_BRIDGE_PREFIX}
 * for the host webServer, each admitted by guard.ts, framed as JSON, and
 * answering a JSON 500 `{ok:false, code:'internal'}` when a handler throws
 * (the host would otherwise answer an empty 400).
 */

import type { BridgeHandlers, BridgeResult } from './handlers.ts'
import { bridgeRejection, type ConnectionReader, type isTrustedBridgeRequest } from './guard.ts'

/** Bridge route prefix (same-origin, loopback-only). */
export const IP_POOL_BRIDGE_PREFIX = '/api/oc2dsh/ip-pool'

/** Cap on JSON request bodies (a probe trigger is tiny). */
const MAX_JSON_BODY_BYTES = 16 * 1024

type Req = { method?: string } & Parameters<typeof isTrustedBridgeRequest>[0]
type Res = {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
  headersSent?: boolean
}

/** One JSON response. */
function writeJson(res: Res, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** Bridge route registration input (exact paths for webServer.register). */
export interface BridgeRoute {
  kind: 'exact'
  path: string
  handler: (req: never, res: never) => void | Promise<void>
}

/** Build the guarded routes. The route bodies are host-shaped (node:http req/res). */
export function makeBridgeRoutes(
  handlers: BridgeHandlers,
  deps: {
    /** The host `connection` service, read per request (absent = every request 403s). */
    connection?: ConnectionReader
    /** Test seam: replaces the whole admission decision. */
    guard?: (req: unknown) => boolean
  } = {},
): BridgeRoute[] {
  const rejection = (req: Req): number | undefined =>
    deps.guard !== undefined ? (deps.guard(req) ? undefined : 403) : bridgeRejection(req, deps.connection)
  const admit = (req: Req, res: Res): boolean => {
    const status = rejection(req)
    if (status !== undefined) {
      writeJson(res, status, { error: status === 401 ? 'unauthorized' : 'forbidden' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed: ' + (req.method ?? '') })
      return false
    }
    return true
  }
  /** Admit, run, and turn a throw into the JSON 500 envelope. */
  const route = (path: string, run: (req: Req, res: Res) => Promise<void>): BridgeRoute => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const rawReq = req as unknown as Req
      const rawRes = res as unknown as Res
      try {
        if (!admit(rawReq, rawRes)) return
        await run(rawReq, rawRes)
      } catch (err) {
        if (rawRes.headersSent === true) return
        writeJson(rawRes, 500, { ok: false, code: 'internal', message: err instanceof Error ? err.message : String(err) })
      }
    },
  })
  /** A route with no request body (/status, /models). */
  const postRoute = (path: string, handle: () => Promise<BridgeResult>): BridgeRoute =>
    route(path, async (_req, res) => {
      writeJson(res, 200, await handle())
    })
  /** A route that reads a JSON object body. */
  const jsonRoute = (path: string, handle: (body: Record<string, unknown>) => Promise<BridgeResult>): BridgeRoute =>
    route(path, async (req, res) => {
      let body: unknown
      try {
        body = await readJsonBody(req as unknown as AsyncIterable<Buffer>)
      } catch {
        body = undefined
      }
      if (body === undefined || typeof body !== 'object' || body === null) {
        writeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
        return
      }
      writeJson(res, 200, await handle(body as Record<string, unknown>))
    })
  return [
    postRoute(`${IP_POOL_BRIDGE_PREFIX}/status`, () => handlers.status()),
    postRoute(`${IP_POOL_BRIDGE_PREFIX}/models`, () => handlers.models()),
    jsonRoute(`${IP_POOL_BRIDGE_PREFIX}/probe`, (body) => handlers.probe(body as { scope?: unknown; exitId?: unknown })),
    jsonRoute(`${IP_POOL_BRIDGE_PREFIX}/exit`, (body) => handlers.exit(body as { action?: unknown; exitId?: unknown })),
    jsonRoute(`${IP_POOL_BRIDGE_PREFIX}/usage`, (body) => handlers.usage(body as { action?: unknown })),
  ]
}
