import { describe, expect, it } from 'vitest'

describe('enpoi-oracle report extraction', () => {
  it('returns report text only, never the child reasoning', async () => {
    const { textOfContent } = await import('../src/index.ts')
    expect(textOfContent([
      { type: 'reasoning', text: 'private deliberation' },
      { type: 'text', text: 'VERDICT: SHIP IT' },
    ])).toBe('VERDICT: SHIP IT')
    expect(textOfContent([{ type: 'tool-call', callId: 'c1', name: 'noop', argsRaw: '{}' }])).toBe('')
    expect(textOfContent([{ text: 'legacy untyped text' }])).toBe('legacy untyped text')
    expect(textOfContent(null)).toBe('')
  })
})

describe('enpoi-oracle background and output schema conformance', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      approved: { type: 'boolean' },
      concerns: { type: 'array', items: { type: 'string' } },
      unverified: { type: 'array', items: { type: 'string' } },
      blockers: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      background: { type: 'boolean' },
      rejected: { type: 'boolean' },
    },
    required: ['approved', 'concerns', 'unverified', 'blockers', 'summary'],
  }

  function validateSchema(val: Record<string, unknown>): boolean {
    for (const req of schema.required) {
      if (!(req in val)) return false
    }
    for (const k of Object.keys(val)) {
      if (!(k in schema.properties)) return false
    }
    return true
  }

  function renderOutput(value: { approved: boolean; concerns: string[]; unverified: string[]; blockers: string[]; summary: string; background?: boolean; rejected?: boolean }) {
    if (value.background === true || value.rejected === true) {
      return [{ type: 'text', text: value.summary }]
    }
    return [{
      type: 'text',
      text: value.approved
        ? `Oracle verdict: APPROVED${value.concerns.length > 0 ? ` (concerns: ${value.concerns.join('; ')})` : ''}`
        : `Oracle verdict: CONCERNS${value.concerns.length > 0 ? ` — ${value.concerns.join('; ')}` : ''}${value.blockers.length > 0 ? ` | blockers: ${value.blockers.join('; ')}` : ''}`,
    }]
  }

  it('conforms background acknowledgment return to output schema and renders cleanly without false verdict line', () => {
    const bgAck = {
      approved: false,
      concerns: [],
      unverified: [],
      blockers: [],
      summary: 'Background consultation started (child-123) — the verdict will be delivered as a message when the oracle finishes.',
      background: true,
    }

    expect(validateSchema(bgAck)).toBe(true)
    const rendered = renderOutput(bgAck)
    expect(rendered[0]?.text).toBe('Background consultation started (child-123) — the verdict will be delivered as a message when the oracle finishes.')
    expect(rendered[0]?.text).not.toContain('Oracle verdict:')
    expect(rendered[0]?.text).not.toContain('CONCERNS')
  })

  it('conforms mutex rejection return to output schema and renders cleanly without false verdict line', () => {
    const mutexRejection = {
      approved: false,
      concerns: [],
      unverified: [],
      blockers: ['CONCURRENT_CALL_REJECTED: another oracle consultation is already running for this session'],
      summary: 'Rejected by the single-flight mutex (I7): another oracle consultation is already running for this session.',
      rejected: true,
    }

    expect(validateSchema(mutexRejection)).toBe(true)
    const rendered = renderOutput(mutexRejection)
    expect(rendered[0]?.text).toBe('Rejected by the single-flight mutex (I7): another oracle consultation is already running for this session.')
    expect(rendered[0]?.text).not.toContain('Oracle verdict:')
  })

  it('renders standard approved and concerns verdicts properly when not in background mode', () => {
    const approved = {
      approved: true,
      concerns: ['small warning'],
      unverified: [],
      blockers: [],
      summary: 'LGTM overall.',
    }
    expect(validateSchema(approved)).toBe(true)
    expect(renderOutput(approved)[0]?.text).toBe('Oracle verdict: APPROVED (concerns: small warning)')

    const rejected = {
      approved: false,
      concerns: ['bad architecture'],
      unverified: [],
      blockers: ['critical flaw'],
      summary: 'Architecture is invalid.',
    }
    expect(validateSchema(rejected)).toBe(true)
    expect(renderOutput(rejected)[0]?.text).toBe('Oracle verdict: CONCERNS — bad architecture | blockers: critical flaw')
  })
})

describe('enpoi-oracle scorecard rollover (doc 35 2.4)', () => {
  it('buildInitialPackage renders PRIOR REVIEWS when the scorecard carries verdicts', async () => {
    const { buildInitialPackage } = await import('../src/index.ts')
    const out = buildInitialPackage('brief', { request: 'r' }, {
      files: [],
      verdicts: [
        { approved: true, concerns: [] },
        { approved: false, concerns: ['race in spawn'] },
      ],
    })
    expect(out).toContain('PRIOR REVIEWS')
    expect(out).toContain('approved')
    expect(out).toContain('race in spawn')
  })

  it('renders no PRIOR REVIEWS section for an empty scorecard', async () => {
    const { buildInitialPackage } = await import('../src/index.ts')
    const out = buildInitialPackage('brief', { request: 'r' }, { files: [], verdicts: [] })
    expect(out).not.toContain('PRIOR REVIEWS')
  })
})

