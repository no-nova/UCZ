/** Durable P11.1 small-input compatibility evidence; never a corpus benchmark. */
import {testP111} from '../../tests/p111.test'
import {sourceFingerprint,gitHead,projectRoot,atomicJson} from './p9-checkpoint.mjs'
const root=projectRoot(),source=await sourceFingerprint(root)
if(process.env.P9_SOURCE_SHA && process.env.P9_SOURCE_SHA!==source.sha256)throw Error('P11.1 打包/运行源码不一致')
const commit=gitHead(root),result=await testP111()
const sourceUnchanged=(await sourceFingerprint(root)).sha256===source.sha256
if(!sourceUnchanged)throw Error('P11.1 检查期间源码变化')
const path=process.argv[2]??`${root}/scripts/diag/p11-results/checks/small-smoke-p11-1.json`
await atomicJson(path,{kind:'p11-1-small-compatibility',commit,source,sourceUnchanged,result})
console.log(`P11.1 small smoke saved: ${path}`)
