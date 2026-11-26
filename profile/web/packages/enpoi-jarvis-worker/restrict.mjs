/** Install the reviewed allow-only mask in the preset's agent scope. */
export const name = 'jarvis-worker-tool-restriction'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - preset-scoped context. */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.restrict({
    allow: ['mcp__jarvis__knowledge_search', 'mcp__jarvis__knowledge_facts'],
    deny: ['run_code'],
  }))
}
