// 数据地形分析:把任意字节流切成块,提取多维特征,分类并聚合成区域

export type Cls = 'fill' | 'noise' | 'text' | 'smooth' | 'repeat' | 'binary'

export const CLS_NAME: Record<Cls, string> = {
  fill: '平原(常量填充)',
  noise: '沙漠(高熵噪声)',
  text: '森林(文本编码)',
  smooth: '缓坡(连续/渐变)',
  repeat: '梯田(重复结构)',
  binary: '丘陵(通用二进制)',
}

export const BLOCK = 512
export const STRIDES = [1, 2, 3, 4, 6, 8, 12, 16]

/**
 * P8 诊断开关（仅供 `scripts/diag/` 探针做 A/B；默认值 = 线上行为，一个字节都不变）。
 *
 * 存在的理由：`analyze` 把“512 网格分类 → 3 点多数滤波 → 短游程吸收”三步焊死在
 * 一个函数里，探针无法单独观测任何一步的贡献。这两个开关只影响标签平滑，
 * 不改特征提取，也不改 `refineFillSeams` / `cleanTinySeams`。
 */
export const analyzeTuning = {
  /** 3 点多数滤波（左右同标签则吞掉中间的单块孤岛）。 */
  majorityFilter: true,
  /** 短游程吸收的最小游程长度（块数）；2 块 = 1024 B。设 0 关闭吸收。 */
  minRunBlocks: 2,
}

export interface BlockFeat {
  start: number
  end: number
  h0: number // 零阶熵 bits/byte
  hd: number // 最佳步长差分后的熵
  bestS: number
  text: number // 合法 UTF-8/ASCII 文本占比
  rep: number // 4-gram 重复率
  uniq: number // 不同字节数 / 256
  hi: number // 高位字节占比
  zero: number // 零字节占比
  mad: number // 平均绝对差分
  cls: Cls
}

export interface Seg {
  start: number
  end: number
  cls: Cls
  b0: number // 起始块
  b1: number // 结束块(不含)
  bestS: number
}

export interface Analysis {
  blocks: BlockFeat[]
  segs: Seg[]
  pca: { x: number; y: number; block: number }[]
  features: string[]
}


function entropy(hist: Int32Array | Uint16Array, n: number): number {
  if (n <= 0) return 0
  const ln = Math.log2(n)
  let h = 0
  for (let i = 0; i < 256; i++) {
    const c = hist[i]
    if (c > 0) h -= (c / n) * (Math.log2(c) - ln)
  }
  return h
}

function textRatio(d: Uint8Array, a: number, b: number): number {
  let good = 0
  let i = a
  const cont = (k: number) => k < b && d[k] >= 0x80 && d[k] <= 0xbf
  while (i < b) {
    const c = d[i]
    if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13) {
      good++
      i++
    } else if (c >= 0xc2 && c <= 0xdf && cont(i + 1)) {
      good += 2
      i += 2
    } else if (c >= 0xe0 && c <= 0xef && cont(i + 1) && cont(i + 2)) {
      good += 3
      i += 3
    } else if (c >= 0xf0 && c <= 0xf4 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      good += 4
      i += 4
    } else i++
  }
  return good / Math.max(1, b - a)
}

