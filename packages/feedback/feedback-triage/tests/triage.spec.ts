/**
 * feedback-triage unit suite: the prompt, the tolerant JSON extractor, and the
 * service seam (a fake runner proving fail-soft nulls and pass-through).
 * The real isolated-session run is exercised by integration on a device.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildTriagePrompt, FeedbackTriageSession, parseTriage, TRIAGE_CATEGORIES } from '../src/index.ts'

describe('buildTriagePrompt', () => {
  it('embeds the message, category, and sections and pins the contract', () => {
    const prompt = buildTriagePrompt({
      message: 'the diff view is unreadable',
      category: 'product-interaction',
      sections: { system: { app: { name: 'deepseek-harness', version: '1.2.3', commit: '' }, platform: 'darwin', arch: 'arm64', node: 'v22', providers: [], defaultModel: null } },
    })
    expect(prompt).toContain('the diff view is unreadable')
    expect(prompt).toContain('product-interaction')
    expect(prompt).toContain('"platform": "darwin"')
    expect(prompt).toContain('"severity"')
    for (const category of TRIAGE_CATEGORIES) expect(prompt).toContain(category)
  })
})

describe('parseTriage', () => {
  const valid = { category: 'service-stability', severity: 'high', summary: 'the update rolled back twice' }

  it('parses a bare JSON object', () => {
    expect(parseTriage(JSON.stringify(valid))).toEqual(valid)
  })

  it('parses fenced and prose-wrapped JSON', () => {
    expect(parseTriage(`Here is the answer:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nDone.`)).toEqual(valid)
    expect(parseTriage(`Sure — ${JSON.stringify({ ...valid, details: 'extra' })} — thanks`)).toEqual({ ...valid, details: 'extra' })
  })

  it('rejects anything outside the strict contract', () => {
    expect(parseTriage('no json here')).toBeNull()
    expect(parseTriage(JSON.stringify({ ...valid, category: 'made-up' }))).toBeNull()
    expect(parseTriage(JSON.stringify({ ...valid, severity: 'critical' }))).toBeNull()
    expect(parseTriage(JSON.stringify({ ...valid, summary: '   ' }))).toBeNull()
    expect(parseTriage(JSON.stringify({ ...valid, details: 42 }))).toBeNull()
    expect(parseTriage('{"category":"service-stability","severity":"high"')).toBeNull()
  })
})

describe('FeedbackTriageSession service', () => {
  it('delegates to the runner seam and returns its answer', async () => {
    const service = new FeedbackTriageSession(new Context())
    service.runner = async () => ({ category: 'resource-cost', severity: 'low', summary: 'slow scan' })
    expect(await service.triage({ message: 'scan is slow', sections: {} }))
      .toEqual({ category: 'resource-cost', severity: 'low', summary: 'slow scan' })
  })

  it('returns null when the runner throws or returns null (fail-soft)', async () => {
    const service = new FeedbackTriageSession(new Context())
    service.runner = async () => { throw new Error('model down') }
    expect(await service.triage({ message: 'x', sections: {} })).toBeNull()
    service.runner = async () => null
    expect(await service.triage({ message: 'x', sections: {} })).toBeNull()
  })
})
