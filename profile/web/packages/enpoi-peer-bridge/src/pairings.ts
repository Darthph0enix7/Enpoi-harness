/**
 * Caller-side reader for the pairing document (`~/.dsh/pairings.yaml`).
 *
 * The bridge only consumes *caller-role* entries — those carrying an
 * `endpoint` for the device named by `peer` — and addresses them by `alias`
 * (with an optional `remoteSessionId` pinning the target session). The serving
 * host reads the same document with its own stricter parser; this parser is
 * deliberately independent so the caller never imports host code and so a
 * caller-only entry (endpoint without `sessionId`/`create`) is usable here.
 *
 * The YAML subset is parsed locally (no dependency): scalar values, one level
 * of nested mappings (`create:`), and sequences of mappings (`pairings:`),
 * with quote-aware comment stripping. Anything outside that subset fails loud
 * with a line number.
 *
 * @module dsh-enpoi-peer-bridge/pairings
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One pairing entry; caller-role when it carries an `endpoint`. */
export interface CallerPairing {
  /** Deterministic alias; matches `[A-Za-z0-9._-]+`. */
  readonly alias: string
  /** Device name of the peer this entry calls. */
  readonly peer: string
  /** Base URL of the peer's HTTP surface, e.g. `https://host:8443`. */
  readonly endpoint?: string
  /** Host-role exposure (unused by the caller, kept for shared documents). */
  readonly exposure?: string
  /** Bearer token sent when present (doc 69 §8 correction 1 hook). */
  readonly token?: string
  /** Session on `peer` this bridge addresses; absent falls back to the alias. */
  readonly remoteSessionId?: string
  /** Peer-created session defaults, host-role (unused by the caller). */
  readonly create?: Readonly<Record<string, unknown>>
  /** This host's session exposed to `peer`, host-role (unused by the caller). */
  readonly sessionId?: string
  /** Optional emergency stop for the serving host, host-role. */
  readonly runawayCeiling?: number
}

/** A pairing entry the bridge can actually dial (endpoint present). */
export type DialablePairing = CallerPairing & { readonly endpoint: string }

/** The parsed document: local device identity plus the raw entry list. */
export interface PairingDocument {
  readonly version: number
  readonly device: string
  readonly pairings: readonly CallerPairing[]
}

/** Path used when no explicit override is configured. */
export function defaultPairingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'pairings.yaml')
}

/** One parse failure with its source line. */
export class PairingDocumentError extends Error {
  /** Line number (1-based) the failure points at; 0 when the document is empty. */
  readonly line: number

  /**
   * @param message - human-readable failure.
   * @param line - source line, 1-based.
   */
  constructor(message: string, line: number) {
    super(line > 0 ? `${message} (line ${String(line)})` : message)
    this.name = 'PairingDocumentError'
    this.line = line
  }
}

interface SourceLine {
  readonly indent: number
  readonly text: string
  readonly line: number
}

/**
 * Read caller-role entries from a pairing document.
 * @param raw - document text.
 * @param path - source path for diagnostics only.
 * @returns the parsed document with every entry (host and caller role).
 * @throws {@link PairingDocumentError} on malformed YAML or schema violations.
 */
export function parsePairingDocument(raw: string, path: string): PairingDocument {
  const lines = significantLines(raw)
  if (lines.length === 0) throw new PairingDocumentError(`peer pairings ${path} is empty`, 0)
  const [document, next] = parseBlock(lines, 0, lines[0]!.indent)
  if (next !== lines.length) {
    throw new PairingDocumentError(`peer pairings ${path} has trailing content`, lines[next]!.line)
  }
  if (!isRecord(document)) throw new PairingDocumentError(`peer pairings ${path} must be a mapping`, 1)
  if (document.version !== 1) throw new PairingDocumentError(`peer pairings ${path} must declare version: 1`, 1)
  const device = requireNonEmptyString(document.device, `${path}: device`)
  const rawList = document.pairings
  if (!Array.isArray(rawList)) throw new PairingDocumentError(`peer pairings ${path} must declare a pairings list`, 1)
  const pairings: CallerPairing[] = []
  for (const [index, entry] of rawList.entries()) {
    if (!isRecord(entry)) throw new PairingDocumentError(`${path}: pairings[${index}] must be a mapping`, 1)
    pairings.push(parseEntry(entry, `${path}#pairings[${index}]`))
  }
  return { version: 1, device, pairings }
}