export function analyze(d: Uint8Array): Analysis {
  const n = d.length
  const nb = Math.max(1, Math.ceil(n / BLOCK))
  // 全局 4-gram 重复统计
  const repCount = new Int32Array(nb)
  const ht = new Int32Array(1 << 18).fill(-1)
  for (let i = 3; i < n; i++) {
    let h = Math.imul(d[i - 3] | (d[i - 2] << 8) | (d[i - 1] << 16) | (d[i] << 24), 0x9e3779b1)
    h = h >>> 14
    const p = ht[h]
    if (p >= 3 && i - p <= 65536 && d[p] === d[i] && d[p - 1] === d[i - 1] && d[p - 2] === d[i - 2] && d[p - 3] === d[i - 3])
      repCount[Math.floor(i / BLOCK)]++
    ht[h] = i
  }

  const blocks: BlockFeat[] = []
  const shortEntropies: number[] = []
  const hist = new Int32Array(256)
  const dh = new Int32Array(256)
  for (let bi = 0; bi < nb; bi++) {
    const a = bi * BLOCK
    const b = Math.min(n, a + BLOCK)
    const len = b - a
    hist.fill(0)
    for (let i = a; i < b; i++) {
      hist[d[i]]++
    }
    let uniqC = 0
    for (let i = 0; i < 256; i++) if (hist[i]) uniqC++
    const h0 = entropy(hist, len)
    let hd = 9
    let bestS = 1
    let rowHd = 9
    for (const s of [...STRIDES, 24, 32, 48, 64, 128, 256]) {
      if (len <= s + 8) continue
      dh.fill(0)
      let cnt = 0
      for (let i = Math.max(a, s); i < b; i++) {
        const v = (d[i] - d[i - s]) & 255
        dh[v]++
        cnt++
      }
      const e = entropy(dh, cnt)
      if (s > 16) { rowHd = Math.min(rowHd, e); continue }
      if (e < hd) {
        hd = e
        bestS = s
      }
    }
    if (hd === 9) hd = h0
    shortEntropies.push(hd)
    hd = Math.min(hd, rowHd)
    blocks.push({
      start: a,
      end: b,
      h0,
      hd,
      bestS,
      text: textRatio(d, a, b),
      rep: len > 4 ? Math.min(1, repCount[bi] / (len - 3)) : 0,
      uniq: uniqC / 256,
      hi: 0,
      zero: 0,
      mad: 0,
      cls: 'binary',
    })
  }

  // 初步分类
  for (let i = 0; i < nb; i++) {
    const f = blocks[i]
    const len = f.end - f.start
    let c: Cls
    if (f.uniq * 256 <= 1) c = 'fill'
    else if (len < BLOCK / 2 && i > 0) c = blocks[i - 1].cls
    else if (f.text > 0.93 && f.h0 < 7.0 && (shortEntropies[i] > f.h0 - 0.5 || f.text > 0.97)) c = 'text'
    else if (f.hd < f.h0 - 0.7 && f.hd < 6.3) c = 'smooth'
    else if (f.rep > 0.6) c = 'repeat'
    else if (f.h0 > 7.3 || (len < BLOCK && f.h0 > Math.log2(len) - 0.35)) c = 'noise'
    else c = 'binary'
    f.cls = c
  }

  // 多数滤波去抖
  const labels = blocks.map((f) => f.cls)
  const sm = labels.slice()
  if (analyzeTuning.majorityFilter) {
    for (let i = 1; i < nb - 1; i++) {
      if (labels[i - 1] === labels[i + 1] && labels[i] !== labels[i - 1]) sm[i] = labels[i - 1]
    }
  }
  // 同样按最左短区优先合并，但使用链表和最小堆，避免反复重扫所有块。
  if (analyzeTuning.minRunBlocks > 0) mergeShortRuns(sm, analyzeTuning.minRunBlocks)
  const segs: Seg[] = []
  for (let i = 0; i < nb; i++) {
    blocks[i].cls = sm[i]
    const last = segs[segs.length - 1]
    if (last && last.cls === sm[i]) {
      last.b1 = i + 1
      last.end = blocks[i].end
    } else segs.push({ start: blocks[i].start, end: blocks[i].end, cls: sm[i], b0: i, b1: i + 1, bestS: 1 })
  }
  for (const sg of segs) {
    const votes = new Map<number, number>()
    for (let i = sg.b0; i < sg.b1; i++) votes.set(blocks[i].bestS, (votes.get(blocks[i].bestS) || 0) + 1)
    let bv = 1
    let bc = -1
    for (const [k, v] of votes) if (v > bc) ((bc = v), (bv = k))
    sg.bestS = bv
  }
  if (n === 0) segs.length = 0
  const refined = cleanTinySeams(d, refineFillSeams(d, segs))
  return { blocks, segs: refined, pca: [], features: FEATURE_NAMES }
}

