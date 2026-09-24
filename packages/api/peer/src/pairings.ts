/**
 * Pairing-file loading, strict validation, and created-session bindings.
 *
 * The pairing file (`~/.dsh/pairings.yaml`) is human-edited and only read; a
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
  PeerTarget,
  PeerTargetResolved,
} from './types.ts'

/** Default watchdog before an orphaned peer turn is aborted (doc 69 §8). */
export const DEFAULT_WATCHDOG_MS = 15 * 60 * 1000

/** Default human-edited pairing document. */
export const DEFAULT_PAIRINGS_PATH = dshHomePath('pairings.yaml')

/** Default machine-written created-session binding document. */
export const DEFAULT_BINDINGS_PATH = dshHomePath('peer-state.json')

const EXPOSURES: readonly PeerExposure[] = ['answer-only', 'debug']
const ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/
const PRIVATE_MODE = 0o600

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
  /** Absolute pairing-file path (also the write target of `ds`-distributed config). */
  readonly pairingsPath: string
  /** Absolute created-session binding path owned exclusively by this module. */
  readonly bindingsPath: string

  private snapshot: LoadedPeerPairings | undefined
  private pairingStamp: { mtimeMs: number; size: number } | undefined
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * @param pairingsPath - pairing document path; defaults to `~/.dsh/pairings.yaml`.
   * @param bindingsPath - binding document path; defaults to `~/.dsh/peer-state.json`.
   */
  constructor(pairingsPath: string = dshHomePath('pairings.yaml'), bindingsPath: string = dshHomePath('peer-state.json')) {
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
      if (error instanceof PeerConfigError) return this.snapshot
      throw error
    }
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
    return undefined
  }

  /** The pairing exposing one session, when the session is paired at all. */
  exposed(sessionId: SessionId): ResolvedPeerPairing | undefined {
    return this.resolve({ kind: 'session', sessionId })
  }

  /** Persist one alias→session binding (atomic, 0600). */
  async bind(alias: PeerAlias, device: PeerDeviceName, sessionId: SessionId): Promise<void> {
    const run = async (): Promise<void> => {
      const current = this.readBindings()
      const bindings: Record<string, PeerBinding> = Object.assign({}, current)
      bindings[alias] = { sessionId, device, createdAt: Date.now() }
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
      bindings[alias] = {
        sessionId: sessionIdOf(value.sessionId),
        device: value.device,
        createdAt: value.createdAt,
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

function parsePairing(value: unknown, subject: string): PeerPairing {
  if (!isRecord(value)) throw new PeerConfigError(`${subject} must be a mapping`)
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
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
