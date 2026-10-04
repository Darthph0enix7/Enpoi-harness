/**
 * enpoi-capabilities — the bash search nudge (doc 80 follow-up).
 *
 * A search-leading bash command in a turn that has not used the dedicated
 * `grep`/`glob` tool yet gets ONE advisory line appended to its result. It is
 * never a denial: shell pipelines stay legal, and the hint only names the
 * cheaper, structured route for the NEXT search. State is per session and
 * per turn: `turn/start` resets it, a `tool/call` of `grep` or `glob` marks
 * the turn as already using the dedicated tools, and the latch keeps the hint
 * to one per turn.
 *
 * @module dsh-enpoi-capabilities/search-nudge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'

/** One search-leading shell command (anchored: the FIRST command word searches). */
const SEARCH_LEADING = /^\s*(?:sudo\s+)?(?:rg|grep|find|fd|ls)\b/u

/** The advisory line appended to the result of a search-leading bash call. */
export const SEARCH_NUDGE_TEXT =
  'Search hint: this turn has not used the grep or glob tool. For the next search, prefer grep/glob — they return structured, cheaper results than a shell search; keep bash for pipelines and anything the dedicated tools cannot express.'

/**
 * Whether a shell command leads with a search tool. Anchored so pipelines and
 * commands that merely mention a search tool (`cat f | grep x`, `npm test`,
 * `git grep foo`) do not match.
 * @param command - the raw bash command.
 * @returns true when the first command word is a search tool.
 */
export function isSearchLeadingCommand(command: string): boolean {
  return SEARCH_LEADING.test(command)
}

/** Structural exec/result/decision faces this listener needs (the registry's typed forms satisfy them). */
interface NudgeExec {
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: { readonly session?: { readonly id?: unknown } } | undefined
}
interface NudgeResult {
  readonly content: readonly ContentBlock[]
}

/** Read a session id defensively from the calling agent. */
function sessionIdOf(agent: NudgeExec['agent']): string | undefined {
  const id = agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Install the nudge on one context. Registers two listeners and owns only
 * per-session turn state; no service is injected or required.
 * @param ctx - owning context (the host-plane capabilities bundle).
 */
export function installSearchNudge(ctx: Context): void {
  /** Sessions whose current turn already used grep/glob. */
  const searchUsed = new Set<string>()
  /** Sessions already hinted in the current turn. */
  const nudged = new Set<string>()

  const onSessionEvent = (session: { id: string }, event: { type: string; data?: { name?: unknown } }): void => {
    if (event.type === 'turn/start') {
      searchUsed.delete(session.id)
      nudged.delete(session.id)
      return
    }
    if (event.type === 'tool/call' && (event.data?.name === 'grep' || event.data?.name === 'glob')) {
      searchUsed.add(session.id)
    }
  }
  const onSessionDisposed = (session: { id: string }): void => {
    searchUsed.delete(session.id)
    nudged.delete(session.id)
  }

  const onPostExecute = async (
    exec: NudgeExec,
    result: NudgeResult,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const decision = await next()
    // Never override another listener's value replacement or a block; the
    // nudge only appends to the accepted content of a bash result.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    if (exec.name !== 'bash') return decision
    const sessionId = sessionIdOf(exec.agent)
    if (sessionId === undefined || searchUsed.has(sessionId) || nudged.has(sessionId)) return decision
    const command = (exec.arguments as { command?: unknown } | undefined)?.command
    if (typeof command !== 'string' || !isSearchLeadingCommand(command)) return decision
    nudged.add(sessionId)
    const accepted = decision as { readonly content?: readonly ContentBlock[] }
    return {
      kind: 'accept',
      content: [...accepted.content ?? result.content, { type: 'text', text: SEARCH_NUDGE_TEXT }],
    }
  }

  ctx.on('session/event', onSessionEvent as never)
  ctx.on('session/disposed', onSessionDisposed as never)
  ctx.on('tools/post-execute', onPostExecute as never)
}
