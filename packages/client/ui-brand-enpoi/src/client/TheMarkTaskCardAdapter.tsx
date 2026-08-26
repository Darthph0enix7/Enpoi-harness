import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { TheMarkTaskCard } from './TheMarkTaskCard.tsx'

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

/**
 * Adapt the generic tool-call owner currency into The Mark task card.
 * Running calls render the live calligraphy strip; settled results freeze
 * their final state with duration and an output excerpt.
 */
export function TheMarkTaskCardAdapter(props: ToolCallOwnerProps) {
  const { toolName, block, callId } = props

  // RunningToolCall has no `kind`; ToolResultNode is kind: 'tool-result'.
  const running = !('kind' in block)
  const argsRaw = running ? block.argsRaw : (block.call?.argsRaw ?? '')

  let parsedArgs: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (parsed !== null && typeof parsed === 'object') parsedArgs = parsed as Record<string, unknown>
  } catch {
    // Non-JSON arguments fall back to the tool name as the title.
  }

  const persona =
    toolName === 'oracle_review'
      ? '🔮 Oracle'
      : toolName === 'roundtable'
        ? '🏛️ Roundtable'
        : toolName === 'chorus'
          ? '🎨 Chorus'
          : typeof parsedArgs.role === 'string'
            ? `🛠️ ${parsedArgs.role}`
            : '⚡ Subagent'

  const rawTitle =
    parsedArgs.query ??
    parsedArgs.task ??
    parsedArgs.request ??
    parsedArgs.objective ??
    parsedArgs.topic ??
    toolName
  const title = String(rawTitle).slice(0, 120)

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

  const outputSummary = running ? undefined : textOfContent(block.content).slice(0, 500)

  return (
    <TheMarkTaskCard
      taskId={callId}
      persona={persona}
      title={title}
      status={status}
      currentTool={running ? toolName : undefined}
      durationMs={durationMs}
      outputSummary={outputSummary}
    />
  )
}