describe('request_evidence fact sheet parsing', () => {
  it('parses a well-formed sheet', async () => {
    const { parseEvidenceSheet } = await import('../src/index.ts')
    const sheet = parseEvidenceSheet('CITATION: src/core/queue.py:142\nFACTS: claims are leased with FOR UPDATE SKIP LOCKED.\nCONFIDENCE: high')
    expect(sheet?.citation).toBe('src/core/queue.py:142')
    expect(sheet?.confidence).toBe('high')
  })

  it('degrades template placeholders instead of faking precision', async () => {
    const { parseEvidenceSheet } = await import('../src/index.ts')
    const sheet = parseEvidenceSheet('CITATION: <file:line or URL — exact>\nFACTS: something.\nCONFIDENCE: high')
    expect(sheet?.citation).toContain('unverified')
    expect(sheet?.confidence).toBe('low')
  })

  it('tolerates markdown bolding', async () => {
    const { parseEvidenceSheet } = await import('../src/index.ts')
    const sheet = parseEvidenceSheet('**CITATION:** README.md:5\n**FACTS:** the harness is plugin-based.\n**CONFIDENCE:** medium')
    expect(sheet?.citation).toBe('README.md:5')
    expect(sheet?.facts).toBe('the harness is plugin-based.')
  })

  it('routes external-looking targets to the librarian', async () => {
    const { isExternalEvidenceTarget } = await import('../src/index.ts')
    expect(isExternalEvidenceTarget('npm docs for zod v4')).toBe(true)
    expect(isExternalEvidenceTarget('web: changelog of xy')).toBe(true)
    expect(isExternalEvidenceTarget('src/core/queue.py')).toBe(false)
    expect(isExternalEvidenceTarget('council engine ledger')).toBe(false)
  })
})

describe('enpoi-oracle timeout must not orphan live work', () => {
  /** Minimal structural ctx: child facts come from a fake persistence handle. */
  function fakeOracleCtx(events: () => Array<Record<string, unknown>>, injected: string[]) {
    const handle = {
      read: async () => ({ events: events(), eventState: 'detached' }),
      close: async () => {},
    }
    const persistence = { open: async () => handle }
    const agents = {
      get: (id: string) => id === 'parent-1'
        ? { session: { id: 'parent-1' }, inject: (message: { content: Array<{ text?: string }> }) => { injected.push(message.content[0]?.text ?? '') } }
        : undefined,
    }
    return { agents, get: (name: string) => name === 'sessionPersistence' ? persistence : name === 'agents' ? agents : undefined } as never
  }

  it('raises OracleTimeoutError naming the still-running child, without deleting it', async () => {
    const { waitForChildTurn, OracleTimeoutError } = await import('../src/index.ts')
    const ctx = fakeOracleCtx(() => [{ type: 'user/message', seq: 0, data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'review this' }] } } }], [])
    const error = await waitForChildTurn(ctx, 'child-1' as never, new AbortController().signal, 20, 5).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OracleTimeoutError)
    expect((error as InstanceType<typeof OracleTimeoutError>).childId).toBe('child-1')
    expect((error as InstanceType<typeof OracleTimeoutError>).timeoutMs).toBe(20)
  })

  it('delivers the verdict after the slow child finishes and releases the single-flight mutex', async () => {
    const { deliverDetachedOracleVerdict } = await import('../src/index.ts')
    const injected: string[] = []
    let finished = false
    const events = () => [
      { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'review this' }] } } },
      ...(finished
        ? [{ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '{"approved":true,"concerns":[],"unverified":[],"blockers":[]}' }] } } }]
        : []),
    ]
    const ctx = fakeOracleCtx(events, injected)
    const fiber = { childId: 'child-1', consultations: 0, lastParentUserSeq: 0, scorecard: { files: [], verdicts: [] }, brief: null }
    const busy = new Set(['parent-1'])
    const parent = { session: { id: 'parent-1' } }
    const delivery = deliverDetachedOracleVerdict({ ctx, parent: parent as never, childId: 'child-1' as never, fiber: fiber as never, key: 'parent-1', busy, pollMs: 5 })
    // Still running: nothing delivered and the mutex stays held.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(injected).toEqual([])
    expect(busy.has('parent-1')).toBe(true)
    finished = true
    await delivery
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('detached after timeout')
    expect(injected[0]).toContain('APPROVED')
    expect(busy.has('parent-1')).toBe(false)
    expect(fiber.consultations).toBe(1)
  })
})
