// Type-check diagnostics against a disposable lib copy with diagnostic exports.
// No production writes, no CM calls.
import { readFileSync,writeFileSync,readdirSync,mkdirSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { applyPatches } from './patches.mjs'
const dir=resolve('.diag-state/p14-types'),lib=join(dir,'lib')
mkdirSync(lib,{recursive:true})
for(const f of readdirSync('src/lib').filter(f=>f.endsWith('.ts')))writeFileSync(join(lib,f),readFileSync(`src/lib/${f}`))
const read=f=>readFileSync(join(lib,f),'utf8'),patch=(f,a,b)=>{const s=read(f);if(s.split(a).length!==2)throw Error('nonunique patch');writeFileSync(join(lib,f),s.replace(a,b))}
applyPatches('unit2','control',patch,read)
const config=join(dir,'tsconfig.json')
writeFileSync(config,JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,noEmit:true,skipLibCheck:true,types:['node'],lib:['ES2022','DOM'],baseUrl:process.cwd(),paths:{'@lib/*':[`${lib}/*`]}},include:[resolve('scripts/diag/p14/*.ts')]},null,2))
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','-p',config],{stdio:'inherit',timeout:12000,killSignal:'SIGKILL'})
console.log(JSON.stringify({diagnosticTypes:'PASS',cmCalls:0,productionWrites:0}))
