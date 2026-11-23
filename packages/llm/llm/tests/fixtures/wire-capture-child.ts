/** One shared-root writer process for the wire-retention convergence spec. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '../../src/message.ts'
import { captureWireRequest } from '../../src/wire-sessions.ts'

const label = process.env.WIRE_CHILD_LABEL ?? 'child'
const count = Number(process.env.WIRE_CHILD_COUNT ?? '4')
const messages = [createUserMessage({
  content: [{ type: 'text', text: `${label} ${'x'.repeat(160)}` }],
  source: { kind: 'user' },
})]

for (let index = 0; index < count; index += 1) {
  captureWireRequest({
    provider: 'mock',
    model: 'mock',
    sessionId: `${label}-session-${index}` as Branded<'SessionId'>,
    messages,
    tools: [],
  })
  await new Promise(resolve => setTimeout(resolve, 5))
}
// Keep the process alive until the fire-and-forget queue has written and pruned.
await new Promise(resolve => setTimeout(resolve, 800))
