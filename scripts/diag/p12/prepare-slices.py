"""Data preparation only: verify corpus SHA, copy fixed <=256KiB windows.
No codec, classifier, model training, or whole-file benchmark is run here.
Raw corpus/slices remain ignored; only provenance JSON is tracked.
"""
from pathlib import Path
import hashlib,json,tarfile,struct
root=Path(__file__).resolve().parents[3]
corpus=root/'.diag-data/corpus';out=root/'.diag-data/p12-slices';out.mkdir(parents=True,exist_ok=True)
base=json.loads((root/'scripts/diag/baseline.json').read_text())
records=[];structures={}
def add(name,file,offset,n=262144,note='fixed contiguous mid-file window'):
 ref=next(f for f in base['files'] if f['file']==file)
 with (corpus/file).open('rb') as f:f.seek(offset);data=f.read(n)
 assert 65536<=len(data)==n<=262144 and offset+n<=ref['size']
 p=out/(name+'.bin');p.write_bytes(data)
 records.append(dict(name=name,file=file,offset=offset,bytes=n,sha256=hashlib.sha256(data).hexdigest(),corpusBytes=ref['size'],corpusSha256=ref['sha256'],source=json.loads((corpus/(file+'.source.json')).read_text()),path=str(p.relative_to(root)),selection=note))
for f in base['files']:
 d=(corpus/f['file']).read_bytes();assert len(d)==f['size'] and hashlib.sha256(d).hexdigest()==f['sha256']
 n=262144//28*28 if f['file']=='sao' else 262144
 align=28 if f['file']=='sao' else 512
 add(f['file']+'-mid',f['file'],(len(d)//2//align)*align,n)
 if f['file'] in ['sao','mr','x-ray','osdb','webster','dickens','reymont','nci']:
  add(f['file']+'-late',f['file'],(len(d)*3//4//align)*align,n,'fixed 75%-offset contiguous window; holdout not selected by compression')
with tarfile.open(corpus/'samba','r:') as t:
 m=t.getmember('samba-2.2.3a/source/rpc_server/srv_spoolss_nt.c')
 add('samba-c','samba',m.offset_data,262144,'starts in identified C source; 219702 B member plus following contiguous tar data; first128KiB entirely C')
 structures['sambaC']=dict(member=m.name,offset=m.offset_data,bytes=m.size)
with tarfile.open(corpus/'xml','r:') as t:
 m=t.getmember('stats1.xml');add('xml-stats','xml',m.offset_data,262144,'identified stats1.xml member, no archive header')
with tarfile.open(corpus/'mozilla','r:') as t:
 m=t.getmember('mozilla/components/libgkcontent.so');h=t.extractfile(m).read(1600)
 assert int.from_bytes(h[:2],'little')==0x183
 n=struct.unpack_from('<H',h,2)[0];opt=struct.unpack_from('<H',h,20)[0]
 sections=[]
 for i in range(n):
  q=24+opt+64*i;name=h[q:q+8].split(b'\0')[0].decode();size,ptr=struct.unpack_from('<QQ',h,q+24)
  sections.append(dict(name=name,bytes=size,offset=ptr))
 structures['mozilla']=dict(member=m.name,memberOffset=m.offset_data,memberBytes=m.size,magic='0x0183',format='Alpha ECOFF (not x86 PE/ELF)',sections=sections)
 for tag,section in [('code','.text'),('resources','.rdata'),('strings','.dynstr')]:
  s=next(s for s in sections if s['name']==section);assert s['offset']+s['bytes']<=m.size
  add('mozilla-'+tag,'mozilla',m.offset_data+s['offset'],262144,'identified Alpha ECOFF '+section+' section of '+m.name)
 rdata=next(s for s in sections if s['name']=='.rdata')
 add('mozilla-resources-late','mozilla',m.offset_data+rdata['offset']+262144,262144,'fixed next contiguous non-overlapping 256KiB window in same Alpha .rdata; holdout after first window')
 s=next(s for s in sections if s['name']=='.text')
 add('mozilla-code-late','mozilla',m.offset_data+s['offset']+1048576,262144,'independent offset +1MiB inside same Alpha .text; input itself256KiB')
d=(corpus/'ooffice').read_bytes();pe=int.from_bytes(d[60:64],'little');assert d[pe:pe+4]==b'PE\0\0'
ns=struct.unpack_from('<H',d,pe+6)[0];opt=struct.unpack_from('<H',d,pe+20)[0];sections=[]
for i in range(ns):
 q=pe+24+opt+40*i;vsize,va,size,ptr=struct.unpack_from('<IIII',d,q+8)
 sections.append(dict(name=d[q:q+8].split(b'\0')[0].decode(),bytes=size,offset=ptr,virtualAddress=va))
structures['ooffice']=dict(format='PE x86',machine=hex(struct.unpack_from('<H',d,pe+4)[0]),sections=sections)
for tag,off in [('code',4096),('code-late',4096+1048576),('resources',5300224)]:
 add('ooffice-'+tag,'ooffice',off,262144,'PE .text' if 'code' in tag else 'PE .rdata')
manifest=dict(kind='P12-fixed-slice-provenance',preparationOnly=True,maxProbeInputBytes=262144,productionCommit='a3b6c3dd3b69f0ac65b06482313de880a2322a4f',samples=records,structures=structures)
p=root/'scripts/diag/p12-results/slices.json'
if p.exists():
 old=json.loads(p.read_text());prior={x['name']:x for x in old['samples']};current={x['name']:x for x in manifest['samples']}
 assert all(current.get(k)==v for k,v in prior.items()),'Existing provenance differs; do not overwrite'
 assert {k:v for k,v in old.items() if k!='samples'}=={k:v for k,v in manifest.items() if k!='samples'}
 if old!=manifest:p.write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n') # append-only sample extension
else:p.write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n')
print('prepared',len(records),'fixed windows; actual inputs',min(r['bytes'] for r in records),'..',max(r['bytes'] for r in records),'B; no whole-file compression')
