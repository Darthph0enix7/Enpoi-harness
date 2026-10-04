/**
 * enpoi-agent-switch — make a mid-session agent switch cache-preserving.
 *
 * Switching an agent preset normally reparents the agent's scope onto the new
 * preset's standing mount, which makes the new preset's `persona` row shadow
 * `deployment:persona-prefix` / `deployment:persona-suffix`; the assembled
 * system prompt then changes and every cached prompt prefix is invalidated.
 *
 * This plugin freezes the ORIGINAL preset's persona bytes on the agent's own
 * scope (a child scope shadows the standing mount for that name and restores
 * on disposal) so the system prompt stays byte-identical across the switch,
 * and delivers the NEWLY selected agent's identity + persona as a trailing
 * `agent-switch` runtime-context delta. Runtime context is materialized by the
 * agent loop as a durable user-role snapshot and is appended only when its
 * text differs, so a later switch logically replaces the delta in place
 * without touching earlier history.
 *
 * Public APIs only: `agentPresets.list()/read()`, `ctx.agents.get()`,
 * `systemPrompt.section()/context()/getSectionOrder()`, and the
 * `agent-preset/selected` event. Every failure logs once and leaves the
 * session working.
 * @module dsh-enpoi-agent-switch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { JSON_SCHEMA, Type, load as loadYaml } from 'js-yaml'

/** Cordis plugin name. */
export const name = 'enpoi-agent-switch'

/** Optional-only wiring: the agent registry, roster, and prompt service are resolved opportunistically. */
export const inject: string[] = []

/** The persona prefix section name the preset's `persona` row shadows. */
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** The persona suffix section name the preset's `persona` row shadows. */
export const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

/** Runtime-context name for the trailing agent-switch delta. */
export const DELTA_CONTEXT_NAME = 'agent-switch'

/**
 * Ordering slot for the delta. All built-in runtime contexts sit at 110–120
 * (sandbox/approval/subagent); 900 keeps the delta trailing without colliding.
 */
export const DELTA_CONTEXT_ORDER = 900

/** Module specifier of the persona row in a preset composition. */
const PERSONA_MODULE = '@deepseek-ai/dsh-persona'

/** The `!!js` YAML tag the Cordis loader dialect uses for evaluated expressions. */
const JS_TAG = 'tag:yaml.org,2002:js'

/**
 * Composition dialect matching the Loader's: `!!js` scalars are accepted (and
 * kept opaque) so a preset file carrying gated rows still parses here.
 */
const COMPOSITION_SCHEMA = JSON_SCHEMA.extend(new Type(JS_TAG, {
  kind: 'scalar',
  construct: (data: string) => ({ __jsExpr: String(data) }),
  represent: (data: unknown) => String((data as { __jsExpr?: unknown } | null)?.__jsExpr ?? ''),
}))

/** Persona text a preset's `persona` row contributes. */
export interface PersonaText {
  /** `config.prefix` — the `deployment:persona-prefix` section text. */
  readonly prefix: string
  /** `config.suffix` — the `deployment:persona-suffix` section text (empty when absent). */
  readonly suffix: string
  /** `config.complete` — whether the prefix is the entire system prompt. */
  readonly complete: boolean
}

/** One `systemPrompt.section()` input, structurally typed for tests. */
export interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly text: string
  readonly complete?: boolean
}

