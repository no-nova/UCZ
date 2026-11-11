import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
const names={'bcj-seams':'testBcjSeams','bcj-target-first':'testBcjTargetFirst','bcj-target-last':'testBcjTargetLast','bcj-large-worker':'testBcjLargeWorker',bcj:'testBcjUpgrade','bcj-cache-worker':'testBcjCacheWorker',family:'testFamilyReuse',policy:'testPolicy',screen:'testScreen',worker:'testWorkerScreen'}
const name=names[process.argv[2]]
if(!name)throw Error(`Choose one bounded P13 shard: ${Object.keys(names).join(', ')}`)
const dir=resolve('.diag-state/p13-tests');mkdirSync(dir,{recursive:true})
const path=resolve(dir,`${name}-${process.pid}.cjs`),begun=performance.now()
try {
 await build({stdin:{contents:`import {${name}} from './tests/p13.test'; ${name}()`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:path,logLevel:'silent'})
 const r=spawnSync(process.execPath,[path],{stdio:'inherit',timeout:Math.max(1,17500-Math.ceil(performance.now()-begun)),killSignal:'SIGKILL'})
 if(r.error)throw r.error
 process.exitCode=r.status??1
}finally{rmSync(path,{force:true})}
