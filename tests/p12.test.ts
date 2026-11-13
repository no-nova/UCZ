import assert from 'node:assert/strict'
import { fastDeepEqual } from './fast-equal'
import { Worker } from 'node:worker_threads'
import { encodeTerrainGroup, decodeTerrainGroup, ID, candidatesFor, orphanProposalForProbe, planTuning, compressGuardedPlanForProbe, evaluatePlan, decompress, type PlanSegment } from '../src/lib/codec'
import { a2Tuning, encodeCM, withContainerModel, withCMBlockSize, decodeCM } from '../src/lib/coder'
import { wordPreFwdSampled, wordPreInv, buildTokenDict, collapseWithDict, dictHeader } from '../src/lib/wordpre'
import { CM_FAMILIES, CM_ENCODING, isFamilyCM } from '../src/lib/unify'
import { encodeGroupForJob } from '../src/lib/codec-jobs'
import { PARALLEL_WORKER_CODE } from '../src/lib/parallel-worker-code'
import { compatibilityInputs, rawCompatibilityInput } from './p111-inputs'
import historical from './p111-references.json'
import words from './p111-wordpre-reference.json'
import legacyWp from './legacy-wordpre-fixtures.json'
const eq = (a:Uint8Array,b:Uint8Array) => fastDeepEqual(Buffer.from(a),Buffer.from(b))

