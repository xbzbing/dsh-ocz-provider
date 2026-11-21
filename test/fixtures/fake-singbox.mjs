#!/usr/bin/env node
/**
 * `sing-box` stand-in for the supervisor tests: `check` succeeds, and `run`
 * binds every inbound `listen_port` from the config then stays alive until it
 * is signalled. Real sing-box proxies traffic; this only holds the ports, which
 * is all the supervisor's readiness wait and the reload adoption look at.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'

const args = process.argv.slice(2)
if (args[0] === 'check') process.exit(0)
const index = args.indexOf('-c')
if (index < 0) process.exit(2)
const config = JSON.parse(readFileSync(args[index + 1], 'utf8'))

const servers = []
for (const inbound of config.inbounds ?? []) {
  const port = inbound?.listen_port
  if (typeof port !== 'number' || port <= 0) continue
  const server = createServer((socket) => socket.end())
  server.on('error', () => {})
  server.listen(port, '127.0.0.1')
  servers.push(server)
}

const stop = () => {
  for (const server of servers) server.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.stdin.resume()
