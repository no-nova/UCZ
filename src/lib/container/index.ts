/** Container-layer public surface (P37.9 module split, step 1).
 *
 * Everything here is independent of the compression model: byte layout, integrity
 * and limits. `codec.ts` keeps the orchestrator; new container code should land in
 * this directory so the 5k-line file stops growing.
 */
export { crc32c, crc32cUpdate, crcTrailer, readCrcTrailer } from './crc32c'
export {
  ID,
  CONTAINER_MAGIC,
  MAX_CONTAINER_VERSION,
  containerHasChecksum,
  containerHasFreshDistance,
  containerIsStrict,
} from './format'