// Refine only regions classified as fill. Long constant runs are extended across
// block boundaries; nonconstant edge bytes remain with neighboring terrain.
export function refineFillSeams(d: Uint8Array, segs: Seg[], minRun = 64): Seg[] {
  const intervals: {start:number; end:number; value:number}[] = []
  for (const sg of segs) {
    if (sg.cls !== 'fill') continue
    let i = sg.start
    while (i < sg.end) {
      let end = i + 1
      while (end < sg.end && d[end] === d[i]) end++
      let start = i, finish = end
      if (start === sg.start) while (start > 0 && d[start - 1] === d[i]) start--
      if (finish === sg.end) while (finish < d.length && d[finish] === d[i]) finish++
      if (finish - start >= minRun) intervals.push({start, end:finish, value:d[i]})
      i = end
    }
  }
  intervals.sort((a,b) => a.start - b.start)
  const runs: typeof intervals = []
  for (const run of intervals) {
    const last = runs[runs.length - 1]
    if (last && run.start <= last.end && run.value === last.value) last.end = Math.max(last.end, run.end)
    else runs.push({...run})
  }
  const out: Seg[] = []
  const append = (start:number, end:number, cls:Cls, bestS:number) => {
    if (end <= start) return
    const last = out[out.length - 1]
    if (last && last.end === start && last.cls === cls && last.bestS === bestS && (cls !== 'fill' || d[last.start] === d[start])) {
      last.end = end; last.b1 = Math.ceil(end / BLOCK)
    } else out.push({start, end, cls, bestS, b0:Math.floor(start / BLOCK), b1:Math.ceil(end / BLOCK)})
  }
  let ri = 0
  for (let si = 0; si < segs.length; si++) {
    const sg = segs[si]
    let pos = sg.start
    while (pos < sg.end) {
      while (ri < runs.length && runs[ri].end <= pos) ri++
      const run = runs[ri]
      if (run && run.start <= pos && pos < run.end) {
        const end = Math.min(sg.end, run.end)
        append(pos, end, 'fill', 1); pos = end
      } else {
        const end = Math.min(sg.end, run ? run.start : sg.end)
        let cls = sg.cls, bestS = sg.bestS
        if (cls === 'fill') {
          const before = run && run.start < sg.end
          const neighbor = (before ? segs[si - 1] : segs[si + 1]) ?? (before ? segs[si + 1] : segs[si - 1])
          cls = neighbor && neighbor.cls !== 'fill' ? neighbor.cls : 'binary'
          bestS = neighbor && neighbor.cls !== 'fill' ? neighbor.bestS : 1
        }
        append(pos, end, cls, bestS); pos = end
      }
    }
  }
  return out
}

// Avoid a separate tiny edge fragment where a neighboring non-fill segment can
// absorb it. Between two fills compare a bounded, exact RLE payload estimate
// with a conservative estimate of the split representation and its metadata.
export function cleanTinySeams(d: Uint8Array, input: Seg[]): Seg[] {
  const segs = input.map(s => ({...s}))
  const varlen = (n:number) => { let k=1; while (n >= 128) { n=Math.floor(n/128); k++ } return k }
  for (let i=0; i<segs.length; i++) {
    const mid=segs[i]
    if (mid.cls === 'fill' || mid.end-mid.start >= 16) continue
    const left=segs[i-1], right=segs[i+1]
    if (left && left.cls !== 'fill') {
      left.end=mid.end; left.b1=Math.ceil(left.end/BLOCK); segs.splice(i,1); i--; continue
    }
    if (right && right.cls !== 'fill') {
      right.start=mid.start; right.b0=Math.floor(right.start/BLOCK); segs.splice(i,1); i--; continue
    }
    if (!left || !right || left.cls !== 'fill' || right.cls !== 'fill' || right.end-left.start > 32768) continue
    let rle=0, p=left.start
    while (p<right.end) { let end=p+1; while (end<right.end && d[end]===d[p]) end++; rle+=1+varlen(end-p); p=end }
    const split=2+(mid.end-mid.start)+varlen(left.end-left.start)+varlen(mid.end-mid.start)+varlen(right.end-right.start)
    // Bitmap/rule dictionary costs are shared globally; this is a bounded
    // heuristic, not a claim that every individual replacement saves bytes.
    const merged=rle+varlen(right.end-left.start)
    if (merged <= split + 6) {
      segs.splice(i-1,3,{start:left.start,end:right.end,cls:'repeat',bestS:1,b0:left.b0,b1:right.b1})
      i=Math.max(-1,i-2)
    }
  }
  return segs
}

