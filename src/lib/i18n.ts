export type Lang = 'en' | 'zh'

/**
 * One dictionary for every user-visible string in the Web GUI.
 * Keys are short so the call sites stay readable: `t.input`, `t.run`, …
 * Anything not listed here (data, file names, codec labels) stays as-is.
 */
export interface Dict {
  tagline: string
  lang: string
  tier: string
  tierFast: string
  tierBalanced: string
  tierMax: string
  tierHint: string
  inputTitle: string
  dropHere: string
  pickFiles: string
  restoreUcz: string
  limits: (max: string) => string
  concurrency: string
  conc1: string
  concN: (n: number) => string
  sizeUnit: string
  unitBytes: string
  unitAuto: string
  cancelled: string
  waitBusy: string
  cancel: string
  details: string
  rawSize: string
  compressedSize: string
  verified: string
  verifiedOk: string
  verifiedBad: string
  decodeMs: string
  encodeMs: string
  regions: string
  blocks: string
  container: string
  throughput: string
  modelFlags: string
  segmentsTitle: string
  segmentsSub: string
  truthTitle: string
  terrainTitle: string
  terrainSub: string
  heightEntropy: string
  heightCost: string
  isoTitle: string
  isoSub: string
  digramTitle: string
  digramSub: string
  residualTitle: string
  residualSub: string
  contextLabel: string
  residualStats: (bins: number, block: number, mean: string, min: string, max: string) => string
  anomalyKind: Record<'cold-start' | 'entropy-spike' | 'regime-shift', string>
  inspect: string
  inspecting: string
  manifold: string
  stride: string
  scanPeriod: string
  flags: string
  anomalies: string
  noAnomalies: string
  processTitle: string
  processSub: string
  stage1: string
  stage2: string
  stage3: string
  expandGroups: string
  expandLog: string
  tableTitle: string
  tableSub: string
  range: string
  terrain: string
  rule: string
  bpb: string
  prev: string
  next: string
  page: (a: number, b: number, n: number) => string
  trials: string
  benchTitle: string
  benchSub: string
  benchRun: string
  benchRunning: string
  benchHint: string
  downloadUcz: string
  downloadRestored: string
  containerOverhead: string
  ncdTitle: string
  ncdSub: string
  ncdRun: (n: number) => string
  ncdRunning: string
  ncdNearest: string
  ncdNote: string
  singleCmSkipped: string
  working: string
}

