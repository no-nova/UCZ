// P7-0：v1 容器 STORE 段长度校验的最小复现。
import { decompress } from '../../src/lib/codec'
const v1 = (rawLen: number, body: number[]) => Uint8Array.from([0x55, 0x43, 0x5a, 0x01, rawLen, 0x01, 0x00, rawLen, body.length, ...body])
console.log('ok  ', [...decompress(v1(4, [1, 2, 3, 4]))])
try { decompress(v1(4, [1, 2])); console.log('BAD: 没有报错') } catch (e) { console.log('throw', (e as Error).message) }
