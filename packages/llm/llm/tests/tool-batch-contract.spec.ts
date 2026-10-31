/**
 * One contract matrix over every adapter's history→wire conversion.
 *
 * The shared fixture declares two tool calls and puts an image in each result.
 * Whatever an adapter does with those images, the wire must keep the results
 * contiguous and in call order, put nothing between the assistant message and
 * the batch's last result, and place escaped extras only after the batch.
 */
import { describe, it } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveAdapterOptions } from '../../llm-deepseek/src/config.ts'
import { serialize } from '../../llm-deepseek/src/serialize.ts'
import { toPiContext } from '../../llm-pi-ai/src/context.ts'
type PiContext = Awaited<ReturnType<typeof toPiContext>>
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { assertToolBatchContract, requestImage, toolBatchHistory, toolBatchImages } from './tool-batch-fixture.ts'
import type { WireView } from './tool-batch-fixture.ts'

/** One adapter row: a name, its history→wire conversion, and expected escaped extras. */
interface ContractAdapter {
  readonly name: string
  readonly convert: () => Promise<WireView> | WireView
  /** Messages that must follow the batch because content left a tool result. */
  readonly extras: number
}

/** The pi-ai conversion keeps images inside the tool result, so nothing escapes. */
function piAiView(context: PiContext): WireView {
  return {
    units: context.messages.flatMap((message): WireView['units'][number][] => {
      if (message.role === 'assistant') {
        return [{
          kind: 'assistant',
          callIds: message.content.flatMap(block => block.type === 'toolCall' ? [block.id] : []),
        }]
      }
      if (message.role === 'toolResult') return [{ kind: 'tool-result', callId: message.toolCallId }]
      return [{ kind: 'other' }]
    }),
  }
}

/** The Messages serializer keeps images inside each `tool_result` block. */
function deepSeekView(body: ReturnType<typeof serialize>): WireView {
  return {
    units: body.messages.flatMap((message): WireView['units'][number][] => {
      const units: WireView['units'][number][] = []
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          const last = units.at(-1)
          if (last?.kind === 'assistant') (last.callIds as string[]).push(block.id)
          else units.push({ kind: 'assistant', callIds: [block.id] })
        } else if (block.type === 'tool_result') {
          units.push({ kind: 'tool-result', callId: block.tool_use_id })
        } else {
          units.push({ kind: 'other' })
        }
      }
      return units
    }),
  }
}

const history = toolBatchHistory()
const images = toolBatchImages()

/**
 * Add each adapter here. A new row needs only its conversion and the number of
 * messages it moves out of the batch (zero when the wire keeps them in place).
 */
const adapters: readonly ContractAdapter[] = [
  {
    name: 'llm-pi-ai context',
    extras: 0,
    convert: () => toPiContext(
      { provider: 'openai', model: 'gpt-4.1', messages: history },
      {
        attachments: {
          readImageRequest: async (ref: Parameters<typeof requestImage>[0]) => requestImage(ref),
        } as unknown as AttachmentStore,
        resolveImageAccess: () => undefined,
      },
    ).then(piAiView),
  },
  {
    name: 'llm-deepseek serialize',
    extras: 0,
    convert: () => {
      const connection = resolveAdapterOptions({ models: [{ id: 'deepseek-v4-flash', inputModalities: ['text', 'image'] }] })
      const request: GenerateOptions = { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: history }
      return deepSeekView(serialize(request, connection, history, images, () => undefined))
    },
  },
]

describe('tool-batch contract matrix', () => {
  it.each(adapters)('$name keeps results contiguous and extras after the batch', async ({ convert, extras }) => {
    assertToolBatchContract(await convert(), extras)
  })
})
