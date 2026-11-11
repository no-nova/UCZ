import assert from 'node:assert/strict'
import { readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
export const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
export function loadSlice(name: string, bytes?: number) {
  const manifest=JSON.parse(readFileSync('scripts/diag/p14/slices.json','utf8'))
  const source=manifest.samples.find((row:any)=>row.name===name)
  assert.ok(source,`unknown fixed slice: ${name}`)
  const length=bytes??source.bytes
  assert.ok(Number.isSafeInteger(length)&&length>0&&length<=source.bytes&&length<=262144)
  const path=`.diag-data/corpus/${source.file}`
  assert.equal(statSync(path).size,source.corpusBytes)
  // Even a short prefix is authenticated against the precommitted parent
  // window. Read at most 256 KiB, never hash or load the whole corpus file.
  assert.ok(source.bytes<=262144)
  const parent=new Uint8Array(source.bytes),fd=openSync(path,'r')
  try { assert.equal(readSync(fd,parent,0,source.bytes,source.offset),source.bytes) } finally {closeSync(fd)}
  assert.equal(sha(parent),source.sha256)
  const data=parent.subarray(0,length)
  return {data,input:{name,file:source.file,offset:source.offset,bytes:length,sha256:sha(data),parentWindowBytes:source.bytes,parentWindowSha256:source.sha256,selection:length===source.bytes?'P14 fixed window':'bounded prefix of P14 fixed window'}}
}
