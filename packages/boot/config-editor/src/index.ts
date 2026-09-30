/** Profile-owned configuration edits, serialized with Loader hot reload. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service, resolveConfig } from '@deepseek-ai/cordis'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-hmr'
import { composeEntries, loadProfileDirectory, readProfilePatches, reconcileProfilePatches, type Profile } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isSeq, parseDocument, Scalar, visit } from 'yaml'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent edits to the active profile's plugin configuration. */
    configEditor: ConfigEditor
  }
}

function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
}

/** The string `id` of one patch-document node, or undefined for other nodes. */
function nodeId(node: unknown): string | undefined {
  if (!isMap(node)) return undefined
  const id = node.get('id')
  return typeof id === 'string' ? id : undefined
}

/** Structural view of the optional `modelChains` registry the LLM runtime reads. */
export interface ModelChainRegistry {
  /**
   * Resolve one model-group id.
   * @param id - group id a config's `chain` field carries.
   * @returns the group when it is routable; `undefined` for unknown, disabled, or malformed ids.
   */
  resolve(id: string): unknown
}

/** Whether one value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Drop every `chain` reference the LLM runtime cannot route. The runtime
 * resolves a carried group through the optional `modelChains` registry and
 * fails open when that registry is absent, the id is unknown or disabled, or
 * resolution throws, so persisting such a reference would record a route that
 * never runs — and a stale reference in a live config survives a merge that
 * does not set `chain` itself, which is how a retired group id reappears.
 * @param config - candidate entry config about to be persisted.
 * @param registry - optional `modelChains` service read from the owning Context.
 * @param onDrop - diagnostic per removed reference; receives its config path and raw value.
 * @returns a detached config without unusable `chain` references.
 */
export function pruneUnusableChains(
  config: Record<string, unknown>,
  registry: ModelChainRegistry | undefined,
  onDrop: (path: string, value: string) => void,
): Record<string, unknown> {
  const usable = (value: unknown): boolean => {
    if (typeof value !== 'string' || value.trim() === '') return false
    if (registry === undefined || typeof registry.resolve !== 'function') return false
    try {
      return registry.resolve(value.trim()) !== undefined
    } catch {
      // A throwing registry is unusable like an unknown id; the runtime fails open the same way.
      return false
    }
  }
  const walk = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${String(index)}]`))
    if (!isRecord(value)) return value
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`
      if (key === 'chain' && !usable(child)) {
        onDrop(childPath, typeof child === 'string' ? child : String(child))
        continue
      }
      result[key] = walk(child, childPath)
    }
    return result
  }
  return walk(config, '') as Record<string, unknown>
}

/** Persist complete raw configs and apply them through the normal Loader path. */
export class ConfigEditor extends Service {
  static inject = ['loader', 'profileContext']
  /**
   * Inherited and override values per entry id, keyed by the composed profile
   * they were derived from. The profile object is replaced whenever any patch
   * source changes, so stale entries become unreachable with it.
   */
  private readonly valuesByProfile = new WeakMap<Profile, Map<string, {
    inherited: Record<string, unknown>
    override: Record<string, unknown>
  }>>()
  /**
   * Composed inherited config per entry id for one profile generation. A
   * profile's user configs target their own id, so dropping every user config
   * in one composition yields the same inherited row per id as dropping only
   * the requested entry's config once per entry.
   */
  private readonly inheritedRowsByProfile = new WeakMap<Profile, Map<string, Record<string, unknown>>>()

  constructor(private readonly ownerContext: Context) {
    super(ownerContext, 'configEditor')
  }

  /** The profile patch edited by this service. */
  get documentPath(): string { return this.ownerContext.profileContext.patchPath }

  /** Addressable profile rows; nested Includes have independent configuration ownership.
   * @returns Active entries with unique profile patch ids.
   */
  entries(): Entry[] {
    const candidates = [...this.ownerContext.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
    const counts = new Map<string, number>()
    for (const entry of candidates) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1)
    return candidates.filter(entry => counts.get(entry.options.id) === 1)
  }

