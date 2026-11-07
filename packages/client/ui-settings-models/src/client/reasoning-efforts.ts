/**
 * Shared adoption of a discovered reasoning ladder into the `llm-pi-ai`
 * settings `models` entry.
 *
 * Discovery reports an explicit empty ladder truthfully (`reasoningEfforts:
 * {}`) when an endpoint states that it offers no selectable level, and the
 * discovered-model cache keeps that answer distinguishable from "nothing
 * disclosed". The settings schema, however, refuses an empty dictionary: it
 * cannot tell a stated-but-empty capability from a malformed declaration. The
 * provider-sync plugin and the heavy planner already omit empty ladders when
 * they write a route; the Add and Refresh surfaces adopt discovery records
 * themselves whenever that optional plugin is unavailable or degraded, so both
 * use this one normalization instead of writing the raw answer.
 *
 * The adoption rules:
 *  - `false` is an explicit answer and stays `false`.
 *  - A ladder that offers at least one thinking level is copied level by
 *    level. `off` accepts the discovery spelling (an empty string, which the
 *    schema does not) and stores `null` — "dispatch no wire value" — while a
 *    non-empty wire spelling is kept verbatim.
 *  - A ladder with no selectable thinking level (empty, or `off` only) is
 *    omitted rather than persisted. It is NOT rewritten to `reasoning: false`:
 *    "no selectable levels" is not the endpoint stating that the model cannot
 *    reason, and a separately disclosed `reasoning: true` stays exactly as
 *    reported.
 *  - Absent means nothing was disclosed and leaves a stored field untouched;
 *    only an explicit answer replaces or clears one, so a refresh can drop a
 *    stale configured ladder when the endpoint retracts it.
 *
 * @module ui-settings-models/reasoning-efforts
 */

/**
 * The canonical pi-ai thinking-level names, in escalation order.
 *
 * Mirrors `THINKING_LEVELS` in `@deepseek-ai/dsh-llm-pi-ai` (`catalog.ts`).
 * The browser bundle must not import the Host adapter, so the list is repeated
 * here as the schema boundary this module guarantees; a level added upstream
 * would have to be mirrored here before an adopted ladder could carry it.
 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One adopted ladder: the field value to persist and whether one was stated. */
export interface AdoptedReasoningEfforts {
  /**
   * Whether the source stated a ladder at all. True for an explicit empty
   * ladder (including an unusable one), so a merge can clear a stale value;
   * false only when the field was absent.
   */
  declared: boolean
  /**
   * The value a `models` entry should carry, or `undefined` to omit the field.
   * `false` is preserved as the explicit disable answer.
   */
  value?: false | Record<string, string | null>
}

/**
 * Normalize one disclosed reasoning ladder into the settings schema's
 * accepted shape.
 * @param raw - the discovered `reasoningEfforts` value, when one was stated.
 * @returns the value to persist and whether the source stated one.
 */
export function normalizeReasoningEfforts(raw: unknown): AdoptedReasoningEfforts {
  if (raw === undefined) return { declared: false }
  if (raw === false) return { declared: true, value: false }
  // `null` (a valueless YAML key) and non-dictionaries are stated answers the
  // schema cannot express; they normalize away without implying "off".
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { declared: true }
  const source = raw as Record<string, unknown>
  const ladder: Record<string, string | null> = {}
  let selectable = false
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(source, level)) continue
    const wire = source[level]
    if (level === 'off') {
      // Discovery spells "no wire value" as an empty string; the settings
      // schema accepts only `null` for that meaning.
      if (wire === null || wire === '') ladder.off = null
      else if (typeof wire === 'string') ladder.off = wire
      continue
    }
    if (typeof wire !== 'string' || wire.length === 0) continue
    ladder[level] = wire
    selectable = true
  }
  // An `off`-only ladder is not a ladder the catalog can serve; the route
  // states that with `false`, which this function never invents.
  return selectable ? { declared: true, value: ladder } : { declared: true }
}

/**
 * Apply the adoption rules to one stored or discovered model record.
 *
 * An absent ladder returns the record unchanged. A stated ladder replaces the
 * record's value or removes it when it normalizes away, so a refresh never
 * keeps a stale effort mapping the endpoint has explicitly retracted.
 * @param row - one model record carrying an optional `reasoningEfforts`.
 * @returns the record with its ladder adopted.
 */
export function withAdoptedReasoningEfforts<T extends Record<string, unknown>>(row: T): T {
  const adopted = normalizeReasoningEfforts(row.reasoningEfforts)
  if (!adopted.declared) return row
  const next: Record<string, unknown> = { ...row }
  if (adopted.value === undefined) delete next.reasoningEfforts
  else next.reasoningEfforts = adopted.value
  return next as T
}
