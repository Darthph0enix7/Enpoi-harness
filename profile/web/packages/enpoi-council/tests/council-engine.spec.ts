import { describe, expect, it } from 'vitest'
import {
  BROKER_KEPT_TOOLS,
  COUNCIL_DENIED_TOOLS,
  COUNCIL_KEPT_TOOLS,
  DEBATER_DENIED_TOOLS,
  RETRIEVAL_TOOLS,
  councilDenyList,
  estimateTokens,
  textOfContent,
  waitForSeatTurnDetailed,
} from '../src/core/fiber.ts'
import { extractEvidenceRequests, parseFactSheet } from '../src/core/broker.ts'
import { extractProposals, parseRefereeOutput } from '../src/core/referee.ts'
import { ROUNDTABLE_SPEC } from '../src/profiles/roundtable.ts'

describe('evidence fencing (doc 54 §6, Oracle amendment #2)', () => {
  it('debaters lose ALL retrieval tools — the broker is the only ingress', () => {
    for (const tool of RETRIEVAL_TOOLS) {
      expect(DEBATER_DENIED_TOOLS).toContain(tool)
    }
  })

  it('broker children keep exactly the research surface', () => {
    expect(BROKER_KEPT_TOOLS).toEqual([...RETRIEVAL_TOOLS])
    for (const tool of BROKER_KEPT_TOOLS) {
      expect(COUNCIL_DENIED_TOOLS).not.toContain(tool)
    }
  })

  it('anti-leak core is intact in both tiers', () => {
    // Seats/referee/chair may NOT run shell commands (2026-09-27: a referee
    // emitted its JSON through a bash heredoc and the pass was lost; a chair
    // spent ~3 minutes shelling for a ledger that never existed). The broker
    // tier keeps the research surface; memory_search stays available.
    for (const t of ['send_message', 'subagent', 'edit', 'write', 'memory_save', 'bash']) {
      expect(DEBATER_DENIED_TOOLS).toContain(t)
    }
    for (const t of ['send_message', 'subagent', 'edit', 'write', 'memory_save']) {
      expect(COUNCIL_DENIED_TOOLS).toContain(t)
    }
    expect(COUNCIL_DENIED_TOOLS).not.toContain('bash')       // broker keeps its research surface
    expect(COUNCIL_DENIED_TOOLS).not.toContain('memory_search')
    expect(DEBATER_DENIED_TOOLS).not.toContain('memory_search')
  })

  it('never names run_code (reserved PTC transport)', () => {
    expect(DEBATER_DENIED_TOOLS).not.toContain('run_code')
    expect(COUNCIL_DENIED_TOOLS).not.toContain('run_code')
  })

  it('keeps the pinned whiteboard in every fencing tier (debaters, chair, broker, registered councils)', () => {
    expect(COUNCIL_KEPT_TOOLS).toContain('whiteboard_read')
    expect(COUNCIL_KEPT_TOOLS).toContain('whiteboard_write')
    for (const tool of COUNCIL_KEPT_TOOLS) {
      expect(DEBATER_DENIED_TOOLS).not.toContain(tool)
      expect(COUNCIL_DENIED_TOOLS).not.toContain(tool)
      expect(councilDenyList(['roundtable'])).not.toContain(tool)
      // A registered council id that collides with a board tool name must not
      // sneak it back into a seat's deny list either.
      expect(councilDenyList([tool])).not.toContain(tool)
    }
  })
})

