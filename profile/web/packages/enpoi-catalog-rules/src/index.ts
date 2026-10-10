/**
 * enpoi-catalog-rules — dynamic rule/filter engine for the model catalogue.
 *
 * Reads `enpoi-orchestration.catalogRules` (rules as data, versioned and
 * operator-editable) and the synced `llm-pi-ai` catalogue, then provides the
 * `catalogRules` service other plugins and UI surfaces resolve through:
 *
 *   ctx.get('catalogRules').visibility()             // every decision + warnings
 *   ctx.get('catalogRules').decide(provider, model)  // picker fast path
 *   ctx.get('catalogRules').expandSelector(selector) // group selector → links
 *   ctx.get('catalogRules').previewRulesChange(raw)  // before/after edit diff
 *
 * Rules are evaluated fresh on every settings update; the engine publishes only
 * its derived `catalogRules.resolved` decision map (never the rules document)
 * and never deletes catalogue entries (hide ≠ delete). On a host that serves
 * the settings artifact channel the map is published there instead of into the
 * configuration document, so publishing it costs no document revision, profile
 * write, Loader reload, or whole-document fan-out; a pre-artifact host keeps
 * the legacy document write. All warnings go to stderr — this harness's logger
 * drops info/warn, so stderr is the observable channel.
 */

import type { Context } from '@deepseek-ai/cordis'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import {
  buildResolvedVisibility, diffRules, evaluateVisibility, isGated, isRecord, parseRulesDocument, resolvePrivacy, withHiddenPins, withShownPins,
  type CatalogEntry, type ParsedRules, type RulesDiff, type VisibilityDecision, type VisibilityReport,
} from './rules.ts'
import { expandSelector, parseGroupSelector, type GroupSelector, type SelectorExpansion } from './selectors.ts'
import { readCatalogue } from './catalogue.ts'

export const name = 'enpoi-catalog-rules'

/** The settings service must be up before the namespace can be read. */
export const inject = ['settings']

/** Namespace that owns `catalogRules` (declared by enpoi-capabilities). */
const ORCH_NS = 'enpoi-orchestration'

/** One settings set-operation; structural subset of the settings seam. */
interface SettingsPathOp {
  op: 'set'
  path: string[]
  value?: unknown
}

/** The settings write seam the resolved-map publisher probes for. */
interface SettingsPublisher {
  /** Revision-fenced namespace write (0.1.7+). */
  mutate?: (ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number) => Promise<void>
  /** Descriptor set carrying each namespace's current revision. */
  describe?: () => ReadonlyArray<{ ns: string; revision?: number }>
}

/** The derived-artifact seam the resolved map moves to when the host serves it (0.1.8+). */
interface SettingsArtifacts {
  /** Publish a derived value beside the configuration document; revision moves only when it changes. */
  publishArtifact?: (key: string, value: unknown) => number
}

/** Artifact name the picker reads `catalogRules.resolved` under. */
const RESOLVED_ARTIFACT = 'catalogRules.resolved'

/** The service contract consumers call through `ctx.get('catalogRules')`. */
export interface CatalogRulesService {
  /** Evaluate every catalogue entry against the current rules document. */
  visibility(): VisibilityReport
  /** Decide one entry; undefined when the catalogue does not carry it. */
  decide(provider: string, modelId: string): VisibilityDecision | undefined
  /** Expand one group selector against the live catalogue (best-first). */
  expandSelector(selector: GroupSelector): SelectorExpansion
  /** Parse and expand one raw selector (the model-chains seam). */
  expandRawSelector(raw: unknown): SelectorExpansion
  /** Diff a proposed rules document against the live one over the catalogue. */
  previewRulesChange(nextRaw: unknown): RulesDiff
  /** Current discipline warnings (empty rules, stale pins). */
  warnings(): readonly string[]
}

/**
 * Stateful rules engine: caches the parsed document, the projected catalogue,
 * the gated merge, and the per-entry decision map; `refresh()` re-reads on
 * settings events. All evaluation is synchronous, so a picker call never
 * awaits.
 */
export class CatalogRulesEngine implements CatalogRulesService {
  private rules: ParsedRules
  private entries: CatalogEntry[]
  private report: VisibilityReport
  private decisions = new Map<string, VisibilityDecision>()

