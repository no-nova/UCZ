export type SizeUnit = 'bytes' | 'auto'

const integers = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

// Actual byte counts remain integers, including at MiB/GiB boundaries.
export function formatBytes(bytes: number, unit: SizeUnit = 'bytes'): string {
  if (!Number.isFinite(bytes)) return '—'
  if (unit === 'bytes' || Math.abs(bytes) < 1024) return `${integers.format(bytes)} B`
  if (Math.abs(bytes) < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`
  if (Math.abs(bytes) < 1073741824) return `${(bytes / 1048576).toFixed(2)} MiB`
  return `${(bytes / 1073741824).toFixed(2)} GiB`
}
