// Optional local benchmark service. The UI submits data only after explicit consent.
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

const exec = promisify(execFile)
const limit = 256 * 1024 * 1024
const jobs = [
  {label:'Zstandard -3', run: async d => { const t = performance.now(); const p = await promisify(zlib.zstdCompress)(d, {params:{[zlib.constants.ZSTD_c_compressionLevel]:3}}); const encodeMs = performance.now() - t; return [p, await promisify(zlib.zstdDecompress)(p), encodeMs] }},
  {label:'Zstandard -19', run: async d => { const t = performance.now(); const p = await promisify(zlib.zstdCompress)(d, {params:{[zlib.constants.ZSTD_c_compressionLevel]:19}}); const encodeMs = performance.now() - t; return [p, await promisify(zlib.zstdDecompress)(p), encodeMs] }},
  {label:'Brotli quality 5', run: async d => { const t = performance.now(); const p = await promisify(zlib.brotliCompress)(d, {params:{[zlib.constants.BROTLI_PARAM_QUALITY]:5}}); const encodeMs = performance.now() - t; return [p, await promisify(zlib.brotliDecompress)(p), encodeMs] }},
  {label:'xz / LZMA2 -6', run: async d => pipeTool('xz', ['-6', '-c'], ['-d', '-c'], d)},
  {label:'bzip2 -9', run: async d => pipeTool('bzip2', ['-9', '-c'], ['-d', '-c'], d)},
  {label:'ZPAQ -m1', run: zpaq},
]
async function pipeTool(cmd, encArgs, decArgs, data) {
  // execFile does not accept stdin; a private temp file avoids shell interpolation.
  const dir = await mkdtemp(join(tmpdir(), 'ucz-bench-'))
  try {
    const input = join(dir, 'input'), packed = join(dir, 'packed')
    await writeFile(input, data)
    const opts = {encoding:'buffer', maxBuffer: limit + 4 * 1024 * 1024, timeout: 600_000}
    const t = performance.now()
    const {stdout: p} = await exec(cmd, [...encArgs, input], opts)
    const encodeMs = performance.now() - t
    await writeFile(packed, p)
    const {stdout: back} = await exec(cmd, [...decArgs, packed], opts)
    return [p, back, encodeMs]
  } finally { await rm(dir, {recursive:true, force:true}) }
}
async function zpaq(data) {
  const dir = await mkdtemp(join(tmpdir(), 'ucz-zpaq-'))
  try {
    const opts = {cwd:dir, maxBuffer:1_000_000, timeout:600_000}
    await writeFile(join(dir,'input.bin'), data)
    const cmd = process.env.ZPAQ_BIN || 'zpaq'
    const t = performance.now()
    await exec(cmd, ['add','result.zpaq','input.bin','-m1','-threads','1'], opts)
    const encodeMs = performance.now() - t
    const p = await readFile(join(dir,'result.zpaq'))
    await mkdir(join(dir,'restore'))
    await exec(cmd, ['extract','result.zpaq','-to','restore'], opts)
    return [p, await readFile(join(dir,'restore','input.bin')), encodeMs]
  } finally { await rm(dir, {recursive:true, force:true}) }
}
export async function runBenchmarks(data, onResult = () => {}) {
  const results = []
  for (const job of jobs) {
    const t = performance.now()
    try {
      const [packed, back, encodeMs] = await job.run(data)
      const result = {label:job.label, size:packed.length, encodeMs, ms:performance.now()-t, verified:Buffer.from(back.buffer, back.byteOffset, back.byteLength).equals(data)}
      results.push(result); onResult(result)
    } catch (e) {
      const result = {label:job.label, error: e.code === 'ENOENT' ? '未安装该程序或当前 Node.js 不支持该算法' : String(e.message).slice(0, 250)}
      results.push(result); onResult(result)
    }
  }
  return results
}
