/**
 * P31.0：库入口。
 *
 * 只做再导出 —— 压缩/解压行为完全由 `src/lib/codec.ts` 决定，
 * 这里不引入任何新语义。
 */
export { VERSION } from './version'
export { compressAdaptive, decompress, type CompressionLevel } from './lib/codec'
export type { Compressed } from './lib/codec'
export {
  fingerprintStream, formatInspectionReport, inspectContainer, inspectStream, isContainer, transformName,
  type ContainerAnatomy, type DelimiterCensus, type ManifoldClass, type ManifoldFingerprint,
  type SegmentAnatomy, type StreamInspection,
} from './lib/inspect'
export {
  computeNCD, computeNCDMatrix, formatNCDMatrixReport,
  type NCDMatrixResult, type NcdMode, type NcdOptions, type NcdPairResult,
} from './lib/ncd'
