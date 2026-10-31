/**
 * One shared history fixture for the tool-batch contract matrix.
 *
 * Add a new adapter by adding a row to the matrix in
 * `tool-batch-contract.spec.ts` (root packages) or in the command-code
 * package's `convert.spec.ts`, and normalize its wire output into a
 * {@link WireView} with `assertToolBatchContract`.
 */
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { expect } from 'vitest'

export const FIRST_CALL = 'call-first'
export const SECOND_CALL = 'call-second'

const image = (seed: string): ImageAttachmentRef => ({
  attachmentId: AttachmentId(`sha256:${seed.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
})

export const FIRST_IMAGE = image('1')
export const SECOND_IMAGE = image('2')

/** The shared fixture: one assistant turn with two calls, and an image in each result. */
export function toolBatchHistory(): Message[] {
  return [
    createUserMessage({
      content: [{ type: 'text', text: 'inspect both images' }],
      source: { kind: 'user' },
    }),
    createAssistantMessage({
      content: [
        { type: 'tool-call', id: ToolCallId(FIRST_CALL), name: 'read_image', arguments: '{"path":"first.png"}' },
        { type: 'tool-call', id: ToolCallId(SECOND_CALL), name: 'read_image', arguments: '{"path":"second.png"}' },
      ],
      source: { provider: 'openai', model: 'gpt-4.1' },
    }),
    createToolResultMessage({
      callId: ToolCallId(FIRST_CALL),
      content: [{ type: 'text', text: 'first result' }, { type: 'image', attachment: FIRST_IMAGE }],
      isError: false,
    }),
    createToolResultMessage({
      callId: ToolCallId(SECOND_CALL),
      content: [{ type: 'text', text: 'second result' }, { type: 'image', attachment: SECOND_IMAGE }],
      isError: false,
    }),
  ]
}

/** Request versions for the fixture's two images, keyed by attachment id. */
export function toolBatchImages(): Map<AttachmentId, RequestImageAttachment> {
  return new Map([FIRST_IMAGE, SECOND_IMAGE].map(ref => [ref.attachmentId, requestImage(ref)]))
}

/** One encoded request version for a fixture attachment. */
export function requestImage(ref: ImageAttachmentRef): RequestImageAttachment {
  return {
    variantId: ImageVariantId(`sha256:${'f'.repeat(64)}`),
    attachment: ref,
    data: ref.attachmentId === FIRST_IMAGE.attachmentId ? Uint8Array.of(1, 2, 3) : Uint8Array.of(4, 5, 6),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: true,
  }
}

/** One normalized wire unit: an assistant call message, one result, or anything else. */
export type WireUnit =
  | { readonly kind: 'assistant'; readonly callIds: readonly string[] }
  | { readonly kind: 'tool-result'; readonly callId: string }
  | { readonly kind: 'other' }

/** The adapter's wire output, flattened to the units the contract speaks about. */
export interface WireView {
  readonly units: readonly WireUnit[]
}

/**
 * Assert the batch contract every adapter must satisfy.
 * @param view - the adapter's normalized wire output.
 * @param extras - number of messages that must follow (and only follow) the batch.
 */
export function assertToolBatchContract(view: WireView, extras: number): void {
  const { units } = view
  const calls = units.flatMap(unit => unit.kind === 'assistant' ? unit.callIds : [])
  expect(calls).toEqual([FIRST_CALL, SECOND_CALL])

  const results = units.filter((unit): unit is Extract<WireUnit, { kind: 'tool-result' }> =>
    unit.kind === 'tool-result')
  expect(results.map(unit => unit.callId)).toEqual([FIRST_CALL, SECOND_CALL])

  const assistantIndex = units.findIndex(unit => unit.kind === 'assistant')
  const lastResultIndex = units.findLastIndex(unit => unit.kind === 'tool-result')
  expect(assistantIndex).toBeGreaterThanOrEqual(0)
  expect(lastResultIndex).toBeGreaterThan(assistantIndex)

  // (a) + (b): after the assistant message the results are one contiguous run,
  // in call order, with no non-tool message before the last one.
  expect(units.slice(assistantIndex + 1, lastResultIndex + 1)).toEqual(results)

  // (c): anything moved out of the results sits only after the batch.
  const trailing = units.slice(lastResultIndex + 1)
  expect(trailing).toHaveLength(extras)
  expect(trailing.every(unit => unit.kind === 'other')).toBe(true)
}