const en: Dict = {
  tagline: 'Universal Adaptive Compression',
  lang: '中文',
  tier: 'Tier',
  tierFast: 'Fast',
  tierBalanced: 'Balanced',
  tierMax: 'Max',
  tierHint: 'Max matches the published benchmark numbers; Fast trades a few percent of size for a large speed-up.',
  inputTitle: 'Input · everything is binary',
  dropHere: 'Drop one or more files here',
  pickFiles: 'Choose files & compress',
  restoreUcz: 'Restore .ucz',
  limits: max => `Up to 256 MiB per file (${max}). Files are read only when their turn starts; large inputs can hold hundreds of MiB of model state, so low-memory devices should keep concurrency at 1.`,
  concurrency: 'Concurrency',
  conc1: '1 file · low memory',
  concN: n => (n <= 8 ? `${n} files · parallel` : n <= 16 ? `${n} files · multi-core` : `${n} files · high memory`),
  sizeUnit: 'Size unit',
  unitBytes: 'Exact bytes (B)',
  unitAuto: 'Auto unit',
  cancelled: 'Cancelled.',
  waitBusy: 'Wait for the restore or benchmark task to finish.',
  cancel: 'Cancel',
  details: 'File details',
  rawSize: 'Raw size',
  compressedSize: 'Adaptive output',
  verified: 'Lossless check',
  verifiedOk: 'byte-identical ✓',
  verifiedBad: 'mismatch ✗',
  decodeMs: 'independent decode',
  encodeMs: 'Encode time',
  regions: 'regions',
  blocks: 'blocks',
  container: 'Container',
  throughput: 'Throughput',
  modelFlags: 'Model flags',
  segmentsTitle: '② Segments · one rule per patch of terrain',
  segmentsSub: 'The band below is laid out by byte offset; colour = the rule the system picked for that region. Click a region to focus it in every view.',
  truthTitle: 'Ground truth of this demo (the analyser did not see it):',
  terrainTitle: '③ Hilbert fold (1-D → 2-D)',
  terrainSub: 'A Hilbert curve folds the byte stream into a square so neighbouring offsets stay neighbours. Colour = rule, height = entropy or compressed cost.',
  heightEntropy: 'height = raw entropy',
  heightCost: 'height = compressed bit/byte',
  isoTitle: 'Isometric 3-D terrain',
  isoSub: 'The same map lifted into 3-D: peaks are high-entropy, basins are regular and predictable.',
  digramTitle: 'Neighbour-byte plane',
  digramSub: 'x = byte i, y = byte i+1. Correlations invisible in one dimension become clusters here.',
  residualTitle: '④ Residual microscope · H(xᵢ | x₍ᵢ₎)',
  contextLabel: 'Context',
  residualStats: (bins, block, mean, min, max) => `${bins} × ${block} B · mean ${mean} · min ${min} · max ${max} bit/B`,
  anomalyKind: { 'cold-start': 'cold start', 'entropy-spike': 'entropy spike', 'regime-shift': 'regime shift' },
  residualSub: 'Prequential predictive code cost per 512-byte bin: the first 64 KiB are encoded with one continuous causal model, so every bar only depends on the bytes before it. High bars are where the model pays the most.',
  inspect: 'Inspect residual profile',
  inspecting: 'Measuring…',
  manifold: 'Manifold',
  stride: 'Record stride',
  scanPeriod: 'Scan period',
  flags: 'Flags',
  anomalies: 'Anomalies',
  noAnomalies: 'none detected',
  processTitle: '⑤ Process & shared terrain',
  processSub: 'Block scan, rule search and shared models. Sizes are real container bytes; trial encodes are sampled.',
  stage1: 'terrain scan',
  stage2: 'rule selection',
  stage3: 'shared model & framing',
  expandGroups: 'Per-rule aggregation and bitmap size',
  expandLog: 'Stage log (max 200 lines)',
  tableTitle: '⑥ Per-region decisions',
  tableSub: 'Terrain class narrows the candidate rules; the system really trial-encodes each candidate and keeps the smallest (storing raw when nothing wins).',
  range: 'Range',
  terrain: 'Terrain',
  rule: 'Rule',
  bpb: 'bit/byte',
  prev: 'Previous',
  next: 'Next',
  page: (a, b, n) => `page ${a} / ${b} · ${n} regions`,
  trials: 'Trial encodes (sampled windows; merged regions show the first part):',
  benchTitle: '⑦ Measured against fixed algorithms',
  benchSub: 'Same input including format framing. Numbers are measured on this machine with the same build.',
  benchRun: 'Run external comparison',
  benchRunning: 'Measuring (high levels can be slow)…',
  benchHint: 'Optional: zstd 3/19, brotli 5, xz/LZMA2 6, bzip2 9, zpaq m1. The current input is sent to the comparison service only when you click.',
  downloadUcz: 'Download .ucz',
  downloadRestored: 'Decompress & download',
  containerOverhead: 'Container overhead includes magic, rule dictionary, region lengths and the collapsed bitmap.',
  ncdTitle: 'Information distance (UCZ-NCD)',
  ncdSub: 'Compression-based similarity between the loaded files. 0 = identical structure, 1 = unrelated.',
  ncdRun: n => `Compute NCD matrix (${n} files)`,
  ncdRunning: 'Computing…',
  ncdNearest: 'Nearest neighbour',
  ncdNote: 'Each file contributes one 32 KiB window; distances are symmetric conditional costs, not byte diffs.',
  singleCmSkipped: 'Single-CM comparison skipped.',
  working: 'Working…',
}

