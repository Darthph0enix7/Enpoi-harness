import { describe, expect, it, vi } from 'vitest'
import { apply, ORACLE_PERSONA, ORACLE_TOOL_FILTER } from '../src/index.ts'
import { createOracleHarness, waitFor } from './harness.ts'

const VERDICT = 'Reviewed thoroughly.\n{"approved":true,"concerns":["minor"],"unverified":[],"blockers":[]}'

function start(harness: ReturnType<typeof createOracleHarness>, pollMs = 100): void {
  apply(harness.ctx as never, { childPollMs: pollMs })
}

/** Read the arguments of the single registered oracle tool. */
function tool(harness: ReturnType<typeof createOracleHarness>) {
  return harness.tool('oracle_review')
}

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

describe('enpoi-oracle output schema conformance', () => {
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
    for (const key of Object.keys(val)) {
      if (!(key in schema.properties)) return false
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

  it('conforms background acknowledgment return to the output schema', () => {
    const ack = {
      approved: false,
      concerns: [],
      unverified: [],
      blockers: [],
      summary: 'Background consultation started (child-123) — the verdict will be delivered as a message when the oracle finishes.',
      background: true,
    }
    expect(validateSchema(ack)).toBe(true)
    const rendered = renderOutput(ack)
    expect(rendered[0]?.text).not.toContain('Oracle verdict:')
  })

  it('conforms the ORACLE_PENDING timeout return to the output schema', () => {
    const pending = {
      approved: false,
      concerns: [],
      unverified: [],
      blockers: ['ORACLE_PENDING'],
      summary: 'ORACLE_PENDING: the Oracle is still working; the verdict will be delivered as a message.',
      rejected: true,
    }
    expect(validateSchema(pending)).toBe(true)
    expect(renderOutput(pending)[0]?.text).toContain('ORACLE_PENDING')
  })

  it('renders standard approved and concerns verdicts', () => {
    const approved = { approved: true, concerns: ['small warning'], unverified: [], blockers: [], summary: 'LGTM overall.' }
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

describe('enpoi-oracle package builders', () => {
  it('builds the first package without a scorecard and with every optional section', async () => {
    const { buildInitialPackage } = await import('../src/index.ts')
    const out = buildInitialPackage({
      request: 'review architecture',
      files: ['src/a.ts'],
      whiteboard: '- 📌 [rule] Global Invariant',
      brief: 'Goal: ship it',
    })
    expect(out).toContain('--- PINNED WHITEBOARD ---')
    expect(out).toContain('Global Invariant')
    expect(out).toContain('--- SESSION BRIEF ---')
    expect(out).toContain('Goal: ship it')
    expect(out).toContain('--- REVIEW REQUEST ---')
    expect(out).toContain('review architecture')
    expect(out).toContain('--- READING LIST (read these files directly) ---')
    expect(out).toContain('- src/a.ts')
    expect(out).not.toContain('PRIOR REVIEWS')
  })

  it('builds a delta with only the changed sections', async () => {
    const { buildDelta } = await import('../src/index.ts')
    const out = buildDelta({
      request: 'now review the retry path',
      operatorQuery: 'please check the queue',
      whiteboard: '- 📌 [rule] Global Invariant',
      brief: 'Goal: ship it',
    })
    expect(out).toContain('--- NEW OPERATOR QUERY ---')
    expect(out).toContain('please check the queue')
    expect(out).toContain('--- PINNED WHITEBOARD ---')
    expect(out).toContain('--- CURRENT SESSION BRIEF ---')
    expect(out).toContain('--- REVIEW REQUEST ---')
    expect(out).toContain('now review the retry path')

    const bare = buildDelta({ request: 'only the request' })
    expect(bare).not.toContain('--- NEW OPERATOR QUERY ---')
    expect(bare).not.toContain('--- PINNED WHITEBOARD ---')
    expect(bare).not.toContain('--- CURRENT SESSION BRIEF ---')
  })

  it('extracts the pinned whiteboard per session and project', async () => {
    const { extractWhiteboardSummary } = await import('../src/index.ts')
    const doc = {
      whiteboard: {
        docs: {
          global: { entries: [{ kind: 'rule', text: 'Global Invariant', pinned: true }] },
          projects: { '/home/user/proj': { entries: [{ kind: 'fact', text: 'Project Fact', pinned: false }] } },
          sessions: { 'session-1': { entries: [{ kind: 'task', text: 'Session Task', pinned: true }] } },
        },
      },
    }
    const summary = extractWhiteboardSummary(doc, 'session-1', '/home/user/proj')
    expect(summary).toContain('- 📌 [rule] Global Invariant')
    expect(summary).toContain('- 📌 [task] Session Task')
    expect(summary).toContain('- [fact] Project Fact')
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

describe('enpoi-oracle persistent child (C8)', () => {
  it('reuses one quiet child labelled exactly "oracle" and sends only a delta on the second consult', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue' })
    start(harness)
    const oracle = tool(harness)

    const first = oracle.execute({ request: 'review the plan' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.spawns.length === 1)
    expect(harness.spawns[0]!.label).toBe('oracle')
    expect(harness.spawns[0]!.quiet).toBe(true)
    expect(harness.spawns[0]!.persona).toBe(ORACLE_PERSONA)
    expect(harness.spawns[0]!.prompt).toContain('--- REVIEW REQUEST ---')
    expect(harness.spawns[0]!.prompt).not.toContain('--- NEW OPERATOR QUERY ---')
    harness.settleLastSpawn(VERDICT)
    const firstResult = await first
    expect(firstResult.approved).toBe(true)

    harness.pushHuman('now check the retry path')
    const second = oracle.execute({ request: 'review the retry path' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.prompts.length === 1)
    expect(harness.spawns).toHaveLength(1)
    expect(harness.prompts[0]!.childId).toBe(harness.spawns[0]!.childId)
    expect(harness.prompts[0]!.source).toEqual({ kind: 'user' })
    expect(harness.prompts[0]!.content).toContain('--- NEW OPERATOR QUERY ---')
    expect(harness.prompts[0]!.content).toContain('now check the retry path')
    harness.settle(harness.prompts[0]!.childId, harness.prompts[0]!.messageId, VERDICT)
    await second
  })

  it('omits the operator query when the parent has not moved to a new query', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue' })
    start(harness)
    const oracle = tool(harness)

    const first = oracle.execute({ request: 'first pass' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.spawns.length === 1)
    harness.settleLastSpawn(VERDICT)
    await first

    const second = oracle.execute({ request: 'follow-up' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.prompts.length === 1)
    expect(harness.prompts[0]!.content).not.toContain('--- NEW OPERATOR QUERY ---')
    harness.settle(harness.prompts[0]!.childId, harness.prompts[0]!.messageId, VERDICT)
    await second
  })

  it('sends the whiteboard and brief only when they changed', async () => {
    const harness = createOracleHarness({
      humanText: 'build the queue',
      livingBrief: 'Goal: ship the queue',
      settings: {
        parameters: { oracle: { timeoutMs: 120_000 } },
        whiteboard: { docs: { sessions: { 'parent-1': { entries: [{ kind: 'task', text: 'first entry', pinned: true }] } } } },
      },
    })
    start(harness)
    const oracle = tool(harness)

    const first = oracle.execute({ request: 'first pass' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.spawns.length === 1)
    expect(harness.spawns[0]!.prompt).toContain('--- PINNED WHITEBOARD ---')
    expect(harness.spawns[0]!.prompt).toContain('--- SESSION BRIEF ---')
    harness.settleLastSpawn(VERDICT)
    await first

    const unchanged = oracle.execute({ request: 'same context' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.prompts.length === 1)
    expect(harness.prompts[0]!.content).not.toContain('--- PINNED WHITEBOARD ---')
    expect(harness.prompts[0]!.content).not.toContain('--- CURRENT SESSION BRIEF ---')
    harness.settle(harness.prompts[0]!.childId, harness.prompts[0]!.messageId, VERDICT)
    await unchanged

    harness.settings.whiteboard = { docs: { sessions: { 'parent-1': { entries: [{ kind: 'task', text: 'second entry', pinned: true }] } } } }
    harness.setLivingBrief('Goal: ship the queue with retries')
    const whiteboardOnly = oracle.execute({ request: 'whiteboard moved' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.prompts.length === 2)
    expect(harness.prompts[1]!.content).toContain('--- PINNED WHITEBOARD ---')
    expect(harness.prompts[1]!.content).toContain('second entry')
    // The brief changed too, but without a new operator query it is not resent.
    expect(harness.prompts[1]!.content).not.toContain('--- CURRENT SESSION BRIEF ---')
    harness.settle(harness.prompts[1]!.childId, harness.prompts[1]!.messageId, VERDICT)
    await whiteboardOnly

    harness.pushHuman('now check the retry path')
    const newQuery = oracle.execute({ request: 'review retries' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.prompts.length === 3)
    expect(harness.prompts[2]!.content).toContain('--- NEW OPERATOR QUERY ---')
    expect(harness.prompts[2]!.content).toContain('--- CURRENT SESSION BRIEF ---')
    expect(harness.prompts[2]!.content).toContain('ship the queue with retries')
    harness.settle(harness.prompts[2]!.childId, harness.prompts[2]!.messageId, VERDICT)
    await newQuery
  })

  it('starts a new child when fresh:true is passed', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue' })
    start(harness)
    const oracle = tool(harness)

    const first = oracle.execute({ request: 'first pass' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.spawns.length === 1)
    harness.settleLastSpawn(VERDICT)
    await first

    const second = oracle.execute({ request: 'fresh eyes', fresh: true }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.spawns.length === 2)
    expect(harness.spawns[1]!.prompt).toContain('--- REVIEW REQUEST ---')
    expect(harness.spawns[1]!.prompt).not.toContain('--- NEW OPERATOR QUERY ---')
    harness.settleLastSpawn(VERDICT)
    await second
  })

  it('rediscovers the newest exact-label oracle child and ignores old labels', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue' })
    harness.seedChild('existing-oracle', 'oracle')
    harness.seedChild('old-label-child', 'oracle review: legacy')
    harness.seedChild('one-shot-child', 'oracle', 'one-shot')
    start(harness)
    const running = tool(harness).execute(
      { request: 'continue the review' },
      { agent: harness.parent, signal: new AbortController().signal },
    )
    await waitFor(() => harness.prompts.length === 1)
    expect(harness.spawns).toHaveLength(0)
    expect(harness.prompts[0]!.childId).toBe('existing-oracle')
    expect(harness.prompts[0]!.content).toContain('--- NEW OPERATOR QUERY ---')
    expect(harness.prompts[0]!.content).toContain('build the queue')
    harness.settle('existing-oracle', harness.prompts[0]!.messageId, VERDICT)
    await running
  })

  it('starts a new child when the resolved route changes', async () => {
    const harness = createOracleHarness({
      humanText: 'build the queue',
      settings: { personas: { oracle: { provider: 'p1', model: 'm1' } }, parameters: { oracle: { timeoutMs: 120_000 } } },
    })
    start(harness)
    const oracle = tool(harness)

    const first = oracle.execute({ request: 'first pass' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.spawns.length === 1)
    expect(harness.spawns[0]!.agentOptions).toEqual({ provider: 'p1', model: 'm1' })
    harness.settleLastSpawn(VERDICT)
    await first

    harness.setSettings({ personas: { oracle: { provider: 'p2', model: 'm2' } }, parameters: { oracle: { timeoutMs: 120_000 } } })
    const second = oracle.execute({ request: 'second pass' }, { agent: harness.parent, signal: new AbortController().signal })
    await waitFor(() => harness.spawns.length === 2)
    expect(harness.spawns[1]!.agentOptions).toEqual({ provider: 'p2', model: 'm2' })
    harness.settleLastSpawn(VERDICT)
    await second
  })
})

describe('enpoi-oracle per-parent FIFO queue', () => {
  it('runs overlapping consultations in call order instead of rejecting one', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue' })
    start(harness)
    const oracle = tool(harness)
    const signal = new AbortController().signal

    const first = oracle.execute({ request: 'first consultation' }, { agent: harness.parent, signal })
    await waitFor(() => harness.spawns.length === 1)

    const second = oracle.execute({ request: 'second consultation' }, { agent: harness.parent, signal })
    await new Promise(resolve => setTimeout(resolve, 50))
    // The second call waits behind the first: nothing was delivered yet.
    expect(harness.spawns).toHaveLength(1)
    expect(harness.prompts).toHaveLength(0)

    harness.settleLastSpawn(VERDICT)
    const firstResult = await first
    expect(firstResult.rejected).toBeUndefined()

    await waitFor(() => harness.prompts.length === 1)
    expect(harness.prompts[0]!.content).toContain('second consultation')
    harness.settle(harness.prompts[0]!.childId, harness.prompts[0]!.messageId, VERDICT)
    const secondResult = await second
    expect(secondResult.approved).toBe(true)
  })
})

describe('enpoi-oracle background delivery', () => {
  it('wakes an idle parent with a follow-up carrying the enpoi-oracle source', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue', parentStatus: 'idle' })
    start(harness)
    const result = await tool(harness).execute(
      { request: 'review in background', background: true },
      { agent: harness.parent, signal: new AbortController().signal },
    )
    expect(result.background).toBe(true)
    await waitFor(() => harness.spawns.length === 1)
    harness.settleLastSpawn(VERDICT)
    await waitFor(() => harness.deliveries.length === 1)
    expect(harness.deliveries[0]!.kind).toBe('followup')
    expect(harness.deliveries[0]!.message.source).toEqual({ kind: 'enpoi-oracle' })
    expect(harness.deliveries[0]!.message.content[0]?.text).toContain('APPROVED')
  })

  it('queues quietly for the next turn when the operator moved to a newer query', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue', parentStatus: 'idle' })
    start(harness)
    await tool(harness).execute(
      { request: 'review in background', background: true },
      { agent: harness.parent, signal: new AbortController().signal },
    )
    await waitFor(() => harness.spawns.length === 1)
    harness.pushHuman('a newer operator query')
    harness.settleLastSpawn(VERDICT)
    await waitFor(() => harness.deliveries.length === 1)
    expect(harness.deliveries[0]!.kind).toBe('send')
    expect(harness.deliveries[0]!.target).toBe('next-turn')
    expect(harness.deliveries[0]!.wakeup).toBe(false)
  })

  it('steers a running parent instead of opening a new turn', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue', parentStatus: 'running' })
    start(harness)
    await tool(harness).execute(
      { request: 'review in background', background: true },
      { agent: harness.parent, signal: new AbortController().signal },
    )
    await waitFor(() => harness.spawns.length === 1)
    harness.settleLastSpawn(VERDICT)
    await waitFor(() => harness.deliveries.length === 1)
    expect(harness.deliveries[0]!.kind).toBe('steer')
  })
})

describe('enpoi-oracle timeout keeps live work deliverable', () => {
  it('returns ORACLE_PENDING and delivers the verdict later as a message', async () => {
    vi.useFakeTimers()
    try {
      const harness = createOracleHarness({
        humanText: 'build the queue',
        settings: { parameters: { oracle: { timeoutMs: 30_000 } } },
      })
      start(harness)
      const oracle = tool(harness)
      const promise = oracle.execute(
        { request: 'slow consultation' },
        { agent: harness.parent, signal: new AbortController().signal },
      )
      await vi.advanceTimersByTimeAsync(31_000)
      const result = await promise
      expect(result.rejected).toBe(true)
      expect(String(result.blockers)).toContain('ORACLE_PENDING')
      expect(String(result.summary)).toContain('ORACLE_PENDING')

      harness.settleLastSpawn(VERDICT)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(harness.deliveries).toHaveLength(1)
      expect(harness.deliveries[0]!.message.source).toEqual({ kind: 'enpoi-oracle' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('enpoi-oracle abort', () => {
  it('interrupts the child and delivers nothing when the caller aborts', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue' })
    start(harness)
    const controller = new AbortController()
    const promise = tool(harness).execute(
      { request: 'review this' },
      { agent: harness.parent, signal: controller.signal },
    )
    await waitFor(() => harness.spawns.length === 1)
    controller.abort(new Error('cancelled'))
    await expect(promise).rejects.toThrow('cancelled')
    expect(harness.interruptions).toHaveLength(1)
    expect(harness.interruptions[0]!.childId).toBe(harness.spawns[0]!.childId)
    expect(harness.interruptions[0]!.authority).toEqual({ kind: 'ancestor', agent: harness.parent })
    expect(harness.deliveries).toHaveLength(0)
  })
})

describe('enpoi-oracle tool surface', () => {
  it('keeps send_message denied for the Oracle child', () => {
    expect(ORACLE_TOOL_FILTER.deny).toContain('send_message')
  })

  it('describes one persistent Oracle with FIFO queueing and waking delivery', () => {
    const harness = createOracleHarness({ humanText: 'build the queue' })
    start(harness)
    const definition = tool(harness)
    expect(definition.description).toContain('One persistent Oracle per session remembers every earlier consultation')
    expect(definition.description).toContain('Calls made while it is busy queue in order.')
    expect(definition.description).toContain('background:true delivers the verdict as a message that wakes this session.')
    expect(JSON.stringify(definition.parameters)).toContain('"fresh"')
  })

  it('states the persistent persona line', () => {
    expect(ORACLE_PERSONA).toContain(
      'This is a persistent reviewer session for the whole operator session: reuse your accumulated context and earlier verdicts across consultations; when a consultation names a new operator query, re-ground on it.',
    )
  })

  it('defaults childPollMs to 1000 and rejects below 100', async () => {
    const { Config } = await import('../src/index.ts')
    expect(Config({}).childPollMs).toBe(1000)
    expect(() => Config({ childPollMs: 50 })).toThrow()
  })
})

describe('enpoi-oracle request_evidence', () => {
  it('waits on the accepted message id and releases the research child', async () => {
    const harness = createOracleHarness({ humanText: 'build the queue' })
    start(harness)
    const evidence = harness.tool('request_evidence')
    const promise = evidence.execute(
      { target: 'src/core/queue.ts', question: 'how are claims leased?' },
      { agent: harness.parent, signal: new AbortController().signal },
    )
    await waitFor(() => harness.spawns.length === 1)
    harness.settle(
      harness.spawns[0]!.childId,
      harness.spawns[0]!.messageId,
      'CITATION: src/core/queue.ts:42\nFACTS: leases use SKIP LOCKED.\nCONFIDENCE: high',
    )
    const result = await promise
    expect(result.found).toBe(true)
    expect(result.citation).toBe('src/core/queue.ts:42')
    expect(harness.drained).toEqual([{ parentId: 'parent-1', childIds: [harness.spawns[0]!.childId] }])
  })
})
