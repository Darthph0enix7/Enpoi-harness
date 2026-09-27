/**
 * Client mirror of the Host settings document: the one `settings.describe`
 * reader in the browser. Every settings consumer derives from this store —
 * shared entry forms through `ConfigForms.get`, cross-namespace
 * surfaces through the provider's shared describe face — so startup cost and
 * freshness are properties of this class, not of how many features own a
 * preference. The Host stays the fact source: the mirror re-reads on the
 * invalidations its owning plugin subscribes to and folds write answers in
 * through {@link SettingsDescribeMirror.acceptView}.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, notifySubscribers, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The full `settings.describe` answer the mirror serves. */
export interface SettingsDescribeView {
  /** Every namespace a live Host plugin registered, as the Host reported it. */
  namespaces: readonly SettingsNamespaceView[]
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Whether a native settings document exists for the Host to open. */
  hasDocument: boolean
}

/**
 * Structural equality for the JSON-shaped section values the mirror carries;
 * a settings form uses it to recognize a same-revision row whose projected
 * value still moved.
 * @param left - left JSON value.
 * @param right - right JSON value.
 * @returns whether both encode the same value.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((entry, index) => sameJson(entry, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  if (keys.length !== Object.keys(rightRecord).length) return false
  return keys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key)
    && sameJson(leftRecord[key], rightRecord[key]))
}

/** Mirror state every derived settings surface renders from. */
export interface SettingsMirrorSnapshot {
  /**
   * `unavailable` is the terminal non-loopback state; `ready` persists across
   * later failed refreshes (the held view keeps serving); `idle` means no
   * answer is held and no read is running, so `ensure` will start one.
   */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** The last good answer; undefined until the first success. */
  view: SettingsDescribeView | undefined
  /** The latest refresh failure message, cleared by the next success. */
  error: string | null
}

/**
 * The mirror as cross-namespace surfaces consume it: current answer,
 * subscription, first-use read, and the write-answer fold. `load` stays off
 * this face — invalidation refreshes belong to the mirror's owning plugin.
 */
export interface SettingsDescribeFace {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsMirrorSnapshot
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Resolve once an answer is held (or the mirror is terminally unavailable),
   * reading only from `idle`.
   * @returns settlement of the current or newly started read, if any.
   */
  ensure(): Promise<void>
  /**
   * Fold one write answer's namespace view into the held view without a wire
   * read, invalidating any older read still in flight.
   * @param view - the namespace view a settings write answered with.
   */
  acceptView(view: SettingsNamespaceView): void
}

/**
 * Serializes every Host `settings.describe` read behind one snapshot store.
 * Concurrent {@link load} calls fold into the in-flight read plus one rerun,
 * so an invalidation arriving mid-read is never lost and never duplicated.
 */
export class SettingsDescribeMirror implements SettingsDescribeFace {
  private readonly store: SnapshotStore<SettingsMirrorSnapshot>
  /** Per-namespace listeners, notified only when their row is replaced. */
  private readonly namespaceListeners = new Map<string, Set<() => void>>()
  /** Namespaces with a local write crossing the wire, and how many. */
  private readonly writesInFlight = new Map<string, number>()
  /** Commit revisions announced while a local write was in flight. */
  private readonly deferredEchoes = new Map<string, number>()
  /**
   * Highest revision folded from this client's own write answers, by
   * namespace: the echo of that commit needs no read. Only folds count — a
   * revision merely held from a read cannot cover an announcement, because a
   * page-policy change (autoGenerate) emits with an unchanged revision.
   */
  private readonly foldedRevisions = new Map<string, number>()
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0

  /**
   * @param ctx - the providing plugin's context, whose `remote.settings`
   * namespace answers the describe read.
   * @param persistence - client-selected Host persistence; non-loopback pages may remain process-local.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly persistence: 'host' | 'memory' = 'host',
  ) {
    this.store = createSnapshotStore<SettingsMirrorSnapshot>({
      status: persistence === 'host' ? 'idle' : 'unavailable',
      view: undefined,
      error: null,
    })
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsMirrorSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Observe one namespace's row: the listener runs only when a publication
   * carries a row for `ns` different from the previous one, so a commit to an
   * unrelated namespace wakes nothing. Wire re-reads reuse the held row of
   * every namespace whose revision did not move, so an echo that changed one
   * namespace still notifies only that namespace's listeners.
   * @param ns - settings namespace identity.
   * @param listener - invoked after a publication replaces that namespace's row.
   * @returns the disposer removing this listener.
   */
  subscribeNamespace(ns: string, listener: () => void): () => void {
    let listeners = this.namespaceListeners.get(ns)
    if (listeners === undefined) {
      listeners = new Set()
      this.namespaceListeners.set(ns, listeners)
    }
    listeners.add(listener)
    return () => {
      const current = this.namespaceListeners.get(ns)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.namespaceListeners.delete(ns)
    }
  }

