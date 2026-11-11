// Isolated research payloads ONLY: no production UCZ container is emitted.
import assert from 'node:assert/strict'
import { openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { encodeTerrainGroup, decodeTerrainGroup, ID } from '@lib/codec'
const [name,which,experiment]=process.argv.slice(2)
assert.match(which,/^(wide[3-9]|tg(4|28))$/)
const entry=['scripts/diag/p12-results/slices.json','scripts/diag/p12-impl/slices.json','scripts/diag/p13/slices.json'].flatMap(p=>JSON.parse(readFileSync(p,'utf8')).samples).find((s:any)=>s.name===name)
assert.ok(entry&&entry.bytes>0&&entry.bytes<=512*1024)
const data=new Uint8Array(entry.bytes),fd=openSync(`.diag-data/corpus/${entry.file}`,'r')
try{assert.equal(readSync(fd,data,0,data.length,entry.offset),data.length)}finally{closeSync(fd)}
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
assert.equal(sha(data),entry.sha256)
const spec={id:which.startsWith('wide')?ID.WIDE_GRAD:ID.TRANSPOSE_GROUP_V3,s:Number(which.replace(/^(wide|tg)/,'')),r:which.startsWith('wide')?(entry.file==='mr'?1024:3800):1}
const start=performance.now(),payload=encodeTerrainGroup([data],spec,undefined,undefined,undefined,[0],'v20'),encodeMs=performance.now()-start
const decoded=decodeTerrainGroup(payload,[data.length],spec,undefined,[0],'v20')
assert.deepEqual(Buffer.from(decoded[0]),Buffer.from(data))
console.log(JSON.stringify({input:entry,spec,experiment,payloadBytes:payload.length,payloadSha256:sha(payload),payloadRoundtrip:true,
 scope:'isolated temporary-source experiment; no production container emitted, no full-file inference',productionCompatible:experiment==='none',
 encodeMs:Math.round(encodeMs),decodeMs:Math.round(performance.now()-start-encodeMs)}))
