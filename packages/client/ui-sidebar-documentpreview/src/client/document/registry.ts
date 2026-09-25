/** File-extension preview registrations; component dispatch belongs to the keyed document slot. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { documentFileName, matchedSuffixLength, normalizeSuffix } from './suffix.ts'

/** Shared text or byte reads, or content loading owned by the renderer. */
export type DocumentLoadMode = 'text-pages' | 'bytes-complete' | 'renderer'

/** What a renderer declares about its own navigation surface. */
export interface DocumentPreviewCapabilities {
  /** The renderer answers the toolbar's find-in-file command. */
  readonly search?: boolean
  /** The renderer answers the toolbar's go-to-line command. */
  readonly gotoLine?: boolean
  /**
   * The renderer draws a served comparison. The pane selects the definition
   * carrying this flag when the file's navigation parameters request a diff
   * (`{ diff: … }`), instead of deriving candidates from the file's suffix.
   * The renderer owns its content channel: the comparison is fetched by the
   * body, never paged in by the pane.
   */
  readonly diff?: boolean
}

/** One renderer implementation, independent of its component registration. */
export interface DocumentPreviewDefinition {
  /** Unique implementation name, also used as the document slot key. */
  readonly id: string
  /** File suffixes without a leading dot; compound suffixes such as tar.gz are accepted. */
  readonly extensions: readonly string[]
  /**
   * Suffixes among `extensions` whose bytes are not readable text; a file
   * matching one loses the plain-text fallback among its viewer choices.
   * Every entry must appear in `extensions`; `register` rejects strays.
   */
  readonly binaryExtensions?: readonly string[]
  /**
   * Band this implementation competes in. External implementations win over
   * product implementations, and the explicit `editor` tier loses to both so an
   * editing surface can be offered without ever being chosen automatically;
   * defaults to extension.
   */
  readonly priority?: 'builtin' | 'extension' | 'editor'
  /**
   * Whether this implementation is the automatic choice among its matches.
   * A `preferred` implementation outranks the band order below; a remembered
   * display pick, an in-memory tab pick, and a requested comparison still win
   * over it. The editing surface marks itself preferred so opening an editable
   * text file lands in the workbench instead of a read-only renderer; binary
   * and non-text types keep their own previews because the editor's suffix
   * list never matches them.
   */
  readonly preferred?: boolean
  /** Localized implementation label, evaluated when the toolbar renders. @returns the visible name. */
  readonly title: () => string
  /** Content delivery mode supplied by the document owner. */
  readonly loading: DocumentLoadMode
  /** Whether the implementation consumes the document's wrap preference. */
  readonly wrap?: boolean
  /** Which toolbar navigation entries the implementation answers; absent hides them. */
  readonly capabilities?: DocumentPreviewCapabilities
}

/** Automatic-selection rank; a missing band is the default external band and `editor` is deliberately last. */
function rankOf(priority: DocumentPreviewDefinition['priority']): number {
  if (priority === 'editor') return 0
  if (priority === 'builtin') return 1
  return 2
}

/**
 * Rank an observed definition snapshot without consulting mutable service state.
 * @param definitions - registered implementations in registration order.
 * @param path - decoded filename or file path.
 * @returns matching implementations: a `preferred` implementation first, then external band before
 * product band, then longest suffix, with the explicit `editor` band last among non-preferred entries.
 */
export function matchingDocumentPreviews(
  definitions: readonly DocumentPreviewDefinition[],
  path: string,
): readonly DocumentPreviewDefinition[] {
  const name = documentFileName(path)
  return definitions.map((definition, order) => ({
    definition, order,
    rank: rankOf(definition.priority),
    length: matchedSuffixLength(name, definition.extensions),
  }))
    .filter(candidate => candidate.length > 0)
    .sort((left, right) =>
      Number(right.definition.preferred === true) - Number(left.definition.preferred === true)
      || right.rank - left.rank || right.length - left.length || left.order - right.order)
    .map(candidate => candidate.definition)
}

/**
 * Whether any registered implementation declares the filename's suffix binary.
 * @param definitions - registered implementations.
 * @param path - decoded filename or file path.
 * @returns true when a declared binary suffix matches the filename.
 */
export function binaryDocumentPath(
  definitions: readonly DocumentPreviewDefinition[],
  path: string,
): boolean {
  const name = documentFileName(path)
  return definitions.some(definition => matchedSuffixLength(name, definition.binaryExtensions ?? []) > 0)
}

/** Observable registry of all live implementations, including lower-priority alternatives. */
export class DocumentPreviewRegistry {
  private readonly registered = new Map<string, DocumentPreviewDefinition>()
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly DocumentPreviewDefinition[] = []

  /**
   * Read the current registrations.
   * @returns the same snapshot until a registration changes.
   */
  readonly getSnapshot = (): readonly DocumentPreviewDefinition[] => this.snapshot

  /**
   * Observe registration changes.
   * @param listener - registration-change observer.
   * @returns its disposer.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Register metadata separately from the matching keyed slot component.
   * @param definition - unique implementation and recognized suffixes; every
   * `binaryExtensions` entry must appear in `extensions`.
   * @returns an idempotent disposer; duplicate live implementation names and
   * binary suffixes outside `extensions` throw.
   */
  register(definition: DocumentPreviewDefinition): () => void {
    if (this.registered.has(definition.id)) {
      throw new Error(`documentPreviews: duplicate implementation "${definition.id}"`)
    }
    const declared = new Set(definition.extensions.map(normalizeSuffix))
    for (const extension of definition.binaryExtensions ?? []) {
      if (!declared.has(normalizeSuffix(extension))) {
        throw new Error(`documentPreviews: "${definition.id}" declares binary suffix "${extension}" outside its extensions`)
      }
    }
    this.registered.set(definition.id, definition)
    this.publish()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.registered.delete(definition.id)
      this.publish()
    }
  }

  /**
   * List every matching implementation in automatic-selection order.
   * @param path - decoded file path; matching never resolves filesystem access.
   * @returns extension band first, then longest suffix, then registration order, with `editor` last.
   */
  candidates(path: string): readonly DocumentPreviewDefinition[] {
    return matchingDocumentPreviews(this.snapshot, path)
  }

  private publish(): void {
    this.snapshot = [...this.registered.values()]
    notifySubscribers(this.listeners, '[document-previews] registry')
  }
}
