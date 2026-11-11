import {mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {patchLibrary} from './patches.mjs'
const dir=resolve('.diag-state/p15-typecheck'),lib=join(dir,'lib');mkdirSync(lib,{recursive:true})
for(const f of readdirSync('src/lib').filter(f=>f.endsWith('.ts')))writeFileSync(join(lib,f),readFileSync(`src/lib/${f}`))
patchLibrary((file,from,to)=>{const p=join(lib,file),s=readFileSync(p,'utf8');if(s.split(from).length!==2)throw Error('nonunique patch '+file);writeFileSync(p,s.replace(from,to))},f=>readFileSync(join(lib,f),'utf8'))
const config={extends:resolve('tsconfig.json'),compilerOptions:{baseUrl:resolve('.'),paths:{'@lib/*':[`${lib}/*`],'@stock/*':['src/lib/*'],'@/*':['src/*']},noUnusedLocals:false,noUnusedParameters:false},include:[...['common','rec2','unit1','unit2','unit3','unit4'].map(x=>resolve(`scripts/diag/p15/${x}.ts`)),join(lib,'coder.ts')]}
writeFileSync(join(dir,'tsconfig.json'),JSON.stringify(config,null,2))
const child=spawnSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(dir,'tsconfig.json')],{encoding:'utf8',timeout:16000})
const out={status:child.status===0?'PASS':'FAIL',exitCode:child.status,signal:child.signal,error:child.error?.message??null,stdout:child.stdout,stderr:child.stderr,scope:'P15 diagnostic TypeScript and isolated patched library; production files not modified'}
writeFileSync('scripts/diag/p15-results/checks/typescript.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out));if(out.status!=='PASS')process.exitCode=1
