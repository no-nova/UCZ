// 主线程直跑：单文件 HTML（file:// 或受限 CSP）里 Blob Worker 可能无法启动，
// 此时不能让任务"失败/跳过"，而要在主线程把同样的活干完——产物与 Worker 完全一致。
import { compressAdaptive, decompress, singleModelSize, streamSize, type CompressionLevel } from '../lib/codec'
import { shouldRunSingleCM } from '../lib/limits'
import type { CompressionOutput, ProgressCallback } from './compression-queue'

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export async function runDirect(
  data: Uint8Array, signal: AbortSignal, progress: ProgressCallback, level?: CompressionLevel,
): Promise<CompressionOutput> {
  const t0 = now()
  let last = 0
  const comp = await compressAdaptive(data, (msg, pct) => {
    if (signal.aborted) return
    const t = now()
    if (t - last >= 100 || pct === 5 || pct === 15 || pct === 85) { last = t; progress(msg, pct) }
  }, level ? { level } : undefined)
  if (signal.aborted) throw new DOMException('已取消', 'AbortError')
  const tComp = now() - t0
  progress('独立解码 + 逐字节比对，验证无损…', 88)
  const t1 = now()
  let verified = false
  try {
    const back = decompress(comp.container)
    verified = back.length === data.length
    for (let i = 0; verified && i < data.length; i++) if (back[i] !== data[i]) verified = false
  } catch { verified = false }
  const tVer = now() - t1
  progress('与固定单一算法对照…', 94)
  const gzip = await streamSize(data, 'gzip')
  const single = shouldRunSingleCM(data.length)
    ? singleModelSize(data, undefined, (done, total) => {
        if (!signal.aborted) progress(`单一 CM 对照… ${Math.floor(done / Math.max(1, total) * 100)}%`, 94 + 5 * done / Math.max(1, total))
      })
    : null
  if (signal.aborted) throw new DOMException('已取消', 'AbortError')
  return { data, comp, verified, tComp, tVer, gzip, single }
}

export function restoreDirect(data: Uint8Array): Uint8Array {
  return decompress(data)
}