  /**
   * @param readRules - reads the raw `catalogRules` value (ctx-bound in production).
   * @param readCatalogue - reads the live catalogue snapshot (ctx-bound in production).
   * @param readHiddenPins - reads `uiPreferences.hiddenModels`, the picker's manual hidden pins.
   * @param readShownPins - reads `uiPreferences.shownModels`, the picker's manual shown pins.
   */
  constructor(
    private readonly readRules: () => unknown,
    private readonly readCatalogue: () => CatalogEntry[],
    private readonly readHiddenPins: () => unknown = () => undefined,
    private readonly readShownPins: () => unknown = () => undefined,
  ) {
    this.rules = parseRulesDocument(undefined)
    this.entries = []
    this.report = { decisions: [], warnings: [] }
    this.refresh()
  }

  /** Re-read the rules document and catalogue; rebuilding every derived view. */
  refresh(): void {
    this.rules = withShownPins(withHiddenPins(parseRulesDocument(this.readRules()), this.readHiddenPins()), this.readShownPins())
    const entries = this.readCatalogue().map(entry => ({
      ...entry,
      ...(isGated(entry, this.rules) ? { gated: true } : {}),
    }))
    this.entries = entries
    this.report = evaluateVisibility(entries, this.rules)
    this.decisions = new Map(this.report.decisions.map(decision => [`${decision.provider}/${decision.model}`, decision]))
  }

  /** Current parsed document (exposed for callers that need the raw clauses). */
  parsed(): ParsedRules {
    return this.rules
  }

  /** Current catalogue snapshot with gated markers merged in. */
  catalogue(): readonly CatalogEntry[] {
    return this.entries
  }

  visibility(): VisibilityReport {
    return this.report
  }

  decide(provider: string, modelId: string): VisibilityDecision | undefined {
    return this.decisions.get(`${provider}/${modelId}`)
  }

  expandSelector(selector: GroupSelector): SelectorExpansion {
    return expandSelector(selector, this.entries, this.rules.privacy)
  }

  expandRawSelector(raw: unknown): SelectorExpansion {
    const warnings: string[] = []
    const selector = parseGroupSelector(raw, line => warnings.push(line))
    if (selector === undefined) {
      return { links: [], matched: 0, warnings: Object.freeze(warnings.length > 0 ? warnings : ['selector ignored']) }
    }
    const expansion = expandSelector(selector, this.entries, this.rules.privacy)
    return { ...expansion, warnings: Object.freeze([...warnings, ...expansion.warnings]) }
  }

  previewRulesChange(nextRaw: unknown): RulesDiff {
    // The proposed document inherits the picker's manual pins, exactly as the
    // live document does — otherwise the diff would misreport them as removed.
    const next = withShownPins(withHiddenPins(parseRulesDocument(nextRaw), this.readHiddenPins()), this.readShownPins())
    return diffRules(this.rules, next, this.entries)
  }

  warnings(): readonly string[] {
    return this.report.warnings
  }
}

/**
 * Mount the `catalogRules` service and keep it in step with the namespace.
 * @param ctx - profile plugin Context.
 */
