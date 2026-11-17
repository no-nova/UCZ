// Optional local benchmark service; invoked only with explicit user consent.
//
// Threat model: this process is started by a user on their own machine, so the risks
// are (a) any *web page* the user visits being able to drive it, and (b) a DNS-rebinding
// page pretending to be same-origin. Both are handled here: the service binds to
// loopback only, requires the `x-ucz-benchmark: yes` header (which a cross-origin page
// cannot send without a preflight this server never approves), pins `Host` to the
// loopback names, and rejects a cross-origin `Origin`.
import http from 'node:http'
import { runBenchmarks } from './algorithms.mjs'

const LIMIT = 256 * 1024 * 1024
const LEVELS = new Set(['fast', 'balanced', 'max'])
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Host header without the port, or '' when it is missing/garbled. */
function hostName(header) {
  const raw = String(header || '').trim()
  if (!raw) return ''
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1).toLowerCase()
  return raw.split(':')[0].toLowerCase()
}

function corsAllowed(origin, host) {
  if (!origin) return true
  try {
    const u = new URL(origin)
    return u.hostname.toLowerCase() === host && (u.protocol === 'http:' || u.protocol === 'https:')
  } catch { return false }
}

/** Parse Content-Length strictly; anything non-numeric is a client error, not "0". */
function declaredLength(header) {
  if (header === undefined) return { ok: true, value: null }
  const text = String(header).trim()
  if (!/^\d{1,12}$/.test(text)) return { ok: false }
  return { ok: true, value: Number(text) }
}

export function createHandler({ busyRef = { busy: false } } = {}) {
  return async function handle(req, res) {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const host = hostName(req.headers.host)
    if (!LOOPBACK_NAMES.has(host)) { req.resume(); return send(421, { error: 'unexpected Host header' }) }
    if (!corsAllowed(req.headers.origin, host)) { req.resume(); return send(403, { error: 'cross-origin request refused' }) }
    if (req.method !== 'POST' || req.url !== '/api/bench' || req.headers['x-ucz-benchmark'] !== 'yes') return send(404, { error: 'Not found' })
    const declared = declaredLength(req.headers['content-length'])
    if (!declared.ok) { req.resume(); return send(400, { error: 'invalid Content-Length' }) }
    if (declared.value !== null && declared.value > LIMIT) { req.resume(); return send(413, { error: 'payload exceeds 256 MiB' }) }
    if (busyRef.busy) { req.resume(); return send(429, { error: 'a comparison run is already in progress' }) }
    busyRef.busy = true
    try {
      const data = await new Promise((resolve, reject) => {
        let size = 0, exceeded = false
        const chunks = []
        req.on('data', chunk => {
          size += chunk.length
          if (size > LIMIT && !exceeded) { exceeded = true; chunks.length = 0; reject(Object.assign(new Error('payload exceeds 256 MiB'), { status: 413 })) }
          if (!exceeded) chunks.push(chunk)
        })
        req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks, size)) })
        req.on('error', reject)
        req.on('aborted', () => reject(new Error('request aborted')))
      })
      if (declared.value !== null && declared.value !== data.length) { send(400, { error: 'Content-Length does not match the body' }); return }
      // The Web GUI sends its compression tier for transparency; the external codecs are
      // fixed-profile, so it is echoed rather than applied. Whitelisted, never echoed raw.
      const requested = String(req.headers['x-ucz-level'] || 'max').toLowerCase()
      const level = LEVELS.has(requested) ? requested : 'max'
      send(200, { level, results: await runBenchmarks(data) })
    } catch (e) { if (!res.headersSent) send(e.status || 500, { error: String(e.message) }) }
    finally { busyRef.busy = false }
  }
}

export function startServer({ port = Number(process.env.BENCH_PORT || 4174), host = '127.0.0.1' } = {}) {
  const busyRef = { busy: false }
  const server = http.createServer(createHandler({ busyRef }))
  return new Promise(resolve => server.listen(port, host, () => resolve(server)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.BENCH_PORT || 4174)
  await startServer({ port })
  console.log(`Benchmark service listening on 127.0.0.1:${port}`)
}
