// 确定性生成的演示样本

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const enc = new TextEncoder()
const text = (s: string) => enc.encode(s)

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const o = new Uint8Array(n)
  let w = 0
  for (const p of parts) {
    o.set(p, w)
    w += p.length
  }
  return o
}

function u32(v: number) {
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
}
function u16(v: number) {
  return [v & 255, (v >> 8) & 255]
}

function bmp(w: number, h: number, seed: number): Uint8Array {
  const rnd = rng(seed)
  const row = (w * 3 + 3) & ~3
  const size = 54 + row * h
  const hdr = [0x42, 0x4d, ...u32(size), 0, 0, 0, 0, ...u32(54), ...u32(40), ...u32(w), ...u32(h), ...u16(1), ...u16(24), ...u32(0), ...u32(row * h), ...u32(2835), ...u32(2835), ...u32(0), ...u32(0)]
  const px = new Uint8Array(row * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fy = y / h
      const wave = 14 * Math.sin((x + y * 0.7) / 9) + 9 * Math.sin((x * 0.5 - y) / 5)
      let r = 40 + 150 * (1 - fy) + wave
      let g = 90 + 120 * (1 - fy) + wave * 0.8
      let b = 160 + 90 * (1 - fy) + wave * 0.6
      const hill = h * 0.55 + Math.sin(x / 17) * 6 + Math.sin(x / 41) * 10
      if (y > h - hill) {
        const t = (y - (h - hill)) / h
        r = 30 + 60 * t + wave * 0.5
        g = 110 - 40 * t + wave * 0.6
        b = 50 + 20 * t + wave * 0.3
      }
      const dx = x - w * 0.72
      const dy = y - h * 0.22
      if (dx * dx + dy * dy < (h * 0.1) ** 2) {
        r = 250
        g = 220
        b = 120
      }
      const nz = rnd() < 0.3 ? Math.floor(rnd() * 3) - 1 : 0
      const o = y * row + x * 3
      px[o] = Math.max(0, Math.min(255, Math.round(b + nz)))
      px[o + 1] = Math.max(0, Math.min(255, Math.round(g + nz)))
      px[o + 2] = Math.max(0, Math.min(255, Math.round(r + nz)))
    }
  }
  return concat([Uint8Array.from(hdr), px])
}

function pcm(samples: number, seed: number, rate = 22050): Uint8Array {
  const rnd = rng(seed)
  const o = new Uint8Array(samples * 2)
  for (let i = 0; i < samples; i++) {
    const t = i / rate
    const env = 0.55 + 0.45 * Math.sin(t * 3)
    const v = Math.round(env * (9000 * Math.sin(2 * Math.PI * 220 * t) + 3500 * Math.sin(2 * Math.PI * 440 * t + 1) + 1200 * Math.sin(2 * Math.PI * 660 * t)) + (rnd() - 0.5) * 24)
    const u = v & 0xffff
    o[2 * i] = u & 255
    o[2 * i + 1] = u >> 8
  }
  return o
}

function wav(samples: number, seed: number): Uint8Array {
  const data = pcm(samples, seed)
  const hdr = [...text('RIFF'), ...u32(36 + data.length), ...text('WAVEfmt '), ...u32(16), ...u16(1), ...u16(1), ...u32(22050), ...u32(44100), ...u16(2), ...u16(16), ...text('data'), ...u32(data.length)]
  return concat([Uint8Array.from(hdr), data])
}

function noise(n: number, seed: number): Uint8Array {
  const r = rng(seed)
  const o = new Uint8Array(n)
  for (let i = 0; i < n; i++) o[i] = Math.floor(r() * 256)
  return o
}

function xmp(seed: number): Uint8Array {
  const r = rng(seed)
  let s = `<?xpacket begin='' id='W5M0MpCehiHzreSzNTczkc9d'?>\n<x:xmpmeta xmlns:x='adobe:ns:meta/'>\n<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>\n<rdf:Description xmlns:dc='http://purl.org/dc/elements/1.1/' xmlns:xmp='http://ns.adobe.com/xap/1.0/'>\n`
  s += `<dc:title>地形压缩实验 · 样张 · Terrain sample</dc:title>\n<dc:description>图片文件内部夹带的文本元数据:它不是像素,不该被当作像素处理。</dc:description>\n`
  for (let i = 0; i < 22; i++) {
    const id = Math.floor(r() * 1e8).toString(16)
    s += `<xmpMM:History action='saved' instanceID='xmp.iid:${id}' when='2026-01-${String(1 + (i % 28)).padStart(2, '0')}T${String(8 + (i % 12)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00+08:00' softwareAgent='UCZ 1.${i % 4}' changed='/metadata'/>\n`
  }
  s += `</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end='w'?>\n`
  return text(s)
}

