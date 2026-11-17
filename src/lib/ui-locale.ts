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
export function translateLabel(label: string): string {
  return label
    .replace(/步长/g, 'stride ')
    .replace(/声道/g, 'ch ')
    .replace(/记录/g, 'records')
    .replace(/文本/g, 'text')
    .replace(/残余/g, 'residual')
    .replace(/合并/g, 'merged')
    .replace(/预置/g, 'preset')
}

export function translateProgress(message: string): string {
  const msg = message.trim()
  let m = /^并行试探 (\d+) 个区域（(\d+) 线程）…$/.exec(msg)
  if (m) return `Parallel probing of ${m[1]} regions (${m[2]} threads)…`
  if (msg === '探测跨区域 16 位宽行结构…') return 'Probing a 16-bit wide-row structure across regions…'
  if (msg === '启动后台工作线程…') return 'Starting the background worker…'
  if (msg === '排队中…') return 'Queued…'
  if (msg === '读取中…') return 'Reading…'
  if (msg === '校验中…') return 'Verifying…'
  m = /^区域 (\d+)\/(\d+) · 试探 (.+)$/.exec(msg)
  if (m) return `Region ${m[1]}/${m[2]} · trying ${translateLabel(m[3])}`
  m = /^区域 (\d+)\/(\d+) → (.+)$/.exec(msg)
  if (m) return `Region ${m[1]}/${m[2]} → ${translateLabel(m[3])}`
  m = /^试探开始 (\d+) 区域 \/ (\d+) 线程$/.exec(msg)
  if (m) return `Probing ${m[1]} regions on ${m[2]} threads`
  return msg
}
