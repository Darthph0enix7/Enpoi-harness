/**
 * enpoi-memory — secret guard for compaction-derived facts.
 *
 * Compaction summaries are model-written, so a durable fact can accidentally
 * quote a credential that appeared in the conversation. The first eight
 * patterns of `feedback-collect` cover the key shapes worth blocking:
 * `sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox`, JWT, `Bearer`, and
 * `key = value` assignments. The generic 40-char base64 rule is deliberately
 * excluded — it matches ordinary hashes, ids, and long identifiers that are
 * exactly the config values durable facts are meant to keep.
 *
 * The patterns are stateless (no `g` flag) so repeated `.test()` calls never
 * depend on `lastIndex`.
 *
 * @module dsh-enpoi-memory/secret-guard
 */

/** Key-like token shapes rejected from durable facts. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/u,
  /\bghp_[A-Za-z0-9]{16,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/u,
  /\bBearer\s+\S{12,}/iu,
  /(?<=(?:api(?:_|-)?key|token|secret|password|passwd|authorization)"?\s*[=:]\s*"?)[^\s,;'"]{6,}/iu,
]

/**
 * Whether one fact text carries a credential-shaped token.
 * Pure and deterministic; never throws on non-string input.
 * @param text - the candidate fact text.
 * @returns true when any secret pattern matches.
 */
export function containsSecret(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  try {
    return SECRET_PATTERNS.some(pattern => pattern.test(text))
  } catch {
    return false
  }
}
