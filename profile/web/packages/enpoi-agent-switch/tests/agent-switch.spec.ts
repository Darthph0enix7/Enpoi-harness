import { describe, expect, it } from 'vitest'
import {
  AgentSwitchController,
  DELTA_CONTEXT_NAME,
  compositionContentOf,
  earliestLoggedPreset,
  loadComposition,
  parsePersonaFromYaml,
  PERSONA_PREFIX_SECTION,
  PERSONA_SUFFIX_SECTION,
  composeDeltaText,
  readHeaderPreset,
  resolveOriginalPreset,
  type AgentPromptApi,
  type PromptContextLike,
  type PromptSectionLike,
  type SwitchDeps,
} from '../src/index'

const FIXTURE_PRESET = `# A fixture composition with a gated row (the !!js tag must not break the read).
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |-
      You are Orchestrator — the fixture lead.
      Second line.
    suffix: |-
      Orchestrator suffix.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
`

const CREATOR_PRESET = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are Creator.
`

/** A prompt API that throws on a same-scope duplicate name, like the registry. */
function fakePrompt(): { api: AgentPromptApi; sections: Map<string, PromptSectionLike>; contexts: Map<string, PromptContextLike> } {
  const sections = new Map<string, PromptSectionLike>()
  const contexts = new Map<string, PromptContextLike>()
  const api: AgentPromptApi = {
    getSectionOrder: name => (name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 10200),
    section: (section) => {
      if (sections.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`)
      sections.set(section.name, section)
      return () => sections.delete(section.name)
    },
    context: (context) => {
      if (contexts.has(context.name)) throw new Error(`prompt context "${context.name}" is already registered in this scope`)
      contexts.set(context.name, context)
      return () => contexts.delete(context.name)
    },
  }
  return { api, sections, contexts }
}

function makeDeps(logs: string[], personas: Record<string, { prefix: string; suffix: string; complete: boolean } | undefined>): SwitchDeps {
  return {
    personaFor: async id => personas[id],
    labelFor: async id => (id === 'orchestrator' ? 'Master Orchestrator' : id === 'creator' ? 'Creator' : undefined),
    log: (sessionId, message) => { logs.push(`${sessionId}:${message}`) },
  }
}

describe('resolveOriginalPreset — header vs projection vs log', () => {
  it('prefers the creation header, then the tracked projection, then the log', () => {
    expect(resolveOriginalPreset({ headerPreset: 'orchestrator', projectionPreset: 'sysadmin', earliestSelected: 'creator' })).toBe('orchestrator')
    expect(resolveOriginalPreset({ projectionPreset: 'sysadmin', earliestSelected: 'creator' })).toBe('sysadmin')
    expect(resolveOriginalPreset({ earliestSelected: 'creator' })).toBe('creator')
    expect(resolveOriginalPreset({})).toBeUndefined()
    expect(resolveOriginalPreset({ headerPreset: '' })).toBeUndefined()
  })

  it('reads the header preset (direct and nested meta) from a session', () => {
    expect(readHeaderPreset({ header: { agentPreset: 'orchestrator' } })).toBe('orchestrator')
    expect(readHeaderPreset({ header: { meta: { agentPreset: 'sysadmin' } } })).toBe('sysadmin')
    expect(readHeaderPreset({})).toBeUndefined()
  })

  it('reads the earliest selection from the session log', () => {
    const session = {
      ownEvents: () => [
        { type: 'user/message', data: {} },
        { type: 'agent-preset/selected', data: { agentPreset: 'sysadmin' } },
        { type: 'agent-preset/selected', data: { agentPreset: 'creator' } },
      ],
    }
    expect(earliestLoggedPreset(session)).toBe('sysadmin')
    expect(earliestLoggedPreset({ ownEvents: () => [] })).toBeUndefined()
  })
})

