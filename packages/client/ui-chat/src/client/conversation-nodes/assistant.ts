import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantBlock, AssistantMessageNode, AssistantProvenanceView, ConversationLocation, ConversationMatch,
  ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AssistantStreamRecord, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { AssistantChatData } from '../contract/chat-nodes.ts'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common.ts'
import {
  emptyAssistantBlock, isTokenDelta, toAssistantBlock, toAssistantBlocks,
} from './event-projection.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Streaming, settled, or interrupted Assistant step. */
    'assistant-step': AssistantChatData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    /** Streaming, settled, or interrupted Assistant material for this Step. */
    'assistant-step': AssistantChatData
  }
}

interface AssistantState {
  readonly turn: number
  readonly step: number
  readonly blocks: readonly (AssistantBlock | undefined)[]
  readonly visibleBlocks: number
  readonly firstVisibleSeq: number | undefined
  readonly firstVisibleTime: number | undefined
  readonly firstTokenTime: number | undefined
  readonly hidden: boolean
  readonly finishChunk?: ConversationMatch | undefined
  readonly final: ConversationMatch | undefined
  readonly usage: unknown
}

function initialState(turn: number, step: number): AssistantState {
  return {
    turn,
    step,
    blocks: [],
    visibleBlocks: 0,
    firstVisibleSeq: undefined,
    firstVisibleTime: undefined,
    firstTokenTime: undefined,
    hidden: false,
    finishChunk: undefined,
    final: undefined,
    usage: undefined,
  }
}

function compactBlocks(blocks: readonly (AssistantBlock | undefined)[]): AssistantBlock[] {
  return blocks.filter((block): block is AssistantBlock => block !== undefined)
}

function blockIsVisible(block: AssistantBlock | undefined): boolean {
  if (block === undefined || block.kind === 'tool-call') return false
  if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
  return true
}

function countVisibleBlocks(blocks: readonly AssistantBlock[]): number {
  let count = 0
  for (const block of blocks) if (blockIsVisible(block)) count++
  return count
}

function hasVisibleContent(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some(blockIsVisible)
}

function hasInterruptionEvidence(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
    return true
  })
}

function resetForRetry(state: AssistantState): AssistantState {
  return {
    ...initialState(state.turn, state.step),
    firstTokenTime: state.firstTokenTime,
    hidden: true,
  }
}

function updateChunk(
  state: AssistantState,
  chunk: StreamChunk,
  seq: number,
  time: number,
  match: ConversationMatch,
): AssistantState {
  const blocks = [...state.blocks]
  let changedIndex = -1
  let previousVisible = false
  switch (chunk.type) {
    case 'block-start':
      changedIndex = chunk.index
      previousVisible = blockIsVisible(blocks[chunk.index])
      blocks[chunk.index] = emptyAssistantBlock(chunk.blockType)
      break
    case 'text-delta': {
      const previous = blocks[chunk.index]
      changedIndex = chunk.index
      previousVisible = blockIsVisible(previous)
      blocks[chunk.index] = { kind: 'text', text: (previous?.kind === 'text' ? previous.text : '') + chunk.text }
      break
    }
    case 'reasoning-delta': {
      const previous = blocks[chunk.index]
      changedIndex = chunk.index
      previousVisible = blockIsVisible(previous)
      blocks[chunk.index] = { kind: 'reasoning', text: (previous?.kind === 'reasoning' ? previous.text : '') + chunk.text }
      break
    }
    case 'tool-call-delta': {
      const previous = blocks[chunk.index]
      changedIndex = chunk.index
      previousVisible = blockIsVisible(previous)
      const base = previous?.kind === 'tool-call'
        ? previous
        : { kind: 'tool-call' as const, callId: '', name: '', argsRaw: '' }
      blocks[chunk.index] = {
        kind: 'tool-call',
        callId: base.callId || String(chunk.id),
        name: chunk.name ?? base.name,
        argsRaw: base.argsRaw + chunk.argumentsDelta,
      }
      break
    }
    case 'block-end':
      changedIndex = chunk.index
      previousVisible = blockIsVisible(blocks[chunk.index])
      blocks[chunk.index] = toAssistantBlock(chunk.block)
      break
    case 'finish':
      // Retained for the model-attribution badge: the finish chunk's
      // replay-state response names the provider/model that served the turn.
      return { ...state, finishChunk: match }
    case 'usage':
      return { ...state, usage: chunk.usage }
    default:
      return state
  }
  const visibleBlocks = state.visibleBlocks
    - Number(previousVisible)
    + Number(blockIsVisible(blocks[changedIndex]))
  const firstToken = isTokenDelta(chunk)
  return {
    ...state,
    blocks,
    visibleBlocks,
    hidden: visibleBlocks > 0 ? false : state.hidden,
    ...visibleBlocks > 0 && state.firstVisibleSeq === undefined
      ? { firstVisibleSeq: seq, firstVisibleTime: time }
      : {},
    ...firstToken && state.firstTokenTime === undefined
      ? { firstTokenTime: time }
      : {},
  }
}