function logText(lines: number, seed: number): Uint8Array {
  const r = rng(seed)
  const lv = ['INFO', 'INFO', 'INFO', 'WARN', 'DEBUG']
  const mod = ['scheduler', 'io.reader', 'cache', 'net.http']
  let s = ''
  for (let i = 0; i < lines; i++) {
    s += `2026-02-03 10:${String(Math.floor(i / 6) % 60).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')} [${lv[Math.floor(r() * lv.length)]}] ${mod[Math.floor(r() * mod.length)]}: request id=${Math.floor(r() * 99999)} took ${Math.floor(r() * 300)}ms status=${r() < 0.9 ? 200 : 503}\n`
  }
  return text(s)
}

function prose(): Uint8Array {
  const paras = [
    '最高的压缩率,就是让每一个种子都被用上,而不是有很多没有用的种子。',
    '一张 100×100 的黑白图片有 2^10000 种可能,但其中绝大多数都是毫无意义的雪花噪点。',
    '把压缩看成一次 AI 训练:中间的方法是黑盒,我们要找到一个黑盒,让输出尽可能贴近需要压缩的文件,最好 100% 还原。',
    'Language modeling is compression: a model predicts the next byte, and an arithmetic coder pays only -log2(p) bits for it.',
    '如果黑盒猜对了,就几乎不用花费比特;如果猜错了,就多花几个比特把它拽回正确的轨道,这就是无损的纠偏种子。',
    'Kolmogorov complexity is the length of the shortest program that outputs the data. It is not computable, so every real compressor is an approximation.',
    '统一成二进制之后,不同类型的数据在同一张地形图上显现出不同的纹理:平原、沙漠、森林、梯田。',
    '图片文件内部如果夹着文本编码的结构,系统应当识别出来,而不是因为它属于图片就整体按像素处理。',
  ]
  let s = ''
  for (let i = 0; i < 40; i++) {
    s += `第 ${i + 1} 节  ` + paras[i % paras.length] + (i % 3 === 0 ? ' ' + paras[(i * 5 + 3) % paras.length] : '') + '\n\n'
  }
  return text(s)
}

function records(count: number, seed: number): Uint8Array {
  const r = rng(seed)
  const o = new Uint8Array(count * 16)
  let ts = 1767225600
  for (let i = 0; i < count; i++) {
    ts += 60 + Math.floor(r() * 3)
    const temp = Math.round(2200 + 500 * Math.sin(i / 40) + r() * 6)
    const rec = [...u32(i + 1000), ...u32(ts), ...u16(temp), r() < 0.9 ? 1 : 2, 0, 0, 0, 0, 0]
    o.set(rec, i * 16)
  }
  return o
}

export interface TruthRegion {
  start: number
  end: number
  label: string
}
export interface Sample {
  key: string
  name: string
  desc: string
  make: () => { data: Uint8Array; truth?: TruthRegion[] }
}

export const SAMPLES: Sample[] = [
  {
    key: 'mixed',
    name: '多模态混合文件',
    desc: 'BMP 图片内部夹着 XMP 文本、加密噪声、PCM 音频、零填充、重复纹理与日志',
    make: () => {
      const parts: [string, Uint8Array][] = [
        ['BMP 像素', bmp(128, 96, 7)],
        ['XMP 文本(藏在图片里)', xmp(3)],
        ['加密缩略图(噪声)', noise(5000, 11)],
        ['PCM 音频块', pcm(7000, 5)],
        ['零填充', new Uint8Array(4096)],
        ['重复纹理', (() => {
          const tile = noise(48, 2)
          const o = new Uint8Array(4800)
          for (let i = 0; i < o.length; i++) o[i] = tile[i % 48] ^ (i % 480 === 0 ? 1 : 0)
          return o
        })()],
        ['日志文本', logText(30, 9)],
      ]
      const truth: TruthRegion[] = []
      let p = 0
      for (const [label, d] of parts) {
        truth.push({ start: p, end: p + d.length, label })
        p += d.length
      }
      return { data: concat(parts.map((x) => x[1])), truth }
    },
  },
  { key: 'text', name: '中英文文本', desc: '纯 UTF-8 文本,只有森林地貌', make: () => ({ data: prose() }) },
  { key: 'bmp', name: '合成图像 (BMP)', desc: '天空渐变 + 山丘 + 太阳 + 传感器噪声', make: () => ({ data: bmp(160, 120, 21) }) },
  { key: 'wav', name: '音频 (WAV)', desc: '16 位单声道 PCM,多个谐波叠加', make: () => ({ data: wav(20000, 8) }) },
  { key: 'rec', name: '定长记录表', desc: '16 字节/条的二进制记录:自增 ID、时间戳、传感器值', make: () => ({ data: records(1500, 4) }) },
  { key: 'noise', name: '随机噪声(对照)', desc: '真随机数据:理论上不可压缩,系统应当诚实地放弃', make: () => ({ data: noise(30000, 99) }) },
]
