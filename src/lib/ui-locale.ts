import type { Cls } from './analyze'

/** English labels for the terrain classes; `CLS_NAME` keeps the Chinese ones. */
export const CLS_LABEL_EN: Record<Cls, string> = {
  fill: 'Plain (constant)',
  noise: 'Desert (high entropy)',
  text: 'Forest (text)',
  smooth: 'Slope (smooth)',
  repeat: 'Terrace (repeat)',
  binary: 'Hills (generic binary)',
}

/** English sample names for the demo buttons (the descriptions were removed). */
export const SAMPLE_LABEL_EN: Record<string, string> = {
  mixed: 'Mixed multimodal file',
  text: 'Bilingual text',
  bmp: 'Synthetic image (BMP)',
  wav: 'Audio (WAV)',
  rec: 'Fixed-length records',
  noise: 'Random noise (control)',
}

/** Compact English names for the codec rules; `CODECS[id].name` holds the Chinese. */
export const CODEC_LABEL_EN: Record<number, string> = {
  0: 'Store raw',
  1: 'Constant fill',
  2: 'Run-length',
  3: 'Order-0 entropy',
  4: 'Text context mixing',
  5: 'Binary context mixing',
  6: 'Delta + residual',
  7: '2-D gradient',
  8: '16-bit linear prediction',
  9: 'Record transpose',
  10: 'Grouped record transpose',
  31: 'Wide-row 16-bit prediction',
  32: 'Two-lag recurrence residual',
  33: 'Bit planes',
  23: 'Word model (9 contexts)',
  24: 'Structural model (9 contexts)',
  25: 'BCJ + 9 contexts',
  26: 'Phase-isolated 2-D residual',
  27: 'Phase-isolated delta residual',
  28: 'Enhanced fixed-stride channels',
  29: 'Enhanced anchor channels',
  30: 'Enhanced grouped transpose',
  22: 'Reversed transpose + 2-D contexts',
  18: 'Word-level context mixing',
  19: 'Structural phase context mixing',
  20: 'Structural-phase BCJ',
  21: '2-D residual contexts',
  17: 'On-the-fly micro-seed predictor',
  15: 'Fixed-stride channel split',
  16: 'Anchor channel split',
  14: 'Recursive terrain peel',
  13: 'Self-delimited syntax anchor fold',
  12: 'Syntax anchor alignment',
  11: 'Relative jump transform',
}

/** English labels for the demo ground-truth regions (`samples.ts` keeps the Chinese). */
export const TRUTH_LABEL_EN: Record<string, string> = {
  'BMP 像素': 'BMP pixels',
  'XMP 文本(藏在图片里)': 'XMP text (hidden in the image)',
  '加密缩略图(噪声)': 'Encrypted thumbnail (noise)',
  'PCM 音频块': 'PCM audio block',
  '零填充': 'Zero padding',
  '重复纹理': 'Repeating texture',
  '日志文本': 'Log text',
}

/**
 * English rendering of a Chinese progress/stage string.
 *
 * The stage strings are produced deep inside the planner, where a translation table
 * would have to be threaded through every callback; instead the few message *shapes*
 * are recognised here, and anything unrecognised falls back to the raw text rather
 * than to a lie. Called only when the UI language is English.
 */
const TERRAIN_EN: Record<string, string> = {
  '缓坡(连续/渐变)': 'slope (smooth)',
  '森林(文本编码)': 'forest (text)',
  '沙漠(高熵噪声)': 'desert (noise)',
  '平原(常量填充)': 'plain (constant)',
  '梯田(重复结构)': 'terrace (repeat)',
}

