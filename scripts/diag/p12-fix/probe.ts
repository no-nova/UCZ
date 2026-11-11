// Synthetic 4,133-byte reproduction, never a Silesia measurement.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { compressGuardedPlanForProbe, decompress, planTuning, ID } from '@lib/codec'
const sha=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex')
async function run() {
  Object.assign(planTuning,{orphanConsolidation:false,macroUniformGate:false})
  const body=new Uint8Array(4096)
  let seed=123456
  for(let i=0;i<body.length;i+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;body.fill((seed>>>0)%16,i,i+4)}
  const spec={id:ID.TRANSPOSE_GROUP,s:4,r:1}
  const one=await compressGuardedPlanForProbe(body,[{start:0,end:body.length,cls:'binary',spec}],{serial:true})
  const promoted={...one.segs[0].spec}
  assert.equal(promoted.id,ID.TRANSPOSE_2D)
  assert.deepEqual(Buffer.from(decompress(one.container)),Buffer.from(body))
  const data=Uint8Array.from([...body,...body.subarray(0,37)])
  const picks=[{start:0,end:body.length,cls:'binary',spec},{start:body.length,end:data.length,cls:'binary',spec:promoted}]
  const common={scope:'synthetic explicit plan; serial; not a full-file/adaptive benchmark',
    inputBytes:data.length,inputSha256:sha(data),initialRules:picks.map(p=>p.spec),
    uncontested:{bytes:one.container.length,sha256:sha(one.container),promoted,roundtrip:true}}
  try {
    const result=await compressGuardedPlanForProbe(data,picks,{serial:true})
    assert.deepEqual(Buffer.from(decompress(result.container)),Buffer.from(data))
    console.log(JSON.stringify({...common,status:'PASS',bytes:result.container.length,containerSha256:sha(result.container),
      finalRules:result.segs.map(s=>s.spec),roundtrip:true}))
  } catch(error) {
    console.log(JSON.stringify({...common,status:'FAIL',error:String((error as Error).message),roundtrip:'not reached'}))
    process.exitCode=1
  }
}
void run()