/** Read and parse a pairing document from disk. */
export function readPairingDocument(path: string): PairingDocument {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new PairingDocumentError(
      `peer pairings ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      0,
    )
  }
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return parsePairingDocument(stripped, path)
}

/** Caller-role entries only: those that can be dialed (endpoint + peer). */
export function callerPairings(document: PairingDocument): readonly DialablePairing[] {
  return document.pairings.filter((pairing): pairing is DialablePairing => pairing.endpoint !== undefined)
}

/**
 * Resolve one alias among the caller-role entries.
 * @param document - parsed pairing document.
 * @param alias - requested alias.
 * @returns the resolved entry.
 * @throws {@link PairingDocumentError} naming the available aliases.
 */
export function resolveCallerPairing(document: PairingDocument, alias: string): DialablePairing {
  const callers = callerPairings(document)
  const found = callers.find(pairing => pairing.alias === alias)
  if (found !== undefined) return found
  const available = callers.length === 0
    ? 'no caller-role entries (an entry needs `endpoint` and `peer`)'
    : `available: ${callers.map(pairing => pairing.alias).join(', ')}`
  throw new PairingDocumentError(`no caller-role pairing with alias ${JSON.stringify(alias)} — ${available}`, 0)
}

/** Load + resolve in one call; the bridge's only document entry point. */
export function loadCallerPairing(path: string, alias: string): { readonly document: PairingDocument; readonly pairing: DialablePairing } {
  const document = readPairingDocument(path)
  return { document, pairing: resolveCallerPairing(document, alias) }
}

// ── YAML subset ──────────────────────────────────────────────────────────────

const ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/

function parseEntry(entry: Record<string, unknown>, subject: string): CallerPairing {
  const alias = requireNonEmptyString(entry.alias, `${subject}: alias`)
  if (!ALIAS_PATTERN.test(alias)) {
    throw new PairingDocumentError(`${subject}: alias must match [A-Za-z0-9._-]+ (received ${JSON.stringify(alias)})`, 1)
  }
  const peer = requireNonEmptyString(entry.peer, `${subject}: peer`)
  const endpoint = typeof entry.endpoint === 'string' && entry.endpoint !== '' ? entry.endpoint : undefined
  if (endpoint !== undefined && !/^https?:\/\//u.test(endpoint)) {
    throw new PairingDocumentError(`${subject}: endpoint must be an http(s) URL (received ${JSON.stringify(endpoint)})`, 1)
  }
  const optionalString = (key: string): string | undefined => {
    const value = entry[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string' || value === '') {
      throw new PairingDocumentError(`${subject}: ${key} must be a non-empty string when present`, 1)
    }
    return value
  }
  const create = entry.create === undefined || entry.create === null
    ? undefined
    : isRecord(entry.create)
      ? entry.create
      : (() => { throw new PairingDocumentError(`${subject}: create must be a mapping`, 1) })()
  const runawayCeiling = entry.runawayCeiling === undefined || entry.runawayCeiling === null
    ? undefined
    : typeof entry.runawayCeiling === 'number' && Number.isFinite(entry.runawayCeiling) && entry.runawayCeiling > 0
      ? entry.runawayCeiling
      : (() => { throw new PairingDocumentError(`${subject}: runawayCeiling must be a positive number`, 1) })()
  const exposure = optionalString('exposure')
  if (exposure !== undefined && exposure !== 'answer-only' && exposure !== 'debug') {
    throw new PairingDocumentError(`${subject}: exposure must be answer-only or debug (received ${JSON.stringify(exposure)})`, 1)
  }
  return {
    alias,
    peer,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(exposure === undefined ? {} : { exposure }),
    ...(optionalString('token') === undefined ? {} : { token: optionalString('token') as string }),
    ...(optionalString('remoteSessionId') === undefined ? {} : { remoteSessionId: optionalString('remoteSessionId') as string }),
    ...(optionalString('sessionId') === undefined ? {} : { sessionId: optionalString('sessionId') as string }),
    ...(create === undefined ? {} : { create }),
    ...(runawayCeiling === undefined ? {} : { runawayCeiling }),
  }
}

function requireNonEmptyString(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new PairingDocumentError(`${subject} must be a non-empty string`, 1)
  }
  return value
}

function significantLines(raw: string): SourceLine[] {
  const out: SourceLine[] = []
  const rows = raw.split(/\r?\n/u)
  for (const [index, row] of rows.entries()) {
    const text = stripComment(row)
    if (text.trim() === '') continue
    out.push({
      indent: text.length - text.trimStart().length,
      text: text.trim(),
      line: index + 1,
    })
  }
  return out
}

/** Remove a comment not inside quotes; `#` only starts a comment after whitespace or at line start. */
function stripComment(raw: string): string {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/u.test(raw[index - 1]!))) return raw.slice(0, index)
  }
  return raw
}