describe('persona parsing and delta composition', () => {
  it('extracts the persona row from a fixture preset despite the !!js row', () => {
    const persona = parsePersonaFromYaml(FIXTURE_PRESET)
    expect(persona).toEqual({
      prefix: 'You are Orchestrator — the fixture lead.\nSecond line.',
      suffix: 'Orchestrator suffix.',
      complete: false,
    })
  })

  it('returns undefined for a persona-less or unreadable file', () => {
    expect(parsePersonaFromYaml('- id: tool-bash\n  name: "@deepseek-ai/dsh-tool-bash"\n')).toBeUndefined()
    expect(parsePersonaFromYaml(':\n  not: [valid')).toBeUndefined()
  })

  it('extracts the composition from both roster answer shapes', () => {
    // 0.1.7 answers `AgentPresetDocument`; earlier engines answered the raw YAML.
    expect(compositionContentOf({ agentPreset: 'orchestrator', content: FIXTURE_PRESET })).toBe(FIXTURE_PRESET)
    expect(compositionContentOf(FIXTURE_PRESET)).toBe(FIXTURE_PRESET)
    expect(compositionContentOf({ agentPreset: 'x' })).toBeUndefined()
    expect(compositionContentOf(undefined)).toBeUndefined()
    // The wrapped content still parses to the persona (the shadow's precondition).
    const wrapped = compositionContentOf({ agentPreset: 'orchestrator', content: FIXTURE_PRESET })
    expect(parsePersonaFromYaml(wrapped ?? '')).toEqual(parsePersonaFromYaml(FIXTURE_PRESET))
  })

  it('reads the composition through readDocument (0.1.7) and the legacy read name', async () => {
    const document = { agentPreset: 'orchestrator', content: FIXTURE_PRESET }
    const ctx = (roster: unknown) => ({ get: (name: string) => (name === 'agentPresets' ? roster : undefined) })
    // 0.1.7: the local method is readDocument (Remote exports it as `read`).
    expect(await loadComposition(ctx({ readDocument: async () => document }) as never, 'orchestrator')).toBe(FIXTURE_PRESET)
    // Pre-0.1.7: a local `read` answered the raw YAML.
    expect(await loadComposition(ctx({ read: async () => FIXTURE_PRESET }) as never, 'orchestrator')).toBe(FIXTURE_PRESET)
    // Neither method: no composition, no throw.
    expect(await loadComposition(ctx({}) as never, 'orchestrator')).toBeUndefined()
    // A throwing read is contained.
    expect(await loadComposition(ctx({ readDocument: async () => { throw new Error('boom') } }) as never, 'orchestrator')).toBeUndefined()
  })

  it('composes the delta from label + persona, falling back to the id', () => {
    const persona = parsePersonaFromYaml(CREATOR_PRESET)
    const text = composeDeltaText({ id: 'creator', label: 'Creator', persona })
    expect(text).toContain("The operator switched this session's agent.")
    expect(text).toContain('You now operate as Creator (creator).')
    expect(text).toContain('You are Creator.')
    const identityOnly = composeDeltaText({ id: 'sysadmin' })
    expect(identityOnly).toContain('You now operate as sysadmin (sysadmin).')
  })
})

describe('AgentSwitchController — shadow registration, idempotence, fail-open', () => {
  it('freezes the original persona and delivers the new one as a delta', async () => {
    const logs: string[] = []
    const { api, sections, contexts } = fakePrompt()
    const controller = new AgentSwitchController(makeDeps(logs, {
      orchestrator: { prefix: 'You are Orchestrator.', suffix: '', complete: false },
      creator: { prefix: 'You are Creator.', suffix: '', complete: false },
    }))

    await controller.onPresetSelected({
      sessionId: 's1', presetId: 'sysadmin', headerPreset: 'orchestrator', prompt: api,
    })

    expect(sections.get(PERSONA_PREFIX_SECTION)?.text).toBe('You are Orchestrator.')
    expect(sections.get(PERSONA_SUFFIX_SECTION)?.text).toBe('')
    expect(contexts.get(DELTA_CONTEXT_NAME)?.text).toContain('You now operate as sysadmin (sysadmin).')
    expect(logs).toEqual([])
  })

  it('two switches register one shadow and replace the delta in place', async () => {
    const logs: string[] = []
    const { api, sections, contexts } = fakePrompt()
    const controller = new AgentSwitchController(makeDeps(logs, {
      orchestrator: { prefix: 'You are Orchestrator.', suffix: '', complete: false },
      creator: { prefix: 'You are Creator.', suffix: '', complete: false },
    }))

    await controller.onPresetSelected({ sessionId: 's1', presetId: 'sysadmin', headerPreset: 'orchestrator', prompt: api })
    await controller.onPresetSelected({ sessionId: 's1', presetId: 'creator', headerPreset: 'orchestrator', prompt: api })

    // Exactly one prefix + one suffix shadow, still the ORIGINAL text.
    expect([...sections.keys()].sort()).toEqual([PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION].sort())
    expect(sections.get(PERSONA_PREFIX_SECTION)?.text).toBe('You are Orchestrator.')
    // One delta context, replaced in place (no duplicate-name throw).
    expect(contexts.size).toBe(1)
    expect(contexts.get(DELTA_CONTEXT_NAME)?.text).toContain('You now operate as Creator (creator).')
    expect(contexts.get(DELTA_CONTEXT_NAME)?.text).toContain('You are Creator.')
    expect(logs).toEqual([])
  })

  it('falls back to the tracked projection when the header is absent', async () => {
    const logs: string[] = []
    const { api, sections } = fakePrompt()
    const controller = new AgentSwitchController(makeDeps(logs, {
      orchestrator: { prefix: 'You are Orchestrator.', suffix: '', complete: false },
    }))
    controller.observe('s1', 'orchestrator')

    await controller.onPresetSelected({ sessionId: 's1', presetId: 'sysadmin', prompt: api })

    expect(sections.get(PERSONA_PREFIX_SECTION)?.text).toBe('You are Orchestrator.')
    expect(logs).toEqual([])
  })

  it('fail-open: missing persona → no shadow, no throw, one log', async () => {
    const logs: string[] = []
    const { api, sections, contexts } = fakePrompt()
    const controller = new AgentSwitchController(makeDeps(logs, {}))

    await controller.onPresetSelected({ sessionId: 's2', presetId: 'sysadmin', headerPreset: 'orchestrator', prompt: api })

    expect(sections.size).toBe(0)
    expect(contexts.size).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('unavailable')
  })

  it('fail-open: a throwing persona read leaves the session working', async () => {
    const logs: string[] = []
    const { api, sections, contexts } = fakePrompt()
    const controller = new AgentSwitchController({
      personaFor: async () => { throw new Error('ENOENT') },
      labelFor: async () => undefined,
      log: (sessionId, message) => { logs.push(`${sessionId}:${message}`) },
    })

    await expect(
      controller.onPresetSelected({ sessionId: 's3', presetId: 'sysadmin', headerPreset: 'orchestrator', prompt: api }),
    ).resolves.toBeUndefined()
    expect(sections.size).toBe(0)
    expect(contexts.size).toBe(0)
    expect(logs).toHaveLength(1)
  })

  it('fail-open: no live agent prompt scope → one log, no throw', async () => {
    const logs: string[] = []
    const controller = new AgentSwitchController(makeDeps(logs, {
      orchestrator: { prefix: 'You are Orchestrator.', suffix: '', complete: false },
    }))

    await controller.onPresetSelected({ sessionId: 's4', presetId: 'sysadmin', headerPreset: 'orchestrator' })

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('no live agent')
  })

  it('release disposes the shadow so a later switch re-installs it', async () => {
    const logs: string[] = []
    const { api, sections } = fakePrompt()
    const controller = new AgentSwitchController(makeDeps(logs, {
      orchestrator: { prefix: 'You are Orchestrator.', suffix: '', complete: false },
    }))

    await controller.onPresetSelected({ sessionId: 's5', presetId: 'sysadmin', headerPreset: 'orchestrator', prompt: api })
    expect(sections.size).toBe(2)
    controller.release('s5')
    expect(sections.size).toBe(0)
  })
})

