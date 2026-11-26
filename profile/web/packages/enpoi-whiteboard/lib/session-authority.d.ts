/**
 * enpoi-whiteboard — session authority: positive root verification and child
 * classification.
 *
 * Whiteboard authoring shares one classifier with `enpoi-memory`: a
 * user-created fork (`parentSession` with `isSeeded: true`, no `origin`, and
 * `delegationDepth` absent or 0) keeps root authority, while a missing header,
 * subagent child (`origin: 'subagent'` or positive `delegationDepth`),
 * `parentSession` without `isSeeded: true`, or malformed lineage fails closed.
 *
 * @module dsh-enpoi-whiteboard/session-authority
 */
/** Minimal structural session-header fields inspected for authority. */
export interface SessionAuthorityHeader {
    readonly id?: unknown;
    readonly parentSession?: unknown;
    readonly isSeeded?: unknown;
    readonly origin?: unknown;
    readonly delegationDepth?: unknown;
}
/** Classified authority of a session header. */
export type SessionAuthority = {
    readonly kind: 'missing';
} | {
    readonly kind: 'root';
} | {
    readonly kind: 'delegated';
    readonly parentSessionId?: string;
    readonly depth: number;
    readonly reason: string;
};
/**
 * Classify a session header's authority.
 * @param header - the session header, or undefined when unavailable.
 * @returns `'missing'` when absent or non-object, `'root'` for unparented roots
 *   and seeded user forks (`isSeeded: true`, no `origin`, `delegationDepth`
 *   absent or 0), otherwise `'delegated'` with any usable parent id and
 *   resolved depth.
 */
export declare function classifySessionAuthority(header: SessionAuthorityHeader | undefined): SessionAuthority;
