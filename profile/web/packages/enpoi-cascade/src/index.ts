/**
 * Enpoi Harness — `enpoi-cascade` (intent-aware user-stop cancellation).
 *
 * When the user stops the main agent, the stop's intent decides what happens
 * to live continuable descendants:
 * - `detach` (the composer's ✕): only the aborted turn stops; every live
 *   continuable descendant keeps running.
 * - `stop-all` (the composer's "Stop all agents"): every live continuable
 *   descendant of the aborted session is interrupted via
 *   `subagents.interrupt(...)` under ancestor authority. Interrupt is per-turn
 *   and PARK-semantic: the child's current turn is cancelled, but its
 *   Activation, unclaimed inbox work, and published descendants stay resident,
 *   and continuable admission stays open. A later `send_message` resumes the
 *   parked queue.
 * - `revert`: only the descendants spawned inside the reverted span are
 *   interrupted — direct children whose catalog `seq` is greater than the
 *   revert anchor, plus their whole descendant subtrees. Children spawned by
 *   earlier, still-visible turns survive.
 * - Absent intent keeps the pre-intent behaviour (`stop-all`) for callers that
 *   never send one.
 * - The context keeper is EXEMPT (I9) — it is not a subagent, so the walk
 *   never touches it.
 *
 * The hook: `agent/turn-stopping` is BYPASSED on abort (verified in source —
 * user cancel aborts the turn signal and jumps past the natural-end hook), so
 * we subscribe to the durable `session/event` `turn/end` record with
 * `reason.kind === 'aborted'` + `reason.reason.kind === 'user'`.
 *
 * Drain (`drainContinuableDescendants`) is NOT used here: that API is host
 * teardown semantics — it closes continuable admission below the exact parent
 * until that Agent leaves the registry, which would poison every later
 * delegation in a session whose Agent stays live across turns.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'

export const name = 'enpoi-cascade'

// Minimal file diagnostics — the Cordis logger only buffers (no console sink).
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
function diag(line: string): void {
  try {
    const home = process.env.DSH_HOME ?? process.env.HOME ?? '/tmp'
    const dir = home.endsWith('.dsh') ? home : join(home, '.dsh')
    mkdirSync(join(dir, 'logs'), { recursive: true })
    appendFileSync(join(dir, 'logs', 'enpoi-cascade.log'), `${new Date().toISOString()} ${line}\n`)
  } catch { /* diagnostics never throw */ }
}

/** Which descendants one user stop parks. */
type StopScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'revert'; readonly fromSeq: number }

/**
 * Select the descendants a revert span owns: direct children whose catalog
 * `seq` is greater than the anchor, expanded to their complete subtrees.
 * @param entries - recursive descendant rows with catalog parent and spawn seq.
 * @param sessionId - the reverted session whose direct children anchor the span.
 * @param fromSeq - the reverted user message's seq.
 * @returns the selected child rows.
 */
function revertSpan(
  entries: readonly SubagentDescendantListEntry[],
  sessionId: SessionId,
  fromSeq: number,
): SubagentDescendantListEntry[] {
  const selected = new Set<SessionId>()
  for (const entry of entries) {
    if (entry.kind === 'child' && entry.parentId === sessionId && entry.seq > fromSeq) {
      selected.add(entry.id)
    }
  }
  // A selected child owns its whole subtree, however deep.
  let grew = true
  while (grew) {
    grew = false
    for (const entry of entries) {
      if (entry.kind !== 'child' || selected.has(entry.id)) continue
      if (selected.has(entry.parentId)) {
        selected.add(entry.id)
        grew = true
      }
    }
  }
  return entries.filter(entry => entry.kind === 'child' && selected.has(entry.id))
}

/**
 * Interrupt the live continuable descendants of `sessionId` selected by
 * `scope`, under the live root Agent's ancestor authority. Enumeration covers
 * the complete session tree, so continuable grandchildren below ordinary or
 * one-shot children are reached as well.
 * @param ctx - plugin context carrying the Agent registry and subagent runtime.
 * @param sessionId - durable id of the session whose turn the user aborted.
 * @param scope - which descendants this stop parks.
 */
async function interruptDescendants(ctx: Context, sessionId: SessionId, scope: StopScope): Promise<void> {
  const subagents = ctx.get('subagents')
  const agent = ctx.get('agents')?.get(sessionId)
  if (subagents === undefined || agent === undefined) return
  let entries
  try {
    entries = await subagents.listDescendants(sessionId)
  } catch (error: unknown) {
    diag(`descendant enumeration failed for ${sessionId}: ${String(error)}`)
    return
  }
  const targets = scope.kind === 'all' ? entries : revertSpan(entries, sessionId, scope.fromSeq)
  let interrupted = 0
  for (const entry of targets) {
    if (entry.kind !== 'child' || entry.mode !== 'continuable') continue
    try {
      subagents.interrupt(entry.id, { kind: 'ancestor', agent })
      interrupted += 1
    } catch (error: unknown) {
      diag(`interrupt of ${entry.id} refused: ${String(error)}`)
    }
  }
  diag(
    `user stop (${scope.kind}) for ${sessionId} — interrupted ${interrupted} continuable descendant(s) `
    + `of ${entries.length} enumerated`,
  )
}

export function apply(ctx: Context): void {
  // Listen on OUR ctx (proven to receive session events — the root does not).
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type !== 'turn/end') return
    const reason = event.data.reason
    if (reason.kind !== 'aborted') return
    const cancelCause = reason.reason
    if (cancelCause === undefined || cancelCause.kind !== 'user') return

    // Absent intent keeps the pre-intent behaviour for callers that never send one.
    const intent = cancelCause.intent ?? 'stop-all'
    if (intent === 'detach') {
      diag(`detach stop for ${session.id} — continuable descendants keep running`)
      return
    }
    if (intent === 'revert' && cancelCause.revertFromSeq === undefined) {
      diag(`revert stop for ${session.id} carried no revertFromSeq — no descendants interrupted`)
      return
    }
    const scope: StopScope = intent === 'revert'
      ? { kind: 'revert', fromSeq: cancelCause.revertFromSeq as number }
      : { kind: 'all' }

    // Defer out of append publication: enumeration reads session logs and the
    // interrupt path must never re-enter the synchronous append guard.
    setTimeout(() => {
      diag(`user stop detected for session ${session.id} — interrupting continuable descendants (${scope.kind})`)
      void interruptDescendants(ctx, session.id, scope).catch((error: unknown) => {
        ctx.logger.warn(`[enpoi-cascade] descendant interrupt failed: ${String(error)}`)
      })
    }, 0)
  })
}