// Equivalent to repeatedly merging the leftmost short run; O(nb + runs log runs).
export function mergeShortRuns(labels: Cls[], minBlocks: number): void {
  type Run = { start: number; end: number; cls: Cls; prev: Run | null; next: Run | null; alive: boolean }
  let first: Run | null = null, last: Run | null = null, count = 0
  for (let i = 0; i < labels.length; i++) {
    if (last && last.cls === labels[i]) last.end = i + 1
    else {
      const run: Run = {start:i, end:i+1, cls:labels[i], prev:last, next:null, alive:true}
      if (last) last.next = run; else first = run
      last = run; count++
    }
  }
  type Entry = { start: number; run: Run }
  const heap: Entry[] = []
  const push = (run: Run) => {
    if (!run.alive || run.end - run.start >= minBlocks) return
    const item = {start:run.start, run}; let i = heap.length; heap.push(item)
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p].start <= item.start) break; heap[i] = heap[p]; i = p }
    heap[i] = item
  }
  const pop = (): Entry | undefined => {
    const root = heap[0], tail = heap.pop()
    if (!tail || !heap.length) return root
    let i = 0
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1
      if (child + 1 < heap.length && heap[child + 1].start < heap[child].start) child++
      if (heap[child].start >= tail.start) break
      heap[i] = heap[child]; i = child
    }
    heap[i] = tail
    return root
  }
  for (let r = first; r; r = r.next) push(r)
  while (count > 1 && heap.length) {
    const entry = pop()!, r = entry.run
    if (!r.alive || entry.start !== r.start || r.end - r.start >= minBlocks) continue
    const left = r.prev, right = r.next
    const takeLeft = !right || (!!left && left.end - left.start >= right.end - right.start)
    let merged: Run
    if (takeLeft && left) {
      left.end = r.end; left.next = right
      if (right) right.prev = left
      r.alive = false; count--; merged = left
      if (right && right.cls === left.cls) {
        left.end = right.end; left.next = right.next
        if (right.next) right.next.prev = left
        right.alive = false; count--
      }
    } else if (right) {
      right.start = r.start; right.prev = left
      if (left) left.next = right; else first = right
      r.alive = false; count--; merged = right
      if (left && left.cls === right.cls) {
        left.end = right.end; left.next = right.next
        if (right.next) right.next.prev = left
        right.alive = false; count--; merged = left
      }
    } else break
    push(merged)
  }
  for (let r = first; r; r = r.next) labels.fill(r.cls, r.start, r.end)
}

const FEATURE_NAMES = ['零阶熵', '差分熵', '文本率', '重复率', '字节多样性', '高位占比', '零字节占比', '平均差分']


// Sampled region-level fixed-record detection, including every stride 2..64.
// Compare equality at each lag to the shuffled-byte baseline; prefer the smallest
// near-best period over its harmonics. No filename/format assumptions are made.
export function detectRecordStride(d: Uint8Array): number {
  // Score each contiguous window independently. No artificial joins are
  // compared, so every stride 2..64 keeps its phase, including 20 and 28.
  const size = d.length <= 8064 ? Math.min(d.length, 4096) : 2688
  if (size < 1024) return 0
  const starts = d.length <= 8064 ? [0] : [0, Math.floor((d.length-size)/2), d.length-size]
  const hist = new Uint32Array(256)
  for (const start of starts) for (let i = start; i < start + size; i++) hist[d[i]]++
  const n = size * starts.length
  let baseline = 0
  for (const c of hist) baseline += (c / n) ** 2
  const scores = new Float64Array(65)
  let best = 0
  for (let s = 2; s <= 64 && s * 12 <= size; s++) {
    let equal = 0
    for (const start of starts) for (let i = start+s; i < start+size; i++) if (d[i] === d[i - s]) equal++
    scores[s] = equal / ((size - s) * starts.length)
    if (scores[s] > best) best = scores[s]
  }
  if (best < baseline + 0.04 || best < baseline * 1.35) return 0
  for (let s = 2; s <= 64; s++) if (scores[s] >= best * 0.97 && scores[s] >= baseline + 0.04) return s
  return 0
}

