/** Encoder-only metadata. Never infer container semantics from mutable knobs or
 * rejected trials. Wrappers inherit flags ONLY from the payloads they serialize.
 * Worker replies carry these numbers explicitly across structured cloning. */
const modelFlags = new WeakMap<object, number>()
export function payloadModelFlags(payload: object): number { return modelFlags.get(payload) ?? 0 }
export function markPayloadModel<T extends Uint8Array>(payload: T, flags: number): T {
  if (flags) modelFlags.set(payload, flags)
  else modelFlags.delete(payload)
  return payload
}
export function inheritPayloadModel<T extends Uint8Array>(payload: T, ...children: readonly Uint8Array[]): T {
  return markPayloadModel(payload, children.reduce((flags, child) => flags | payloadModelFlags(child), 0))
}
