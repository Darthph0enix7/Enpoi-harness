/**
 * Pairing-file loading, strict validation, and created-session bindings.
 *
 * The pairing file (`~/.dsh/pairings.yaml`) is rendered by `dsh update` from
 * the profile fleet registry and only read here; a first-line
 * `# dsh-managed: false` marker hands the document back to the operator. A
 * malformed document fails loud at the first load instead of degrading to an
 * empty table. Created-session bindings live in a separate machine-written
 * document (`~/.dsh/peer-state.json`, 0600, atomic replacement).
 *
 * @module @deepseek-ai/dsh-api-peer/pairings
 */

import { readFileSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionId as sessionIdOf } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parse as parseYaml } from 'yaml'
import type {
  PeerAlias,
  PeerBinding,
  PeerBindingsFile,
  PeerCreateDefaults,
  PeerDeviceName,
  PeerExposure,
  PeerPairing,
  PeerPairingsFile,
  PeerRoutingPolicy,
  PeerTarget,
  PeerTargetResolved,
  RetiredPeerBinding,
} from './types.ts'
import { isRoutingPattern } from './routing-policy.ts'

/** Default watchdog before an orphaned peer turn is aborted (doc 69 §8). */
export const DEFAULT_WATCHDOG_MS = 15 * 60 * 1000

/** Default human-edited pairing document. */
export const DEFAULT_PAIRINGS_PATH = dshHomePath('pairings.yaml')

/** Default machine-written created-session binding document. */
export const DEFAULT_BINDINGS_PATH = dshHomePath('peer-state.json')

const EXPOSURES: readonly PeerExposure[] = ['answer-only', 'debug']
const ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/
const PRIVATE_MODE = 0o600
/** Distinct rejected-reload diagnostics one store reports before staying silent. */
const MAX_RELOAD_WARNINGS = 16
/** Longest rejection line a warning carries; parser detail stops at the first newline. */
const MAX_REJECTION_LINE = 300

/** A pairing document that cannot be trusted to describe this host's exposure. */
export class PeerConfigError extends Error {
  /** @param message - correction-oriented diagnostic naming the offending field. */
  constructor(message: string) {
    super(message)
    this.name = 'PeerConfigError'
  }
}

/** One resolved pairing plus the session it binds on this host. */
export interface ResolvedPeerPairing {
  readonly pairing: PeerPairing
  readonly sessionId: SessionId
  readonly exposure: PeerExposure
  readonly device: PeerDeviceName
}

/** Optional host wiring for {@link PeerPairingsStore}. */
export interface PeerPairingsStoreOptions {
  /**
   * Sink for one bounded warning per distinct rejected reload; the host passes
   * `ctx.logger.warn`. A rejected reload keeps the previous valid snapshot, so
   * without a sink the failure is silent. The message stops at the first
   * newline and is length-capped, so a YAML parser's code frame never reaches
   * the log.
   */
  readonly onConfigError?: (message: string) => void
}

/** Loaded pairing document plus its created-session bindings. */
export interface LoadedPeerPairings {
  readonly device: PeerDeviceName
  readonly watchdogMs: number
  readonly pairings: readonly PeerPairing[]
  readonly bindings: Readonly<Record<string, PeerBinding>>
}

/**
 * Read, validate, and cache the pairing and binding documents behind one host.
 * Validation runs on every reload; a change that breaks the schema throws and
 * keeps the previous valid snapshot in place until the file is corrected.
 */
export class PeerPairingsStore {
  /** Absolute pairing-file path; `dsh update` renders it from the profile fleet registry (`profile/web/scripts/generate-pairings.mjs`). */
  readonly pairingsPath: string
  /** Absolute created-session binding path owned exclusively by this module. */
  readonly bindingsPath: string

  private snapshot: LoadedPeerPairings | undefined
  private pairingStamp: { mtimeMs: number; size: number } | undefined
  private writeChain: Promise<void> = Promise.resolve()
  private readonly rejected = new Set<string>()

