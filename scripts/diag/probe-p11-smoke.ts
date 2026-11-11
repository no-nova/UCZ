/** Reproducible small P11 correctness checks; no corpus or large-input encode. */
import { testP11 } from '../../tests/p11.test'
import { sourceFingerprint, gitHead, projectRoot, atomicJson } from './p9-checkpoint.mjs'
const root = projectRoot(), source = await sourceFingerprint(root)
if (process.env.P9_SOURCE_SHA && process.env.P9_SOURCE_SHA !== source.sha256) throw Error('P11 打包/运行源码不一致')
const commit = gitHead(root), result = await testP11()
const sourceUnchanged = (await sourceFingerprint(root)).sha256 === source.sha256
if (!sourceUnchanged) throw Error('P11 检查期间源码变化')
const path = process.argv[2] ?? `${root}/scripts/diag/p11-results/checks/small-smoke.json`
await atomicJson(path, { kind:'p11-small-correctness', commit, source, sourceUnchanged, result })
console.log(`P11 small smoke saved: ${path}`)