function parseBlock(lines: readonly SourceLine[], start: number, indent: number): [unknown, number] {
  const first = lines[start]
  if (first === undefined) return [null, start]
  if (first.indent < indent) return [null, start]
  if (isSequenceLine(first.text)) return parseSequence(lines, start, first.indent)
  return parseMapping(lines, start, first.indent)
}

function isSequenceLine(text: string): boolean {
  return text === '-' || text.startsWith('- ')
}

function parseMapping(
  lines: readonly SourceLine[],
  start: number,
  indent: number,
  firstPair?: { readonly text: string; readonly line: number },
): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {}
  let index = start
  let pending = firstPair
  while (true) {
    let text: string
    let line: number
    if (pending !== undefined) {
      text = pending.text
      line = pending.line
      pending = undefined
    } else {
      const current = lines[index]
      if (current === undefined || current.indent !== indent || isSequenceLine(current.text)) break
      text = current.text
      line = current.line
      index += 1
    }
    const colon = findColon(text)
    if (colon < 0) throw new PairingDocumentError(`expected "key: value"`, line)
    const key = unquote(text.slice(0, colon).trim())
    const rest = text.slice(colon + 1).trim()
    if (rest === '' || rest === '|' || rest === '>') {
      const next = lines[index]
      if (next !== undefined && next.indent > indent) {
        const [value, consumed] = parseBlock(lines, index, next.indent)
        out[key] = value
        index = consumed
      } else {
        out[key] = null
      }
    } else {
      out[key] = parseScalar(rest, line)
    }
  }
  return [out, index]
}

function parseSequence(lines: readonly SourceLine[], start: number, indent: number): [unknown[], number] {
  const out: unknown[] = []
  let index = start
  while (index < lines.length) {
    const current = lines[index]!
    if (current.indent !== indent || !isSequenceLine(current.text)) break
    const rest = current.text.slice(1).trim()
    index += 1
    if (rest === '') {
      const next = lines[index]
      if (next !== undefined && next.indent > indent) {
        const [value, consumed] = parseBlock(lines, index, next.indent)
        out.push(value)
        index = consumed
      } else {
        out.push(null)
      }
      continue
    }
    const colon = findColon(rest)
    if (colon < 0) {
      out.push(parseScalar(rest, current.line))
      continue
    }
    // `- key: value` opens a mapping whose continuation lines sit deeper.
    const next = lines[index]
    const childIndent = next !== undefined && next.indent > indent ? next.indent : indent + 2
    const [value, consumed] = parseMapping(lines, index, childIndent, { text: rest, line: current.line })
    out.push(value)
    index = consumed
  }
  return [out, index]
}

function findColon(text: string): number {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':') return index
  }
  return -1
}

function parseScalar(text: string, line: number): unknown {
  if (text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  // Empty flow collections are the one flow form the shared documents use.
  if (text === '[]') return []
  if (text === '{}') return {}
  if (/^-?\d+$/u.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d+\.\d+$/u.test(text)) return Number.parseFloat(text)
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return unquote(text)
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    throw new PairingDocumentError('unterminated quoted scalar', line)
  }
  return text
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\nt])/gu, (_match, escape: string) => {
      if (escape === 'n') return '\n'
      if (escape === 't') return '\t'
      return escape
    })
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/gu, "'")
  }
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
