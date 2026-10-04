/**
 * enpoi-preset-authoring — manual main-agent preset authoring for the Agent
 * presets settings section.
 *
 * Fenced `/sidebar/presets` JSON routes (same trust fence as the sidebar API:
 * loopback host or a configured trusted authority). Operations:
 * - presets.list   — declared presets with authoring metadata (built-in flag,
 *                    persona presence, suffix size, order, disabled)
 * - presets.get    — one preset's editable fields (name, description, suffix)
 * - presets.create — clone a base preset into a new `preset-<id>` row
 * - presets.update — user presets only: name, description, persona suffix
 * - presets.delete — user presets only: remove the top-level row
 *
 * Every write goes through the harness `configEditor` (the canonical profile
 * patch writer: profile lock, recomposition validation, atomic write, Loader
 * reconcile, rollback), so this plugin owns no second writer. The clone copies
 * the base composition byte-for-byte and rewrites only the persona suffix —
 * the shared prefix parity is structural, not checked after the fact.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { IncomingHttpHeaders } from 'node:http'
import {
  BUILT_IN_PRESET_IDS,
  hasSharedPersona,
  isPresetId,
  newPresetConfig,
  nextPresetOrder,
  personaSuffixOf,
  validatePresetInput,
  withPersonaSuffix,
  type PresetConfigRow,
} from './presets.js'

export const name = 'enpoi-preset-authoring'
export const inject = ['webServer', 'webRuntime']

export const Config = Schema.object({})

export interface PresetAuthoringConfig {}

/** Compose-row view of one Loader entry the authoring routes read. */
interface EntryFace {
  options: {
    id: string
    name?: string
    config?: Record<string, unknown>
    disabled?: unknown
  }
}

/** Structural face of the harness profile config editor. */
interface ConfigEditorFace {
  entries(): EntryFace[]
  insert(row: { id: string; name: string; config: Record<string, unknown> }): Promise<void>
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
  remove(id: string): Promise<void>
}

/** One authoring row as the settings section reads it. */
interface PresetAuthoringRow {
  id: string
  rowId: string
  name: string
  description: string
  order: number | undefined
  builtIn: boolean
  disabled: boolean
  hasPersona: boolean
  suffixChars: number
}

/** Structural subset of the node HTTP request the fence reads. */
interface TrustRequest {
  headers: IncomingHttpHeaders
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** DNS-rebinding / cross-site fence, behaviorally identical to the sidebar's. */
function isTrustedRequest(req: TrustRequest, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (isLoopbackHostname(hostname)) return true
  return trustedHosts.some((entry) => {
    try {
      return new URL(`http://${entry}`).hostname === hostname
    } catch {
      return false
    }
  })
}

/** One API failure with its wire code and HTTP status. */
class PresetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

function requireString(payload: unknown, key: string, allowEmpty = false): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new PresetError('bad-request', `missing or invalid "${key}"`, 400)
  }
  return value.trim()
}

/** Largest JSON request body accepted: one persona suffix plus JSON escaping. */
const MAX_BODY_BYTES = 512 * 1024

async function readJsonBody(req: { on: (event: string, cb: (chunk: Buffer) => void) => unknown }): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new PresetError('bad-request', 'request body too large', 413)
    chunks.push(Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new PresetError('bad-request', 'malformed JSON body', 400)
  }
}

function writeJson(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function writeOk(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, error: unknown): void {
  const err = error instanceof PresetError ? error : new PresetError('internal', error instanceof Error ? error.message : String(error), 500)
  writeJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } })
}

/** Row id of one preset. */
function presetRowId(id: string): string {
  return `preset-${id}`
}

/** Preset id carried by a `preset-<id>` row id. */
function presetIdOf(rowId: string): string {
  return rowId.slice('preset-'.length)
}