describe('evidence request extraction', () => {
  it('parses tolerant NEED_EVIDENCE lines', () => {
    const text = [
      'I need ground truth.',
      'NEED_EVIDENCE(target: queue scheduler, question: does claim_next use a lock?)',
      'NEED_EVIDENCE(target: "npm docs", question: "what is the retry default?")',
      'NEED_EVIDENCE(target:, question: empty target ignored)',
    ].join('\n')
    const reqs = extractEvidenceRequests('skeptic', 2, text)
    expect(reqs).toHaveLength(2)
    expect(reqs[0].target).toBe('queue scheduler')
    expect(reqs[1].question).toBe('what is the retry default?')
    expect(reqs[0].ticket).toMatch(/^EV-[0-9a-f]{8}$/)
  })

  it('same question from different seats yields the same ticket (dedupe)', () => {
    const a = extractEvidenceRequests('skeptic', 2, 'NEED_EVIDENCE(target: scheduler, question: lock or row update?)')
    const b = extractEvidenceRequests('architect', 2, 'NEED_EVIDENCE(target: scheduler, question: lock or row update?)')
    expect(a[0].ticket).toBe(b[0].ticket)
  })

  it('parses broker fact sheets', () => {
    const sheet = 'CITATION: src/x.py:12\nFACTS: it uses a row update.\nCONFIDENCE: high'
    const parsed = parseFactSheet(sheet)
    expect(parsed).toEqual({ citation: 'src/x.py:12', facts: 'it uses a row update.', confidence: 'high' })
    expect(parseFactSheet('no structure')).toBeNull()
  })
})

describe('referee output handling', () => {
  it('extracts PROPOSE_CRUX and SPROUT proposals from seat turns', () => {
    const text = 'Blah.\nPROPOSE_CRUX: The lease TTL is too short.\nSPROUT: Ambient dock | a glanceable strip.\nDone.'
    expect(extractProposals(text)).toEqual([
      { kind: 'crux', assertion: 'The lease TTL is too short.' },
      { kind: 'idea', assertion: 'SPROUT: Ambient dock | a glanceable strip.'.replace('SPROUT: ', '') },
    ])
  })

  it('parses referee JSON and sanitizes floors to known seats', () => {
    const raw = JSON.stringify({
      admissions: [{ kind: 'crux', assertion: 'x', author: 'skeptic' }, { kind: 'bogus-kind', assertion: 'y', author: 'z' }],
      flips: [{ id: 'C-1', to: 'contested', reason: 'r' }],
      directives: { skeptic: '1. do x', ghost: 'ignored' },
      floor: { active: ['skeptic', 'ghost-seat'], standby: ['architect'] },
      scopeWarnings: ['drift detected'],
    })
    const out = parseRefereeOutput(raw, ROUNDTABLE_SPEC)
    // Unknown kinds are KEPT so applyRefereeOutput can report them — silently
    // dropping them emptied the ledger in the 2026-09-27 run.
    expect(out.admissions).toHaveLength(2)
    expect(out.flips).toHaveLength(1)
    expect(out.directives).toEqual({ skeptic: '1. do x' })
    expect(out.floor.active).toEqual(['skeptic'])
    expect(out.floor.standby).toEqual(['architect'])
    expect(out.scopeWarnings).toHaveLength(1)
  })

  it('reports unknown admission kinds as rejections instead of dropping them', async () => {
    const { applyRefereeOutput } = await import('../src/core/referee.ts')
    const { Ledger } = await import('../src/core/ledger.ts')
    const output = parseRefereeOutput(JSON.stringify({
      admissions: [
        { kind: 'fact', assertion: 'raw-socket block is a diagnostic limitation', author: 'skeptic' },
        { kind: 'crux', assertion: 'a real crux', author: 'architect' },
      ],
      flips: [], directives: {}, floor: { active: ['skeptic', 'architect', 'pragmatist'], standby: [] }, scopeWarnings: [],
    }), ROUNDTABLE_SPEC)
    const ledger = new Ledger()
    const applied = applyRefereeOutput(output, ledger, {
      spec: ROUNDTABLE_SPEC, ledgerText: '', roundTranscript: '', vaultDeltaText: '', epoch: 1, previousDirectives: {},
    }, ROUNDTABLE_SPEC, '')
    expect(applied.admissions).toHaveLength(1)
    expect(applied.rejected.join(' ')).toMatch(/unknown ledger kind/)
    expect(ledger.state().entries).toHaveLength(1)
  })

  it('fails loud when the referee turn carries no JSON object at all', async () => {
    const { RefereeOutputError } = await import('../src/core/referee.ts')
    expect(() => parseRefereeOutput('Referee JSON produced for EPOCH 2. Summary of rulings: admitted 5 entries.', ROUNDTABLE_SPEC))
      .toThrow(RefereeOutputError)
    expect(() => parseRefereeOutput('I refuse to emit JSON.', ROUNDTABLE_SPEC))
      .toThrow(/no JSON object/)
  })
})