  /**
   * @param pairingsPath - pairing document path; defaults to `~/.dsh/pairings.yaml`.
   * @param bindingsPath - binding document path; defaults to `~/.dsh/peer-state.json`.
   * @param options - optional rejected-reload warning sink.
   */
  constructor(
    pairingsPath: string = dshHomePath('pairings.yaml'),
    bindingsPath: string = dshHomePath('peer-state.json'),
    private readonly options: PeerPairingsStoreOptions = {},
  ) {
    this.pairingsPath = pairingsPath
    this.bindingsPath = bindingsPath
  }

  /** Load the pairings, re-reading whenever the file's stamp changed. */
  load(): LoadedPeerPairings {
    const stamp = this.stampOf(this.pairingsPath)
    if (this.snapshot !== undefined
      && stamp !== undefined
      && this.pairingStamp !== undefined
      && stamp.mtimeMs === this.pairingStamp.mtimeMs
      && stamp.size === this.pairingStamp.size) {
      return this.snapshot
    }
    if (this.snapshot === undefined) return this.reload()
    if (stamp === undefined) {
      // The file disappeared after a valid load: exposure is withdrawn.
      return this.withdraw()
    }
    try {
      return this.reload()
    } catch (error) {
      if (error instanceof PeerConfigError) {
        this.reportRejected(error)
        return this.snapshot
      }
      throw error
    }
  }

  /**
   * Report one rejected reload once per distinct diagnostic, up to
   * {@link MAX_RELOAD_WARNINGS} distinct messages for this store's lifetime.
   * The previous valid snapshot stays active; failing loud belongs to the
   * first load, where no snapshot exists.
   * @param error - the validation failure that kept the previous snapshot.
   */
  private reportRejected(error: PeerConfigError): void {
    const line = error.message.split('\n', 1).join('').trim().slice(0, MAX_REJECTION_LINE)
    if (this.rejected.has(line) || this.rejected.size >= MAX_RELOAD_WARNINGS) return
    this.rejected.add(line)
    this.options.onConfigError?.(line)
  }

  /**
   * The last validated snapshot without re-reading the pairing file.
   *
   * The token-ceiling watcher runs on every committed Assistant message, so
   * its ceiling lookup must not stat the document. Bindings are machine-written
   * through {@link bind}, which republishes the snapshot; a caller that needs
   * the on-disk document calls {@link load}.
   * @returns the current snapshot, loading it when this store has not yet.
   */
  current(): LoadedPeerPairings {
    return this.snapshot ?? this.reload()
  }

  /** Reload unconditionally, publishing the new snapshot only when it validates. */
  reload(): LoadedPeerPairings {
    let raw: string
    try {
      raw = readFileSync(this.pairingsPath, 'utf8')
    } catch (error) {
      // An absent pairing file means no peers are configured; the host still
      // reports its own device name for the handshake.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.withdraw()
      throw error
    }
    const document = parsePairingsDocument(raw, this.pairingsPath)
    const bindings = this.readBindings()
    const snapshot: LoadedPeerPairings = {
      device: document.device,
      watchdogMs: document.watchdogMs ?? DEFAULT_WATCHDOG_MS,
      pairings: document.pairings,
      bindings,
    }
    this.snapshot = snapshot
    this.pairingStamp = this.stampOf(this.pairingsPath)
    return snapshot
  }

  /** The active device name (host name when no pairing document is present). */
  device(): PeerDeviceName {
    return this.load().device
  }

  /** Every pairing as the handshake reports it; never carries a token. */
  list(): readonly PeerPairing[] {
    return this.load().pairings
  }

