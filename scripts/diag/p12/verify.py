"""Metadata/evidence verification and arithmetic-only projections. No codec call.
Run from the project directory after prepare-slices.py. Never edits production.
The projection interval is min/max observed slice rates under an explicit
same-distribution/full-coverage assumption, NOT a statistical bound or result.
"""
from pathlib import Path
import hashlib,json,subprocess
root=Path(__file__).resolve().parents[3]
out=root/'scripts/diag/p12-results'
sha=lambda x:hashlib.sha256(x).hexdigest()
load=lambda p:json.loads(Path(p).read_text())
def git(*a):return subprocess.check_output(['git',*a],cwd=root,text=True).strip()
assert git('branch','--show-current')=='arena/1220f47e-test'
assert not git('diff','a3b6c3d','--','src'), 'Production source changed'
base=load(root/'scripts/diag/baseline.json');B={x['file']:x for x in base['files']}
assert sum(x['bestUcz'] for x in B.values())==41814147
catalog=load(out/'slices.json');samples={x['name']:x for x in catalog['samples']}
primary=[];by={}
for a in ['agent1','agent2','agent3','agent4']:
 for p in sorted((out/a).glob('*.json')):
  r=load(p)
  if r.get('kind')!='P12-bounded-oracle':continue
  primary.append((p,r));by[(a,r['name'],r['variant'],r['inputLimit'])]=r['result']
replay_path=out/'validation/replay-xml-mid-pool-repack-v1.json'
replay=load(replay_path);all_records=primary+[(replay_path,replay)]
for p,r in all_records:
 assert r['status']=='PASS' and r['exitCode']==0 and 0<r['wallMs']<r['budgetMs']<20000,p
 assert r['productionReference']=='a3b6c3dd3b69f0ac65b06482313de880a2322a4f'
 m=r['result']['input'];s=samples[r['name']]
 assert 65536<=m['bytes']<=262144 and m['bytes']<=s['bytes']
 assert m['offset']==s['offset'] and m['file']==s['file']
 assert m['corpusSha256']==B[m['file']]['sha256'] and m['corpusBytes']==B[m['file']]['size']
 data=(root/s['path']).read_bytes();assert len(data)==s['bytes'] and sha(data)==s['sha256']
 assert sha(data[:m['bytes']])==m['sha256'] and m['parentSliceSha256']==s['sha256']
 for name,h in r['source'].items():assert sha((root/'src/lib'/name).read_bytes())==h,(p,name)
 for name,h in r['tools'].items():assert sha((out/'tool-sources'/(h+'-'+name)).read_bytes())==h,(p,name)
 for patch in r['patches']:
  assert patch['originalSha256']==r['source'][patch['file']]
  assert not patch['modified'] or r['agent']=='agent1' or r['agent']=='agent4' and r['variant']=='v2-atomic'
  if not patch['modified']:assert patch['compiledSha256']==patch['originalSha256']
 if r['variant']!='stats':assert r['result']['roundtrip'] is True
# Independent timing run of the same short complete UCZ case, exact SHA match.
old=by['agent4','xml-mid','pool-repack-v1',None];new=replay['result']
for k in ['payloadBytes','bytes','payloadSha256','containerSha256','short','usage']:assert old[k]==new[k],k
counts={}
for a in ['agent1','agent2','agent3','agent4']:
 rows=[r for _,r in primary if r['agent']==a]
 counts[a]={'probes':len(rows),'statisticsOnly':sum(r['variant']=='stats' for r in rows),'codecRoundtrips':sum(r['variant']!='stats' for r in rows),'maxWallMs':max(r['wallMs'] for r in rows)}
 assert counts[a]['probes']==load(out/a/'summary.json').get('probeCount')
# Receipt-derived gains: positive means smaller, with cost scope explicit.
def result(agent,name,var):return by[agent,name,var,None]
def case(agent,name,variants,candidate,metric='payloadBytes'):
 c=result(agent,name,candidate);refs=[result(*v) if isinstance(v,tuple) else result(agent,name,v) for v in variants]
 best=min(refs,key=lambda r:r[metric]);assert all(r['input']['sha256']==c['input']['sha256'] for r in refs)
 return {'agent':agent,'name':name,'referenceVariants':variants,'candidate':candidate,'inputBytes':c['input']['bytes'],'referenceBytes':best[metric],'candidateBytes':c[metric],'savedBytes':best[metric]-c[metric],'metric':metric}
def area(label,bytes,cases):
 rates=[c['savedBytes']/c['inputBytes'] for c in cases]
 return {'scope':label,'bytes':bytes,'cases':cases,'assumedSavedBytesMin':min(rates)*bytes,'assumedSavedBytesMax':max(rates)*bytes,'assumedSavedBytesMean':sum(rates)/len(rates)*bytes}
struct=catalog['structures'];moz=struct['mozilla'];text=next(s['bytes'] for s in moz['sections'] if s['name']=='.text');rdata=next(s['bytes'] for s in moz['sections'] if s['name']=='.rdata');office=next(s['bytes'] for s in struct['ooffice']['sections'] if s['name']=='.text')
items=[]
def add(rank,key,title,areas,scope,complexity,risk,priority):
 cases=[c for a in areas for c in a['cases']]
 items.append({'rank':rank,'key':key,'title':title,'measuredSavedBytesSum':sum(c['savedBytes'] for c in cases),'measuredSavedKB':sum(c['savedBytes'] for c in cases)/1000,'measuredCostScope':scope,'areas':areas,'conditionalProjectionKB':[sum(a['assumedSavedBytesMin'] for a in areas)/1000,sum(a['assumedSavedBytesMax'] for a in areas)/1000],'productionIncrementEstablished':False,'complexity':complexity,'fallbackRisk':risk,'priority':priority})
