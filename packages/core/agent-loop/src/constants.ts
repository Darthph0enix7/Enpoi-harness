/** Shared agent-loop scheduler defaults.
 * @module dsh-agent-loop/constants
 */

/** Default maximum in-flight parallel-safe calls per agent step. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10

/** Default bounded continuation turns after an owner turn ends `max-tokens`. */
export const DEFAULT_MAX_TOKENS_CONTINUATIONS = 1