/** One `systemPrompt.context()` input, structurally typed for tests. */
export interface PromptContextLike {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** The agent-scoped slice of `systemPrompt` this plugin uses. */
export interface AgentPromptApi {
  getSectionOrder(name: 'DEPLOYMENT_PERSONA_PREFIX' | 'DEPLOYMENT_PERSONA_SUFFIX'): number
  section(section: PromptSectionLike): () => void
  context(context: PromptContextLike): () => void
}

/** One switch observed for one session. */
export interface SwitchView {
  /** Session whose agent preset changed. */
  readonly sessionId: string
  /** The preset just selected. */
  readonly presetId: string
  /** Creation-time preset from the session header, when present. */
  readonly headerPreset?: string
  /** Earliest `agent-preset/selected` value in the session log, when present. */
  readonly earliestSelected?: string
  /** The live agent's prompt API; absent when no live agent could be resolved. */
  readonly prompt?: AgentPromptApi
}

/** Injected side effects, so the controller is testable without a harness. */
export interface SwitchDeps {
  /** Read a preset's persona text; `undefined` when the roster/file is unavailable. */
  personaFor(presetId: string): Promise<PersonaText | undefined>
  /** Read a preset's display label; `undefined` falls back to the id. */
  labelFor(presetId: string): Promise<string | undefined>
  /** Log one failure (implementations dedupe per session). */
  log(sessionId: string, message: string): void
  /**
   * Hot in-memory persona lookup so a switch can register its delta without an
   * await: `null` = not warmed (cold), `undefined` = warmed and absent.
   * Omitted by structural tests that exercise only the async path.
   */
  cachedPersona?(presetId: string): PersonaText | undefined | null
  /** Hot in-memory label lookup; same `null`/`undefined` convention as {@link cachedPersona}. */
  cachedLabel?(presetId: string): string | undefined | null
}

/** One session's live shadow/delta registrations (fields appear as they install). */
interface SessionRecord {
  originalId?: string
  prefixDispose?: () => void
  suffixDispose?: () => void
  contextDispose?: () => void
}

/**
 * Resolve the session's ORIGINAL preset id from the ordered evidence.
 * @param input - header, tracked-projection, and earliest-log candidates.
 * @returns the first non-empty candidate, or `undefined` when none is known.
 */
export function resolveOriginalPreset(input: {
  headerPreset?: string
  projectionPreset?: string
  earliestSelected?: string
}): string | undefined {
  for (const candidate of [input.headerPreset, input.projectionPreset, input.earliestSelected]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * Compose the delta text: the operator-intent statement plus the new agent's
 * persona prose.
 * @param input - new preset id, display label, and persona (when known).
 * @returns the delta text registered as runtime context.
 */
export function composeDeltaText(input: {
  id: string
  label?: string
  persona?: PersonaText
}): string {
  const label = input.label !== undefined && input.label !== '' ? input.label : input.id
  const head = `The operator switched this session's agent. You now operate as ${label} (${input.id}).`
  if (input.persona === undefined) return head
  const parts = [head]
  const prefix = input.persona.prefix.trim()
  if (prefix !== '') parts.push(prefix)
  const suffix = input.persona.suffix.trim()
  if (suffix !== '') parts.push(suffix)
  return parts.join('\n\n')
}

/**
 * Find the persona row anywhere in a parsed composition and read its config.
 * @param rows - parsed composition rows (may nest inside groups).
 * @returns the persona text, or `undefined` when no persona row is present.
 */
function personaFromRows(rows: unknown): PersonaText | undefined {
  if (!Array.isArray(rows)) return undefined
  for (const value of rows) {
    if (value === null || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    if (row['group'] === true) {
      const nested = personaFromRows(row['config'])
      if (nested !== undefined) return nested
      continue
    }
    if (row['name'] !== PERSONA_MODULE) continue
    const config = row['config']
    if (config === null || typeof config !== 'object') continue
    const fields = config as Record<string, unknown>
    if (typeof fields['prefix'] !== 'string') continue
    return {
      prefix: fields['prefix'],
      suffix: typeof fields['suffix'] === 'string' ? fields['suffix'] : '',
      complete: fields['complete'] === true,
    }
  }
  return undefined
}

/**
 * Parse a preset composition and extract its persona config.
 *
 * The roster API (`agentPresets.list()` / `compositionInventory()`) exposes a
 * preset's display label but not its persona prose, so persona text comes from
 * the preset's composition file. Parsing uses the Loader's dialect (so `!!js`
 * gated rows do not break the read) and never throws.
 * @param text - raw `agent.cordis.yml` content.
 * @returns the persona text, or `undefined` for an unreadable or persona-less file.
 */
export function parsePersonaFromYaml(text: string): PersonaText | undefined {
  try {
    return personaFromRows(loadYaml(text, { schema: COMPOSITION_SCHEMA }))
  } catch {
    return undefined
  }
}

/** Render one error as a short message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns the per-session shadow and delta registrations.
 *
 * Switch handling is serialized per session so two rapid selections cannot
 * both register the one-shot shadow (which would throw on the duplicate name).
 */
export class AgentSwitchController {
  private readonly records = new Map<string, SessionRecord>()
  private readonly projection = new Map<string, string>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly deps: SwitchDeps) {}

  /**
   * Record the projection value observed at agent creation/resume.
   * @param sessionId - session whose agent appeared.
   * @param presetId - the projection's current preset, when known.
   */
  observe(sessionId: string, presetId: string | undefined): void {
    if (presetId !== undefined && presetId !== '') this.projection.set(sessionId, presetId)
  }

  /**
   * Handle one `agent-preset/selected`, serialized behind earlier work for the
   * session.
   *
   * When the persona/label cache is warm and no switch is in flight, the delta
   * is published synchronously — and the persona shadow installed synchronously
   * when the original persona is cached — so the turn immediately after a
   * committed switch always assembles with the `agent-switch` context present.
   * A cold datum (a preset authored at runtime) still gets an identity-only
   * delta synchronously, refined through the async path.
   * @param view - the switch and the evidence used to resolve the original.
   */
  onPresetSelected(view: SwitchView): Promise<void> {
    if (
      this.chains.get(view.sessionId) === undefined
      && this.deps.cachedPersona !== undefined && this.deps.cachedLabel !== undefined
    ) {
      if (this.processSync(view) !== 'deferred') return Promise.resolve()
    }
    const previous = this.chains.get(view.sessionId) ?? Promise.resolve()
    const run = previous.then(() => this.process(view))
    this.chains.set(view.sessionId, run.then(() => undefined, () => undefined))
    return run
  }

  /**
   * Dispose one session's shadow and delta (session/agent disposal).
   * @param sessionId - session leaving the registry.
   */
  release(sessionId: string): void {
    const record = this.records.get(sessionId)
    if (record !== undefined) {
      this.records.delete(sessionId)
      this.safeDispose(record.contextDispose)
      this.safeDispose(record.suffixDispose)
      this.safeDispose(record.prefixDispose)
    }
    this.chains.delete(sessionId)
  }

  /** Forget a session entirely, including its tracked projection value. */
  forget(sessionId: string): void {
    this.release(sessionId)
    this.projection.delete(sessionId)
  }

  /**
   * Synchronous switch handling for a warm cache. Publishes the delta first
   * (identity-only when a datum is cold) so the next turn can never miss it,
   * then installs the persona shadow when the original persona is cached.
   * @returns `complete` (nothing further needed), `deferred` (delta published;
   * cold data still needs the async path), or `handled` (terminal fail-open).
   */
  private processSync(view: SwitchView): 'complete' | 'deferred' | 'handled' {
    const { sessionId, presetId } = view
    try {
      const originalId = resolveOriginalPreset({
        ...view.headerPreset === undefined ? {} : { headerPreset: view.headerPreset },
        ...this.projection.get(sessionId) === undefined ? {} : { projectionPreset: this.projection.get(sessionId) },
        ...view.earliestSelected === undefined ? {} : { earliestSelected: view.earliestSelected },
      })
      let record = this.records.get(sessionId)
      if (record === undefined && originalId === undefined) {
        this.deps.log(sessionId, 'original agent preset unknown; session left unchanged')
        return 'handled'
      }
      if (view.prompt === undefined) {
        if (record === undefined) this.deps.log(sessionId, 'no live agent prompt scope; session left unchanged')
        return 'handled'
      }
      // `processSync` runs only with both hot-cache getters installed.
      const cachedPersona = this.deps.cachedPersona!(presetId)
      const cachedLabel = this.deps.cachedLabel!(presetId)
      let complete = cachedPersona !== null && cachedLabel !== null
      record = record ?? this.ensureRecord(sessionId)
      // Delta FIRST: the next turn must carry it even while the shadow's cold
      // persona bytes are still being read.
      this.registerDelta(
        sessionId, record, presetId, view.prompt,
        cachedPersona === null ? undefined : cachedPersona,
        cachedLabel === null ? undefined : cachedLabel,
      )
      this.projection.set(sessionId, presetId)
      // Freeze the ORIGINAL persona too, when its bytes are cached.
      if (record.prefixDispose === undefined && originalId !== undefined) {
        const original = this.deps.cachedPersona!(originalId)
        if (original === null) complete = false
        else if (original === undefined) {
          this.deps.log(sessionId, `persona for original preset "${originalId}" unavailable; not shadowing`)
        } else {
          this.installShadowInto(sessionId, record, originalId, original, view.prompt)
        }
      }
      return complete ? 'complete' : 'deferred'
    } catch (error: unknown) {
      this.deps.log(sessionId, `agent-switch handling failed: ${messageOf(error)}`)
      return 'handled'
    }
  }

  /** Install the original persona shadow once, then refresh the trailing delta. */
  private async process(view: SwitchView): Promise<void> {
    const { sessionId, presetId } = view
    try {
      let record = this.records.get(sessionId)
      if (record?.prefixDispose === undefined) {
        const originalId = resolveOriginalPreset({
          ...view.headerPreset === undefined ? {} : { headerPreset: view.headerPreset },
          ...this.projection.get(sessionId) === undefined ? {} : { projectionPreset: this.projection.get(sessionId) },
          ...view.earliestSelected === undefined ? {} : { earliestSelected: view.earliestSelected },
        })
        if (originalId === undefined) {
          this.deps.log(sessionId, 'original agent preset unknown; session left unchanged')
          return
        }
        if (view.prompt === undefined) {
          this.deps.log(sessionId, 'no live agent prompt scope; session left unchanged')
          return
        }
        const persona = await this.deps.personaFor(originalId)
        if (persona === undefined) {
          this.deps.log(sessionId, `persona for original preset "${originalId}" unavailable; not shadowing`)
          return
        }
        record = record ?? this.ensureRecord(sessionId)
        if (!this.installShadowInto(sessionId, record, originalId, persona, view.prompt)) return
      }
      await this.refreshDelta(sessionId, presetId, view.prompt)
    } catch (error: unknown) {
      this.deps.log(sessionId, `agent-switch handling failed: ${messageOf(error)}`)
    } finally {
      this.projection.set(sessionId, presetId)
    }
  }

  /** Get or create one session's record (delta may precede the shadow). */
  private ensureRecord(sessionId: string): SessionRecord {
    const existing = this.records.get(sessionId)
    if (existing !== undefined) return existing
    const record: SessionRecord = {}
    this.records.set(sessionId, record)
    return record
  }

  /** Register the prefix/suffix shadows on a record, rolling back a partial install. */
  private installShadowInto(
    sessionId: string,
    record: SessionRecord,
    originalId: string,
    persona: PersonaText,
    prompt: AgentPromptApi,
  ): boolean {
    let prefixDispose: (() => void) | undefined
    let suffixDispose: (() => void) | undefined
    try {
      prefixDispose = prompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: persona.prefix,
        ...persona.complete ? { complete: true } : {},
      })
      suffixDispose = prompt.section({
        name: PERSONA_SUFFIX_SECTION,
        order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        text: persona.suffix,
      })
    } catch (error: unknown) {
      this.safeDispose(suffixDispose)
      this.safeDispose(prefixDispose)
      this.deps.log(sessionId, `persona shadow registration failed: ${messageOf(error)}`)
      return false
    }
    record.originalId = originalId
    record.prefixDispose = prefixDispose
    record.suffixDispose = suffixDispose
    return true
  }

  /** Register the trailing delta on a record, replacing the previous in place. */
  private registerDelta(
    sessionId: string,
    record: SessionRecord,
    presetId: string,
    prompt: AgentPromptApi,
    persona: PersonaText | undefined,
    label: string | undefined,
  ): void {
    const text = composeDeltaText({
      id: presetId,
      ...label === undefined ? {} : { label },
      ...persona === undefined ? {} : { persona },
    })
    // The context name is unique per scope: dispose the previous contribution
    // first so a later switch replaces it in place rather than throwing.
    this.safeDispose(record.contextDispose)
    record.contextDispose = undefined
    try {
      record.contextDispose = prompt.context({ name: DELTA_CONTEXT_NAME, order: DELTA_CONTEXT_ORDER, text })
    } catch (error: unknown) {
      this.deps.log(sessionId, `delta context registration failed: ${messageOf(error)}`)
    }
  }

  /** Replace the session's delta with the newest preset's identity + persona. */
  private async refreshDelta(sessionId: string, presetId: string, prompt?: AgentPromptApi): Promise<void> {
    const record = this.records.get(sessionId)
    if (record === undefined || prompt === undefined) return
    const persona = await this.deps.personaFor(presetId)
    const label = await this.deps.labelFor(presetId)
    this.registerDelta(sessionId, record, presetId, prompt, persona, label)
  }

  /** Dispose without ever letting a dispose failure escape. */
  private safeDispose(dispose: (() => void) | undefined): void {
    if (dispose === undefined) return
    try {
      dispose()
    } catch {
      // A disposing scope would throw here; it cannot un-mount the session.
    }
  }
}

/** A live agent as this plugin reads it. */
interface AgentView {
  readonly id: string
  readonly session?: SessionLike
  readonly ctx?: { readonly systemPrompt?: AgentPromptApi }
}

/** The slice of a Session this plugin reads. */
interface SessionLike {
  readonly id?: string
  readonly header?: {
    readonly agentPreset?: string
    readonly meta?: { readonly agentPreset?: string }
  }
  ownEvents?(): readonly SessionEventLike[]
}

/** The slice of a session event this plugin reads. */
interface SessionEventLike {
  readonly type?: string
  readonly data?: { readonly agentPreset?: unknown }
}

/** Roster surface used for persona text and labels. */
interface RosterLike {
  /**
   * One preset's declared composition. The 0.1.7 service method is
   * `readDocument` (exported over Remote as `read`); the pre-0.1.7 engine
   * exposed a local `read`. Both answer `AgentPresetDocument`
   * (`{ agentPreset, content }`) or the raw YAML string.
   */
  readDocument?(id: string): Promise<string | { readonly content?: unknown }>
  read?(id: string): Promise<string | { readonly content?: unknown }>
  resolve(id?: string): Promise<{ readonly name?: string }>
  /** Unmemoized discovery; present on the real roster, omitted by structural tests. */
  list?(): Promise<readonly { readonly id?: string; readonly name?: string }[]>
}

/** Read the creation-time preset from a session header. */
export function readHeaderPreset(session: SessionLike | undefined): string | undefined {
  const header = session?.header
  const direct = header?.agentPreset
  if (typeof direct === 'string' && direct !== '') return direct
  const nested = header?.meta?.agentPreset
  return typeof nested === 'string' && nested !== '' ? nested : undefined
}

/** Read the earliest `agent-preset/selected` value from the session log. */
export function earliestLoggedPreset(session: SessionLike | undefined): string | undefined {
  try {
    for (const event of session?.ownEvents?.() ?? []) {
      const value = event?.data?.agentPreset
      if (event?.type === 'agent-preset/selected' && typeof value === 'string' && value !== '') return value
    }
  } catch {
    // A session without a readable log simply has no evidence.
  }
  return undefined
}

/** Resolve the live agent for a session, if the registry is present. */
function agentOf(ctx: Context, sessionId: string): AgentView | undefined {
  const registry = ctx.get('agents') as { get(id: string): AgentView | undefined } | undefined
  return registry?.get(sessionId)
}

/** Resolve the current projection value, falling back to the header. */
function currentPreset(ctx: Context, session: SessionLike | undefined): string | undefined {
  const projections = ctx.get('sessionProjections') as {
    stateOf(session: unknown, key: string): unknown
  } | undefined
  try {
    const value = session === undefined ? undefined : projections?.stateOf(session, 'agentPreset')
    if (typeof value === 'string' && value !== '') return value
  } catch {
    // Fall through to the header.
  }
  return readHeaderPreset(session)
}

/**
 * Extract the YAML composition from one roster `read` answer. The 0.1.7
 * registry answers `AgentPresetDocument` (`{ agentPreset, content }`); earlier
 * engines answered the raw YAML string. Without this the warm cache held
 * `undefined` for every preset and the switch never froze the original persona
 * (the system prompt rebuilt on every agent switch).
 * @param document - the roster answer.
 * @returns the composition YAML, or undefined when the answer carries none.
 */
export function compositionContentOf(document: unknown): string | undefined {
  if (typeof document === 'string') return document
  if (document === null || typeof document !== 'object') return undefined
  const content = (document as { content?: unknown }).content
  return typeof content === 'string' ? content : undefined
}

/** Read a preset's raw composition from the roster. */
export async function loadComposition(ctx: Context, presetId: string): Promise<string | undefined> {
  const roster = ctx.get('agentPresets') as RosterLike | undefined
  if (roster === undefined) return undefined
  // 0.1.7 renamed the local method to `readDocument` (Remote export `read`);
  // keep the old name as the fallback for engines that still expose it.
  const read = roster.readDocument?.bind(roster) ?? roster.read?.bind(roster)
  if (read === undefined) return undefined
  try {
    return compositionContentOf(await read(presetId))
  } catch {
    return undefined
  }
}

/** Load one preset's persona text. */
async function loadPersona(ctx: Context, presetId: string): Promise<PersonaText | undefined> {
  const composition = await loadComposition(ctx, presetId)
  return composition === undefined ? undefined : parsePersonaFromYaml(composition)
}

/** Load one preset's display label. */
async function loadLabel(ctx: Context, presetId: string): Promise<string | undefined> {
  const roster = ctx.get('agentPresets') as RosterLike | undefined
  if (roster === undefined) return undefined
  try {
    return (await roster.resolve(presetId)).name
  } catch {
    return undefined
  }
}

/**
 * Mount the agent-switch cache-preservation plugin.
 * @param ctx - profile plugin Context.
 */
export function apply(ctx: Context): void {
  const logged = new Set<string>()
  // Pre-warm the persona/label cache so a switch's delta registers without an
  // await. Discovery is unmemoized, so a cache miss (a preset authored while
  // the process runs) re-warms and falls back to the async read.
  const personas = new Map<string, PersonaText | undefined>()
  const labels = new Map<string, string | undefined>()
  let warming: Promise<void> | undefined
  let warmedAt = 0
  const warm = (): Promise<void> => {
    const roster = ctx.get('agentPresets') as RosterLike | undefined
    if (roster?.list === undefined) return Promise.resolve()
    if (warming !== undefined) return warming
    if (Date.now() - warmedAt < 2_000) return Promise.resolve()
    warmedAt = Date.now()
    warming = (async () => {
      try {
        for (const preset of await roster.list!()) {
          const id = preset?.id
          if (typeof id !== 'string' || id === '') continue
          labels.set(id, typeof preset.name === 'string' && preset.name !== '' ? preset.name : undefined)
          const composition = await loadComposition(ctx, id)
          personas.set(id, composition === undefined ? undefined : parsePersonaFromYaml(composition))
        }
      } catch {
        // A roster that cannot be listed leaves the async fallback intact.
      } finally {
        warming = undefined
      }
    })()
    return warming
  }
  const cachedPersona = (presetId: string): PersonaText | undefined | null => {
    if (!personas.has(presetId)) { void warm(); return null }
    return personas.get(presetId)
  }
  const cachedLabel = (presetId: string): string | undefined | null => {
    if (!labels.has(presetId)) { void warm(); return null }
    return labels.get(presetId)
  }
  void warm()
  const controller = new AgentSwitchController({
    personaFor: presetId => loadPersona(ctx, presetId),
    labelFor: presetId => loadLabel(ctx, presetId),
    cachedPersona,
    cachedLabel,
    log: (sessionId, message) => {
      const key = `${sessionId}\u0000${message}`
      if (logged.has(key)) return
      logged.add(key)
      try {
        ;(ctx.logger as { warn?: (format: string) => void } | undefined)?.warn?.(
          `enpoi-agent-switch: ${message} (session ${sessionId})`,
        )
      } catch {
        // Diagnostics must never break the switch path.
      }
    },
  })

  for (const agent of (ctx.get('agents') as { list(): AgentView[] } | undefined)?.list() ?? []) {
    controller.observe(agent.id, currentPreset(ctx, agent.session))
  }

  // Mount-time evidence. This harness installs no logger exporter for `info`
  // (app-boot's only exporter captures warn/error), so `ctx.logger.info` here
  // is a silent no-op; write to stderr — the channel enpoi-capabilities uses —
  // so a restart's journal proves whether this plugin mounted.
  process.stderr.write('[enpoi-agent-switch] mounted\n')

  // The switch is observed through the SESSION EVENT STREAM, not the
  // `agent-preset/selected` emit: that emit comes from the agent-presets
  // plugin's own context, which a profile plugin does not receive (Cordis
  // events are context-scoped), while a logged session event is host-wide.
  ctx.on('session/event', (session, rawEvent) => {
    // The fork/plugin event vocabulary is registered at runtime but not part of
    // the typed union, so the payload is read structurally.
    const event = rawEvent as unknown as { type?: string; data?: { agentPreset?: unknown } }
    if (event.type !== 'agent-preset/selected') return
    const presetId = event.data?.agentPreset
    if (typeof presetId !== 'string' || presetId === '') return
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    const agent = agentOf(ctx, sessionId)
    if (agent === undefined) {
      // No live agent: nothing to freeze or announce. Drop any stale record.
      controller.forget(sessionId)
      return
    }
    const prompt = agent.ctx?.systemPrompt
    controller.observe(sessionId, presetId)
    // Re-warm in the background so a preset authored or edited during the
    // process run converges for later switches (throttled inside `warm`).
    void warm()
    // The framework Session is structurally the evidence these helpers read.
    const evidence = session as unknown as SessionLike
    const headerPreset = readHeaderPreset(evidence)
    const earliestSelected = earliestLoggedPreset(evidence)
    void controller.onPresetSelected({
      sessionId,
      presetId,
      ...headerPreset === undefined ? {} : { headerPreset },
      ...earliestSelected === undefined ? {} : { earliestSelected },
      ...prompt === undefined ? {} : { prompt },
    })
  })
}