function settleMessage(
  state: AssistantState,
  match: ConversationMatch,
  event: SessionEvent<'assistant/message'>,
): AssistantState {
  const blocks = toAssistantBlocks(event.data.message.content)
  return {
    ...state,
    blocks,
    visibleBlocks: countVisibleBlocks(blocks),
    hidden: false,
    final: match,
    usage: event.data.usage,
  }
}

function closedBoundary(location: ConversationLocation): { seq: number; time: number } | undefined {
  if (location.kind === 'step' && location.step.status === 'closed' && location.step.end !== undefined) {
    return location.step.end
  }
  if ((location.kind === 'step' || location.kind === 'turn')
    && location.turn.status === 'closed' && location.turn.end !== undefined) {
    return location.turn.end
  }
  return undefined
}

/** Last terminal `finish` chunk of a settled Assistant stream, or undefined when it carries none. */
function durableFinishChunk(stream: readonly AssistantStreamRecord[]): Extract<StreamChunk, { type: 'finish' }> | undefined {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk.type === 'finish') return record.chunk
  }
  return undefined
}

/**
 * Provider/model identity recorded on a durable Assistant message source,
 * plus the optional model-group id (`chain`) the producing selection carried.
 */
type ProvenanceWithChain = AssistantProvenanceView & { chain?: string }

/**
 * Provider/model identity recorded on a durable Assistant message source.
 * The transport replays `assistant/message` without the live stream, so this
 * source is the attribution that survives a reload; an unrecognized producer
 * yields nothing.
 * @param source - Durable `assistant/message` source.
 * @returns The recorded provider/model, or undefined when absent.
 */
function sourceProvenance(source: unknown): ProvenanceWithChain | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const { kind, provider, model, chain } = source as Record<string, unknown>
  if (kind !== 'model' || typeof provider !== 'string' || typeof model !== 'string') return undefined
  return {
    provider,
    model,
    ...typeof chain === 'string' && chain !== '' ? { chain } : {},
  }
}

function finalNode(
  state: AssistantState,
  context: ConversationNodeContext<AssistantState>,
): AssistantMessageNode | undefined {
  const final = state.final
  if (final?.event.type === 'assistant/message') {
    const event = final.event
    const finishMatch = state.finishChunk
    const liveChunk = finishMatch?.event.type === 'assistant/live-chunk' ? finishMatch.event.data.chunk : undefined
    // Live streaming names the model in its finish chunk; a reloaded session
    // carries the same chunk inside the settled event's recorded stream.
    const finishChunk = liveChunk?.type === 'finish' ? liveChunk : durableFinishChunk(event.data.stream)
    const response = finishChunk?.replayState?.response as {
      provider?: string
      model?: string
      reasoningEffort?: string
      chain?: string
    } | null | undefined
    const provider = response?.provider
    const model = response?.model
    const reasoningEffort = response?.reasoningEffort
    // The answering link may still carry the group id the request was made
    // under; attribution prefers the selection's own id either way.
    const chain = typeof response?.chain === 'string' && response.chain !== '' ? response.chain : undefined
    const requestConfig = typeof provider === 'string' && typeof model === 'string'
      ? {
        provider,
        model,
        ...typeof reasoningEffort === 'string' ? { reasoningEffort } : {},
        ...chain === undefined ? {} : { chain },
      }
      : undefined
    const provenance = sourceProvenance(event.data.message.source)
    return {
      kind: 'assistant',
      seq: event.seq,
      messageId: event.data.message.id,
      time: event.time,
      turn: state.turn,
      step: state.step,
      blocks: toAssistantBlocks(event.data.message.content),
      usage: event.data.usage,
      timing: {
        stepStartTime: context.start?.event.time ?? null,
        firstTokenTime: state.firstTokenTime ?? null,
        completedTime: event.time,
      },
      ...event.data.interrupted === true ? { interrupted: true } : {},
      ...requestConfig !== undefined ? { requestConfig } : {},
      ...provenance !== undefined ? { provenance } : {},
    }
  }
  const location = context.start?.location ?? context.matches.at(-1)?.location
  const boundary = location === undefined ? undefined : closedBoundary(location)
  if (boundary === undefined) return undefined
  const blocks = compactBlocks(state.blocks)
  if (!hasInterruptionEvidence(blocks)) return undefined
  return {
    kind: 'assistant',
    seq: boundary.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
    time: boundary.time,
    turn: state.turn,
    step: state.step,
    blocks,
    interrupted: true,
  }
}