// 检测行跨度：仅比较与像素跨度 s 对齐的滞后，选局部山谷。
// 可识别短行；无显著谷底时返回 0，不保证候选一定优于 DELTA。
export function detectLag(d: Uint8Array, s: number): number {
  if (!Number.isInteger(s) || s < 1) return 0
  const n = d.length, lmax = Math.min(4096, Math.floor(n / 4))
  if (lmax < 4 * s) return 0
  const start = lmax, step = Math.max(1, Math.floor((n - start) / 2500)) | 1
  const count = Math.floor(lmax / s)
  const cost = new Float64Array(count + 1)
  for (let k = 1; k <= count; k++) {
    const lag = k * s
    let c = 0
    for (let i = start; i < n; i += step) c += Math.abs(d[i] - d[i - lag])
    cost[k] = c + 1
  }
  // 归一化以容忍随距离增长的水平差异；局部凹陷须比两侧均低。
  const ref = Math.min(8, count)
  const alpha = Math.min(0.8, Math.max(0, Math.log(cost[ref] / cost[1]) / Math.log(ref)))
  let best = 0, bestScore = Infinity
  for (let k = 3; k < count; k++) {
    const valley = cost[k]
    if (valley >= cost[k - 1] * 0.995 || valley >= cost[k + 1] * 0.995) continue
    // 比较两侧局部邻域均值，排除随机波动的浅谷；边缘使用可用窗口。
    const window = Math.min(3, k - 1, count - k)
    let left = 0, right = 0
    for (let j = 1; j <= window; j++) { left += cost[k - j]; right += cost[k + j] }
    const local = Math.min(left, right) / window
    if (valley >= local * 0.97) continue
    const base = cost[ref] * Math.pow(k / ref, alpha)
    const score = valley / base
    const irregular = k % 8 !== 0 && k % 10 !== 0 && k % 12 !== 0
    if (k < 16 ? score < bestScore : irregular ? score < 0.72 && score < bestScore * 0.85 : score < 0.9 && score < bestScore) {
      bestScore = score; best = k * s
    }
  }
  return best
}

// Probe spatially separated windows; return at most two valleys that recur in
// independent windows. Short regions retain a single bounded probe.
export function detectLagCandidates(d: Uint8Array, s: number): number[] {
  if (!Number.isInteger(s) || s < 1 || d.length < 4 * s) return []
  const size = Math.min(d.length, 16000)
  const counts = new Map<number, number>()
  const add = (lag: number) => { if (lag > 0) counts.set(lag, (counts.get(lag) ?? 0) + 1) }
  if (d.length <= size * 2) {
    add(detectLag(d, s))
  } else {
    for (const fraction of [0.2, 0.5, 0.8]) {
      const start = Math.floor(((d.length - size) * fraction) / s) * s
      add(detectLag(d.subarray(start, start + size), s))
    }
    // A full-region aggregate is not an independent spatial observation.
    // Require the same exact valley in at least two separated windows.
    for (const [lag, votes] of counts) if (votes < 2) counts.delete(lag)
  }
  return [...counts].sort((a,b) => b[1] - a[1] || a[0] - b[0]).slice(0, 2).map(([lag]) => lag)
}

