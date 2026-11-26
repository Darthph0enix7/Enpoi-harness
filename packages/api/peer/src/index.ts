/**
 * Device-to-device peer API: the narrow serving namespace, the pairing store,
 * the derived execution latch, the ask registry, and the caller bridge.
 *
 * @module @deepseek-ai/dsh-api-peer
 */

export {
  DEFAULT_HARNESS_VERSION,
  PEER_METHODS_DIGEST,
  PEER_PROTOCOL_VERSION,
  PEER_SCHEMA_DIGEST,
  PeerService,
  currentPeerAuth,
  withPeerAuth,
  type AuthenticatedPeerContext,
  type Config,
  type PeerAuthContext,
} from './host.ts'
export {
  PEER_WIRE_DESCRIPTORS,
  WIRE_PROTOCOL_VERSION,
  computePeerMethodsDigest,
  computePeerSchemaDigest,
  type PeerWireFieldDescriptor,
  type PeerWireMethodDescriptor,
} from './wire-schema.ts'
export {
  DEFAULT_JOB_BINDINGS_PATH,
  canonicalCreateJobTuple,
  isValidCredentialRefName,
  jobUpdatePayloadHash,
  requireValidJobId,
  validateCreateJob,
  validateExpiryWindow,
  type JobValidationBounds,
  type PeerJobUpdateReceipt,
  type ValidatedCreateJob,
} from './job-bindings.ts'
export {
  DEFAULT_EXPORT_ROOT,
  checkExportRootAvailable,
  ensureSessionExportDir,
  fetchSessionExport,
  listSessionExports,
  sessionExportDirPath,
} from './export-root.ts'
export {
  DEFAULT_BINDINGS_PATH,
  DEFAULT_PAIRINGS_PATH,
  DEFAULT_WATCHDOG_MS,
  PeerConfigError,
  PeerPairingsStore,
  hashPairingToken,
  parseBearerAuthorization,
  parsePairingsDocument,
  verifyPairingToken,
  type LoadedPeerPairings,
  type PeerPairingsStoreOptions,
  type ResolvedPeerPairing,
} from './pairings.ts'
export { PeerAskRegistry } from './registry.ts'
export {
  DEFAULT_INPUT_RECEIPTS_PATH,
  DEFAULT_RECEIPTS_PATH,
  PeerInputReceiptStore,
  PeerReceiptStore,
  createPayloadHash,
  deterministicCreateSessionId,
  inputReceiptKey,
  promptPayloadHash,
  receiptKey,
  type FinalizePeerInputReceipt,
  type PeerInputReceipt,
  type PeerReceipt,
  type PreparePeerInputReceipt,
} from './receipts.ts'
export {
  derivePromptDisposition,
  type PeerPromptDispositionResult,
} from './disposition.ts'
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