export function translateLabel(label: string): string {
  const exact = TERRAIN_EN[label]
  if (exact) return exact
  let out = label
    .replace(/步长/g, 'stride ')
    .replace(/声道/g, 'ch ')
    .replace(/记录/g, 'records')
    .replace(/文本/g, 'text')
    .replace(/残余/g, 'residual')
    .replace(/合并/g, 'merged')
    .replace(/预置/g, 'preset')
  if (hasCjk(out)) {
    // 未知标签：只保留其中的 ASCII 结构（规则名、数字、步长），绝不把中文原样透传。
    out = out.replace(/[^\x20-\x7e]/g, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim()
    if (!out) out = 'candidate'
  }
  return out
}

export const PLANNER_STRINGS_EN: Record<string, string> = {
  '扫描数据地形…': 'Scanning the data terrain…',
  '为每个区域试探最合适的编码规则…': 'Probing the best coding rule for each region…',
  '探测跨区域 16 位宽行结构…': 'Probing a 16-bit wide-row structure across regions…',
  '启动后台工作线程…': 'Starting the background worker…',
  '低基数符号流：采样比较 8 位与低基数符号模型…': 'Low-cardinality stream: comparing 8-bit and symbol models…',
  '低基数符号流：整份文件单遍低基数符号编码…': 'Low-cardinality stream: single-pass symbol encoding…',
  '完整容器择优完成': 'Container selection finished',
  '原样存储': 'Stored raw',
  '常量填充': 'Constant fill',
  '游程编码': 'Run-length',
  '差分 + 残差': 'Delta + residual',
  '记录转置': 'Record transpose',
  '排队中…': 'Queued…',
  '读取中…': 'Reading…',
  '读取文件…': 'Reading the file…',
  '校验中…': 'Verifying…',
  '逐字节校验通过': 'Byte-verified',
  '已取消，未保留部分结果。': 'Cancelled (no partial result kept)',
}

/** True when the text still contains CJK — used to guarantee English mode never leaks it. */
function hasCjk(text: string): boolean { return /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(text) }

/**
 * English rendering of a planner/queue message.
 *
 * Exact literals come from `STAGE_EN`; the few parameterised shapes are recognised by
 * regex. Anything else that still contains CJK becomes a neutral English phrase: the
 * one thing English mode must never do is show Chinese, and the one thing it must not
 * do instead is invent a specific-but-wrong description.
 */
export function translateProgress(message: string): string {
  const msg = message.trim()
  const exact = PLANNER_STRINGS_EN[msg]
  if (exact) return exact
  let m = /^并行试探 (\d+) 个区域（(\d+) 线程）…$/.exec(msg)
  if (m) return `Parallel probing of ${m[1]} regions (${m[2]} threads)…`
  m = /^区域 (\d+)\/(\d+) · 试探 (.+)$/.exec(msg)
  if (m) return `Region ${m[1]}/${m[2]} · trying ${translateLabel(m[3])}`
  m = /^区域 (\d+)\/(\d+) → (.+)$/.exec(msg)
  if (m) return `Region ${m[1]}/${m[2]} → ${translateLabel(m[3])}`
  m = /^试探开始 (\d+) 区域 \/ (\d+) 线程$/.exec(msg)
  if (m) return `Probing ${m[1]} regions on ${m[2]} threads`
  if (hasCjk(msg)) return 'Working…'
  return msg
}

/** Failure messages: keep the raw text available for diagnosis, show English in the UI. */
export function translateError(message: string): string {
  const msg = message.trim()
  const exact = PLANNER_STRINGS_EN[msg]
  if (exact) return exact
  if (/不是有效的 UCZ 容器/.test(msg)) return 'Not a valid UCZ container'
  if (/容器内容校验失败/.test(msg)) return 'Container checksum mismatch (data corrupted)'
  if (/超过上限|超过该输出长度的预算/.test(msg)) return 'Output exceeds the configured limit'
  if (/内存预算/.test(msg)) return 'Memory budget exhausted'
  if (/截断/.test(msg)) return 'Container truncated'
  if (hasCjk(msg)) return 'Compression failed (see the browser console for the raw message)'
  return msg
}