function fallbackState(context: ConversationNodeContext<AssistantState>): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    if (match.event.type === 'assistant/live-chunk') {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = updateChunk(state, match.event.data.chunk, match.event.seq, match.event.time, match)
      continue
    }
    if (match.event.type === 'assistant/message') {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = settleMessage(state, match, match.event)
      continue
    }
    if (match.event.type === 'llm/retry' && state !== undefined) {
      state = resetForRetry(state)
    }
  }
  return state
}

interface AssistantProjection {
  readonly data: AssistantChatData
  readonly anchorSeq: number
  readonly visible: boolean
  readonly settled: AssistantMessageNode | undefined
}

function projectAssistant(context: ConversationNodeContext<AssistantState>): AssistantProjection | undefined {
  const state = context.state ?? fallbackState(context)
  if (state === undefined) return undefined
  const settled = finalNode(state, context)
  const blocks = settled?.blocks ?? compactBlocks(state.blocks)
  const visible = settled === undefined ? state.visibleBlocks > 0 : hasVisibleContent(blocks)
  const status = settled?.interrupted === true
    ? 'interrupted'
    : settled === undefined ? 'running' : 'settled'
  const anchorSeq = settled?.seq ?? state.firstVisibleSeq ?? context.matches[0]?.event.seq ?? 0
  const time = settled?.time ?? state.firstVisibleTime ?? context.matches[0]?.event.time ?? 0
  return {
    anchorSeq,
    visible,
    settled,
    data: {
      status,
      turn: state.turn,
      step: state.step,
      blocks,
      time,
      ...state.usage === undefined ? {} : { usage: state.usage },
      ...settled === undefined ? {} : { finalNode: settled },
    },
  }
}

function publishedAssistantData(
  context: ConversationNodeContext<AssistantState>,
): Readonly<AssistantChatData> | undefined {
  const location = context.start?.location ?? context.matches.at(-1)?.location
  return location?.kind === 'step' ? location.step.data.get('assistant-step') : undefined
}

/** Per-step Assistant streaming/final/interruption Definition. */
export const assistantDefinition: ConversationNodeDefinition<AssistantState> = {
  kind: 'assistant-step',
  target: 'chat',
  match: (event) => {
    if (event.type === 'step/start') return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (event.type === 'assistant/live-chunk'
      || (event.type === 'assistant/message' && event.surfaceOp === 'append')) {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    if (event.type === 'llm/retry') {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') throw new Error('assistant-step start requires step/start')
    return initialState(match.event.data.turn, match.event.data.step)
  },
  update: (context, match) => {
    if (match.event.type === 'assistant/live-chunk') {
      return updateChunk(context.state, match.event.data.chunk, match.event.seq, match.event.time, match)
    }
    if (match.event.type === 'assistant/message') return settleMessage(context.state, match, match.event)
    if (match.event.type === 'llm/retry') {
      return resetForRetry(context.state)
    }
    return context.state
  },
  publication: (match) => {
    if (match.event.type === 'step/start') return 'none'
    if (match.event.type !== 'assistant/live-chunk') return 'immediate'
    const type = match.event.data.chunk.type
    return type === 'usage' || type === 'finish' ? 'none' : 'animation-frame'
  },
  buildLocationData: (context, scope) => {
    if (scope !== 'step') return null
    const projected = projectAssistant(context)
    if (projected === undefined) return null
    return {
      kind: 'step',
      turn: projected.data.turn,
      step: projected.data.step,
      key: 'assistant-step',
      value: projected.data,
    }
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    const data = publishedAssistantData(context)
    if (data === undefined) return null
    const settled = data.finalNode
    const visible = settled === undefined ? state.visibleBlocks > 0 : hasVisibleContent(data.blocks)
    if (settled === undefined && !visible) {
      const current = context.current.get('chat')
      if (!state.hidden || current === undefined || current === null) return null
    }
    const anchorSeq = settled?.seq ?? state.firstVisibleSeq ?? context.matches[0]?.event.seq ?? 0
    return chatNode(context, 'assistant-step', anchorSeq, data, {
      visibility: settled?.interrupted === true || visible ? 'visible' : 'hidden',
    })
  },
}

/**
 * Register the Assistant lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerAssistantConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(assistantDefinition)
}
