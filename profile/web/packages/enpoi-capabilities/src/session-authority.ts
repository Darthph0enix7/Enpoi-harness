/**
 * Session authority classification: distinguishes a trusted root session
 * (including a user-created fork with `parentSession`, `isSeeded: true`, no
 * `origin`, and no positive `delegationDepth`) from a delegated subagent or
 * ambiguous/missing header.
 *
 * A real subagent child always stamps `origin: 'subagent'` and a positive
 * `delegationDepth`; a user fork stamps `parentSession` and `isSeeded: true`
 * without `origin` (persisted logs stamp `delegationDepth: 0`), so those two
 * fork shapes are indistinguishable and classify as root by design (an
 * attacker who can forge arbitrary session headers already controls a forged
 * session). A `parentSession` without `isSeeded: true` and without `origin` is
 * ambiguous and fails closed as delegated.
 *
 * @module dsh-enpoi-capabilities/session-authority
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
