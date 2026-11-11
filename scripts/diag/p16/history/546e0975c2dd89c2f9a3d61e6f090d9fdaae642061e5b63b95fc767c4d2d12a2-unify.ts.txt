// 同族 CM 规则的“择优归一”。
//
// 分组键是规则字典项 (id, s, r)，所以 CM-TEXT / CM-TEXT2 / CM-TEXT3 会各自
// 建组、各自冷启动一套上下文模型。对碎片化文件（samba 有 2,188 个区域）这笔
// 冷启动开销可观，但一刀切统一又会伤到本该分治的文件（mozilla）。
//
// 这里只做严格择优：先完整编码原有各独立分组得到 separateBytes，再对候选
// 统一规则完整编码同一批区域得到 unifiedBytes；只有 unifiedBytes < separateBytes
// 才接受。因此结果对原有方案单调不劣（最坏情况只是多花一点编码时间），
// 不新增 codec ID，也不改变 v1–v14 容器格式。

/** 参与归一的纯 CM 规则：id → 编码参数。与 codec.ts 中的编码路径逐项对齐。 */
interface CMEncoding { profile: 'text' | 'bin'; variant: boolean | 'v13' }
export const CM_ENCODING: Readonly<Record<number, CMEncoding>> = {
  4: { profile: 'text', variant: false }, // TEXT
  18: { profile: 'text', variant: true }, // TEXT_V2
  23: { profile: 'text', variant: 'v13' }, // TEXT_V3
  5: { profile: 'bin', variant: false }, // BIN
  19: { profile: 'bin', variant: true }, // BIN_V2
  24: { profile: 'bin', variant: 'v13' }, // BIN_V3
}

export interface CMFamily {
  name: string
  /** 同族规则 ID；BCJ 还可包含独立版本化的 s2 变换。 */
  members: readonly number[]
  /** 初始归一目标；codec 的组候选器再比较 BCJ s2 与 v15/v20。 */
  target: number
}

export const CM_FAMILIES: readonly CMFamily[] = [
  { name: 'TEXT', members: [4, 18, 23], target: 23 },
  { name: 'BIN', members: [5, 19, 24], target: 24 },
  { name: 'BCJ', members: [11, 20, 25], target: 25 },
]

// BCJ is a transformed family, NOT a raw CM_ENCODING entry.
export const isFamilyCM = (id: number) => CM_FAMILIES.some(f => f.members.includes(id))