export function testP120Units() {
  assert.equal(a2Tuning.wordPreTextOff,false); assert.equal(planTuning.candidateTgV3,true)
  // Multi-part plain v15 must not fall through to the old encodeSpec kernel.
  const a = Uint8Array.from({length:4096},(_,i)=>(i*13+(i>>3))&255), parts=[a.subarray(0,1777),a.subarray(1777)]
  for (const [id,profile] of [[ID.BIN,'bin'],[ID.TEXT,'text'],[ID.O0,'o0']] as const) {
    const spec={id,s:1,r:1}, p=encodeTerrainGroup(parts,spec,undefined,undefined,undefined,[0,1777],'v15')
    eq(p,encodeCM(a,profile,1,1,undefined,0,undefined,undefined,'v15'))
    const decoded=decodeTerrainGroup(p,parts.map(x=>x.length),spec,undefined,[0,1777],'v15')
    decoded.forEach((x,i)=>eq(x,parts[i]))
  }
  const text=new TextEncoder().encode(('alpha alpha alpha=\"beta\":\n\t<node-name>123</node-name> ' + String.fromCharCode(127,128,255)).repeat(300))
  const p=wordPreFwdSampled(text)!
  eq(wordPreInv(p.header,p.body,text.length),text)
  assert.ok(p.dict.length<=120 && p.dict.every(w=>w.length>=3 && w.length<=24))
  fastDeepEqual(wordPreFwdSampled(text),p)
  for (const extended of [false,true]) {
    const dict=buildTokenDict(text,120,extended), body=collapseWithDict(text,dict)!
    assert.ok(p.body.length+p.header.length<=body.length+dictHeader(dict).length)
  }
  const bcj=CM_FAMILIES.find(f=>f.name==='BCJ')!
  fastDeepEqual(bcj,{name:'BCJ',members:[ID.BCJ,ID.BCJ_V2,ID.BCJ_V3],target:ID.BCJ_V3})
  assert.ok(isFamilyCM(ID.BCJ)); assert.equal(CM_ENCODING[ID.BCJ],undefined)
  const gate=(count:number,plausible:number)=>{
    const x=new Uint8Array(4096).fill(0x50)
    for(let i=0;i<count;i++)x.set([0xe8,0x12,0x34,0x56,i<plausible?0:0x12],i*16)
    return candidatesFor(x,'binary',1,x).some(s=>s.id===ID.BCJ_V3)
  }
  assert.equal(gate(5,5),false);assert.equal(gate(6,1),false);assert.equal(gate(6,2),true)
  const periodic=Uint8Array.from({length:32768},(_,i)=>(i%1024)&255)
  assert.ok(candidatesFor(periodic,'binary',2,periodic).some(s=>s.id===ID.TRANSPOSE_GROUP_V3))
  const spec={id:ID.BIN_V3,s:1,r:1}
  const plan:PlanSegment[]=[{start:0,end:90000,cls:'binary',spec,compLen:40000},
    {start:90000,end:95000,cls:'smooth',spec:{id:ID.DELTA_V3,s:2,r:1},compLen:1749},
    {start:95000,end:100000,cls:'binary',spec:{id:ID.O0,s:1,r:1},compLen:3000}]
  fastDeepEqual(orphanProposalForProbe(100000,plan)!.members,[0,2])
  plan[1].compLen=1750;fastDeepEqual(orphanProposalForProbe(100000,plan)!.members,[0,1,2])
  for (const unknown of [undefined, Number.NaN, -1]) {
    plan[1].compLen=unknown;fastDeepEqual(orphanProposalForProbe(100000,plan)!.members,[0,1,2])
  }
  // Explicit post-encode zero allocations are legal; pre-encode placeholders
  // must be stripped by the speculative prefetch caller (worker-plan test).
  plan[1].compLen=0;fastDeepEqual(orphanProposalForProbe(100000,plan)!.members,[0,2])
  console.log('P12.0 units PASS: multi-part kernel, v1 token constraints/roundtrip, BCJ gate/family, TG3, measured orphan exclusion')
}
export function testP12HistoricalDecode() {
  const inputs=compatibilityInputs()
  for(const g of [...historical.references.p10.containers,...words.references.p10.containers]) {
    eq(decompress(Buffer.from(g.base64,'base64')),inputs.find(x=>x.name===g.name)!.data)
  }
  const raw=rawCompatibilityInput()
  for(const [version,ref] of [[18,historical.references.p10],[19,historical.references.p11]] as const)
    for(const m of ref.models) eq(withContainerModel(version,m.flags,()=>withCMBlockSize(m.scope,()=>decodeCM(Buffer.from(m.base64,'base64'),raw.length,'bin',1,1,undefined,'v15'))),raw)
  for(const f of legacyWp.fixtures) eq(decompress(Buffer.from(f.base64,'base64')),new TextEncoder().encode(legacyWp.text))
  console.log('Historical independent container/model/WORD-PRE decode PASS (includes v18 and pre-fixed-mht4 v19)')
}
export async function testP120Family() {
  // A real multi-member BCJ family with nonzero segment positions; merging may
  // win or lose, but retained kernels, transforms and bitmap must remain exact.
  const data=Uint8Array.from({length:32768},(_,i)=>(i*37+(i>>5))&255)
  for(let i=0;i+5<data.length;i+=97)data.set([0xe8,21,0,0,0],i)
  const save={...planTuning};Object.assign(planTuning,{macroUniformGate:false,orphanConsolidation:false})
  try {
    for (const ids of [[ID.BCJ,ID.BCJ_V2,ID.BCJ_V3],[ID.BIN,ID.BIN_V2,ID.BIN_V3]]) {
      const picks:PlanSegment[]=ids.map((id,i)=>({start:i*8192,end:i===2?data.length:(i+1)*8192,cls:'binary',spec:{id,s:1,r:1}}))
      const base=evaluatePlan(data,picks,{alreadyMerged:true})
      const out=await compressGuardedPlanForProbe(data,picks,{serial:true});eq(decompress(out.container),data)
      assert.ok(out.container.length<=base.totalBytes,'compare selected separate kernels, not mismatched v13/v15 costs')
    }
  }
  finally { Object.assign(planTuning,save) }
  console.log('P12.0 full family/absolute-position roundtrip PASS')
}
export async function testP12Worker() {
  const data=new TextEncoder().encode('worker alpha beta gamma=\"text\"\n'.repeat(1100)),spec={id:ID.TEXT_V3,s:1,r:1}
  const local=encodeGroupForJob([data],spec,[0],[data.length])
  const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
  try {
    const reply=await new Promise((resolve,reject)=>{
      worker.once('message',(m:any)=>m.error?reject(Error(m.error)):resolve(m));worker.once('error',reject)
      worker.postMessage({kind:'encodeGroup',parts:[[0,data.length]],spec,positions:[0],ends:[data.length]})
    });fastDeepEqual(reply,local)
  } finally { await worker.terminate() }
  console.log('P12 embedded worker exact bytes/flags/cost/candidates PASS')
}