  /**
   * Note that a local write for `ns` is crossing the wire: a
   * `document-updated` announcement for it arriving before the answer is
   * deferred, because the answer itself folds the committed revision and a
   * read would only re-fetch the document the answer already carries.
   * @param ns - settings namespace identity.
   */
  expectWrite(ns: string): void {
    this.writesInFlight.set(ns, (this.writesInFlight.get(ns) ?? 0) + 1)
  }

  /**
   * Note that one local write for `ns` settled, folding the answer first. The
   * last settle flushes a commit revision announced while the write was in
   * flight unless the folded view already carries it.
   * @param ns - settings namespace identity.
   */
  settleWrite(ns: string): void {
    const remaining = (this.writesInFlight.get(ns) ?? 1) - 1
    if (remaining > 0) {
      this.writesInFlight.set(ns, remaining)
      return
    }
    this.writesInFlight.delete(ns)
    const announced = this.deferredEchoes.get(ns)
    if (announced === undefined) return
    this.deferredEchoes.delete(ns)
    const folded = this.foldedRevisions.get(ns)
    if (folded !== undefined && folded >= announced) return
    void this.load()
  }

  /**
   * Note one namespace commit announced by the Host. A revision this client
   * folded from its own write answer needs no read, and one announced while a
   * local write for the namespace is in flight defers to that write's answer.
   * Everything else reads: the announcement carries no page-policy bit, so a
   * revision the document merely holds cannot prove the commit is old news.
   * @param ns - settings namespace identity.
   * @param revision - the revision the Host announced.
   */
  invalidate(ns: string, revision: number): void {
    const folded = this.foldedRevisions.get(ns)
    if (folded !== undefined && folded >= revision) return
    if ((this.writesInFlight.get(ns) ?? 0) > 0) {
      this.deferredEchoes.set(ns, revision)
      return
    }
    void this.load()
  }

  /**
   * Refresh from the Host. A call during an in-flight read marks one rerun
   * after it settles instead of racing a second wire read.
   * @returns settlement after this call's freshness is reflected.
   */
  load(): Promise<void> {
    if (this.persistence === 'memory') return Promise.resolve()
    if (this.inFlight !== undefined) {
      this.rerun = true
      return this.inFlight
    }
    // Own the slot before the loading publication can synchronously reenter load().
    const run = Promise.resolve().then(() => this.run())
    this.inFlight = run
    return run
  }

  /**
   * Resolve once an answer is held (or the mirror is terminally unavailable),
   * reading only from `idle`. The cheap idempotent entry for surfaces that
   * render on first use.
   * @returns settlement of the current or newly started read, if any.
   */
  ensure(): Promise<void> {
    if (this.persistence === 'memory') return Promise.resolve()
    if (this.inFlight !== undefined) return this.inFlight
    if (this.getSnapshot().status === 'idle') return this.load()
    return Promise.resolve()
  }

  /**
   * Fold one write answer's namespace view into the held view without a wire
   * read, and invalidate any read still in flight. With no held document, the
   * answer is not published as a partial document; an in-flight read reruns so
   * it cannot publish a document fetched before the write committed.
   * @param view - the namespace view a settings write answered with.
   */
  acceptView(view: SettingsNamespaceView): void {
    const before = this.store.getSnapshot()
    if (before.view === undefined) {
      this.generation += 1
      if (this.inFlight !== undefined) this.rerun = true
      return
    }
    const held = before.view.namespaces.find(row => row.ns === view.ns)
    const folded = this.foldedRevisions.get(view.ns)
    if (folded === undefined || view.revision > folded) this.foldedRevisions.set(view.ns, view.revision)
    // Folding the exact held row is a no-op: no replacement, no wake, no
    // invalidation of an in-flight read. A value-equal answer with a fresh
    // reference still publishes — consumers that only act on value movement
    // (a settings form compares the row revision) skip it themselves.
    if (held === view) return
    this.generation += 1
    if (this.inFlight !== undefined) this.rerun = true
    const namespaces = held !== undefined
      ? before.view.namespaces.map(row => row.ns === view.ns ? view : row)
      : [...before.view.namespaces, view]
    this.publish({ ...before, view: { ...before.view, namespaces } }, before.view)
  }

