/** Chat-owned approval detail resolving a correlated Tool call's command or PTC program. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import css from './ApprovalCommand.module.css'

interface ApprovalToolCall {
  readonly callId: string
  readonly argsRaw: string
}

/** PTC program carried by a correlated `run_code` call. */
export interface ApprovalProgram {
  /** The program's own human summary (the required `description` argument); empty when absent. */
  readonly description: string
  /** The TypeScript program text the approval would execute. */
  readonly source: string
  /** Tool names the program references through the generated SDK, deduplicated and sorted. */
  readonly tools: readonly string[]
}

/**
 * Extract a shell command from a correlated Tool call when its arguments carry one.
 * @param call - Tool call arguments, when a correlated call exists.
 * @returns command text, or undefined for absent, malformed, or unrelated arguments.
 */
export function commandOf(call: ApprovalToolCall | undefined): string | undefined {
  if (call === undefined) return undefined
  try {
    const args = JSON.parse(call.argsRaw) as Record<string, unknown>
    return typeof args.command === 'string' ? args.command : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract the PTC program from a correlated `run_code` call. The approval card
 * must show what would run before anyone grants it, so the program text is the
 * detail; the referenced SDK tool names state the intended calls in one line.
 * @param call - Tool call arguments, when a correlated call exists.
 * @returns program text, summary, and referenced tools, or undefined for other tools or malformed arguments.
 */
export function programOf(call: ApprovalToolCall | undefined): ApprovalProgram | undefined {
  if (call === undefined) return undefined
  let args: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(call.argsRaw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    args = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  const code = args.code
  if (typeof code !== 'string' || code.trim() === '') return undefined
  const tools = new Set<string>()
  for (const match of code.matchAll(/\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/gu)) {
    const name = match[1] ?? match[2]
    if (name !== undefined) tools.add(name)
  }
  return {
    description: typeof args.description === 'string' ? args.description.trim() : '',
    source: code,
    tools: [...tools].sort(),
  }
}

/**
 * Render the correlated Tool call's command, or — for the PTC `run_code`
 * transport — the program it would execute and the tools it references.
 * @param props - Approval identity and Session-standard Chat selector hook.
 * @returns command text, a program detail block, or null when the call carries neither.
 */
export function ApprovalCommand({ callId, useChat, t }: PropsRuntime<'conversation.approval.detail'> & PropsLocale<'chat'>) {
  const root = useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      const candidate = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
      if (candidate !== undefined && candidate.callId === callId && !('kind' in candidate) && candidate.phase === 'start') {
        return candidate
      }
    }
    return undefined
  })
  const command = commandOf(root)
  if (command !== undefined) return command
  const program = programOf(root)
  if (program === undefined) return null
  return (
    <div className={css.program}>
      {program.description !== '' && <div className={css.description}>{program.description}</div>}
      <pre className={css.source} data-approval-program>{program.source}</pre>
      {program.tools.length > 0 && (
        <div className={css.tools}>
          <span className={css.toolsLabel}>{t('approval.toolsReferenced')}</span>
          {program.tools.map(tool => <code key={tool} className={css.toolPill}>{tool}</code>)}
        </div>
      )}
    </div>
  )
}