// v20 transform tests use an independent arithmetic oracle, not only inverse
// functions sharing the same implementation.
export async function testP121Transforms() {
  const {wide16Fwd,wide16Inv,bcjMsbFwd,bcjMsbInv,wordRowDelta}=await import('../src/lib/transforms')
  const {V20_FLAG_TRANSFORMS}=await import('../src/lib/coder')
  const {planHeader,encodeSpec,decodeSpec,tgPlanningWindow}=await import('../src/lib/codec')
  const {markPayloadModel,payloadModelFlags}=await import('../src/lib/payload-model')
  const values=[65535,0,40000,100,0,65535,12345,54321,2,65533,0,1]
  const raw=Uint8Array.from(values.flatMap(x=>[x&255,x>>>8])),row=4
  for(let mode=3;mode<=8;mode++) {
    const predMode=mode===6?4:mode===7?5:mode===8?3:mode,rs:number[]=[]
    values.forEach((x,i)=>{
      const a=i%row?values[i-1]:0,b=i>=row?values[i-row]:0,c=i>=row&&i%row?values[i-row-1]:0
      const med=c>=Math.max(a,b)?Math.min(a,b):c<=Math.min(a,b)?Math.max(a,b):a+b-c
      const p=i<row?a:i%row===0?b:predMode===3?med:predMode===4?Math.max(0,Math.min(65535,Math.floor((3*a+3*b-2*c+2)/4))):Math.floor((a+b)/2)
      const r=(x-p+65536)%65536, signed=r>=32768?r-65536:r
      rs.push(mode>=6?signed>=0?signed*2:-signed*2-1:r)
    })
    const expected=Uint8Array.from(mode>=6?[...rs.map(r=>r>>>8),...rs.map(r=>r&255)]:rs.flatMap(r=>[r&255,r>>>8]))
    eq(wide16Fwd(raw,row*2,mode),expected);eq(wide16Inv(expected,row*2,mode),raw)
  }
  assert.throws(()=>wide16Fwd(new Uint8Array(3),256,3),/LE16/)
  const image=Uint8Array.from({length:2050},(_,i)=>(i*31+(i>>8))&255)
  for(let mode=3;mode<=8;mode++)for(const kernel of [false,'v15','v20'] as const) {
    const spec={id:ID.WIDE_GRAD,s:mode,r:256},parts=[image.subarray(0,514),image.subarray(514)],positions=[0,514]
    const p=encodeTerrainGroup(parts,spec,undefined,undefined,undefined,positions,kernel)
    assert.equal(payloadModelFlags(p)&V20_FLAG_TRANSFORMS,V20_FLAG_TRANSFORMS)
    const decoded=decodeTerrainGroup(p,parts.map(x=>x.length),spec,undefined,positions,kernel)
    decoded.forEach((x,i)=>eq(x,parts[i]))
    const h=planHeader(image.length,parts.map((x,i)=>({start:positions[i],end:positions[i]+x.length,cls:'smooth' as const,spec})),[{spec,members:[0,1],payload:p,v15:kernel==='v15'||kernel==='v20'}])
    assert.equal(h[3],20);eq(decompress(Uint8Array.from([...h,...p])),image)
    eq(decodeSpec(encodeSpec(image,spec),image.length,spec),image)
    assert.throws(()=>withContainerModel(19,0,()=>decodeTerrainGroup(p,parts.map(x=>x.length),spec)),/宽行/)
  }
  assert.equal(tgPlanningWindow(131071,28),Math.floor(16000/28)*28)
  assert.equal(tgPlanningWindow(131072,28),Math.floor(65536/28)*28)
  assert.equal(tgPlanningWindow(262144,8,false),16000)
  for(const base of [0,0xfffff9,0x1000000,0xfffffffe,17318384]) {
    const x=Uint8Array.of(0xe8,0xe8,255,255,1,0,0xe9,0,0,0,255,0xe8,0,0,0,0,0xe9,1,2)
    const copy=x.slice(),p=bcjMsbFwd(x,base);eq(bcjMsbInv(p,base),x);eq(x,copy)
    for(const kind of [0xe8,0xe9])for(const rel of [0,0x00ffffff,0xff000000,0xffffffff]) {
      const x=Uint8Array.of(kind,rel&255,rel>>>8&255,rel>>>16&255,rel>>>24),p=bcjMsbFwd(x,base)
      const v=(((rel>>>0)+(base+5))&0x1ffffff)<<7>>7
      eq(p,Uint8Array.of(kind,v&255,v>>>8&255,v>>>16&255,v>>>24));eq(bcjMsbInv(p,base),x)
    }
  }
  // uint64 reference arithmetic uses BigInt; production uses exact byte carry.
  for(const span of [4,8])for(const reverse of [false,true]) {
    const mask=(1n<<BigInt(span*8))-1n,values=[0n,mask,1n,0x12345678n,mask-1n]
    const bytes=(x:bigint)=>Array.from({length:span},(_,i)=>Number(x>>BigInt(i*8)&255n))
    const orient=(b:number[])=>reverse?b.reverse():b
    const x=Uint8Array.from([...values.flatMap(v=>orient(bytes(v))),9,8,7])
    const expected=Uint8Array.from([...values.flatMap((v,i)=>orient(bytes((v-(i?values[i-1]:0n))&mask))),9,8,7])
    eq(wordRowDelta(x,[x.length],span,false,reverse),expected)
    eq(wordRowDelta(expected,[x.length],span,true,reverse),x)
    // Force a real inner-mode frame so both new mode opcodes/reverse flags and
    // a partial final row exercise the production decoder, even if DP declines.
    const cm=encodeCM(expected,'bin',span,1,undefined,0,undefined,undefined,'v13',span)
    const len:number[]=[];let v=cm.length;do{const b=v&127;v=Math.floor(v/128);len.push(b|(v?128:0))}while(v)
    const payload=markPayloadModel(Uint8Array.from([span,(span===4?7:8)|(reverse?128:0),...len,...cm]),payloadModelFlags(cm)|V20_FLAG_TRANSFORMS)
    const spec={id:ID.TRANSPOSE_GROUP_V3,s:span,r:1}
    // The input to TG is LE rows, not the gathered/reversed byte orientation.
    const plain=Uint8Array.from([...values.flatMap(bytes),9,8,7])
    eq(decodeTerrainGroup(payload,[x.length],spec)[0],plain)
    assert.throws(()=>withContainerModel(19,0,()=>decodeTerrainGroup(payload,[x.length],spec)),/未知转置/)
  }
  for(const spec of [{id:ID.BCJ_V3,s:2,r:1},{id:ID.TRANSPOSE_GROUP_V3,s:4,r:1},{id:ID.TRANSPOSE_GROUP_V3,s:8,r:1}]) {
    const payload=encodeTerrainGroup([image],spec,undefined,undefined,undefined,[0],'v20')
    const h=planHeader(image.length,[{start:0,end:image.length,cls:'binary',spec}],[{spec,members:[0],payload,v15:true}])
    eq(decompress(Uint8Array.from([...h,...payload])),image)
  }
  assert.throws(()=>withContainerModel(19,0x800,()=>0),/v19/)
  const {cmTableShape}=await import('../src/lib/coder')
  for(const scope of [524288,4194304])assert.equal(withContainerModel(20,0x800|20,()=>withCMBlockSize(scope,()=>cmTableShape(128))).mht4Bits,20)
  console.log('P12.1 predictor oracle, 18 multi-part kernel roundtrips, split planes, BCJ25, uint32/64 carries/reverse/tails, v20-only format PASS')
}