export function apply(ctx: Context): void {
  const settings = (): SettingsDocumentReader | undefined => ctx.get('settings') as SettingsDocumentReader | undefined
  const engine = new CatalogRulesEngine(
    () => {
      const document = readOrchestrationDocument(settings())
      return document?.catalogRules
    },
    () => readCatalogue(settings()),
    () => {
      const document = readOrchestrationDocument(settings())
      const preferences = document?.uiPreferences
      return isRecord(preferences) ? preferences.hiddenModels : undefined
    },
    () => {
      const document = readOrchestrationDocument(settings())
      const preferences = document?.uiPreferences
      return isRecord(preferences) ? preferences.shownModels : undefined
    },
  )
  const emitted = new Set<string>()
  const emitWarnings = (): void => {
    for (const warning of engine.warnings()) {
      if (emitted.has(warning)) continue
      emitted.add(warning)
      process.stderr.write(`[enpoi-catalog-rules] ${warning}\n`)
    }
  }
  /**
   * Publish the compact resolved map the picker reads. The map is derived, so
   * on a host that serves the settings artifact channel it is published there
   * (`settings.publishArtifact`) and never enters the configuration document;
   * that removes the 100 KB-class document write and the whole-document
   * re-read it forced on every client. A host without the channel keeps the
   * legacy document write under `catalogRules.resolved`. Both paths skip when
   * the map has not moved, and reads stay the only input to the engine.
   */
  let lastPublished: string | undefined
  const publishResolved = (): void => {
    const next = buildResolvedVisibility(engine.visibility().decisions)
    const serialized = JSON.stringify(next)
    if (serialized === lastPublished) return
    const writer = ctx.get('settings') as (SettingsPublisher & SettingsArtifacts) | undefined
    if (writer?.publishArtifact !== undefined) {
      lastPublished = serialized
      writer.publishArtifact(RESOLVED_ARTIFACT, next)
      return
    }
    void publishResolvedDocument(writer, next, serialized)
  }
  /** Legacy document publisher for hosts without the artifact channel. */
  const publishResolvedDocument = async (writer: SettingsPublisher | undefined, next: unknown, serialized: string): Promise<void> => {
    if (writer?.mutate === undefined) return
    const document = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const rules = document?.catalogRules
    const current = isRecord(rules) ? rules.resolved : undefined
    if (JSON.stringify(current ?? null) === serialized) {
      lastPublished = serialized
      return
    }
    const revision = writer.describe?.().find(entry => entry.ns === ORCH_NS)?.revision
    // Claim the map before the first await so a settings event raised by this
    // very write cannot queue a duplicate publish.
    lastPublished = serialized
    for (let attempt = 0; ; attempt += 1) {
      try {
        await writer.mutate(ORCH_NS, [{ op: 'set', path: ['catalogRules', 'resolved'], value: next }], revision)
        return
      } catch (error) {
        const conflict = error as { code?: string }
        if ((conflict?.code === 'SETTINGS_CONFLICT' || conflict?.code === 'settings/conflict') && attempt < 2) continue
        // A refused write must not block a later attempt after the next change.
        lastPublished = undefined
        process.stderr.write(`[enpoi-catalog-rules] resolved map publish failed: ${error instanceof Error ? error.message : String(error)}\n`)
        return
      }
    }
  }
  /**
   * Remove the persisted map the pre-artifact publisher wrote into
   * `enpoi-orchestration`. It is derived data now riding the artifact channel;
   * leaving it in user config would keep every describe (and every client read)
   * carrying its bytes. Runs at mount and again on every settings event, so a
   * refused removal (a nested HMR transaction, a revision conflict) retries
   * until it lands; the check is a document read once the map is gone.
   */
  let removalWarned = false
  const removeDocumentMap = (): void => {
    const writer = ctx.get('settings') as (SettingsPublisher & SettingsArtifacts) | undefined
    if (writer?.publishArtifact === undefined || writer.mutate === undefined) return
    const document = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const rules = document?.catalogRules
    if (!isRecord(rules) || rules.resolved === undefined) return
    const revision = writer.describe?.().find(entry => entry.ns === ORCH_NS)?.revision
    void writer.mutate(ORCH_NS, [{ op: 'unset', path: ['catalogRules', 'resolved'] }], revision).catch((error: unknown) => {
      if (removalWarned) return
      removalWarned = true
      process.stderr.write(`[enpoi-catalog-rules] resolved map removal failed: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }
  ctx.provide('catalogRules', engine)
  emitWarnings()
  removeDocumentMap()
  publishResolved()
  const onNamespaceChange = ((ns: unknown) => {
    if (String(ns) !== ORCH_NS && String(ns) !== 'llm-pi-ai') return
    engine.refresh()
    emitWarnings()
    removeDocumentMap()
    publishResolved()
  }) as (...args: unknown[]) => unknown
  ctx.on('settings/document-updated', onNamespaceChange)
  ctx.on('settings/updated', onNamespaceChange)
  process.stderr.write('[enpoi-catalog-rules] mounted\n')
}

export {
  buildResolvedVisibility, diffRules, evaluateVisibility, formatHiddenReason, parseRulesDocument, resolvePrivacy, withHiddenPins, withShownPins,
  type CatalogEntry, type CatalogPredicate, type HideRule, type ModelOverrides, type ParsedRules,
  type PrivacyOverrides, type PrivacyVerdict, type ResolvedVisibilityEntry, type RulesDiff,
  type VisibilityDecision, type VisibilityReport,
} from './rules.ts'
export { expandSelector, parseGroupSelector, type GroupSelector, type SelectorExpansion, type SelectorMatch } from './selectors.ts'
export { readCatalogue } from './catalogue.ts'
