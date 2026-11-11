// 诊断：在真实编码结果上，按当前 unifyFamilies 的规则重建“统一载荷”并与
// 最终容器里的分组载荷逐字节比对，判断差异来自输入集合还是编码过程。
// 用法：node scripts/diag/run.mjs probe-unify-block <文件> <TEXT|BIN>
import { readFile } from 'node:fs/promises'
import { compressAdaptive, encodeTerrainGroup, ID } from '../../src/lib/codec'

const data = await readFile(process.argv[2] ?? '/tmp/corpus/samba')
const which = (process.argv[3] ?? 'TEXT').toUpperCase()
const comp = await compressAdaptive(data)
const target = which === 'TEXT' ? ID.TEXT_V3 : ID.BIN_V3
const members = comp.segs.map((s, i) => ({ s, i })).filter(x => x.s.spec.id === target)
const parts = members.map(x => data.subarray(x.s.start, x.s.end))
const unified = encodeTerrainGroup(parts, { id: target, s: 1, r: 1 }).length
const inContainer = members.reduce((a, x) => a + x.s.compLen, 0)
// 逆序再算一次，看顺序影响有多大
const rev = encodeTerrainGroup(parts.slice().reverse(), { id: target, s: 1, r: 1 }).length
console.log(JSON.stringify({ which, segs: members.length, raw: parts.reduce((a, p) => a + p.length, 0), unified, inContainer, reversed: rev }))