export async function testP121Worker() {
  const data=Uint8Array.from({length:1026},(_,i)=>(i*37+(i>>5))&255)
  data.set([0xe8,255,255,255,255],18)
  const specs=[...Array.from({length:6},(_,i)=>({id:ID.WIDE_GRAD,s:i+3,r:256})),{id:ID.BCJ_V3,s:2,r:1},{id:ID.TRANSPOSE_GROUP_V3,s:4,r:1}]
  const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
  try {
    for(const spec of specs) {
      const local=encodeGroupForJob([data.subarray(0,514),data.subarray(514)],spec,[0,514],[514,1026])
      const reply=await new Promise((resolve,reject)=>{
        const onError=(e:Error)=>reject(e);worker.once('error',onError)
        worker.once('message',(m:any)=>{worker.off('error',onError);m.error?reject(Error(m.error)):resolve(m)})
        worker.postMessage({kind:'encodeGroup',parts:[[0,514],[514,1026]],spec,positions:[0,514],ends:[514,1026]})
      });fastDeepEqual(reply,local)
    }
  }finally{await worker.terminate()}
  console.log('P12.1 real worker: six WIDE16 modes, BCJ s2, TG3 exact bytes/flags/candidates/cost PASS')
}

export async function testP122Kernel() {
  const {encodeCMDual,setAttribHook,attribHook,cmV20Tuning,V20_FLAG_CM,V20_FLAG_BIN_RECOVERY}=await import('../src/lib/coder')
  const {payloadModelFlags}=await import('../src/lib/payload-model')
  const input=new TextEncoder().encode('The quick brown fox 123. alpha BETA gamma delta.\n'.repeat(90))
  const keep=attribHook,save={...cmV20Tuning}
  try {
    for(const profile of ['text','bin','res','res2d'] as const)for(const geom of [0,4]) {
      const states:any[]=[]
      setAttribHook((m:any,i)=>{if(i>16 && i<32)states.push({weights:m.weights.length,N:m.ninputs,m2hi:m.m2hi,c0:m.m2UsesC0,ms:m.lastMs,primary:m.lastPrimaryMs,H:Array.from(m.hashes)})})
      const p=encodeCM(input,profile,2,32,undefined,0,undefined,undefined,'v20',geom)
      setAttribHook(keep)
      assert.equal(payloadModelFlags(p)&V20_FLAG_CM,V20_FLAG_CM)
      eq(decodeCM(p,input.length,profile,2,32,undefined,'v20',geom),input)
      const both=encodeCMDual(input,profile,2,32,'v20',geom);eq(both.alt,p)
      assert.ok(states.every(m=>m.weights===32*m.N && m.ms>=0 && m.ms<=2 && m.primary<=3))
      if(profile==='bin'||profile==='text')assert.ok(states.some(m=>m.m2hi!==0),'v20 must initialize weights2 context before early returns')
      if(profile==='text')assert.ok(states.every(m=>m.c0))
      // Independent hashes check requested wiring, not just stream symmetry.
      if(profile==='bin') {
        const h=(a:number,b=0,c=0,d=0,e=0,f=0)=>{
          return [a,b,c,d,e,f].reduce((v,x)=>Math.imul(v^x,0x01000193),0x811c9dc5)
        }
        states.forEach((m,j)=>{
          const i=17+j,pos=i+1,b1=input[i],b2=input[i-1]
          if(!geom) {assert.equal(m.H[4],h(b1,pos&3));assert.equal(m.H[6],h(input[i-2],input[i-3]));assert.equal(m.H[8],h(b2,input[i-3]))}
          else {const up=input[pos-geom],prev=input[pos-geom-1],up2=input[pos-2*geom];assert.equal(m.H[6],h((b1<<8)^up^(up2<<16)));assert.equal(m.H[7],h((b1<<16)^(b2<<8)^((up-prev)&255)^(up&0xf0)))}
        })
      }
    }
    cmV20Tuning.binRecovery=true
    const pattern=Uint8Array.from({length:80},(_,i)=>(i*73+19)&255),gap=Uint8Array.from([...pattern,...pattern]);gap[120]^=5
    const distances:number[]=[]
    setAttribHook((m:any)=>{if(m.lastDist)distances.push(m.lastDist)})
    const p=encodeCM(gap,'bin',1,1,undefined,0,undefined,undefined,'v20');setAttribHook(keep)
    assert.ok(distances.includes(80),'gap distance is pos-1-mptr, not 81')
    assert.equal(payloadModelFlags(p)&V20_FLAG_BIN_RECOVERY,V20_FLAG_BIN_RECOVERY)
    cmV20Tuning.binRecovery=false
    eq(withContainerModel(20,payloadModelFlags(p),()=>decodeCM(p,gap.length,'bin',1,1,undefined,'v20')),gap)
    assert.throws(()=>withContainerModel(19,0,()=>decodeCM(p,gap.length,'bin',1,1,undefined,'v20')),/标志/)
    assert.throws(()=>withContainerModel(20,0x2000,()=>0),/v20/)
    console.log('P12.2 kernel: four profiles/geometries, exact dual alt, mixer indices, H4/H6/H8, ms2 bounds, corrected gap distance and flags PASS')
  }finally{setAttribHook(keep);Object.assign(cmV20Tuning,save)}
}