describe('AgentSwitchController — deterministic synchronous switch path', () => {
  function makeCachedDeps(
    logs: string[],
    personas: Record<string, { prefix: string; suffix: string; complete: boolean } | undefined>,
    labels: Record<string, string | undefined>,
  ): SwitchDeps {
    return {
      personaFor: async id => personas[id],
      labelFor: async id => labels[id],
      cachedPersona: (id) => (id in personas ? personas[id] : null),
      cachedLabel: (id) => (id in labels ? labels[id] : null),
      log: (sessionId, message) => { logs.push(`${sessionId}:${message}`) },
    }
  }

  it('registers shadow + delta synchronously when the cache is warm', async () => {
    const logs: string[] = []
    const { api, sections, contexts } = fakePrompt()
    const controller = new AgentSwitchController(makeCachedDeps(logs, {
      orchestrator: { prefix: 'You are Orchestrator.', suffix: '', complete: false },
      sysadmin: { prefix: 'You are Sysadmin.', suffix: '', complete: false },
    }, { orchestrator: 'Master Orchestrator', sysadmin: 'Sysadmin' }))

    const pending = controller.onPresetSelected({ sessionId: 's1', presetId: 'sysadmin', headerPreset: 'orchestrator', prompt: api })

    // Asserted WITHOUT awaiting: the next turn's pre-step does not get to run first.
    expect(sections.get(PERSONA_PREFIX_SECTION)?.text).toBe('You are Orchestrator.')
    expect(contexts.get(DELTA_CONTEXT_NAME)?.text).toContain('You now operate as Sysadmin (sysadmin).')
    expect(contexts.get(DELTA_CONTEXT_NAME)?.text).toContain('You are Sysadmin.')
    expect(logs).toEqual([])
    await pending
  })

  it('cold cache still publishes the delta synchronously, then refines it in place', async () => {
    const logs: string[] = []
    const { api, sections, contexts } = fakePrompt()
    const controller = new AgentSwitchController({
      ...makeCachedDeps(logs, {}, {}),
      personaFor: async id => (id === 'orchestrator'
        ? { prefix: 'You are Orchestrator.', suffix: '', complete: false }
        : undefined),
      labelFor: async id => (id === 'sysadmin' ? 'Sysadmin' : undefined),
    })

    const pending = controller.onPresetSelected({ sessionId: 's1', presetId: 'sysadmin', headerPreset: 'orchestrator', prompt: api })

    // Identity-only delta is already visible; the shadow is not yet installed.
    expect(contexts.get(DELTA_CONTEXT_NAME)?.text).toContain('You now operate as sysadmin (sysadmin).')
    expect(sections.size).toBe(0)
    await pending
    // The async path froze the original persona and upgraded the delta in place.
    expect(sections.get(PERSONA_PREFIX_SECTION)?.text).toBe('You are Orchestrator.')
    expect(sections.size).toBe(2)
    expect(contexts.size).toBe(1)
    expect(contexts.get(DELTA_CONTEXT_NAME)?.text).toContain('You now operate as Sysadmin (sysadmin).')
  })
})
