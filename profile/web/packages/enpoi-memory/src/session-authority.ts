/**
 * enpoi-memory — session authority: positive root verification and child
 * classification.
 *
 * Root-only memory actions, operator-trust writes, and compaction-fact capture
 * share one classifier: a user-created fork (`parentSession` with
 * `isSeeded: true`, no `origin`, and `delegationDepth` absent or 0) keeps root
 * authority, while a missing header, subagent child (`origin: 'subagent'` or
 * positive `delegationDepth`), `parentSession` without `isSeeded: true`, or
 * malformed lineage fails closed.
 *
 * @module dsh-enpoi-memory/session-authority
 */

/** Minimal structural session-header shape inspected for authority. */
export interface SessionAuthorityHeader {
  readonly id?: unknown
  readonly parentSession?: unknown
  readonly isSeeded?: unknown
  readonly origin?: unknown
  readonly delegationDepth?: unknown
}

/** Classified authority of a session header. */
export type SessionAuthority =
  | { readonly kind: 'missing' }
  | { readonly kind: 'root' }
  | {
    readonly kind: 'delegated'
    readonly parentSessionId?: string
    readonly depth: number
    readonly reason: string
  }

/**
 * Classify a session header's authority.
 * @param header - the session header, or undefined when unavailable.
 * @returns `'missing'` when absent or non-object, `'root'` for unparented roots
 *   and seeded user forks (`isSeeded: true`, no `origin`, `delegationDepth`
 *   absent or 0), otherwise `'delegated'` with any usable parent id and
 *   resolved depth.
 */
export function classifySessionAuthority(header: SessionAuthorityHeader | undefined): SessionAuthority {
  if (header === undefined || header === null || typeof header !== 'object' || Array.isArray(header)) {
    return { kind: 'missing' }
  }
  const rawParent = header.parentSession
  const hasParentField = rawParent !== undefined
  const usableParent = typeof rawParent === 'string' && rawParent.trim() !== '' ? rawParent : undefined

  const rawOrigin = header.origin
  const isSubagentOrigin = rawOrigin === 'subagent'
  const hasUnexpectedOrigin = rawOrigin !== undefined && !isSubagentOrigin

  const rawDepth = header.delegationDepth
  const isValidDepth = typeof rawDepth === 'number' && Number.isSafeInteger(rawDepth) && rawDepth >= 0
  const hasInvalidDepth = rawDepth !== undefined && !isValidDepth
  const hasPositiveDepth = isValidDepth && rawDepth > 0

  const rawSeeded = header.isSeeded
  const hasInvalidSeeded = rawSeeded !== undefined && typeof rawSeeded !== 'boolean'

  const depth = hasPositiveDepth ? rawDepth : 1

  if (hasUnexpectedOrigin || hasInvalidDepth || hasInvalidSeeded) {
    return {
      kind: 'delegated',
      ...usableParent !== undefined ? { parentSessionId: usableParent } : {},
      depth,
      reason: 'ambiguous session lineage',
    }
  }
  if (hasParentField && usableParent === undefined) {
    return {
      kind: 'delegated',
      depth,
      reason: 'unusable parentSession',
    }
  }
  if (isSubagentOrigin || hasPositiveDepth) {
    return {
      kind: 'delegated',
      ...usableParent !== undefined ? { parentSessionId: usableParent } : {},
      depth,
      reason: usableParent === undefined
        ? isSubagentOrigin
          ? 'subagent origin without usable parentSession'
          : 'positive delegationDepth without usable parentSession'
        : isSubagentOrigin
          ? 'subagent origin'
          : 'positive delegationDepth',
    }
  }
  if (usableParent !== undefined) {
    if (rawSeeded === true) return { kind: 'root' }
    return {
      kind: 'delegated',
      parentSessionId: usableParent,
      depth,
      reason: 'parentSession without seed lineage',
    }
  }
  return { kind: 'root' }
}

/**
 * Whether one session header lacks positive root authority (delegated child,
 * ambiguous lineage, or missing header).
 * @param header - the session header, or undefined when no session is available.
 * @returns true when root-only memory authority does not apply.
 */
export function isDelegatedSession(header: SessionAuthorityHeader | undefined): boolean {
  return classifySessionAuthority(header).kind !== 'root'
}