  /**
   * Resolve one peer target to a concrete session.
   * @param target - alias or explicit session id from the wire request.
   * @returns the pairing, session, and exposure, or `undefined` when unpaired.
   */
  resolve(target: PeerTarget): ResolvedPeerPairing | undefined {
    const loaded = this.load()
    if (target.kind === 'alias') {
      const pairing = loaded.pairings.find(candidate => candidate.alias === target.alias)
      if (pairing === undefined) return undefined
      const sessionId = pairing.sessionId ?? loaded.bindings[target.alias]?.sessionId
      if (sessionId === undefined) return undefined
      return { pairing, sessionId, exposure: pairing.exposure, device: pairing.peer }
    }
    const direct = loaded.pairings.find(candidate => candidate.sessionId === target.sessionId)
    if (direct !== undefined) {
      return { pairing: direct, sessionId: target.sessionId, exposure: direct.exposure, device: direct.peer }
    }
    for (const [alias, binding] of Object.entries(loaded.bindings)) {
      if (binding.sessionId !== target.sessionId) continue
      const pairing = loaded.pairings.find(candidate => candidate.alias === alias)
      if (pairing === undefined) continue
      return { pairing, sessionId: target.sessionId, exposure: pairing.exposure, device: pairing.peer }
    }
    // A session this alias was bound to before a `peer.create` rebound it
    // stays addressable by explicit id: the pairing gate still applies, only
    // the alias resolution moved on.
    for (const [alias, binding] of Object.entries(loaded.bindings)) {
      if (binding.retired?.some(entry => entry.sessionId === target.sessionId) !== true) continue
      const pairing = loaded.pairings.find(candidate => candidate.alias === alias)
      if (pairing === undefined) continue
      return { pairing, sessionId: target.sessionId, exposure: pairing.exposure, device: pairing.peer }
    }
    // A shared pairing document may carry this host's session only in the
    // caller-role `remoteSessionId` pin (the same logical entry authored from
    // the other device's side). Resolving it to the pairing's own bound
    // session keeps a caller's pin addressable without granting an arbitrary
    // session id: the pin must be declared in this host's own file.
    for (const candidate of loaded.pairings) {
      if (candidate.remoteSessionId !== target.sessionId) continue
      const sessionId = candidate.sessionId ?? loaded.bindings[candidate.alias]?.sessionId
      if (sessionId === undefined) continue
      return { pairing: candidate, sessionId, exposure: candidate.exposure, device: candidate.peer }
    }
    return undefined
  }

  /** The pairing exposing one session, when the session is paired at all. */
  exposed(sessionId: SessionId): ResolvedPeerPairing | undefined {
    return this.resolve({ kind: 'session', sessionId })
  }