function requireEditor(ctx: Context): ConfigEditorFace {
  const editor = ctx.get('configEditor') as ConfigEditorFace | undefined
  if (editor === undefined || typeof editor.insert !== 'function' || typeof editor.remove !== 'function') {
    throw new PresetError('internal', 'profile config editor is unavailable', 500)
  }
  return editor
}

function entryConfig(entry: EntryFace): PresetConfigRow {
  return (entry.options.config ?? {}) as PresetConfigRow
}

/** All declared presets, sorted by id. */
function presetEntries(editor: ConfigEditorFace): Array<{ entry: EntryFace; id: string; config: PresetConfigRow }> {
  return editor.entries()
    .filter(entry => entry.options.id.startsWith('preset-'))
    .map(entry => ({ entry, id: presetIdOf(entry.options.id), config: entryConfig(entry) }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function authoringRow(id: string, entry: EntryFace, config: PresetConfigRow): PresetAuthoringRow {
  return {
    id,
    rowId: entry.options.id,
    name: typeof config.name === 'string' && config.name !== '' ? config.name : id,
    description: typeof config.description === 'string' ? config.description : '',
    order: typeof config.order === 'number' ? config.order : undefined,
    builtIn: BUILT_IN_PRESET_IDS.has(id),
    disabled: entry.options.disabled === true,
    hasPersona: hasSharedPersona(config),
    suffixChars: (personaSuffixOf(config) ?? '').length,
  }
}

/** Find one editable preset entry by id. */
function findPreset(editor: ConfigEditorFace, id: string): { entry: EntryFace; config: PresetConfigRow } | undefined {
  const found = editor.entries().find(entry => entry.options.id === presetRowId(id))
  return found === undefined ? undefined : { entry: found, config: entryConfig(found) }
}

export function apply(ctx: Context, _config: PresetAuthoringConfig): void {
  const trustedHosts = (ctx.get('webRuntime') as { trustedHosts?: readonly string[] } | undefined)?.trustedHosts ?? []

  const api: Record<string, (payload: unknown) => Promise<unknown>> = {
    'presets.list': async () => {
      const editor = requireEditor(ctx)
      return {
        presets: presetEntries(editor).map(({ entry, id, config }) => authoringRow(id, entry, config)),
      }
    },

    'presets.get': async (payload) => {
      const id = requireString(payload, 'id')
      const editor = requireEditor(ctx)
      const found = findPreset(editor, id)
      if (found === undefined) throw new PresetError('not-found', `preset "${id}" does not exist`, 404)
      return {
        ...authoringRow(id, found.entry, found.config),
        suffix: personaSuffixOf(found.config) ?? '',
      }
    },

    'presets.create': async (payload) => {
      const id = requireString(payload, 'id')
      const name = requireString(payload, 'name')
      const description = requireString(payload, 'description', true)
      const suffix = requireString(payload, 'suffix')
      const baseId = requireString(payload, 'base')
      const problem = validatePresetInput({ id, name, description, suffix }, true)
      if (problem !== undefined) throw new PresetError('bad-request', problem, 400)
      const editor = requireEditor(ctx)
      const base = findPreset(editor, baseId)
      if (base === undefined) throw new PresetError('not-found', `base preset "${baseId}" does not exist`, 404)
      if (findPreset(editor, id) !== undefined) {
        throw new PresetError('exists', `preset "${id}" already exists`, 409)
      }
      let config
      try {
        config = newPresetConfig(base.config, {
          id,
          name,
          description: description === '' ? `Custom preset cloned from ${baseId}` : description,
          suffix,
          order: nextPresetOrder(presetEntries(editor).map(row => row.config)),
        })
      } catch (error) {
        throw new PresetError('bad-request', `cannot clone base preset "${baseId}": ${error instanceof Error ? error.message : String(error)}`, 400)
      }
      await editor.insert({ id: presetRowId(id), name: '@deepseek-ai/dsh-agent-preset', config: config as Record<string, unknown> })
      return { id, rowId: presetRowId(id) }
    },

    'presets.update': async (payload) => {
      const id = requireString(payload, 'id')
      const name = requireString(payload, 'name')
      const description = requireString(payload, 'description', true)
      const suffix = requireString(payload, 'suffix')
      if (BUILT_IN_PRESET_IDS.has(id)) {
        throw new PresetError('protected', `preset "${id}" is a shipped preset and cannot be edited`, 400)
      }
      const problem = validatePresetInput({ name, description, suffix }, false)
      if (problem !== undefined) throw new PresetError('bad-request', problem, 400)
      const editor = requireEditor(ctx)
      const found = findPreset(editor, id)
      if (found === undefined) throw new PresetError('not-found', `preset "${id}" does not exist`, 404)
      await editor.edit(found.entry, current => ({
        ...current,
        name,
        description,
        plugins: withPersonaSuffix(current.plugins, suffix),
      }))
      return { id }
    },

    'presets.delete': async (payload) => {
      const id = requireString(payload, 'id')
      if (!isPresetId(id)) {
        throw new PresetError('bad-request', `invalid preset id "${id}"`, 400)
      }
      if (BUILT_IN_PRESET_IDS.has(id)) {
        throw new PresetError('protected', `preset "${id}" is a shipped preset and cannot be deleted`, 400)
      }
      const editor = requireEditor(ctx)
      if (findPreset(editor, id) === undefined) {
        throw new PresetError('not-found', `preset "${id}" does not exist`, 404)
      }
      await editor.remove(presetRowId(id))
      return { id }
    },
  }

  ctx.effect((): (() => void) => {
    const webServer = ctx.get('webServer') as {
      register?: (spec: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) => unknown
    } | undefined
    if (webServer?.register === undefined) return () => {}
    const dispose = webServer.register({
      kind: 'prefix',
      path: '/sidebar/presets',
      handler: async (req, res) => {
        const httpReq = req as {
          headers: IncomingHttpHeaders
          method?: string
          url?: string
          on: (event: string, cb: (chunk: Buffer) => void) => unknown
        }
        const httpRes = res as {
          writeHead: (status: number, headers: Record<string, string>) => void
          end: (body: string) => void
        }
        if (!isTrustedRequest(httpReq, trustedHosts)) {
          writeJson(httpRes, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        // Cross-site simple-request CSRF: application/json forces a preflight,
        // which the 405 below answers; an explicit untrusted Origin is refused.
        const contentType = header(httpReq.headers, 'content-type') ?? ''
        if (!contentType.toLowerCase().includes('application/json')) {
          writeJson(httpRes, 415, { ok: false, error: { code: 'bad-request', message: 'content-type must be application/json' } })
          return
        }
        const origin = header(httpReq.headers, 'origin')
        if (origin !== undefined && origin !== 'null') {
          let originHost: string
          try {
            originHost = new URL(origin).hostname
          } catch {
            writeJson(httpRes, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (!isLoopbackHostname(originHost) && !trustedHosts.some((entry) => {
            try { return new URL(`http://${entry}`).hostname === originHost } catch { return false }
          })) {
            writeJson(httpRes, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
        }
        if (httpReq.method !== 'POST') {
          writeJson(httpRes, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const pathname = new URL(httpReq.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith('/sidebar/presets/') ? pathname.slice('/sidebar/presets/'.length) : undefined
        if (method === undefined || method.includes('/')) {
          writeError(httpRes, new PresetError('not-found', 'unknown presets method', 404))
          return
        }
        try {
          const payload = await readJsonBody(httpReq)
          const handler = api[method]
          if (handler === undefined) {
            throw new PresetError('not-found', `unknown presets method "${method}"`, 404)
          }
          writeOk(httpRes, await handler(payload))
        } catch (error) {
          writeError(httpRes, error)
        }
      },
    })
    return () => { void dispose }
  }, 'dsh-enpoi-preset-authoring: /sidebar/presets routes')
}
