// Structural patch preflight only. Zero CM encodes; no working-tree writes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
import { CASES,applyPatches } from './patches.mjs'
let cases=0
for(const [unit,variants] of Object.entries(CASES))for(const variant of variants) {
 const src=Object.fromEntries(['coder.ts','codec.ts'].map(f=>[f,readFileSync(`src/lib/${f}`,'utf8')]))
 const patch=(f,a,b)=>{assert.equal(src[f].split(a).length,2,`${unit}/${variant}: nonunique ${f} ${a}`);src[f]=src[f].replace(a,b)}
 applyPatches(unit,variant,patch,f=>src[f])
 await transform(src['coder.ts'],{loader:'ts',logLevel:'silent'})
 await transform(src['codec.ts'],{loader:'ts',logLevel:'silent'})
 cases++
}
console.log(JSON.stringify({patchCases:cases,syntax:true,cmCalls:0,productionWrites:0}))
