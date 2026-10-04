/**
 * Root-side advisory recommendation — one-shot seam suite.
 *
 * Pins the bounded model call the forwarded card's recommendation line comes
 * from: prompt facts, untrusted-output parsing, and the fail-open behaviour
 * (success, timeout, error, cut) that keeps the derived line whenever the call
 * misses. The suggestion is advisory presentation and never resolves an ask.
 */

import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  buildRecommendationPrompt, parseRecommendationAnswer, requestRecommendation,
  RECOMMENDATION_MAX_TOKENS, RECOMMENDATION_TIMEOUT_MS,
  type RecommendationAsk,
} from '../src/recommendation'
import type { AskDecision, ForwardingOrigin } from '../src/forwarding'

const ORIGIN: ForwardingOrigin = {
  childSessionId: 'child-42', rootSessionId: 'root-1', parentSessionId: 'root-1',
  depth: 1, label: 'fixer: repair', cwd: '/ws',
}

const DECISION = {
  kind: 'ask', reason: 'bash rule requires approval', source: 'rule:bash', grantTier: 'pattern',
} as unknown as AskDecision

function ask(overrides: Partial<RecommendationAsk> = {}): RecommendationAsk {
  return {
    toolName: 'bash',
    args: { command: 'rm plain' },
    origin: ORIGIN,
    workspaceRelation: "the child runs in the root's own workspace (/ws)",
    decision: DECISION,
    ...overrides,
  }
}

function textStream(text: string, finish: 'stop' | 'max-tokens' = 'stop') {
  return async function* stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: finish } }
  }
}

function failingStream(error: Error) {
  return async function* stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw error
  }
}

describe('recommendation prompt', () => {
  it('carries the ask, provenance, rails verdict, and workspace relation', () => {
    const prompt = buildRecommendationPrompt(ask())
    expect(prompt.user).toContain('tool: bash')
    expect(prompt.user).toContain('arguments: {"command":"rm plain"}')
    expect(prompt.user).toContain('child: fixer: repair (depth 1, session child-42)')
    expect(prompt.user).toContain('why it asked: bash rule requires approval')
    expect(prompt.user).toContain('matched rule: rule:bash')
    expect(prompt.user).toContain('rails verdict: no never-approvable class matched')
    expect(prompt.user).toContain("workspace: the child runs in the root's own workspace (/ws)")
    expect(prompt.system).toContain('advisory')
  })

  it('names a matched rail and bounds a huge argument payload', () => {
    const prompt = buildRecommendationPrompt(ask({
      rail: { rail: 'credentials', evidence: '.env' },
      args: { command: 'x'.repeat(2000) },
    }))
    expect(prompt.user).toContain('rails verdict: matched credentials (.env)')
    expect(prompt.user.length).toBeLessThan(1200)
    expect(prompt.user).toContain('…')
  })

  it('marks an APPLIED judgement (Full access) as the decision, not card advice', () => {
    const applied = buildRecommendationPrompt(ask({ applied: true }))
    expect(applied.system).toContain('Full access')
    expect(applied.system).toContain('APPLIED')
    expect(buildRecommendationPrompt(ask()).system).not.toContain('APPLIED')
  })
})

describe('recommendation parsing (untrusted model output)', () => {
  it('accepts a plain JSON object and keeps a valid suggestion', () => {
    expect(parseRecommendationAnswer('{"text":"Safe to run once.","suggestion":"allow-once"}'))
      .toEqual({ text: 'Safe to run once.', suggestion: 'allow-once' })
  })

  it('accepts JSON inside prose or a code fence', () => {
    expect(parseRecommendationAnswer('Sure:\n```json\n{"text":"Inside the workspace.","suggestion":"allow"}\n```'))
      .toEqual({ text: 'Inside the workspace.', suggestion: 'allow' })
  })

  it('drops an unknown suggestion but keeps the line', () => {
    expect(parseRecommendationAnswer('{"text":"Looks risky.","suggestion":"maybe"}')).toEqual({ text: 'Looks risky.' })
  })

  it('rejects empty, non-JSON, text-less, and non-object answers', () => {
    expect(parseRecommendationAnswer('')).toBeUndefined()
    expect(parseRecommendationAnswer('no json here')).toBeUndefined()
    expect(parseRecommendationAnswer('{"suggestion":"allow"}')).toBeUndefined()
    expect(parseRecommendationAnswer('{"text":"   "}')).toBeUndefined()
    expect(parseRecommendationAnswer('["allow"]')).toBeUndefined()
  })

  it('clips an overlong line', () => {
    const parsed = parseRecommendationAnswer(JSON.stringify({ text: 'x'.repeat(400) }))
    expect(parsed?.text.length).toBe(240)
    expect(parsed?.text.endsWith('…')).toBe(true)
  })
})

describe('requestRecommendation (bounded one-shot)', () => {
  const model = { provider: 'freellmapi', model: 'auto' }

  it('returns the parsed answer on a clean stop and honours the output cap', async () => {
    // The bound is the requirement's tight 5–8s window.
    expect(RECOMMENDATION_TIMEOUT_MS).toBeGreaterThanOrEqual(5000)
    expect(RECOMMENDATION_TIMEOUT_MS).toBeLessThanOrEqual(8000)
    const seen: GenerateOptions[] = []
    const stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      seen.push(options)
      yield { type: 'text-delta', index: 0, text: '{"text":"Safe once.","suggestion":"allow-once"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const answer = await requestRecommendation(ask(), { stream, ...model })
    expect(answer).toEqual({ text: 'Safe once.', suggestion: 'allow-once' })
    expect(seen[0].provider).toBe('freellmapi')
    expect(seen[0].model).toBe('auto')
    expect(seen[0].maxTokens).toBe(RECOMMENDATION_MAX_TOKENS)
    expect(seen[0].temperature).toBe(0)
    expect(seen[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('times out tightly and returns undefined (caller keeps the derived line)', async () => {
    const stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      const signal = options.signal
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted === true) {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
          return
        }
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }, { once: true })
      })
    }
    const started = Date.now()
    const misses: string[] = []
    const answer = await requestRecommendation(ask(), { stream, ...model, timeoutMs: 30, onMiss: reason => misses.push(reason) })
    expect(answer).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(misses[0]).toContain('ENPOI_FORWARDED_RECOMMENDATION after 30ms')
  })

  it('returns undefined when the provider errors, the stream is cut, or the signal is aborted', async () => {
    const misses: string[] = []
    expect(await requestRecommendation(ask(), {
      stream: failingStream(new Error('provider exploded')), ...model, onMiss: reason => misses.push(reason),
    })).toBeUndefined()
    expect(misses[0]).toContain('provider exploded')
    expect(await requestRecommendation(ask(), { stream: textStream('{"text":"partial"', 'max-tokens'), ...model })).toBeUndefined()
    const controller = new AbortController()
    controller.abort(new Error('child call aborted'))
    expect(await requestRecommendation(ask(), { stream: textStream('{"text":"late"}'), ...model, signal: controller.signal })).toBeUndefined()
  })

  it('returns undefined for unparseable text and names the miss for the host', async () => {
    const misses: string[] = []
    expect(await requestRecommendation(ask(), {
      stream: textStream('I would allow this.'), ...model, onMiss: reason => misses.push(reason),
    })).toBeUndefined()
    expect(misses[0]).toContain('unparseable answer')
    expect(misses[0]).toContain('I would allow this.')
  })
})