  /**
   * Persist one alias→session binding (atomic, 0600); a replaced binding moves
   * to `retired`. A supplied `maxTotalTokens` replaces the recorded ceiling;
   * re-adopting the same session without one keeps the earlier ceiling.
   * @param alias - pairing alias owning the binding.
   * @param device - peer device the alias names.
   * @param sessionId - session the alias now exposes.
   * @param options - create-time token ceiling, when the request or policy set one.
   */
  async bind(
    alias: PeerAlias,
    device: PeerDeviceName,
    sessionId: SessionId,
    options: { readonly maxTotalTokens?: number } = {},
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const current = this.readBindings()
      const previous = current[alias]
      const rebinding = previous === undefined || previous.sessionId === sessionId
      const retired: readonly RetiredPeerBinding[] | undefined = rebinding
        ? previous?.retired
        : [
          ...previous.retired ?? [],
          {
            sessionId: previous.sessionId,
            device: previous.device,
            createdAt: previous.createdAt,
            retiredAt: Date.now(),
            ...(previous.maxTotalTokens === undefined ? {} : { maxTotalTokens: previous.maxTotalTokens }),
          },
        ]
      const maxTotalTokens = options.maxTotalTokens ?? (rebinding ? previous?.maxTotalTokens : undefined)
      const bindings: Record<string, PeerBinding> = Object.assign({}, current)
      bindings[alias] = {
        sessionId,
        device,
        createdAt: Date.now(),
        ...(retired === undefined || retired.length === 0 ? {} : { retired }),
        ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
      }
      const next: PeerBindingsFile = { version: 1, bindings }
      await writeFileAtomic(this.bindingsPath, `${JSON.stringify(next, undefined, 2)}\n`, {
        mode: PRIVATE_MODE,
        dirMode: 0o700,
      })
      if (this.snapshot !== undefined) {
        this.snapshot = { ...this.snapshot, bindings: next.bindings }
      }
    }
    const chained = this.writeChain.then(run, run)
    this.writeChain = chained.catch(() => undefined)
    return chained
  }

  /**
   * The total-token ceiling recorded for one session, including a session a
   * later create retired from its alias.
   * @param sessionId - session to look up.
   * @returns the first recorded ceiling for that session, or `undefined`.
   */
  ceilingOf(sessionId: SessionId): number | undefined {
    for (const binding of Object.values(this.load().bindings)) {
      if (binding.sessionId === sessionId && binding.maxTotalTokens !== undefined) return binding.maxTotalTokens
      const retired = binding.retired?.find(entry => entry.sessionId === sessionId)
      if (retired?.maxTotalTokens !== undefined) return retired.maxTotalTokens
    }
    return undefined
  }

  /** The target summary a resolved pairing reports back to callers. */
  describe(resolved: ResolvedPeerPairing): PeerTargetResolved {
    return {
      device: resolved.device,
      sessionId: resolved.sessionId,
      exposure: resolved.exposure,
      alias: resolved.pairing.alias,
    }
  }

  private withdraw(): LoadedPeerPairings {
    const snapshot: LoadedPeerPairings = {
      device: this.snapshot?.device ?? hostname(),
      watchdogMs: this.snapshot?.watchdogMs ?? DEFAULT_WATCHDOG_MS,
      pairings: [],
      bindings: {},
    }
    this.snapshot = snapshot
    this.pairingStamp = undefined
    return snapshot
  }

  private readBindings(): Readonly<Record<string, PeerBinding>> {
    let raw: string
    try {
      raw = readFileSync(this.bindingsPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.bindings)) {
      throw new PeerConfigError(`peer bindings ${this.bindingsPath} must be {version: 1, bindings: {...}}`)
    }
    const bindings: Record<string, PeerBinding> = {}
    for (const [alias, value] of Object.entries(parsed.bindings)) {
      if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.device !== 'string'
        || typeof value.createdAt !== 'number') {
        throw new PeerConfigError(`peer binding ${JSON.stringify(alias)} must carry sessionId, device, and createdAt`)
      }
      const retired = readRetiredBindings(alias, value.retired)
      const maxTotalTokens = optionalPositiveInteger(value, 'maxTotalTokens', `peer binding ${JSON.stringify(alias)}`)
      bindings[alias] = {
        sessionId: sessionIdOf(value.sessionId),
        device: value.device,
        createdAt: value.createdAt,
        ...(retired === undefined ? {} : { retired }),
        ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
      }
    }
    return bindings
  }

  private stampOf(path: string): { mtimeMs: number; size: number } | undefined {
    try {
      const stat = statSync(path)
      return { mtimeMs: stat.mtimeMs, size: stat.size }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}

/**
 * Parse and strictly validate one pairing document.
 * @param raw - YAML document text.
 * @param path - source path for diagnostics only.
 * @returns the validated document.
 * @throws {@link PeerConfigError} when any field is missing, malformed, or inconsistent.
 */
export function parsePairingsDocument(raw: string, path: string): PeerPairingsFile {
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (error) {
    throw new PeerConfigError(`peer pairings ${path} is not valid YAML: ${String(error)}`)
  }
  if (!isRecord(parsed)) throw new PeerConfigError(`peer pairings ${path} must be a YAML mapping`)
  if (parsed.version !== 1) throw new PeerConfigError(`peer pairings ${path} must declare version: 1`)
  const device = requireString(parsed, 'device', 'pairings document')
  const watchdogMs = optionalPositiveInteger(parsed, 'watchdogMs', 'pairings document')
  if (!Array.isArray(parsed.pairings)) throw new PeerConfigError(`peer pairings ${path} must declare a pairings list`)
  const pairings: PeerPairing[] = []
  const seen = new Set<string>()
  for (const [index, entry] of parsed.pairings.entries()) {
    const pairing = parsePairing(entry, `${path}#pairings[${index}]`)
    // The wire `PeerTarget` carries no peer discriminator, so a duplicated
    // alias would let one device's `create` hijack the session another device
    // resolves (doc 72 G8); reject it at load instead.
    if (seen.has(pairing.alias)) throw new PeerConfigError(`peer pairings ${path} repeats alias ${JSON.stringify(pairing.alias)}; aliases must be unique per host`)
    seen.add(pairing.alias)
    pairings.push(pairing)
  }
  return {
    version: 1,
    device,
    ...(watchdogMs === undefined ? {} : { watchdogMs }),
    pairings,
  }
}

const PAIRING_KEYS: ReadonlySet<string> = new Set([
  'alias',
  'peer',
  'exposure',
  'sessionId',
  'remoteSessionId',
  'endpoint',
  'token',
  'runawayCeiling',
  'allowModelChange',
  'create',
  'routing',
])

const CREATE_KEYS: ReadonlySet<string> = new Set(['workspaceId', 'cwd', 'agentPreset'])

/**
 * Reject keys outside the closed set. A pairing is access policy: a mistyped
 * `routing` key would otherwise be dropped silently and leave the alias with
 * the default exposure instead of the restriction the operator wrote.
 * @param value - parsed mapping.
 * @param allowed - the closed key set for this mapping.
 * @param subject - diagnostic location.
 * @throws {@link PeerConfigError} naming the first unknown key.
 */
function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, subject: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PeerConfigError(`${subject}: unknown key ${JSON.stringify(key)}`)
  }
}