  /** Read inherited and explicit profile values for the active entries.
   * Both values depend only on the composed profile and the entry id, so each
   * id is composed once per profile generation and cloned per read.
   * @returns Detached layer values alongside their Loader entries.
   */
  configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }> {
    const profile = this.ownerContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
    let values = this.valuesByProfile.get(loaded)
    if (values === undefined) {
      values = new Map()
      this.valuesByProfile.set(loaded, values)
    }
    return this.entries().map((entry) => {
      const id = entry.options.id
      let entryValues = values.get(id)
      if (entryValues === undefined) {
        entryValues = {
          inherited: this.inherited(entry, loaded),
          override: structuredClone((loaded.patches.findLast(
            row => row.id === id && row.config !== undefined,
          )?.config ?? {}) as Record<string, unknown>),
        }
        values.set(id, entryValues)
      }
      return {
        entry,
        inherited: structuredClone(entryValues.inherited),
        override: structuredClone(entryValues.override),
      }
    })
  }

  private inherited(entry: Entry, loaded: Profile): Record<string, unknown> {
    const rows = this.inheritedRows(loaded)
    return structuredClone(rows.get(entry.options.id) ?? {})
  }

  /** Compose one profile's inherited rows once, then serve every entry id from it. */
  private inheritedRows(loaded: Profile): Map<string, Record<string, unknown>> {
    let rows = this.inheritedRowsByProfile.get(loaded)
    if (rows !== undefined) return rows
    const patches = loaded.patches.map((patch) => {
      if (patch.config === undefined || patch.insert !== undefined) return patch
      const rest = { ...patch }
      Reflect.deleteProperty(rest, 'config')
      return rest
    })
    rows = new Map()
    for (const row of flatten(composeEntries([...loaded.layers.map(layer => layer.patches), patches]))) {
      // `.find` in the per-entry composition returned the first flattened
      // occurrence, so a repeated id keeps that first row's inherited config.
      if (!rows.has(row.id)) {
        rows.set(row.id, structuredClone((row.config ?? {}) as Record<string, unknown>))
      }
    }
    this.inheritedRowsByProfile.set(loaded, rows)
    return rows
  }

  /**
   * Insert a new top-level profile row and reconcile the Loader.
   *
   * The row is appended to the profile patch document (comment- and
   * form-preserving), validated by recomposition, written atomically under the
   * profile lock, and applied through the same reload path as {@link edit}.
   * @param row - unique entry id, module name, and complete raw config.
   * @returns Fulfillment after Loader reconciliation completes.
   * @throws When the id already exists as an entry or a top-level row, or the
   *   composed row does not carry exactly the supplied config.
   */
  async insert(row: { id: string; name: string; config: Record<string, unknown> }): Promise<void> {
    if (row.id.trim() === '') throw new Error('config-editor: row id must not be empty')
    const run = async (): Promise<void> => {
      await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), async () => {
        if (this.entries().some(entry => entry.options.id === row.id)) {
          throw new Error(`config-editor: entry "${row.id}" already exists`)
        }
        const path = this.documentPath
        let before: string
        try { before = await readFile(path, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          before = '[]\n'
        }
        const document = parseDocument(before, {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        })
        if (document.errors[0] !== undefined) throw document.errors[0]
        if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
        // Rows are created through an `insert` list: a bare `{ id, name, config }`
        // row is a patch that only targets an existing entry.
        const items = document.contents.items
        const duplicate = items.some((item, index) => {
          if (!isMap(item)) return false
          if (document.getIn([index, 'id']) === row.id) return true
          const insert = item.get('insert')
          return isSeq(insert) && insert.items.some(child => nodeId(child) === row.id)
        })
        if (duplicate) throw new Error(`config-editor: profile row "${row.id}" already exists`)
        document.add(document.createNode({ insert: [{ id: row.id, name: row.name, config: row.config }] }))
        const profile = this.ownerContext.profileContext
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const patches = readProfilePatches('dsh', profile, { ...loaded, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
        const effective = flatten(composeEntries([patches])).find(candidate => candidate.id === row.id)
        if (effective === undefined || !isDeepStrictEqual(effective.config ?? {}, row.config)) {
          throw new Error(`config-editor: inserted row "${row.id}" did not compose as declared`)
        }
        await writeFileAtomic(path, String(document), { mode: 0o600 })
        try {
          await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh', [row.id])
        } catch (error) {
          await writeFileAtomic(path, before, { mode: 0o600 })
          await reconcileProfilePatches(this.ownerContext.root, readProfilePatches('dsh', profile), 'dsh')
          throw error
        }
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }

  /**
   * Remove every top-level profile row for an entry id and reconcile the Loader.
   *
   * Only top-level rows are removable: a row inside another layer's `insert`
   * (a shipped declaration) is not owned by this document.
   * @param id - unique composition entry id.
   * @returns Fulfillment after Loader reconciliation completes.
   * @throws When no top-level row carries the id, or the id still composes
   *   after removal (for example when a bundle inserts it).
   */
  async remove(id: string): Promise<void> {
    const run = async (): Promise<void> => {
      await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), async () => {
        const path = this.documentPath
        let before: string
        try { before = await readFile(path, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          before = '[]\n'
        }
        const document = parseDocument(before, {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        })
        if (document.errors[0] !== undefined) throw document.errors[0]
        if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
        let found = false
        for (let index = document.contents.items.length - 1; index >= 0; index--) {
          const node = document.contents.items[index]
          if (!isMap(node)) continue
          const insert = node.get('insert')
          if (isSeq(insert)) {
            for (let child = insert.items.length - 1; child >= 0; child--) {
              if (nodeId(insert.items[child]) !== id) continue
              insert.delete(child)
              found = true
            }
            if (insert.items.length === 0) document.delete(index)
            continue
          }
          // Override/disabled rows for the same id belong to it and go with it.
          if (document.getIn([index, 'id']) === id) {
            document.delete(index)
            found = true
          }
        }
        if (!found) throw new Error(`config-editor: profile row "${id}" is not removable from this document`)
        const profile = this.ownerContext.profileContext
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const patches = readProfilePatches('dsh', profile, { ...loaded, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
        const remaining = flatten(composeEntries([patches])).find(candidate => candidate.id === id)
        if (remaining !== undefined) throw new Error(`config-editor: row "${id}" is still composed by another layer`)
        await writeFileAtomic(path, String(document), { mode: 0o600 })
        try {
          await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh')
        } catch (error) {
          await writeFileAtomic(path, before, { mode: 0o600 })
          await reconcileProfilePatches(this.ownerContext.root, readProfilePatches('dsh', profile), 'dsh')
          throw error
        }
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }

  /** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
   * References to model groups the LLM runtime cannot route are dropped from the candidate with a warning.
   * A derived candidate equal to the live entry config returns before the profile reload, so a no-op
   * edit raises no reload, document write, or update notification.
   * @param entry Current Loader entry, also used to detect replacement during the write.
   * @param change Derive a raw config from the current entry and its inherited layer; it must be
   * side-effect free because a committed edit invokes it for the no-op probe and again after the reload.
   * @returns Fulfillment after Loader reconciliation completes, or immediately for a no-op candidate.
   */
  async edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    // Every profile write re-applies this idempotent check, so a stale `chain`
    // reference a merge would otherwise carry over is repaired on the write
    // that would have resurrected it — not only at boot.
    const candidateOf = (current: Record<string, unknown>, inherited: Record<string, unknown>): Record<string, unknown> =>
      pruneUnusableChains(change(current, inherited), this.ownerContext.get('modelChains') as ModelChainRegistry | undefined, (fieldPath, value) => {
        this.ownerContext.logger.warn(`config-editor: dropped unusable chain "${value}" at ${fieldPath} of "${entry.options.id}": the model group is disabled, unknown, or unregistered`)
      })
    const loadInherited = (): Record<string, unknown> => this.inherited(entry, loadProfileDirectory('dsh', this.ownerContext.profileContext.dir, this.ownerContext.profileContext.installAnchor))
    const run = async (): Promise<void> => {
      const path = this.documentPath
      await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), async () => {
        if (!this.entries().includes(entry) || entry.fiber === undefined) throw new Error('Configuration entry is no longer available')
        // The no-op probe runs before the profile reload: a candidate equal to
        // the live config has nothing to persist, so returning here skips both
        // reconciles, the atomic patch write, the descriptor projection, and
        // the `app-boot/config-reload` / `settings/document-updated`
        // notifications that a committed write would raise.
        const probe = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
        if (isDeepStrictEqual(candidateOf(probe, loadInherited()), probe)) return
        const beforePatches = readProfilePatches('dsh', this.ownerContext.profileContext)
        await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
        if (!this.entries().includes(entry)) throw new Error('Configuration entry changed during reload')
        const current = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
        const inherited = loadInherited()
        const next = candidateOf(current, inherited)
        if (isDeepStrictEqual(next, current)) return
        const fiber = entry.fiber
        if (fiber.state !== FiberState.ACTIVE) throw new Error('Configuration plugin is no longer active')
        const resolved: unknown = fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)
        resolveConfig(fiber.runtime as NonNullable<typeof fiber.runtime>, resolved)
        let before: string
        try { before = await readFile(path, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          before = '[]\n'
        }
        const document = parseDocument(before, {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        })
        if (document.errors[0] !== undefined) throw document.errors[0]
        if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
        document.contents.flow = false
        const index = document.contents.items.findLastIndex((item, index) => isMap(item)
          && document.getIn([index, 'id']) === entry.options.id && !item.has('insert')
          && (!item.has('name') || document.getIn([index, 'name']) === entry.options.name))
        if (isDeepStrictEqual(next, inherited)) {
          for (let index = document.contents.items.length - 1; index >= 0; index--) {
            const row = document.contents.items[index]
            if (!isMap(row) || document.getIn([index, 'id']) !== entry.options.id || row.has('insert')) continue
            row.delete('config')
            if (row.items.length === Number(row.has('id')) + Number(row.has('name'))) document.delete(index)
          }
        } else if (index < 0) document.add(document.createNode({ id: entry.options.id, name: entry.options.name, config: next }))
        else document.setIn([index, 'config'], document.createNode(next))
        visit(document, { Map(_key, node) {
          if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
          const expression = new Scalar(node.get('__jsExpr'))
          expression.tag = 'tag:yaml.org,2002:js'
          return expression
        } })
        const profile = this.ownerContext.profileContext
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const patches = readProfilePatches('dsh', profile, { ...loaded, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
        const effective = flatten(composeEntries([patches])).find(row => row.id === entry.options.id)
        if (!isDeepStrictEqual(effective?.config ?? {}, next)) {
          throw new Error(`Configuration for "${entry.options.id}" is overridden by a home patch or command-line overlay`)
        }
        await writeFileAtomic(path, String(document), { mode: 0o600 })
        try {
          await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh', [entry.options.id])
        } catch (error) {
          await writeFileAtomic(path, before, { mode: 0o600 })
          await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
          throw error
        }
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }
}

export default ConfigEditor
