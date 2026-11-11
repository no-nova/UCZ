import assert from 'node:assert/strict'
import {loadSlice,sha} from '../scripts/diag/p141/input'
import {ID,encodeTerrainGroup,decodeTerrainGroup,planHeader,decompress,type Spec} from '../src/lib/codec'
import {V20_FLAG_CM} from '../src/lib/coder'
import {payloadModelFlags} from '../src/lib/payload-model'
const [kind='sub',name='mozilla-resources',b='32768']=process.argv.slice(2),{data,input}=loadSlice(name,Number(b))
const specs:Record<string,Spec>={sub:{id:ID.SUB_TRANSPOSE,s:8,r:2},sub3:{id:ID.SUB_TRANSPOSE_V3,s:8,r:2},transpose:{id:ID.TRANSPOSE,s:4,r:1},tg:{id:ID.TRANSPOSE_GROUP,s:4,r:1},transpose2d:{id:ID.TRANSPOSE_2D,s:4,r:1},delta:{id:ID.DELTA,s:4,r:1},delta3:{id:ID.DELTA_V3,s:4,r:1},grad3:{id:ID.GRAD_V3,s:4,r:32}}
const spec=specs[kind];assert.ok(spec);const half=Math.floor(data.length/8)*4,parts=[data.subarray(0,half),data.subarray(half)],pos=[0,half]
const old=encodeTerrainGroup(parts,spec,undefined,undefined,undefined,pos,false),next=encodeTerrainGroup(parts,spec,undefined,undefined,undefined,pos,'v20')
assert.ok(payloadModelFlags(next)&V20_FLAG_CM,'candidate must contain a v20 stream')
assert.deepEqual(decodeTerrainGroup(next,parts.map(p=>p.length),spec,undefined,pos,'v20').map(x=>Array.from(x)),parts.map(x=>Array.from(x)))
function frame(p:Uint8Array,v15:boolean){const h=planHeader(data.length,parts.map((x,i)=>({start:pos[i],end:pos[i]+x.length,cls:'binary' as const,spec})),[{spec,members:[0,1],payload:p,v15}]);const c=new Uint8Array(h.length+p.length);c.set(h);c.set(p,h.length);assert.deepEqual(decompress(c),data);return c}
const base=frame(old,false),alt=frame(next,true);console.log(JSON.stringify({input,kind,spec,base:base.length,alt:alt.length,basePayload:old.length,altPayload:next.length,oldSha256:sha(old),newSha256:sha(next),roundtrip:true,forced:true}))
