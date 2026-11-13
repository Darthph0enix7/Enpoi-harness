/** Assert the authored compaction request keeps public evidence and no reasoning. */
export const name = 'assert-public-replay'
export const inject = ['llm']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-local context.
 */
export function apply(ctx) {
  let checked = false
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== 'compaction') {
      yield* next()
      return
    }
    if (checked) throw new Error('compaction request was repeated')
    checked = true
    const texts = []
    let reasoning = false
    for (const message of options.messages) {
      for (const block of message.content) {
        if (block.type === 'reasoning') reasoning = true
        if (block.type === 'text') texts.push(block.text)
        if (block.type === 'tool-call') texts.push(block.arguments)
      }
    }
    const corpus = texts.join('\n')
    if (reasoning) throw new Error('compaction request carried private reasoning')
    for (const marker of [
      'HUMAN_PUBLIC_MARKER',
      'ASSISTANT_PUBLIC_MARKER',
      'TOOL_CALL_PUBLIC_MARKER',
      'TOOL_RESULT_PUBLIC_MARKER',
    ]) {
      if (!corpus.includes(marker)) throw new Error(`compaction request lost ${marker}`)
    }
    for (const label of [
      'human operator instruction',
      'public assistant output and tool-call arguments projected as public evidence',
      'tool result evidence projected as user-role public evidence',
    ]) {
      if (!corpus.includes(label)) throw new Error(`compaction request lost source label ${label}`)
    }
    if (corpus.includes('PRIVATE_REASONING_MARKER')) {
      throw new Error('compaction request carried the private reasoning text')
    }
    yield* next()
  })
}