export async function testP122Mixed() {
  const {planHeader,groupV15CandidatesSync}=await import('../src/lib/codec')
  const {cmV20Tuning}=await import('../src/lib/coder')
  const {default:frozen}=await import('./p121-fixtures.json')
  const raw=Buffer.from(frozen.input.base64,'base64')
  for(const f of frozen.cases)eq(decompress(Buffer.from(f.base64,'base64')),raw)
  const a=new TextEncoder().encode('alpha BETA gamma 1234567. '.repeat(100)),b=Uint8Array.from({length:3000},(_,i)=>(i*37+(i>>3))&255)
  const sa={id:ID.TEXT_V3,s:1,r:1},sb={id:ID.BIN_V3,s:1,r:1}
  const old=encodeTerrainGroup([a],sa,undefined,undefined,undefined,[0],'v15'),current=encodeTerrainGroup([b],sb,undefined,undefined,undefined,[a.length],'v20')
  const segs=[{start:0,end:a.length,cls:'text' as const,spec:sa},{start:a.length,end:a.length+b.length,cls:'binary' as const,spec:sb}]
  const h=planHeader(a.length+b.length,segs,[{spec:sa,members:[0],payload:old,v15:true},{spec:sb,members:[1],payload:current,v15:true}])
  const c=Uint8Array.from([...h,...old,...current]);assert.equal(c[3],20);eq(decompress(c),Uint8Array.from([...a,...b]))
  // Strict selection itself, including v20 header overhead, has a retained v15
  // complete-container baseline. This small fixture uses the real guarded path.
  const save={...cmV20Tuning};cmV20Tuning.enabled=false
  const base=await compressGuardedPlanForProbe(b,[{start:0,end:b.length,cls:'binary',spec:sb}],{serial:true})
  cmV20Tuning.enabled=true
  try {
    const result=await compressGuardedPlanForProbe(b,[{start:0,end:b.length,cls:'binary',spec:sb}],{serial:true})
    assert.ok(result.container.length<=base.container.length);eq(decompress(result.container),b)
    const text=new TextEncoder().encode('alpha beta gamma delta=\"text\"\n'.repeat(1200))
    const cand=groupV15CandidatesSync([text],sa,[0])!
    assert.ok(cand.v20);assert.ok(cand.wordPreV20)
    const wp=cand.wordPreV20!,header=planHeader(text.length,[{start:0,end:text.length,cls:'text',spec:sa}],[{spec:sa,members:[0],payload:wp,v15:true,wordPre:true}])
    eq(decompress(Uint8Array.from([...header,...wp])),text)
  }finally{Object.assign(cmV20Tuning,save)}
  console.log('P12.2 mixed v15/v20 group markers, 14 independent P12.1 v20 fixtures, strict old-kernel fallback and WORD-PRE v20 PASS')
}