  /**
   * Convenience row lookup on the held view.
   * @param ns - namespace identity.
   * @returns the namespace view, or undefined while unanswered or unregistered.
   */
  namespace(ns: string): SettingsNamespaceView | undefined {
    return this.store.getSnapshot().view?.namespaces.find(row => row.ns === ns)
  }

  private async run(): Promise<void> {
    // The in-flight slot must clear in the same synchronous segment that
    // observes `rerun` false (and on abrupt exit): a `.finally()` on the
    // returned promise runs one microtask later, and a `load()` landing in
    // that gap would mark a rerun nobody reads, losing the read.
    try {
      do {
        const before = this.store.getSnapshot()
        if (before.status === 'idle') this.store.set({ ...before, status: 'loading' })
        // Cleared immediately before the wire read goes out: a load() marked
        // earlier (including one reentering from the loading publish above)
        // is covered by this very read, while one landing after needs the
        // rerun.
        this.rerun = false
        const generation = ++this.generation
        let outcome: { view: SettingsDescribeView } | { failure: string }
        try {
          const response = await this.ctx.remote.settings.describe()
          outcome = response.ok
            ? { view: response.value }
            : { failure: response.error.message }
        } catch (error) {
          outcome = { failure: error instanceof Error ? error.message : String(error) }
        }
        // A write answer invalidates a document read before that write committed.
        if (generation !== this.generation) continue
        const held = this.store.getSnapshot()
        if ('view' in outcome) {
          // Structural sharing by row revision: a wire re-read of a document
          // only one namespace moved in reuses every other namespace's held
          // row, so unrelated subscribers are not woken and derived stores see
          // their input unchanged by reference. A 304 answering the held
          // `view` leaves the whole snapshot as it is.
          const view = this.shareRows(held.view, outcome.view)
          const next = { status: 'ready' as const, view, error: null }
          if (held.status === next.status && held.view === view && held.error === next.error) continue
          this.publish(next, held.view)
        } else {
          // No answer yet: fall back to idle so `ensure` retries; with one, the
          // held view keeps serving and only the error field reports the miss.
          const next = {
            status: held.view === undefined ? 'idle' as const : 'ready' as const,
            view: held.view,
            error: outcome.failure,
          }
          if (held.status === next.status && held.view === next.view && held.error === next.error) continue
          this.publish(next, held.view)
        }
      } while (this.shouldRerun())
    } finally {
      this.inFlight = undefined
    }
  }

  private shouldRerun(): boolean {
    return this.rerun
  }

  /**
   * Reuse the held row for every namespace whose revision (and page policy)
   * did not move and whose projected value is unchanged. The revision is the
   * Host's content counter, but it is not compared alone: a projection can
   * move under a static revision (a page policy, a client-visible redaction),
   * and reusing such a row would serve stale content.
   */
  private shareRows(previous: SettingsDescribeView | undefined, next: SettingsDescribeView): SettingsDescribeView {
    if (previous === undefined || previous === next) return next
    const heldRows = new Map(previous.namespaces.map(row => [row.ns, row]))
    const namespaces = next.namespaces.map((row) => {
      const before = heldRows.get(row.ns)
      return before !== undefined && before.revision === row.revision && before.autoGenerate === row.autoGenerate
        && sameJson(before.value, row.value)
        ? before
        : row
    })
    if (previous.writable === next.writable && previous.hasDocument === next.hasDocument
      && namespaces.length === previous.namespaces.length
      && namespaces.every((row, index) => row === previous.namespaces[index])) return previous
    return { ...next, namespaces }
  }

  /**
   * Replace the snapshot, then wake the per-namespace slices whose row object
   * moved. Rows the publication did not touch (acceptView maps the held array)
   * keep their reference and notify no one.
   */
  private publish(next: SettingsMirrorSnapshot, previousView: SettingsDescribeView | undefined): void {
    this.store.set(next)
    // The first document answers every slice, including namespaces it does not
    // serve: a consumer subscribed before the first read still has to learn
    // that its namespace is absent.
    const firstDocument = previousView === undefined && next.view !== undefined
    for (const [ns, listeners] of this.namespaceListeners) {
      if (!firstDocument) {
        const before = previousView?.namespaces.find(row => row.ns === ns)
        const after = next.view?.namespaces.find(row => row.ns === ns)
        if (before === after) continue
      }
      notifySubscribers(listeners, '[settings-mirror]')
    }
  }
}
