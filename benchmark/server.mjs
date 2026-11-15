// Optional local benchmark service; invoked only with explicit user consent.
import http from 'node:http'
import { runBenchmarks } from './algorithms.mjs'
const limit = 256 * 1024 * 1024
const port = Number(process.env.BENCH_PORT || 4174)
let busy = false
http.createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'}); res.end(JSON.stringify(value)) }
  if (req.method !== 'POST' || req.url !== '/api/bench' || req.headers['x-ucz-benchmark'] !== 'yes') return send(404, {error:'Not found'})
  if (busy) return send(429, {error:'已有对照测试运行中，请稍后重试'})
  if (Number(req.headers['content-length']) > limit) { req.resume(); return send(413, {error:'数据超过 256 MiB 限制'}) }
  busy = true
  try {
    const data = await new Promise((resolve, reject) => {
      let size = 0, exceeded = false
      const chunks = []
      req.on('data', chunk => {
        size += chunk.length
        if (size > limit && !exceeded) { exceeded = true; chunks.length = 0; reject(Object.assign(new Error('数据超过 256 MiB 限制'), {status: 413})) }
        if (!exceeded) chunks.push(chunk)
      })
      req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks, size)) })
      req.on('error', reject)
      req.on('aborted', () => reject(new Error('请求中断')))
    })
    // The Web GUI sends its compression tier for transparency; the external
    // codecs are fixed-profile, so it is echoed rather than applied.
    const level = String(req.headers['x-ucz-level'] || 'max')
    send(200, {level, results: await runBenchmarks(data)})
  } catch (e) { if (!res.headersSent) send(e.status || 500, {error:String(e.message)}) }
  finally { busy = false }
}).listen(port, '127.0.0.1', () => console.log(`Benchmark service listening on 127.0.0.1:${port}`))