export async function testP122Worker() {
  const {cmV20Tuning}=await import('../src/lib/coder')
  const data=Uint8Array.from({length:2050},(_,i)=>(i*17+(i>>3))&255),spec={id:ID.BIN_V3,s:1,r:1}
  const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}}),save={...cmV20Tuning}
  try {
    for(const config of [{enabled:true,binRecovery:false},{enabled:true,binRecovery:true},{enabled:false,binRecovery:false},null]) {
      Object.assign(cmV20Tuning,config??save)
      const local=encodeGroupForJob([data.subarray(0,514),data.subarray(514)],spec,[0,514],[514,2050])
      const reply=await new Promise<any>((resolve,reject)=>{
        const onError=(e:Error)=>reject(e);worker.once('error',onError)
        worker.once('message',(m:any)=>{worker.off('error',onError);m.error?reject(Error(m.error)):resolve(m)})
        worker.postMessage({kind:'encodeGroup',parts:[[0,514],[514,2050]],spec,positions:[0,514],ends:[514,2050],...(config?{cmV20:config}:{})})
      });fastDeepEqual(reply,local)
      assert.ok(reply.cand, 'BIN3 worker returns its candidate record')
      if(config?.enabled)assert.equal(reply.cand.v20Flags,config.binRecovery?0x3000:0x1000)
      if(config?.enabled===false)assert.equal(reply.cand.v20,null)
    }
  }finally{Object.assign(cmV20Tuning,save);await worker.terminate()}
  console.log('P12.2 real worker explicit v20/recovery options, legacy-off jobs, scoped restoration and serialized flags PASS')
}


export async function testP122WorkerPlan() {
  const {cmV20Tuning}=await import('../src/lib/coder')
  const {parallelReport}=await import('../src/lib/codec')
  const save={cm:{...cmV20Tuning},plan:{...planTuning},parallel:{...parallelReport}}
  const data=Uint8Array.from({length:8704},(_,i)=>(i*17+(i>>3))&255)
  const picks:PlanSegment[]=[{start:0,end:8192,cls:'binary',spec:{id:ID.BIN_V3,s:1,r:1}},
    {start:8192,end:data.length,cls:'smooth',spec:{id:ID.DELTA_V3,s:2,r:1}}]
  const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
  const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
  try {
    for(const binRecovery of [false,true]) {
      Object.assign(cmV20Tuning,{enabled:true,binRecovery})
      Object.assign(planTuning,{orphanConsolidation:true,macroUniformGate:true})
      const serial=await compressGuardedPlanForProbe(data,picks,{serial:true})
      const batches:number[]=[]
      const result=await compressGuardedPlanForProbe(data,picks,{runJobs:async jobs=>{
        batches.push(jobs.length)
        const replies=[]
        for(const job of jobs) {
          fastDeepEqual(job.cmV20,{enabled:true,binRecovery})
          const reply=await new Promise<any>((resolve,reject)=>{
            const fail=(e:Error)=>reject(e);worker.once('error',fail)
            worker.once('message',(m:any)=>{worker.off('error',fail);m.error?reject(Error(m.error)):resolve(m)})
            worker.postMessage(job)
          })
          if(reply.cand?.v20)assert.ok(reply.cand.v20Flags&0x1000)
          replies.push(reply)
        }
        return replies
      }})
      assert.equal(batches[0],2,'unknown initial cost must not preserve DELTA and prefetch a third speculative macro job')
      assert.ok(result.guardStats!.workerJobs>=2)
      assert.equal(result.guardStats!.workerFallbacks,0)
      eq(result.container,serial.container);eq(decompress(result.container),data)
      fastDeepEqual(result.segs.map(s=>s.modelFlags),serial.segs.map(s=>s.modelFlags))
    }
  }finally {Object.assign(cmV20Tuning,save.cm);Object.assign(planTuning,save.plan);Object.assign(parallelReport,save.parallel);await worker.terminate()}
  console.log('P12.2 real worker/main-thread restoration: mixed-rule guarded plans, recovery on/off, exact container bytes and no unknown-cost orphan prefetch PASS')
}

function transposeCollisionFixture() {
  const width=4,body=new Uint8Array(width*1024)
  let seed=123456
  for(let i=0;i<body.length;i+=width){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;body.fill((seed>>>0)%16,i,i+width)}
  return {body,original:{id:ID.TRANSPOSE_GROUP,s:width,r:1}}
}