// Discover syntax anchors on a representative contiguous sample. This is only
// a candidate gate; independent real encoding determines whether they win.
export function detectAnchors(seg: Uint8Array, cls: Cls): {s:number; r:number}[] {
  const n=Math.min(seg.length,40000), start=Math.floor((seg.length-n)/2)
  const sub=seg.subarray(start,start+n)
  if(n<512) return []
  const freq=new Int32Array(256)
  for(const b of sub) freq[b]++
  const mode=cls==='text'?0:128, out:{s:number;r:number}[]=[]
  const lt=freq[60], gt=freq[62]
  if(lt >= (n >> 8) && lt <= (n >> 2) && gt >= lt*0.7 && gt <= lt*1.3) out.push({s:60,r:62|mode})
  const nl=freq[10]
  if(nl >= (n >> 8) && nl <= (n >> 3)) {
    let best=-1, bestScore=0
    for(const d of [9,44,59,58,124,61]) {
      if(freq[d]<nl*0.6) continue
      let lines=0, withD=0, cur=0, modeCount=0
      const hist=new Map<number,number>()
      for(const b of sub) {
        if(b===d) cur++
        else if(b===10) { lines++; if(cur) {withD++; const v=(hist.get(cur)??0)+1; hist.set(cur,v); modeCount=Math.max(modeCount,v)} cur=0 }
      }
      if(lines>=8 && withD>=lines*0.65) {
        const regularity=modeCount/withD, score=regularity*withD/lines
        if(regularity>=0.45 && score>bestScore) {bestScore=score;best=d}
      }
    }
    if(best!==-1) out.push({s:10,r:best|mode})
    if(nl>=16) out.push({s:10,r:8|mode})
  }
  const nul=freq[0]
  if(cls!=='text' && nul >= (n >> 7) && nul <= (n >> 3)) out.push({s:0,r:8|128})
  return out.slice(0,2)
}

// Probe 16-bit little-endian sample differences in separated 64 KiB windows.
// No format assumption is required: the lag and byte phase must recur, with a
// pronounced local valley. This is a candidate gate, not proof of an image.
export function detectWide16Lag(data: Uint8Array): number {
  const window = 65536, limit = 8192, step = 26
  if (data.length < window * 4) return 0
  const votes = new Map<number, number>()
  for (const fraction of [0.2, 0.5, 0.8]) {
    const start = Math.floor((data.length-window)*fraction/2)*2
    let phase=0, bestHorizontal=Infinity
    for (let p=0;p<2;p++) {
      let sum=0,count=0
      for(let i=start+limit+p;i<start+window-1;i+=step) {
        const a=data[i]|(data[i+1]<<8), b=data[i-2]|(data[i-1]<<8)
        sum+=Math.abs(a-b);count++
      }
      if(sum/count<bestHorizontal) {bestHorizontal=sum/count;phase=p}
    }
    if(bestHorizontal>10000) continue
    const costs=new Float64Array(limit/2+1)
    let best=Infinity, lag=0
    for(let k=128;k<=limit/2;k++) {
      const distance=2*k;let sum=0,count=0
      for(let i=start+limit+phase;i<start+window-1;i+=step) {
        const a=data[i]|(data[i+1]<<8), b=data[i-distance]|(data[i-distance+1]<<8)
        sum+=Math.abs(a-b);count++
      }
      costs[k]=sum/Math.max(1,count)
      if(costs[k]<best){best=costs[k];lag=distance}
    }
    const k=lag/2
    const neighbors:number[]=[]
    if(k-8>=128) neighbors.push(costs[k-8])
    if(k+8<=limit/2) neighbors.push(costs[k+8])
    if(!neighbors.length) continue
    const local=neighbors.reduce((a,b)=>a+b,0)/neighbors.length
    // Demand a deep local trough and vertical similarity; this rejects flat
    // or noisy signals and intentionally errs on the side of missing a width.
    if(best >= local*0.85 || best > bestHorizontal*4) continue
    votes.set(lag,(votes.get(lag)??0)+1)
  }
  const matches=[...votes].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]||a[0]-b[0])
  return matches[0]?.[0]??0
}