const zh: Dict = {
  ...en,
  tagline: '通用自适应压缩',
  lang: 'EN',
  tier: '档位',
  tierFast: '快速',
  tierBalanced: '均衡',
  tierMax: '极限',
  tierHint: '极限档与公开跑分一致；快速档用几个百分点的体积换取大幅提速。',
  inputTitle: '① 输入：一切皆二进制',
  dropHere: '把一个或多个文件拖到这里',
  pickFiles: '选择多个文件并压缩',
  restoreUcz: '还原 .ucz 文件',
  limits: max => `每个文件最多 256 MiB（${max}）。文件在轮到时才读取；大文件模型可能占用数百 MiB 内存，低内存设备建议并发设为 1。`,
  concurrency: '同时处理',
  conc1: '1 个文件 · 节省内存',
  concN: n => (n <= 8 ? `${n} 个文件 · 并行压缩` : n <= 16 ? `${n} 个文件 · 多核并行` : `${n} 个文件 · 高并发（内存占用高）`),
  sizeUnit: '大小显示',
  unitBytes: '完整字节（B）',
  unitAuto: '自动单位',
  cancelled: '已取消。',
  waitBusy: '请等待还原或外部对照任务完成。',
  cancel: '取消',
  details: '文件详情',
  rawSize: '原始大小',
  compressedSize: '自适应压缩后',
  verified: '无损校验',
  verifiedOk: '逐字节一致 ✓',
  verifiedBad: '校验失败 ✗',
  decodeMs: '独立解码',
  encodeMs: '压缩耗时',
  regions: '个区域',
  blocks: '块',
  container: '容器格式',
  throughput: '压缩吞吐',
  modelFlags: '模型标志',
  segmentsTitle: '② 分区：每片地形一条规则',
  segmentsSub: '按字节偏移铺开；颜色 = 系统为该区域自动选定的压缩规则。点击区域可在所有图中聚焦。',
  truthTitle: '对照：这个演示文件的真实构成（系统分析时并不知道）：',
  terrainTitle: '③ 希尔伯特折叠地形图（一维 → 二维）',
  terrainSub: '希尔伯特曲线把字节流折成方阵，保证偏移相近的字节在图上也相邻。颜色 = 规则；高度 = 熵或压缩后代价。',
  heightEntropy: '高度 = 原始熵',
  heightCost: '高度 = 压缩后 bit/字节',
  isoTitle: '等距 3D 地形',
  isoSub: '同一张图抬升成立体地形：山峰 = 高熵，盆地 = 规则可预测。',
  digramTitle: '相邻字节对平面',
  digramSub: '横轴 = 第 i 个字节，纵轴 = 第 i+1 个字节。一维序列里看不出的相关性在这里成形。',
  residualTitle: '④ 残差显微镜 · H(xᵢ | x₍ᵢ₎)',
  contextLabel: '上下文',
  residualStats: (bins, block, mean, min, max) => `${bins} × ${block} B · 均值 ${mean} · 最小 ${min} · 最大 ${max} bit/B`,
  anomalyKind: { 'cold-start': '冷启动', 'entropy-spike': '熵尖峰', 'regime-shift': '分布切换' },
  residualSub: '每 512 字节的前序预测码代价：用单一因果模型编码前 64 KiB 实测，每根柱子只依赖它之前的字节。高柱即模型付出代价最大的地方。',
  inspect: '测量残差曲线',
  inspecting: '测量中…',
  manifold: '流形分类',
  stride: '记录步长',
  scanPeriod: '扫描周期',
  flags: '标志',
  anomalies: '异常高熵区',
  noAnomalies: '未检出',
  processTitle: '⑤ 处理过程与地形共享',
  processSub: '分块、规则试探到共享模型。大小为实际容器数据，候选试编码是采样值。',
  stage1: '地形扫描',
  stage2: '规则选择与合并',
  stage3: '共享模型与封装',
  expandGroups: '展开每个规则的聚合与位图统计',
  expandLog: '展开阶段日志（最多 200 条）',
  tableTitle: '⑥ 每个区域的自动决策',
  tableSub: '地形类型决定候选规则集；系统在采样上真实试编码，比较实际大小后选出最优者。',
  range: '范围',
  terrain: '识别的地形',
  rule: '选定的规则',
  bpb: 'bit/字节',
  prev: '上一页',
  next: '下一页',
  page: (a, b, n) => `第 ${a} / ${b} 页 · 共 ${n} 个区域`,
  trials: '候选规则试编码结果（采样窗口；合并区域显示首个原始区域）：',
  benchTitle: '⑦ 压缩算法实测对照',
  benchSub: '同一份输入、包含各格式封装开销。数值在本机用同一份构建测得。',
  benchRun: '运行外部对照测试',
  benchRunning: '正在实测（高等级可能较慢）…',
  benchHint: '可选：zstd 3/19、brotli 5、xz/LZMA2 6、bzip2 9、zpaq m1。点击后才会把当前输入发送到对照服务。',
  downloadUcz: '下载 .ucz 压缩文件',
  downloadRestored: '解压并下载还原文件',
  containerOverhead: '容器额外开销包含魔数、规则字典、区域长度与坍缩位图。',
  ncdTitle: '文件信息距离（UCZ-NCD）',
  ncdSub: '已加载文件之间的压缩相似度：0 = 结构相同，1 = 毫不相关。',
  ncdRun: n => `计算信息距离矩阵（${n} 个文件）`,
  ncdRunning: '计算中…',
  ncdNearest: '最近邻',
  ncdNote: '每个文件取 32 KiB 窗口；距离是对称条件代价，不是逐字节比较。',
  singleCmSkipped: '已跳过 Single CM 对照。',
  working: '处理中…',
}

export const DICT: Record<Lang, Dict> = { en, zh }
