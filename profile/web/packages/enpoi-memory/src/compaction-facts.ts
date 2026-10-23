/**
 * enpoi-memory — durable-facts subscriber.
 *
 * The compaction backend writes a `## Durable Facts` section inside the model
 * summary. This subscriber reads that section back from the durable
 * `compaction/summary` event, waits for the MATCHING `compaction/end` (C2), and
 * only then writes the facts into cross-session memory. A failed compaction or
 * a mechanical stub (no model, or the summarizer-failure ladder) never writes.
 *
 * Claims land with `origin: 'compaction'` and `trust: 'verified_execution'`
 * (C3): a checkpoint that committed is executed evidence, but it is not
 * operator authority and must not outrank `memory_save`. Provenance records the
 * workspace cwd so `memory_search` can scope these rows to the caller's
 * workspace, and each fact passes the secret guard plus a FTS/Jaccard
 * near-duplicate filter so three consecutive consolidated compactions cannot
 * pile up paraphrases of the same fact.
 *
 * Every failure is logged once per (session, compaction) and never rethrown —
 * memory capture is a side channel, never a compaction dependency.
 *
 * @module dsh-enpoi-memory/compaction-facts
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-compaction'
import type { DatabaseSync } from 'node:sqlite'
import {
  parseDurableFacts,
  type DurableFact,
  type DurableFactKind,
} from '@deepseek-ai/dsh-compaction-basic/durable-facts'
import type { MemoryConfig } from './config'
import type { ClaimInput, IntakeOptions, Pipeline } from './pipeline'
import { jaccard, nearDuplicateCandidates } from './retriever'
import { containsSecret } from './secret-guard'

/** C3 category mapping: decisions are architecture, everything else project knowledge. */
const CATEGORY_BY_KIND: Readonly<Record<DurableFactKind, string>> = {
  decision: 'ARCHITECTURE',
  constraint: 'PROJECT',
  requirement: 'PROJECT',
  fact: 'PROJECT',
}

/** One summary held between `compaction/summary` and its matching `compaction/end`. */
interface HeldCompaction {
  readonly sessionId: string
  readonly compactionId: string
  readonly cwd: string
  readonly shadowedRange: { readonly start: number; readonly end: number }
  readonly provider: string
  readonly model: string
  readonly facts: readonly DurableFact[]
}

/** Join the text blocks of a summary (the C1 parser input). */
function summaryText(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  let text = ''
  for (const block of summary) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const value = (block as { text?: unknown }).text
      if (typeof value === 'string') text += value
    }
  }
  return text
}

/** Stable key for the held map and the warn-once set. */
function keyOf(sessionId: string, compactionId: string): string {
  return `${sessionId}\u0000${compactionId}`
}

/**
 * Register the compaction-facts subscriber on the host context.
 * @param ctx - host context (session events).
 * @param db - the memory database (near-duplicate candidate lookup).
 * @param pipeline - the claim intake pipeline.
 * @param config - the resolved plugin config.
 * @returns the disposer that drops every held summary and stops future writes.
 */
export function registerCompactionFacts(
  ctx: Context,
  db: DatabaseSync,
  pipeline: Pipeline,
  config: MemoryConfig,
): () => void {
  const held = new Map<string, HeldCompaction>()
  const warned = new Set<string>()
  let disposed = false

  const warnOnce = (key: string, detail: unknown): void => {
    if (warned.has(key)) return
    warned.add(key)
    try {
      const message = detail instanceof Error ? detail.message : String(detail)
      ctx.logger?.warn(`enpoi-memory: compaction facts for ${key.replace('\u0000', '/')} skipped: ${message}`)
    } catch {
      // Observability only; a logger failure never changes the host path.
    }
  }

  /** One batch write: secret guard → near-duplicate filter → intake (C3). */
  const write = async (record: HeldCompaction): Promise<void> => {
    const key = keyOf(record.sessionId, record.compactionId)
    try {
      if (disposed) return
      const scope = { cwd: record.cwd, scopeCompaction: config.scopeCompactionFactsToWorkspace }
      const threshold = config.compactionFactsNearDuplicate
      const accepted: ClaimInput[] = []
      for (const fact of record.facts) {
        if (containsSecret(fact.text)) continue
        // Near-duplicate inside this one compaction's own batch.
        if (accepted.some(claim => jaccard(claim.fact, fact.text) >= threshold)) continue
        // Near-duplicate against memory already saved (any origin, same scope).
        const existing = nearDuplicateCandidates(db, fact.text, scope)
        if (existing.some((text: string) => jaccard(text, fact.text) >= threshold)) continue
        accepted.push({ fact: fact.text, category: CATEGORY_BY_KIND[fact.kind], tags: `compaction ${fact.kind}` })
      }
      if (accepted.length === 0) return
      const provenance = JSON.stringify({
        source: 'compaction',
        sessionId: record.sessionId,
        compactionId: record.compactionId,
        cwd: record.cwd,
        shadowedRange: { start: record.shadowedRange.start, end: record.shadowedRange.end },
        summaryRoute: `${record.provider}/${record.model}`,
      })
      const options: IntakeOptions = { origin: 'compaction', trust: 'verified_execution', provenance }
      await pipeline.intake(accepted, options)
    } catch (error: unknown) {
      warnOnce(key, error)
    }
  }

  const onSummary = (session: Session, event: SessionEvent<'compaction/summary'>): void => {
    if (!config.compactionFacts) return
    const data = event.data
    // Mechanical stub: no model wrote this summary.
    if (data.provider === '') return
    // The summarizer failed and the deterministic fallback replaced it.
    if (data.summarizationFailure !== undefined) return
    // Subagent children are scratch work unless the operator opts in.
    if (session.header.parentSession !== undefined && !config.compactionFactsIncludeChildSessions) return
    const facts = parseDurableFacts(summaryText(data.summary)).slice(0, config.compactionFactsMax)
    if (facts.length === 0) return
    held.set(keyOf(session.id, data.compactionId), {
      sessionId: session.id,
      compactionId: data.compactionId,
      cwd: session.header.cwd ?? '',
      shadowedRange: { start: data.shadowedRange.start, end: data.shadowedRange.end },
      provider: data.provider,
      model: data.model,
      facts,
    })
  }

  const onEnd = (session: Session, event: SessionEvent<'compaction/end'>): void => {
    const key = keyOf(session.id, event.data.compactionId)
    const record = held.get(key)
    if (record === undefined) return
    // The lock closed: the held summary is consumed either way.
    held.delete(key)
    if (event.data.error !== undefined) return
    // A write must not run inside the event dispatch; the compaction boundary
    // is durability-relevant to the caller.
    setImmediate(() => { void write(record) })
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      if (event.type === 'compaction/summary') onSummary(session, event)
      else if (event.type === 'compaction/end') onEnd(session, event)
    } catch (error: unknown) {
      // Never touch `event.data` unguarded here: a hostile getter must not be
      // able to throw out of the containment path either.
      let key = 'unknown'
      try {
        const compactionId = (event.data as { compactionId?: unknown } | undefined)?.compactionId
        key = keyOf(session.id, String(compactionId ?? 'unknown'))
      } catch {
        // Keep the fallback key.
      }
      warnOnce(key, error)
    }
  })

  ctx.on('session/disposed', (session: Session) => {
    const prefix = `${session.id}\u0000`
    for (const key of held.keys()) if (key.startsWith(prefix)) held.delete(key)
  })

  return () => {
    disposed = true
    held.clear()
  }
}