describe('chair deliverable validation (never forward an unshaped answer)', () => {
  it('accepts a document with every required section and body text', async () => {
    const { validateChairDeliverable } = await import('../src/core/chair.ts')
    const doc = [
      '# Decision', '', 'Adopt the lease design.', '',
      '## Options Considered', '', '- Row-update lease (chosen).', '',
      '## Evidence', '', 'src/core/queue.py:142.', '',
      '## Established Invariants', '', '- Bounded staleness.', '',
      '## Binding Dissents', '', 'None.', '',
      '## Action Items', '', '- Ship it.',
    ].join('\n')
    expect(validateChairDeliverable(doc, ROUNDTABLE_SPEC.deliverableSections)).toEqual({ ok: true, missing: [] })
  })

  it('flags missing sections and empty bodies', async () => {
    const { validateChairDeliverable } = await import('../src/core/chair.ts')
    const missing = validateChairDeliverable('# Decision\n\nAdopt X.\n\n## Evidence\n\n', ROUNDTABLE_SPEC.deliverableSections)
    expect(missing.ok).toBe(false)
    expect(missing.missing).toContain('Options Considered')
    expect(missing.missing).toContain('Evidence')      // heading present, body empty
    expect(missing.missing).toContain('Action Items')
  })
})

describe('text helpers (anti-leak, preserved)', () => {
  it('estimates tokens conservatively', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('extracts text blocks only — reasoning never passes', () => {
    const content = [
      { type: 'reasoning', text: 'private planning' },
      { type: 'text', text: 'the report' },
    ]
    expect(textOfContent(content)).toBe('the report')
  })
})

describe('procedural steelman gate (Oracle gate #5)', () => {
  it('rejects attack flips without a STEELMAN block when the spec mandates steelman', async () => {
    const { enforceSteelman } = await import('../src/core/referee.ts')
    const flips = [
      { id: 'C-1', to: 'contested' as const, reason: 'attacked' },
      { id: 'C-2', to: 'invariant' as const, reason: 'survived' },
    ]
    const gate = enforceSteelman(flips, ROUNDTABLE_SPEC, 'no steelman here, just attacks')
    expect(gate.allowed.map(f => f.id)).toEqual(['C-2'])
    expect(gate.rejected[0]).toMatch(/missing mandatory steelman/)
  })

  it('allows attack flips when a STEELMAN block exists in the transcript', async () => {
    const { enforceSteelman } = await import('../src/core/referee.ts')
    const flips = [{ id: 'C-1', to: 'falsified' as const, reason: 'felled' }]
    const gate = enforceSteelman(flips, ROUNDTABLE_SPEC, 'STEELMAN [skeptic]: Your strongest form is X; the boundary fails here.')
    expect(gave(gate)).toBe(true)
    function gave(g: { allowed: unknown[] }): boolean { return g.allowed.length === 1 }
  })
})

describe('batch broker parsing (one child, N sheets)', () => {
  it('splits a multi-sheet response in order', async () => {
    const { parseFactSheets } = await import('../src/core/broker.ts')
    const text = [
      'SHEET 1',
      'CITATION: src/a.py:10',
      'FACTS: first answer.',
      'CONFIDENCE: high',
      'SHEET 2',
      'CITATION: https://example.com/b',
      'FACTS: second answer.',
      'CONFIDENCE: low',
    ].join('\n')
    const sheets = parseFactSheets(text)
    expect(sheets).toHaveLength(2)
    expect(sheets[0].citation).toBe('src/a.py:10')
    expect(sheets[1].facts).toBe('second answer.')
    expect(sheets[1].confidence).toBe('low')
  })

  it('parses single-question responses unchanged', async () => {
    const { parseFactSheet } = await import('../src/core/broker.ts')
    expect(parseFactSheet('CITATION: src/x.ts:1\nFACTS: it uses a row update.\nCONFIDENCE: high')?.facts).toBe('it uses a row update.')
  })
})

describe('tolerant protocol extraction (natural model styles)', () => {
  it('parses the multi-line NEED_EVIDENCE block form (NEED_EVIDENCE alone, Target/Question below)', async () => {
    const { extractEvidenceRequests } = await import('../src/core/broker.ts')
    const text = [
      'Position Update',
      '',
      'NEED_EVIDENCE',
      'Target: The internal module structure of the non-worker code',
      'Question: Are domain boundaries already enforced through packages? (This decides C-1.)',
      '',
      'There is no evidence supporting additional boundaries.',
    ].join('\n')
    const reqs = extractEvidenceRequests('skeptic', 3, text)
    expect(reqs).toHaveLength(1)
    expect(reqs[0].target).toBe('The internal module structure of the non-worker code')
    expect(reqs[0].question).toContain('domain boundaries')
  })

  it('parses decorated single-line requests (bullets, bold, backticks, trailing prose)', async () => {
    const { extractEvidenceRequests } = await import('../src/core/broker.ts')
    const text = [
      '- **NEED_EVIDENCE(target: `ingestion_pipeline`, question: does it need polyglot runtimes?)** — this decides C-5',
      '3. NEED_EVIDENCE(target: postgres_core, question: what isolation level?)',
    ].join('\n')
    const reqs = extractEvidenceRequests('architect', 2, text)
    expect(reqs).toHaveLength(2)
    expect(reqs[0].target).toBe('ingestion_pipeline')
    expect(reqs[1].question).toContain('isolation level')
  })

  it('parses decorated PROPOSE_CRUX lines (bullets, bold)', async () => {
    const { extractProposals } = await import('../src/core/referee.ts')
    const text = [
      '**PROPOSE_CRUX:** Decoupling GPU-heavy ingestion via a queue satisfies isolation without microservices.',
      '- PROPOSE_CRUX: Operational boundaries follow process topology, not domain ownership.',
      'PROPOSE_CRUX - plain dash variant also counts',
    ].join('\n')
    const out = extractProposals(text)
    expect(out).toHaveLength(3)
    expect(out[0].kind).toBe('crux')
    expect(out[2].assertion).toContain('plain dash')
  })
})

describe('fiber turn settlement (a flail ends with a reason)', () => {
  /** A ctx whose child session serves one scripted event list. */
  function turnCtx(events: unknown[]) {
    return {
      agents: { get: () => undefined },
      get: (ns: string) => ns === 'sessionPersistence'
        ? {
            open: async () => ({
              read: async () => ({ events }),
              close: async () => undefined,
            }),
          }
        : undefined,
    }
  }

  it('returns NO_OUTPUT immediately when the turn settled with reasoning-only content', async () => {
    const ctx = turnCtx([
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'reasoning', text: 'private planning' }, { type: 'text', text: '\n\n' }] } } },
      { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
    ])
    const turn = await waitForSeatTurnDetailed(ctx as never, 'child-empty', new AbortController().signal, 2000)
    expect(turn.text).toContain('NO_OUTPUT')
    expect(turn.truncated).toBe(false)
  })

  it('still returns real text from a completed turn', async () => {
    const ctx = turnCtx([
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'the deliverable' }] } } },
      { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
    ])
    const turn = await waitForSeatTurnDetailed(ctx as never, 'child-text', new AbortController().signal, 2000)
    expect(turn.text).toBe('the deliverable')
  })

  it('keeps polling while the child is still working (no turn/end yet)', async () => {
    const events: unknown[] = [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'reasoning', text: 'working' }] } } },
    ]
    const ctx = turnCtx(events)
    await expect(waitForSeatTurnDetailed(ctx as never, 'child-working', new AbortController().signal, 400))
      .rejects.toThrow(/timed out after 400ms .*never settled a turn/)
  })

  /** Settled turn events for a registered child. */
  const settledEvents = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'prompt' }] } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'settled while registered' }] } } },
    { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
  ]

  it('reads a settled turn from persistence while the child is STILL REGISTERED (latent-stall regression)', async () => {
    // The old gate was `agents.get(childId) === undefined`, so an idle child
    // whose fiber was still registered polled to the 90s deadline with its
    // text sitting durable in persistence. It must now be read on settle.
    let opens = 0
    const ctx = {
      agents: { get: () => ({ status: 'idle' }) },
      get: (ns: string) => ns === 'sessionPersistence'
        ? {
            open: async () => {
              opens += 1
              return { read: async () => ({ events: settledEvents }), close: async () => undefined }
            },
          }
        : undefined,
    }
    const turn = await waitForSeatTurnDetailed(ctx as never, 'child-registered', new AbortController().signal, 2000)
    expect(turn.text).toBe('settled while registered')
    expect(turn.truncated).toBe(false)
    expect(opens).toBeGreaterThan(0)
  })

  it('does not probe persistence while the child is registered and running', async () => {
    let opens = 0
    const ctx = {
      agents: { get: () => ({ status: 'running' }) },
      get: (ns: string) => ns === 'sessionPersistence'
        ? { open: async () => { opens += 1; return { read: async () => ({ events: settledEvents }), close: async () => undefined } } }
        : undefined,
    }
    await expect(waitForSeatTurnDetailed(ctx as never, 'child-running', new AbortController().signal, 400))
      .rejects.toThrow(/timed out after 400ms .*never settled a turn.*no persistence probe was attempted/)
    expect(opens).toBe(0)
  })

  it('names a failing persistence probe when the wait still times out', async () => {
    const ctx = {
      agents: { get: () => ({ status: 'idle' }) },
      get: (ns: string) => ns === 'sessionPersistence'
        ? { open: async () => { throw new Error('store offline') } }
        : undefined,
    }
    await expect(waitForSeatTurnDetailed(ctx as never, 'child-probe-error', new AbortController().signal, 400))
      .rejects.toThrow(/last failed: store offline/)
  })

  it('bounds each persistence probe — a hung store is named, not waited on', async () => {
    const ctx = {
      agents: { get: () => ({ status: 'idle' }) },
      get: (ns: string) => ns === 'sessionPersistence'
        ? { open: () => new Promise<never>(() => { /* never resolves */ }) }
        : undefined,
    }
    await expect(waitForSeatTurnDetailed(ctx as never, 'child-hang', new AbortController().signal, 700))
      .rejects.toThrow(/last failed: session persistence open for child-hang timed out after \d+ms/)
  })
})

describe('EvidenceVault', () => {
  it('has no no-op fingerprint lookup — the dead stub stays deleted', async () => {
    const { EvidenceVault } = await import('../src/core/vault.ts')
    expect('findByFingerprint' in EvidenceVault.prototype).toBe(false)
  })

  it('keeps the real dedupe surface: question/citation lookups over live entries', async () => {
    const { EvidenceVault } = await import('../src/core/vault.ts')
    const vault = new EvidenceVault()
    const entry = vault.add({
      citation: 'src/core/vault.ts:1',
      question: 'where is dedupe?',
      factSheet: 'in the live-entry scans',
      addedEpoch: 1,
      retrievedBy: 'explorer',
    })
    expect(vault.get(entry.id)?.question).toBe('where is dedupe?')
    expect(vault.hasLiveFor('src/core/vault.ts:1')).toBe(true)
    expect(vault.since(1)).toHaveLength(1)
  })
})
