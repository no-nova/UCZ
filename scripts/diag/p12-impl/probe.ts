import assert from 'node:assert/strict'
import { readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as codec from '@lib/codec'
import * as coder from '@lib/coder'
import { payloadModelFlags } from '@lib/payload-model'
const [name, which] = process.argv.slice(2)
const entry = [...JSON.parse(readFileSync('scripts/diag/p12-results/slices.json', 'utf8')).samples,...JSON.parse(readFileSync('scripts/diag/p12-impl/slices.json','utf8')).samples].find((s:any) => s.name === name)
assert.ok(entry); assert.ok(entry.bytes <= 512 * 1024)
const data = new Uint8Array(entry.bytes), fd = openSync(`.diag-data/corpus/${entry.file}`, 'r')
try { assert.equal(readSync(fd, data, 0, data.length, entry.offset), data.length) } finally { closeSync(fd) }
const sha = (b:Uint8Array) => createHash('sha256').update(b).digest('hex')
assert.equal(sha(data), entry.sha256)
const { ID, encodeTerrainGroup, groupV15CandidatesSync, planHeader, decompress } = codec
const modeName=which.replace(/-(v15|v20)(-gap|-default)?$/, ''),explicitKernel=which.includes('-v20')?'v20':which.endsWith('-v15')?'v15':null
if((coder as any).cmV20Tuning && !which.endsWith('-default'))(coder as any).cmV20Tuning.binRecovery=which.endsWith('-gap')
const id = modeName === 'text' ? ID.TEXT_V3 : modeName.startsWith('bcj') ? ID.BCJ_V3 : modeName.startsWith('tg') ? ID.TRANSPOSE_GROUP_V3 : modeName.startsWith('wide') ? ID.WIDE_GRAD : ID.BIN_V3
const spec = { id, s: modeName.startsWith('tg') ? Number(modeName.slice(2)) : modeName.startsWith('wide') ? Number(modeName.slice(4)) : modeName === 'bcj2' ? 2 : 1,
  r: modeName.startsWith('wide') ? (entry.file === 'mr' ? 1024 : 3800) : 1 }
const parts = [data], positions = [0]
const segs = [{ start: 0, end: data.length, cls: id === ID.TEXT_V3 ? 'text' : 'binary', spec }]
const frames: any[] = []
function add(payload:Uint8Array, v15:boolean, wordPre=false) {
  const h = Uint8Array.from(planHeader(data.length,segs,[{ spec,members:[0],payload,v15,wordPre }]))
  const c = new Uint8Array(h.length + payload.length); c.set(h); c.set(payload,h.length)
  frames.push({payload,c,v15,wordPre,headerBytes:h.length,flags:payloadModelFlags(payload)})
}
const begun = performance.now()
if(explicitKernel)add(encodeTerrainGroup(parts,spec,undefined,undefined,undefined,positions,explicitKernel),true)
else add(encodeTerrainGroup(parts,spec,undefined,undefined,undefined,positions),false)
const candidates = explicitKernel?null:groupV15CandidatesSync(parts,spec,positions)
if (candidates?.alt) add(candidates.alt,true)
if (candidates?.wordPre) add(candidates.wordPre,true,true)
if(candidates?.v20)add(candidates.v20,true)
if(candidates?.wordPreV20)add(candidates.wordPreV20,true,true)
frames.sort((a,b)=>a.c.length-b.c.length)
const best = frames[0]
// Verify every selectable stream, not only the winner. Separate processes keep
// each complete encode/decode comparison under the wall-clock budget.
for (const f of frames) assert.deepEqual(Buffer.from(decompress(f.c)),Buffer.from(data))
console.log(JSON.stringify({input:entry,spec,scope:explicitKernel?`forced single ${explicitKernel} group; complete UCZ; not adaptive routing or base/v15 selection`:'forced single production group; real base/v15/WORD-PRE strict complete-cost selection, not whole-file adaptive routing',
  bytes:best.c.length,headerBytes:best.headerBytes,version:best.c[3],v15:best.v15,wordPre:best.wordPre,flags:best.flags,
  containerSha256:sha(best.c),roundtrip:true,candidates:frames.map(f=>({bytes:f.c.length,v15:f.v15,wordPre:f.wordPre,flags:f.flags})),encodeDecodeMs:Math.round(performance.now()-begun)}))