function parsePairing(value: unknown, subject: string): PeerPairing {
  if (!isRecord(value)) throw new PeerConfigError(`${subject} must be a mapping`)
  rejectUnknownKeys(value, PAIRING_KEYS, subject)
  const alias = requireString(value, 'alias', subject)
  if (!ALIAS_PATTERN.test(alias)) {
    throw new PeerConfigError(`${subject}: alias must match [A-Za-z0-9._-]+ (received ${JSON.stringify(alias)})`)
  }
  const peer = requireString(value, 'peer', subject)
  const exposure = requireString(value, 'exposure', subject)
  if (!EXPOSURES.includes(exposure as PeerExposure)) {
    throw new PeerConfigError(`${subject}: exposure must be answer-only or debug (received ${JSON.stringify(exposure)})`)
  }
  const sessionId = optionalString(value, 'sessionId', subject)
  const remoteSessionId = optionalString(value, 'remoteSessionId', subject)
  const endpoint = optionalString(value, 'endpoint', subject)
  const token = optionalString(value, 'token', subject)
  const runawayCeiling = optionalPositiveInteger(value, 'runawayCeiling', subject)
  const allowModelChange = optionalBoolean(value, 'allowModelChange', subject)
  let create: PeerCreateDefaults | undefined
  if (value.create !== undefined) {
    if (!isRecord(value.create)) throw new PeerConfigError(`${subject}: create must be a mapping`)
    const createSubject = `${subject}.create`
    rejectUnknownKeys(value.create, CREATE_KEYS, createSubject)
    const workspaceId = optionalString(value.create, 'workspaceId', createSubject)
    const cwd = optionalString(value.create, 'cwd', createSubject)
    const agentPreset = optionalString(value.create, 'agentPreset', createSubject)
    create = {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    }
  }
  if (sessionId === undefined && create === undefined) {
    throw new PeerConfigError(`${subject}: declare sessionId, create, or both; an entry with neither is unreachable`)
  }
  const routing = value.routing === undefined
    ? undefined
    : parseRoutingPolicy(value.routing, `${subject}.routing`)
  return {
    alias: brandString<PeerAlias>(alias),
    peer,
    exposure: exposure as PeerExposure,
    ...(sessionId === undefined ? {} : { sessionId: sessionIdOf(sessionId) }),
    ...(create === undefined ? {} : { create }),
    ...(remoteSessionId === undefined ? {} : { remoteSessionId: sessionIdOf(remoteSessionId) }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(token === undefined ? {} : { token }),
    ...(runawayCeiling === undefined ? {} : { runawayCeiling }),
    ...(allowModelChange === undefined ? {} : { allowModelChange }),
    ...(routing === undefined ? {} : { routing }),
  }
}

const ROUTING_KEYS: ReadonlySet<string> = new Set([
  'allowChains',
  'allowModels',
  'requireZeroPrice',
  'requireNoTraining',
  'requireTools',
  'allowReasoningEfforts',
  'allowSwitch',
  'maxTotalTokens',
])

/**
 * Strictly validate one pairing's `routing` policy. Unknown keys and wrong
 * types are configuration errors, because a silently ignored cost guard would
 * widen what a paired controller may select.
 */
function parseRoutingPolicy(value: unknown, subject: string): PeerRoutingPolicy {
  if (!isRecord(value)) throw new PeerConfigError(`${subject} must be a mapping`)
  for (const key of Object.keys(value)) {
    if (!ROUTING_KEYS.has(key)) {
      throw new PeerConfigError(`${subject}: unknown routing key ${JSON.stringify(key)}`)
    }
  }
  const allowChains = optionalStringList(value, 'allowChains', subject, true)
  const allowModels = optionalStringList(value, 'allowModels', subject, true)
  const requireZeroPrice = optionalBoolean(value, 'requireZeroPrice', subject)
  const requireNoTraining = optionalBoolean(value, 'requireNoTraining', subject)
  const requireTools = optionalBoolean(value, 'requireTools', subject)
  const allowReasoningEfforts = optionalStringList(value, 'allowReasoningEfforts', subject)
  const allowSwitch = optionalString(value, 'allowSwitch', subject)
  if (allowSwitch !== undefined && allowSwitch !== 'never' && allowSwitch !== 'idle-only') {
    throw new PeerConfigError(`${subject}: allowSwitch must be never or idle-only (received ${JSON.stringify(allowSwitch)})`)
  }
  const maxTotalTokens = optionalPositiveInteger(value, 'maxTotalTokens', subject)
  return {
    ...(allowChains === undefined ? {} : { allowChains }),
    ...(allowModels === undefined ? {} : { allowModels }),
    ...(requireZeroPrice === undefined ? {} : { requireZeroPrice }),
    ...(requireNoTraining === undefined ? {} : { requireNoTraining }),
    ...(requireTools === undefined ? {} : { requireTools }),
    ...(allowReasoningEfforts === undefined ? {} : { allowReasoningEfforts }),
    ...(allowSwitch === undefined ? {} : { allowSwitch }),
    ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one binding's optional retired-session history.
 * @param alias - owning alias for diagnostics.
 * @param value - raw `retired` value; absent and empty are equivalent.
 * @returns retired entries, or undefined when the field is absent or empty.
 * @throws {@link PeerConfigError} when an entry is malformed.
 */
function readRetiredBindings(alias: string, value: unknown): readonly RetiredPeerBinding[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new PeerConfigError(`peer binding ${JSON.stringify(alias)}: retired must be a list`)
  }
  const retired: RetiredPeerBinding[] = []
  for (const [index, entry] of value.entries()) {
    const subject = `peer binding ${JSON.stringify(alias)}.retired[${index}]`
    if (!isRecord(entry) || typeof entry.sessionId !== 'string' || typeof entry.device !== 'string'
      || typeof entry.createdAt !== 'number' || typeof entry.retiredAt !== 'number') {
      throw new PeerConfigError(`${subject} must carry sessionId, device, createdAt, and retiredAt`)
    }
    const maxTotalTokens = optionalPositiveInteger(entry, 'maxTotalTokens', subject)
    retired.push({
      sessionId: sessionIdOf(entry.sessionId),
      device: entry.device,
      createdAt: entry.createdAt,
      retiredAt: entry.retiredAt,
      ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
    })
  }
  return retired.length === 0 ? undefined : retired
}

function requireString(record: Record<string, unknown>, key: string, subject: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new PeerConfigError(`${subject}: ${key} must be a non-empty string`)
  }
  return value
}

function optionalString(record: Record<string, unknown>, key: string, subject: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new PeerConfigError(`${subject}: ${key} must be a non-empty string when present`)
  }
  return value
}

function optionalBoolean(record: Record<string, unknown>, key: string, subject: string): boolean | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new PeerConfigError(`${subject}: ${key} must be a boolean when present`)
  return value
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string, subject: string): number | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new PeerConfigError(`${subject}: ${key} must be a positive integer when present`)
  }
  return value
}

/**
 * Read one optional list of non-empty strings. `patterns` additionally accepts
 * only the routing charset, for chain ids and `provider/model` globs.
 */
function optionalStringList(
  record: Record<string, unknown>,
  key: string,
  subject: string,
  patterns = false,
): readonly string[] | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new PeerConfigError(`${subject}: ${key} must be a list when present`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new PeerConfigError(`${subject}: ${key}[${index}] must be a non-empty string`)
    }
    if (patterns && !isRoutingPattern(entry)) {
      throw new PeerConfigError(`${subject}: ${key}[${index}] must match [A-Za-z0-9._:/@*+-]+`)
    }
    return entry
  })
}
