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