add(1,'med16','True 16-bit MED',[
 area(f, B[f]['size'],[case('agent2',f+'-'+p,['d16','byte-med','grad-v3'],'med16','bytes') for p in ['mid','late']]) for f in ['mr','x-ray']],
 'group CM payload; new UCZ transform/version not priced','low transform / medium integration','medium: endian, alignment, mixed data and wire compatibility','P1 research')
add(2,'tg-coverage','Existing TG3 structure coverage',[
 area('libgkcontent.so .text',text,[case('agent3',n,[('agent1',n,'base')],'tg4') for n in ['mozilla-code','mozilla-code-late']]),
 area('libgkcontent.so .rdata',rdata,[case('agent3',n,['base','delta8','sub-transpose'],'tg8') for n in ['mozilla-resources','mozilla-resources-late']])],
 'existing TG3 group payload including inner headers; baseline final groups unknown','medium-high planner/aggregation investigation','high attribution risk: current baseline may already realize the gain','P1 evidence/metadata first, not global enablement')
add(3,'sao-carry','Carry-aware LE32 field delta + current TG3',[
 area('sao (assume all records fit this distribution)',B['sao']['size'],[case('agent2',n,['tg-base'],'tg-delta32','bytes') for n in ['sao-mid','sao-late']])],
 'TG3 payload plus 1-byte field mask; new outer transform/version not priced','medium','medium-high: field alignment, heterogeneous records and sample overfit','P2 guarded candidate')
add(4,'word-dict','Actual-usage dictionary repack, v1-compatible',[
 area('xml (assume all bytes behave as sampled members)',B['xml']['size'],[case('agent4',n,['plain','v1'],'pool-repack-v1','bytes') for n in ['xml-stats','xml-mid']]),
 area('nci (assume all bytes eligible TEXT3)',B['nci']['size'],[case('agent4',n,['plain','v1'],'pool-repack-v1','bytes') for n in ['nci-mid','nci-late']])],
 'actual complete single-group UCZ including dictionary, prefix, flags, outer header','low-medium, no decoder-format change','low wire risk but measured webster +1147 B; strict selection mandatory','P2, safest integration experiment')
add(5,'gap-distance','Correct disabled match-recovery distance before enabling',[
 area('libgkcontent.so .text',text,[case('agent1',n,['base'],'gap-distance') for n in ['mozilla-code','mozilla-code-late']]),
 area('ooffice .text',office,[case('agent1',n,['base'],'gap-distance') for n in ['ooffice-code','ooffice-code-late']]),
 area('osdb (assume all bytes eligible BIN)',B['osdb']['size'],[case('agent1',n,['base'],'gap-distance') for n in ['osdb-mid','osdb-late']])],
 'raw CM payload only, not BCJ/TG-transformed groups or full UCZ','low arithmetic / medium format and dual-worker validation','medium-high bitstream risk; recovery remains disabled in production','P2 version-isolated candidate')
projection={'kind':'P12-conditional-arithmetic-not-benchmark','kbDefinition':'1000 bytes','warning':'No whole-file net gain measured. Min/max are observed cold-window rates applied to named byte coverage under identical-distribution assumptions, NOT confidence intervals or guaranteed upper bounds. Especially TG3 may already be selected. Never sum candidates: overlapping inputs/interactions. Macro/format/header and warm large models are not reproduced.','items':items}
(out/'top5.json').write_text(json.dumps(projection,indent=2,ensure_ascii=False)+'\n')
report={'kind':'P12-evidence-integrity-check','compressionExecutedByThisScript':False,'checkedAtCommit':git('rev-parse','HEAD'),'productionReference':'a3b6c3dd3b69f0ac65b06482313de880a2322a4f','productionSrcTreeUnchanged':True,'baselineBytes':41814147,'byAgent':counts,'primaryProbes':len(primary),'primaryCodecRoundtrips':sum(r['variant']!='stats' for _,r in primary),'statisticsOnly':sum(r['variant']=='stats' for _,r in primary),'extraBoundedReplay':{'path':str(replay_path.relative_to(root)),'wallMs':replay['wallMs'],'inputBytes':new['input']['bytes'],'containerBytes':new['bytes'],'containerSha256':new['containerSha256'],'matchesOriginalExactly':True},'globalMaxWallMs':max(r['wallMs'] for _,r in all_records),'inputSourceAndToolHashesChecked':len(all_records),'reportHashes':{p.name:sha(p.read_bytes()) for p in sorted((root/'docs/audits').glob('P12_*.md'))},'status':'PASS','limits':'Receipt integrity/input/source/tool checking, NOT an independent rerun of all codecs or full corpus validation.'}
(out/'verification.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['status','primaryProbes','primaryCodecRoundtrips','statisticsOnly','globalMaxWallMs','productionSrcTreeUnchanged']},indent=2))
for i in items:print(i['rank'],i['key'],'measured KB',i['measuredSavedKB'],'conditional KB',*[round(x,3) for x in i['conditionalProjectionKB']])
