// Uploads and automatic reference-model runs use binary MiB throughout.
export const MAX_INPUT_BYTES = 256 * 1024 * 1024
export const MAX_SINGLE_CM_BYTES = 10 * 1024 * 1024
// Decompression allocates the full output buffer from a length in the container
// header, before any payload is validated. A tiny forged header could otherwise
// request an arbitrarily large allocation, so the claim is bounded here.
// This is deliberately larger than MAX_INPUT_BYTES so that streams produced on
// another device (or with a raised compression limit) still decode locally.
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024
// 并行编码时每个 worker 会各自实例化一套 CM 上下文表（单区域峰值约 72 MiB：
// 9 张 2^21 项的表 + 权重 + 匹配表）。上限 8 线程最多约 0.6 GiB，对 32 GB 机器
// 没问题，但小内存环境需要收窄——低于这个可用内存时按 4 线程封顶。
export const PARALLEL_MEMORY_FLOOR_MIB = 2048

export function shouldRunSingleCM(size: number, skipSingleCM = false): boolean {
  return !skipSingleCM && size <= MAX_SINGLE_CM_BYTES
}
