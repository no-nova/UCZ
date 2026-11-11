import { markPayloadModel, payloadModelFlags } from './payload-model'

// Geometric byte buffer avoids the much larger JS number[] used for binary payloads.
export class ByteWriter {
  private data = new Uint8Array(1024)
  private length = 0
  private modelFlags = 0
  push(value: number) {
    if (this.length === this.data.length) {
      const next = new Uint8Array(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = value
  }
  append(bytes: Uint8Array) {
    this.modelFlags |= payloadModelFlags(bytes)
    const needed = this.length + bytes.length
    if (needed > this.data.length) {
      let size = this.data.length
      while (size < needed) size *= 2
      const next = new Uint8Array(size)
      next.set(this.data); this.data = next
    }
    this.data.set(bytes, this.length); this.length = needed
  }
  finish(): Uint8Array { return markPayloadModel(this.data.slice(0, this.length), this.modelFlags) }
}
