/** Reproducible <=48 KiB synthetic checks; no corpus download or large encode. */
import { testP10 } from '../../tests/p10.test'
import { sourceFingerprint, gitHead, projectRoot, atomicJson } from './p9-checkpoint.mjs'
const root = projectRoot(), source = await sourceFingerprint(root)
if (process.env.P9_SOURCE_SHA && process.env.P9_SOURCE_SHA !== source.sha256) throw Error('P10 打包/运行源码不一致')
const result = await testP10()
const sourceUnchanged = (await sourceFingerprint(root)).sha256 === source.sha256
if (!sourceUnchanged) throw Error('P10 检查期间源码变化')
const path = process.argv[2] ?? `${root}/scripts/diag/p10-results/checks/small-smoke.json`
await atomicJson(path, { kind: 'p10-small-correctness', commit: gitHead(root), source, sourceUnchanged, result })
console.log(`P10 small smoke saved: ${path}`)
