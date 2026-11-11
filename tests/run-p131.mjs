import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync,rmSync } from 'node:fs'
import { resolve } from 'node:path'
const names={gate:'testP131Gate',worker:'testP131Worker'},name=names[process.argv[2]],begun=performance.now()
if(!name)throw Error('Choose one bounded P13.1 shard: gate / worker')
const dir=resolve('.diag-state/p131-tests');mkdirSync(dir,{recursive:true})
const path=resolve(dir,`${name}-${process.pid}.cjs`)
try {
 await build({stdin:{contents:`import {${name}} from './tests/p131.test'; ${name}()`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:path,logLevel:'silent'})
 const r=spawnSync(process.execPath,[path],{stdio:'inherit',timeout:Math.max(1,17500-Math.ceil(performance.now()-begun)),killSignal:'SIGKILL'})
 if(r.error)throw r.error
 process.exitCode=r.status??1
} finally {rmSync(path,{force:true})}
