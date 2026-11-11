// Run ONLY at the P12.1 checkpoint: freezes transform-v20 / legacy-CM bytes.
// These must remain decodable after the independent P12.2 CM activation flag.
import { build } from 'esbuild'
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
const target='tests/p121-fixtures.json'
if(existsSync(target))throw Error('Refusing to overwrite independent checkpoint fixtures')
mkdirSync('.diag-state/p12-impl',{recursive:true})
const contents=`
import {encodeTerrainGroup,planHeader,decompress,ID} from './src/lib/codec'
import {payloadModelFlags} from './src/lib/payload-model'
import {writeFileSync,readFileSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
const sha=x=>createHash('sha256').update(x).digest('hex')
const input=Uint8Array.from({length:2050},(_,i)=>(i*37+(i>>5))&255)
input.set([0xe8,255,255,255,255,0xe9,0,0,0,0],48)
const specs=[...Array.from({length:6},(_,i)=>({id:ID.WIDE_GRAD,s:i+3,r:256})),{id:ID.BCJ_V3,s:2,r:1}]
const cases=[]
for(const spec of specs)for(const kernel of [false,'v15']){
 const p=encodeTerrainGroup([input.subarray(0,514),input.subarray(514)],spec,undefined,undefined,undefined,[0,514],kernel)
 const segments=[{start:0,end:514,cls:'binary',spec},{start:514,end:input.length,cls:'binary',spec}]
 const h=planHeader(input.length,segments,[{spec,members:[0,1],payload:p,v15:kernel==='v15'}])
 const c=Uint8Array.from([...h,...p])
 if(sha(decompress(c))!==sha(input))throw Error('fixture roundtrip')
 cases.push({spec,kernel,flags:payloadModelFlags(p),bytes:c.length,sha256:sha(c),base64:Buffer.from(c).toString('base64')})
}
const sources=Object.fromEntries(readdirSync('src/lib').sort().filter(f=>f.endsWith('.ts')).map(f=>[f,sha(readFileSync('src/lib/'+f))]))
writeFileSync('${target}',JSON.stringify({kind:'P12.1-transform-v20-legacy-CM-frozen',parentCommit:${JSON.stringify(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())},input:{bytes:input.length,sha256:sha(input),base64:Buffer.from(input).toString('base64')},sources,cases},null,2)+'\\n',{flag:'wx'})
console.log('Frozen '+cases.length+' independently retained P12.1 v20/legacy-CM fixtures')
`
await build({stdin:{contents,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:'.diag-state/p12-impl/freeze-v20.cjs',logLevel:'silent'})
const r=spawnSync(process.execPath,['.diag-state/p12-impl/freeze-v20.cjs'],{stdio:'inherit',timeout:17000,killSignal:'SIGKILL'})
if(r.error)throw r.error
process.exitCode=r.status??1
