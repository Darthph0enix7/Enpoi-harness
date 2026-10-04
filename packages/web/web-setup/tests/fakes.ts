/** In-memory seams for the web-setup unit tests; only external boundaries are faked. */
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type {
  WebSetupConfigEditor,
  WebSetupCredentialsSeam,
  WebSetupEditorRow,
  WebSetupFetch,
  WebSetupSeams,
  WebSetupToolToggles,
} from '../src/types.ts'

/** One recorded editor call. */
export interface EditorCall {
  kind: 'insert' | 'edit' | 'remove'
  id: string
  name: string
  config: Record<string, unknown>
}

/** A config editor that mutates its rows exactly like the persisted-document API would. */
export class FakeEditor implements WebSetupConfigEditor {
  readonly calls: EditorCall[] = []
  insertFailure: Error | undefined
  editFailure: Error | undefined
  removeFailure: Error | undefined
  entriesFailure: Error | undefined
  /** When true, `insert` reports success without adding the row. */
  swallowInsert = false

  constructor(readonly rows: WebSetupEditorRow[] = []) {}

  entries(): readonly WebSetupEditorRow[] {
    if (this.entriesFailure !== undefined) throw this.entriesFailure
    return this.rows
  }

  async edit(
    entry: WebSetupEditorRow,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    if (this.editFailure !== undefined) throw this.editFailure
    const next = change(structuredClone(entry.options.config ?? {}), {})
    this.calls.push({ kind: 'edit', id: entry.options.id, name: entry.options.name, config: next })
    entry.options.config = next
  }

  async insert(row: { id: string; name: string; config: Record<string, unknown> }): Promise<void> {
    if (this.insertFailure !== undefined) throw this.insertFailure
    this.calls.push({ kind: 'insert', id: row.id, name: row.name, config: structuredClone(row.config) })
    if (this.swallowInsert) return
    this.rows.push({ options: { id: row.id, name: row.name, config: structuredClone(row.config) } })
  }

  async remove(id: string): Promise<void> {
    if (this.removeFailure !== undefined) throw this.removeFailure
    const index = this.rows.findIndex(row => row.options.id === id)
    const removed = index < 0 ? undefined : this.rows[index]
    this.calls.push({ kind: 'remove', id, name: removed?.options.name ?? '', config: {} })
    if (index >= 0) this.rows.splice(index, 1)
  }
}

/** A credential provider over an in-memory store. */
export class FakeCredentials implements WebSetupCredentialsSeam {
  readonly store = new Map<string, string>()
  readonly sets: Array<[string, string]> = []
  setFailure: Error | undefined
  describeFailure: Error | undefined
  resolveFailure: Error | undefined

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (this.describeFailure !== undefined) throw this.describeFailure
    const value = this.store.get(String(ref))
    return value === undefined
      ? { configured: false, writable: true }
      : { configured: true, source: 'store', writable: true }
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (this.resolveFailure !== undefined) throw this.resolveFailure
    const value = this.store.get(String(ref))
    return value === undefined ? undefined : { value, source: 'store' }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (this.setFailure !== undefined) throw this.setFailure
    this.sets.push([String(ref), value])
    this.store.set(String(ref), value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.store.delete(String(ref))
  }
}

/** A live `web` row with the given provider config. */
export function webRow(config: Record<string, unknown> = {}): WebSetupEditorRow {
  return { options: { id: 'web', name: '@deepseek-ai/dsh-web', config } }
}

/** A live `tool-web` row. */
export function toolRow(config: WebSetupToolToggles = { search: false, fetch: false }): WebSetupEditorRow {
  return { options: { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { ...config } } }
}

/** A live provider row carrying a catalog module name. */
export function providerRow(id: string, name: string, config: Record<string, unknown> = {}): WebSetupEditorRow {
  return { options: { id, name, config } }
}

/** Module name of the preset group plugin that mounts `config.plugins` in a per-agent tree. */
export const PRESET_PLUGIN_NAME = '@deepseek-ai/dsh-agent-preset'

/** A preset group row carrying nested plugin entries. */
export function presetRow(id: string, plugins: unknown[]): WebSetupEditorRow {
  return { options: { id, name: PRESET_PLUGIN_NAME, config: { id, name: id, plugins } } }
}

/** One nested `tool-web` plugin entry inside a preset row's `config.plugins`. */
export function nestedToolWeb(config: Record<string, unknown> = {}, disabled?: boolean): Record<string, unknown> {
  return {
    id: 'tool-web',
    name: '@deepseek-ai/dsh-tool-web',
    ...disabled === undefined ? {} : { disabled },
    config,
  }
}

/** A fetch stub that answers with the given payload. */
export function jsonFetch(body: unknown, status = 200): WebSetupFetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** One lazy seam bundle; override individual seams per test. */
export function seams(overrides: Partial<WebSetupSeams> = {}): () => WebSetupSeams {
  const base: WebSetupSeams = {
    fetchImpl: jsonFetch({}),
    env: {},
    now: () => 0,
  }
  return () => ({ ...base, ...overrides })
}
