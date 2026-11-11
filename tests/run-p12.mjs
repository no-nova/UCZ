import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
const names={'cache-collision':'testP122CachedCollision',reservations:'testP122Reservations',collision:'testP122Collision','worker-plan':'testP122WorkerPlan','worker-v20':'testP122Worker',kernel:'testP122Kernel',mixed:'testP122Mixed','worker-transforms':'testP121Worker',transforms:'testP121Transforms',unit:'testP120Units',history:'testP12HistoricalDecode',family:'testP120Family',worker:'testP12Worker'}
const historicalCase=process.argv[2]==='history-write'?process.argv[3]:null
const name=historicalCase?'testP111':names[process.argv[2]]
if(!name)throw Error(`Choose one bounded shard: ${Object.keys(names).join(', ')}, history-write <fixture>`)
const dir=resolve('.diag-state/p12-tests');mkdirSync(dir,{recursive:true})
const path=resolve(dir,`${name}-${process.pid}.cjs`),begun=performance.now()
try {
 await build({stdin:{contents:`import {${name}} from './tests/${historicalCase?'p111':'p12'}.test'; ${name}(${historicalCase?JSON.stringify(historicalCase):''})`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:path,logLevel:'silent'})
 const r=spawnSync(process.execPath,[path],{stdio:'inherit',timeout:Math.max(1,17500-Math.ceil(performance.now()-begun)),killSignal:'SIGKILL'})
 if(r.error)throw r.error
 process.exitCode=r.status??1
}finally{rmSync(path,{force:true})}
