/**
 * Device-to-device peer API: the narrow serving namespace, the pairing store,
 * the derived execution latch, the ask registry, and the caller bridge.
 *
 * @module @deepseek-ai/dsh-api-peer
 */

export {
  DEFAULT_HARNESS_VERSION,
  PEER_PROTOCOL_VERSION,
  PEER_SCHEMA_DIGEST,
  PeerService,
  type Config,
} from './host.ts'
export {
  DEFAULT_BINDINGS_PATH,
  DEFAULT_PAIRINGS_PATH,
  DEFAULT_WATCHDOG_MS,
  PeerConfigError,
  PeerPairingsStore,
  parsePairingsDocument,
  type LoadedPeerPairings,
  type PeerPairingsStoreOptions,
  type ResolvedPeerPairing,
} from './pairings.ts'
export { PeerAskRegistry } from './registry.ts'
export {
  DEFAULT_RECEIPTS_PATH,
  PeerReceiptStore,
  receiptKey,
  type PeerReceipt,
} from './receipts.ts'
export {
  clampTokenCeiling,
  isRoutingPattern,
  matchesPattern,
  policyAllowsChain,
  policyAllowsModel,
} from './routing-policy.ts'
export {
  PeerLatchFold,
  foldExecutionState,
  isPeerParticipant,
  readHostLatch,
  type HostLatchFacts,
  type PeerFoldEvent,
} from './latch.ts'
export {
  MODEL_HOP_RECORD_TYPE,
  isDebugOnlyType,
  isExposedEvent,
  toPeerRecord,
  toPeerRecords,
} from './exposure.ts'
export {
  PeerClient,
  type PeerBackoff,
  type PeerClientOptions,
  type PeerWebSocket,
} from './client.ts'
export { HARNESS_VERSION } from './version.ts'
export type * from './types.ts'

export { PeerService as default } from './host.ts'