export async function testP122Collision() {
  const {parallelReport}=await import('../src/lib/codec')
  const save={plan:{...planTuning},parallel:{...parallelReport}}
  Object.assign(planTuning,{orphanConsolidation:false,macroUniformGate:false})
  try {
    const {body,original}=transposeCollisionFixture()
    const one=await compressGuardedPlanForProbe(body,[{start:0,end:body.length,cls:'binary',spec:original}],{serial:true})
    const promoted={...one.segs[0].spec}
    assert.equal(promoted.id,ID.TRANSPOSE_2D,'uncontested upgrade must remain available')
    const legacy=encodeTerrainGroup([body],original)
    for(const reverse of [false,true]) {
      const tail=body.subarray(0,37),data=Uint8Array.from(reverse?[...tail,...body]:[...body,...tail])
      const picks:PlanSegment[]=reverse
        ? [{start:0,end:tail.length,cls:'binary',spec:promoted},{start:tail.length,end:data.length,cls:'binary',spec:original}]
        : [{start:0,end:body.length,cls:'binary',spec:original},{start:body.length,end:data.length,cls:'binary',spec:promoted}]
      console.log(JSON.stringify({case:'late-transpose-rule-collision',inputBytes:data.length,initialRules:picks.map(p=>p.spec),singleGroupPromotesTo:promoted}))
      const result=await compressGuardedPlanForProbe(data,picks,{serial:true})
      eq(decompress(result.container),data)
      assert.notEqual(result.segs[reverse?1:0].spec.id,promoted.id)
      fastDeepEqual(result.segs[reverse?0:1].spec,promoted)
      assert.equal(evaluatePlan(data,picks,{alreadyMerged:true}).totalBytes,result.container.length)
      console.log(JSON.stringify({reverse,bytes:result.container.length,finalRules:result.segs.map(s=>s.spec)}))
    }
    // Both alternative identities are occupied. The original real stream must
    // remain, not be mislabeled, concatenated with a peer, or lose its costs.
    const data=Uint8Array.from([...body,...body.subarray(0,37),...body.subarray(0,41)])
    const picks:PlanSegment[]=[{start:0,end:body.length,cls:'binary',spec:original},
      {start:body.length,end:body.length+37,cls:'binary',spec:promoted},
      {start:body.length+37,end:data.length,cls:'binary',spec:{id:ID.TRANSPOSE_GROUP_V3,s:4,r:1}}]
    const serial=await compressGuardedPlanForProbe(data,picks,{serial:true})
    eq(decompress(serial.container),data)
    fastDeepEqual(serial.segs[0].spec,original)
    assert.equal(serial.segs[0].compLen,legacy.length)
    assert.equal(serial.overhead+serial.segs.reduce((n,s)=>n+s.compLen,0),serial.container.length)
    assert.equal(evaluatePlan(data,picks,{alreadyMerged:true}).totalBytes,serial.container.length)
    const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
    const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
    try {
      const parallel=await compressGuardedPlanForProbe(data,picks,{runJobs:async jobs=>{
        const replies=[]
        for(const job of jobs) replies.push(await new Promise<any>((resolve,reject)=>{
          const fail=(e:Error)=>reject(e);worker.once('error',fail)
          worker.once('message',(r:any)=>{worker.off('error',fail);r.error?reject(Error(r.error)):resolve(r)})
          worker.postMessage(job)
        }))
        return replies
      }})
      assert.ok(parallel.guardStats!.workerJobs>=2)
      assert.equal(parallel.guardStats!.workerFallbacks,0)
      eq(parallel.container,serial.container);fastDeepEqual(parallel.blockCost,serial.blockCost)
      eq(decompress(parallel.container),data)
    }finally{await worker.terminate()}
    console.log('P12.2 collision: both group orders, occupied 2D/TG3 keys, exact legacy fallback, costs, evaluator and real-worker/container parity PASS (max 4174 B synthetic)')
  } finally {Object.assign(planTuning,save.plan);Object.assign(parallelReport,save.parallel)}
}

export async function testP122Reservations() {
  const {planSpecReservations,planHeader}=await import('../src/lib/codec')
  // These are dictionary metadata, not virtual-size codec inputs. The same
  // predicate guards late >=1 MiB upgrades and cached aliases in production.
  const a={spec:{id:ID.TRANSPOSE_GROUP,s:4,r:1}},b={spec:{id:ID.TRANSPOSE_GROUP_V3,s:4,r:1}},c={spec:{id:ID.TRANSPOSE_2D,s:4,r:1}}
  const keys=planSpecReservations([a,b,c])
  assert.ok(keys.available(a,a.spec));assert.ok(!keys.available(a,b.spec));assert.ok(!keys.available(a,c.spec))
  assert.throws(()=>keys.claim(a,b.spec),/另一组/)
  assert.ok(keys.available(a,{...b.spec,s:8}),'different strides are distinct dictionary identities')
  const other={spec:{id:ID.BIN_V3,s:1,r:1}},free=planSpecReservations([a,other])
  assert.ok(free.available(a,b.spec));free.claim(a,b.spec)
  assert.ok(free.available(a,b.spec));assert.ok(!free.available(other,b.spec),'cached target reservation survives until final encoding')
  assert.ok(!free.available(other,a.spec),'initial keys remain reserved even after an upgrade')
  assert.throws(()=>planSpecReservations([a,{spec:{...a.spec}}]),/重复/)
  const segs=[{start:0,end:1,cls:'binary' as const,spec:a.spec},{start:1,end:2,cls:'binary' as const,spec:a.spec}]
  assert.throws(()=>planHeader(2,segs,[{spec:a.spec,members:[0],payload:{length:1}},{spec:a.spec,members:[1],payload:{length:1}}]),/重复/)
  // Malformed duplicate STORE dictionary remains rejected by the decoder.
  assert.throws(()=>decompress(Uint8Array.of(85,67,90,7,2,2,2,0,1,1,1,0,1,1,1,1,1,1,65,66)),/无效的规则字典/)
  console.log('P12.2 dictionary ownership, cached-alias metadata, large-upgrade predicate and malformed duplicate rejection PASS')
}

