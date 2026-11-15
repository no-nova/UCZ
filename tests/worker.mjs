// Exercise the actual worker handler via Node worker_threads (not a browser rendering test).
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import assert from 'node:assert/strict'
const dir = await mkdtemp(join(tmpdir(), 'ucz-worker-test-'))
try {
  const script = join(dir, 'worker.cjs'), bootstrap = join(dir, 'bootstrap.cjs')
  await build({entryPoints:['src/lib/compress.worker.ts'],bundle:true,platform:'node',format:'cjs',outfile:script,logLevel:'silent'})
  await writeFile(bootstrap, `const { parentPort } = require('node:worker_threads'); global.self = { postMessage: (v,t) => parentPort.postMessage(v,t) }; require(${JSON.stringify(script)}); parentPort.on('message', data => global.self.onmessage({data}));`)
  async function runWorker(data, options = {}) {
    const original = data.slice(), worker = new Worker(bootstrap), messages = []
    let heartbeats = 0
    const timer = setInterval(() => heartbeats++, 5)
    try {
      const result = await new Promise((resolve, reject) => {
        worker.on('error', reject)
        worker.on('message', v => {
          if (v.type === 'progress') messages.push(v.msg)
          else if (v.type === 'done') resolve(v)
          else if (v.type === 'error') reject(new Error(v.message))
        })
        worker.postMessage({type:'run',data,...options}, [data.buffer])
      })
      assert.ok(result.verified)
      { const a=result.data,b=original; assert.equal(a.length,b.length)
        for(let i=0;i<a.length;i++) if(a[i]!==b[i]) assert.fail(`worker 第 ${i} 字节不同 ${a[i]} != ${b[i]}`) }
      assert.ok(messages.length > 0); assert.ok(heartbeats > 0)
      return {result, messages}
    } finally { clearInterval(timer); await worker.terminate() }
  }
  const text = () => new TextEncoder().encode('Worker test text and data 123.\n'.repeat(100))
  const normal = await runWorker(text())
  assert.notEqual(normal.result.single, null)
  const skipped = await runWorker(text(), {skipSingleCM:true})
  assert.equal(skipped.result.single, null)
  assert.ok(!skipped.messages.some(m => m.startsWith('单一 CM 对照…')))
  const large = await runWorker(new Uint8Array(10 * 1024 * 1024 + 1).fill(42))
  assert.equal(large.result.single, null)
  assert.ok(!large.messages.some(m => m.startsWith('单一 CM 对照…')))
  console.log('worker test passed')
} finally { await rm(dir, {recursive:true, force:true}) }
