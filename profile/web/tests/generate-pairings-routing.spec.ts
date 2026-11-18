import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parsePairingsDocument } from '../../../packages/api/peer/src/pairings.ts'
import {
  identifyLocalMember, renderPairingsDocument, validateRegistry, validateRouting,
} from '../scripts/generate-pairings.mjs'

/**
 * Fleet routing blocks: the free-only worker alias example, the alias-owner
 * rendering rule, strict validation, and the peer parser's acceptance of the
 * rendered document.
 */

const WORKER_ROUTING = {
  allowChains: ['free'],
  allowModels: ['kilo/*:free', 'openrouter/*:free'],
  requireZeroPrice: true,
  requireNoTraining: false,
  requireTools: true,
  allowReasoningEfforts: ['minimal', 'medium'],
  allowSwitch: 'idle-only',
  maxTotalTokens: 200_000,
}

const REGISTRY = {
  version: 1,
  hub: 'serverlocal',
  members: [
    { name: 'serverlocal', exposure: 'debug', create: 'orchestrator', hostnames: ['serverlocal'], ip: '100.122.163.25' },
    {
      name: 'jarvis-worker-test',
      exposure: 'answer-only',
      create: 'jarvis-readonly',
      hostnames: ['jarvis-worker-*'],
      ip: '100.64.0.9',
      routing: WORKER_ROUTING,
    },
    { name: 'pc', exposure: 'debug', create: 'orchestrator', hostnames: ['mainpc'], ip: '100.98.71.68' },
  ],
}

const IPS = new Map([
  ['jarvis-worker-test', '100.64.0.9'],
  ['pc', '100.98.71.68'],
  ['serverlocal', '100.122.163.25'],
])

describe('fleet routing block generation', () => {
  it('renders the worker alias golden example and the peer parser accepts it', () => {
    const registry = validateRegistry(REGISTRY, 'fleet.yaml')
    const hub = identifyLocalMember(registry, { device: 'serverlocal', hostnames: [] })
    const rendered = renderPairingsDocument(registry, { local: hub, ips: IPS })
    expect(rendered).toContain([
      '  - alias: jarvis-worker-test',
      '    peer: jarvis-worker-test',
      '    exposure: answer-only',
      '    endpoint: http://100.64.0.9:3080',
      '    create:',
      '      agentPreset: jarvis-readonly',
      '    routing:',
      '      allowChains: [free]',
      '      allowModels: ["kilo/*:free", "openrouter/*:free"]',
      '      requireZeroPrice: true',
      '      requireNoTraining: false',
      '      requireTools: true',
      '      allowReasoningEfforts: [minimal, medium]',
      '      allowSwitch: idle-only',
      '      maxTotalTokens: 200000',
    ].join('\n'))
    const parsed = parsePairingsDocument(rendered, 'pairings.yaml')
    expect(parsed.pairings.find(pairing => pairing.alias === 'jarvis-worker-test')).toMatchObject({
      peer: 'jarvis-worker-test',
      exposure: 'answer-only',
      create: { agentPreset: 'jarvis-readonly' },
    })
    // The human entries carry no routing block.
    expect(rendered.match(/^ {4}routing:$/gmu)).toHaveLength(1)
  })

  it('renders routing from the alias owner, including on the member device', () => {
    const registry = validateRegistry(REGISTRY, 'fleet.yaml')
    const worker = identifyLocalMember(registry, { device: 'jarvis-worker-test', hostnames: [] })
    const rendered = renderPairingsDocument(registry, { local: worker, ips: IPS })
    // The member's own record owns the hub entry, so routing rides with it.
    expect(rendered).toContain('  - alias: jarvis-worker-test\n    peer: serverlocal\n')
    expect(rendered).toContain('      maxTotalTokens: 200000')
    expect(parsePairingsDocument(rendered, 'pairings.yaml').device).toBe('jarvis-worker-test')
  })

  it('validates routing strictly with the peer parser rules', () => {
    expect(validateRouting(WORKER_ROUTING, 'routing')).toEqual(WORKER_ROUTING)
    expect(validateRouting({ allowChains: [] }, 'routing')).toEqual({ allowChains: [] })
    expect(() => validateRouting({ surprise: true }, 'routing')).toThrow(/unknown key/u)
    expect(() => validateRouting({ allowModels: 'kilo/*' }, 'routing')).toThrow(/must be a list/u)
    expect(() => validateRouting({ allowModels: ['kilo model'] }, 'routing')).toThrow(/entries must match/u)
    expect(() => validateRouting({ allowModels: [7] }, 'routing')).toThrow(/entries must match/u)
    expect(() => validateRouting({ requireZeroPrice: 'yes' }, 'routing')).toThrow(/must be a boolean/u)
    expect(() => validateRouting({ requireTools: 'yes' }, 'routing')).toThrow(/must be a boolean/u)
    expect(() => validateRouting({ allowSwitch: 'always' }, 'routing')).toThrow(/never or idle-only/u)
    expect(() => validateRouting({ maxTotalTokens: 0 }, 'routing')).toThrow(/positive integer/u)
    expect(() => validateRouting({ maxTotalTokens: 1.5 }, 'routing')).toThrow(/positive integer/u)
    // An explicitly empty block is a deny-all policy and renders inline.
    expect(validateRouting({}, 'routing')).toEqual({})
    const denyAll = renderPairingsDocument(validateRegistry({
      version: 1,
      hub: 'serverlocal',
      members: [
        { name: 'serverlocal', exposure: 'debug', create: 'orchestrator', hostnames: [], ip: '100.122.163.25' },
        { name: 'worker', exposure: 'answer-only', create: 'orchestrator', hostnames: [], ip: '100.64.0.8', routing: {} },
      ],
    }, 'fleet.yaml'), {
      local: { name: 'serverlocal', alias: 'serverlocal', exposure: 'debug', create: 'orchestrator', hostnames: [], ip: '100.122.163.25' },
      ips: new Map([['worker', '100.64.0.8']]),
    })
    expect(denyAll).toContain('    routing: {}\n')
    expect(() => validateRouting('nope', 'routing')).toThrow(/must be a mapping/u)
    // `null` fields are absent, exactly like the sibling fleet fields.
    expect(validateRouting({ allowChains: null, requireNoTraining: null, requireTools: null, allowSwitch: null, maxTotalTokens: null, allowModels: ['*'] }, 'routing'))
      .toEqual({ allowModels: ['*'] })
    expect(() => validateRegistry({
      ...REGISTRY,
      members: [{ name: 'x', exposure: 'debug', hostnames: [], routing: { allowSwitch: 'always' } }],
    }, 'fleet.yaml')).toThrow(/allowSwitch/u)
  })

  it('ships no routing block on the human fleet entries', () => {
    const fleet = readFileSync(fileURLToPath(new URL('../fleet.yaml', import.meta.url)), 'utf8')
    expect(fleet).not.toMatch(/^ {4}routing:/mu)
  })
})