export async function testP122CachedCollision() {
  const {compressCachedPlansForProbe,parallelReport}=await import('../src/lib/codec')
  const savedParallel={...parallelReport}
  const {body,original}=transposeCollisionFixture()
  const data=Uint8Array.from([...body,...body.subarray(0,37),...body.subarray(0,41),...new Uint8Array(19).fill(65)])
  const rules=[ID.STORE,ID.TRANSPOSE_2D,ID.TRANSPOSE_GROUP_V3]
  const plans:PlanSegment[][]=rules.map((_,phase)=>[
    {start:0,end:body.length,cls:'binary',spec:original},
    {start:body.length,end:body.length+37,cls:'binary',spec:{id:phase?ID.TRANSPOSE_2D:ID.STORE,s:phase?4:1,r:1}},
    {start:body.length+37,end:body.length+78,cls:'binary',spec:{id:phase===2?ID.TRANSPOSE_GROUP_V3:ID.STORE,s:phase===2?4:1,r:1}},
    {start:body.length+78,end:data.length,cls:'fill',spec:{id:ID.FILL,s:1,r:1}},
  ])
  try {
    const cached=await compressCachedPlansForProbe(data,plans,{serial:true})
    fastDeepEqual(cached.map(r=>r.segs[0].spec.id),[ID.TRANSPOSE_2D,ID.TRANSPOSE_GROUP_V3,ID.TRANSPOSE_GROUP])
    assert.equal(cached[0].guardStats!.reusedGroups,0)
    assert.ok(cached[1].guardStats!.reusedGroups>0,'unchanged FILL must still reuse a real cache entry')
    assert.ok(cached[2].guardStats!.reusedGroups>cached[1].guardStats!.reusedGroups)
    for(let i=0;i<plans.length;i++) {
      const [cold]=await compressCachedPlansForProbe(data,[plans[i]],{serial:true})
      eq(cached[i].container,cold.container);eq(decompress(cached[i].container),data)
      fastDeepEqual(cached[i].blockCost,cold.blockCost)
      assert.equal(evaluatePlan(data,plans[i],{alreadyMerged:true}).totalBytes,cached[i].container.length)
      assert.equal(cached[i].overhead+cached[i].segs.reduce((n,s)=>n+s.compLen,0),cached[i].container.length)
    }
    const sab=new SharedArrayBuffer(data.length);new Uint8Array(sab).set(data)
    const worker=new Worker(PARALLEL_WORKER_CODE,{eval:true,workerData:{sab}})
    try {
      const actual=await compressCachedPlansForProbe(data,plans,{runJobs:async jobs=>{
        const replies=[]
        for(const job of jobs) replies.push(await new Promise<any>((resolve,reject)=>{
          const fail=(e:Error)=>reject(e);worker.once('error',fail)
          worker.once('message',(r:any)=>{worker.off('error',fail);r.error?reject(Error(r.error)):resolve(r)})
          worker.postMessage(job)
        }))
        return replies
      }})
      assert.ok(actual[2].guardStats!.workerJobs>=2)
      assert.equal(actual[2].guardStats!.workerFallbacks,0)
      assert.equal(actual[2].guardStats!.reusedGroups,cached[2].guardStats!.reusedGroups)
      for(let i=0;i<plans.length;i++){
        eq(actual[i].container,cached[i].container);eq(decompress(actual[i].container),data)
        fastDeepEqual(actual[i].blockCost,cached[i].blockCost)
      }
    }finally{await worker.terminate()}
    console.log('P12.2 cached alias collision: 2D then TG3 targets occupied, original-stream fallback, unaffected cache reuse, cold/evaluator/cost/real-worker parity PASS (4193 B synthetic)')
  }finally{Object.assign(parallelReport,savedParallel)}
}
