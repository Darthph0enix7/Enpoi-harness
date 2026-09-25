import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TheMarkTaskCard } from './TheMarkTaskCard.tsx'
import { getPersonaAssignments } from './persona-store.ts'

export interface TheMarkTaskCardInjected {
  openSession?: ((sessionId: SessionId) => void) | undefined
}

export type TheMarkTaskCardAdapterProps = ToolCallOwnerProps & TheMarkTaskCardInjected

/** Flatten text out of settled result content blocks (best effort). */
function textOfContent(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
    } else if (block !== null && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

interface PersonaInfo {
  label: string
  roleKey?: string
}

/**
 * Infer a human-friendly role name, icon, and roleKey from tool arguments, prompt keywords, and stems.
 */
function inferPersona(toolName: string, args: Record<string, unknown>): PersonaInfo {
  if (toolName === 'oracle_review') return { label: '🔮 Oracle', roleKey: 'oracle' }
  if (toolName === 'roundtable') return { label: '🏛️ Roundtable' }
  if (toolName === 'chorus') return { label: '🎨 Chorus' }

  const explicitRole = typeof args.role === 'string' ? args.role.toLowerCase() : ''
  const desc = typeof args.description === 'string' ? args.description.toLowerCase() : ''
  const prompt = typeof args.prompt === 'string' ? args.prompt.toLowerCase() : ''
  const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type.toLowerCase() : ''
  const combined = `${explicitRole} ${subagentType} ${desc} ${prompt}`

  // Check role stems and keywords
  if (/\b(librarian|research|docs?|web|lookup|fetch|api\s*reference)\b/i.test(combined)) {
    return { label: '📚 Librarian', roleKey: 'librarian' }
  }
  if (/\b(fixer|fix|bug|patch|repair|refactor|error|issue)\b/i.test(combined)) {
    return { label: '🛠️ Fixer', roleKey: 'fixer' }
  }
  if (/\b(explorer|explore|codebase|map|survey|find|grep|search)\b/i.test(combined)) {
    return { label: '🔍 Explorer', roleKey: 'explorer' }
  }
  if (/\b(designer|design|ui|ux|style|css|theme|layout|visual)\b/i.test(combined)) {
    return { label: '🎨 Designer', roleKey: 'designer' }
  }
  if (/\b(oracle|review|architecture|audit)\b/i.test(combined)) {
    return { label: '🔮 Oracle', roleKey: 'oracle' }
  }
  if (/\b(referee|arbiter|adjudicat)\b/i.test(combined)) {
    return { label: '⚖️ Referee', roleKey: 'referee' }
  }
  if (/\b(chair|synthesis|compil)\b/i.test(combined)) {
    return { label: '🪑 Chair', roleKey: 'chair' }
  }
  if (/\b(visionary|moonshot|horizon)\b/i.test(combined)) {
    return { label: '🔭 Visionary', roleKey: 'visionary' }
  }
  if (/\b(architect|structure|topology)\b/i.test(combined)) {
    return { label: '🏗️ Architect', roleKey: 'architect' }
  }
  if (/\b(skeptic|adversarial)\b/i.test(combined)) {
    return { label: '🧐 Skeptic', roleKey: 'skeptic' }
  }
  if (/\b(pragmatist|practical)\b/i.test(combined)) {
    return { label: '⚡ Pragmatist', roleKey: 'pragmatist' }
  }

  return { label: '⚡ Subagent', roleKey: 'subagent' }
}

/** Recursively collect subcall tool names invoked during a subagent run. */
function collectSubTools(block: ToolCallBlock): string[] {
  const tools: string[] = []
  function walk(node: ToolCallBlock) {
    if ('subCalls' in node && Array.isArray(node.subCalls)) {
      for (const child of node.subCalls) {
        const name = 'kind' in child ? child.call?.name : child.name
        if (name && !tools.includes(name)) {
          tools.push(name)
        }
        walk(child)
      }
    }
  }
  walk(block)
  return tools
}

/** Try to extract a child session or subagent ID from tool results or text output. */
function extractChildSessionId(block: ToolCallOwnerProps['block']): string | undefined {
  if (!('kind' in block)) return undefined

  // Check structured output value if available
  const val = (block as unknown as { value?: Record<string, unknown> })?.value
  if (val && typeof val === 'object') {
    if (typeof val.subagentId === 'string') return val.subagentId
    if (typeof val.jobId === 'string') return val.jobId
    if (typeof val.runId === 'string') return val.runId
  }

  // Check text content for session id patterns
  const text = textOfContent(block.content)
  const subagentMatch = text.match(/started subagent\s+([\w-]+)/i)
  if (subagentMatch?.[1]) return subagentMatch[1]

  const sessionMatch = text.match(/(session-[0-9a-f-]{36})/i)
  if (sessionMatch?.[1]) return sessionMatch[1]

  return undefined
}

/**
 * Adapt the generic tool-call owner currency into The Mark task card.
 * Handles subagent delegation, Oracle reviews, and Council debates with
 * live action calligraphy, compact markdown output previews, subcall tool timelines,
 * and child session navigation.
 */
export function TheMarkTaskCardAdapter(props: TheMarkTaskCardAdapterProps) {
  const { toolName, block, callId, openSession } = props

  // RunningToolCall has no `kind`; ToolResultNode is kind: 'tool-result'.
  const running = !('kind' in block)
  // A preparing call has no arguments yet; only a dispatched call carries them.
  const argsRaw = running
    ? (block.phase === 'start' ? block.argsRaw : '')
    : (block.call?.argsRaw ?? '')

  let parsedArgs: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (parsed !== null && typeof parsed === 'object') parsedArgs = parsed as Record<string, unknown>
  } catch {
    // Non-JSON arguments fall back to defaults
  }

  const { label: persona, roleKey } = inferPersona(toolName, parsedArgs)

  const rawTitle =
    parsedArgs.description ??
    parsedArgs.query ??
    parsedArgs.task ??
    parsedArgs.request ??
    parsedArgs.objective ??
    parsedArgs.topic ??
    parsedArgs.prompt ??
    toolName

  // Use the first line of the title and truncate gracefully
  const titleLine = String(rawTitle).split('\n')[0] ?? toolName
  const title = titleLine.slice(0, 120)

  // Resolve model: explicit tool option > assigned persona in fleet > undefined
  const agentOptions = parsedArgs.agentOptions as { model?: string } | undefined
  const assignments = getPersonaAssignments()
  const assignedModel = roleKey ? assignments[roleKey]?.model : undefined
  const model = typeof agentOptions?.model === 'string'
    ? agentOptions.model
    : assignedModel ?? undefined

  const status: 'running' | 'settled' | 'failed' = running
    ? 'running'
    : block.isError
      ? 'failed'
      : 'settled'

  const durationMs = running
    ? undefined
    : block.callTime !== null
      ? Math.max(0, block.time - block.callTime)
      : undefined

  const outputSummary = running ? undefined : textOfContent(block.content)
  const childSessionId = extractChildSessionId(block)
  const subTools = collectSubTools(block)

  return (
    <TheMarkTaskCard
      taskId={callId}
      persona={persona}
      title={title}
      model={model}
      status={status}
      currentTool={running ? toolName : undefined}
      durationMs={durationMs}
      childSessionId={childSessionId}
      outputSummary={outputSummary}
      subTools={subTools}
      onOpenSession={openSession ? id => openSession(id as SessionId) : undefined}
    />
  )
}
