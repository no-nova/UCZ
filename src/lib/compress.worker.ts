/// <reference lib="webworker" />
import { compressAdaptive, decompress, singleModelSize, streamSize, type CompressionLevel } from './codec'
import { shouldRunSingleCM } from './limits'

const ctx = self as unknown as DedicatedWorkerGlobalScope
// 长任务（mozilla 量级要 15 分钟以上）没有取消通道的话，用户只能关标签页。
// 取消时立刻回一条 aborted，主线程据此结束等待并终止本 worker。
let cancelled = false
ctx.onmessage = async (event: MessageEvent<{ type: 'run' | 'restore' | 'cancel'; data?: Uint8Array; skipSingleCM?: boolean; level?: CompressionLevel }>) => {
  if (event.data.type === 'cancel') {
    cancelled = true
    return
  }
  try {
    const data = event.data.data
    if (!data) throw new Error('缺少输入数据')
    if (event.data.type === 'restore') {
      const restored = decompress(data, (done, total) => {
        if (cancelled) return
        ctx.postMessage({ type: 'progress', msg: `后台解压中… ${Math.floor(done / Math.max(1, total) * 100)}%`, pct: 100 * done / Math.max(1, total) })
      })
      if (cancelled) { ctx.postMessage({ type: 'aborted' }); return }
      ctx.postMessage({ type: 'restored', data: restored }, [restored.buffer as ArrayBuffer])
      return
    }
    const t0 = performance.now()
    let lastProgress = 0
    const comp = await compressAdaptive(data, (msg, pct) => {
      if (cancelled) return
      const now = performance.now()
      if (now - lastProgress >= 100 || pct === 5 || pct === 15 || pct === 85) {
        lastProgress = now; ctx.postMessage({ type: 'progress', msg, pct })
      }
    }, event.data.level ? { level: event.data.level } : undefined)
    if (cancelled) { ctx.postMessage({ type: 'aborted' }); return }
    const tComp = performance.now() - t0
    ctx.postMessage({ type: 'progress', msg: '独立解码 + 逐字节比对，验证无损…', pct: 88 })
    const t1 = performance.now()
    let verified = false
    try {
      const back = decompress(comp.container, (done, total) => {
        if (cancelled) return
        ctx.postMessage({ type: 'progress', msg: `解码校验中… ${Math.floor(done / Math.max(1, total) * 100)}%`, pct: 88 + 4 * done / Math.max(1, total) })
      })
      verified = back.length === data.length
      for (let i = 0; verified && i < data.length; i++) if (back[i] !== data[i]) verified = false
    } catch { verified = false }
    if (cancelled) { ctx.postMessage({ type: 'aborted' }); return }
    const tVer = performance.now() - t1
    ctx.postMessage({ type: 'progress', msg: '与固定单一算法对照…', pct: 94 })
    const gzip = await streamSize(data, 'gzip')
    const single = shouldRunSingleCM(data.length, event.data.skipSingleCM)
      ? singleModelSize(data, undefined, (done, total) => {
          if (cancelled) return
          ctx.postMessage({ type: 'progress', msg: `单一 CM 对照… ${Math.floor(done / Math.max(1, total) * 100)}%`, pct: 94 + 5 * done / Math.max(1, total) })
        })
      : null
    if (cancelled) { ctx.postMessage({ type: 'aborted' }); return }
    ctx.postMessage({ type: 'done', data, comp, verified, tComp, tVer, gzip, single },
      [data.buffer as ArrayBuffer, comp.container.buffer as ArrayBuffer, comp.blockCost.buffer as ArrayBuffer, comp.blockSeg.buffer as ArrayBuffer])
  } catch (error) { ctx.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }) }
}
