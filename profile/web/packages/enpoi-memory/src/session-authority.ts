/**
 * enpoi-memory — session authority: which session headers count as delegated.
 *
 * Root-only memory actions and compaction-fact capture share one rule: a
 * seeded root fork also records `parentSession`, so lineage alone cannot
 * identify a subagent child.
 *
 * @module dsh-enpoi-memory/session-authority
 */
import type { SessionHeader } from '@deepseek-ai/dsh-session/types'

/**
 * Whether one session header belongs to a delegated subagent. The typed
 * subagent origin or a positive delegation depth is what distinguishes a child
 * from a seeded root fork; a bare `parentSession` without seed lineage is still
 * delegated.
 * @param header - the session header, or undefined when no session is available.
 * @returns true when root-only memory authority does not apply.
 */
export function isDelegatedSession(header: SessionHeader | undefined): boolean {
  if (header === undefined) return false
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return true
  return header.parentSession !== undefined && header.isSeeded !== true
}
