// routes.spec.ts — the fenced /sidebar/presets handler against a fake config
// editor: list mapping, clone-on-create (suffix-only rewrite), built-in
// protection, and error codes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { apply } from '../src/index.js'

type Handler = (req: unknown, res: unknown) => Promise<void>

const SHARED_PREFIX = 'Shared persona prefix.\n'
const BASE_PLUGINS = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: SHARED_PREFIX, suffix: 'Base doctrine.' } },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
]

interface Entry {
  options: { id: string; name?: string; config?: Record<string, unknown>; disabled?: unknown }
}

function makeHarness() {
  let handler: Handler | undefined
  const entries: Entry[] = [
    { options: { id: 'preset-orchestrator', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'orchestrator', name: 'Orchestrator', description: 'Default', order: 1, plugins: BASE_PLUGINS } } },
    { options: { id: 'preset-sysadmin', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'sysadmin', name: 'Sysadmin', description: 'Ops', order: 2, plugins: BASE_PLUGINS } } },
    { options: { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', name: 'Standard', order: 10, plugins: BASE_PLUGINS }, disabled: true } },
    { options: { id: 'unrelated-row', name: 'cordis:probe', config: {} } },
  ]
  const insert = vi.fn(async (row: { id: string; name: string; config: Record<string, unknown> }) => {
    entries.push({ options: { id: row.id, name: row.name, config: row.config } })
  })
  const remove = vi.fn(async (id: string) => {
    const index = entries.findIndex(entry => entry.options.id === id)
    if (index >= 0) entries.splice(index, 1)
  })
  const edit = vi.fn(async (entry: unknown, change: (current: Record<string, unknown>) => Record<string, unknown>) => {
    const target = entry as Entry
    target.options.config = change(structuredClone(target.options.config ?? {}))
  })
  const editor = { entries: () => entries, insert, remove, edit }
  const ctx = {
    get(name: string) {
      if (name === 'webServer') {
        return {
          register: (spec: { handler: Handler }) => {
            handler = spec.handler
            return () => {}
          },
        }
      }
      if (name === 'webRuntime') return { trustedHosts: [] as string[] }
      if (name === 'configEditor') return editor
      return undefined
    },
    effect: (fn: () => unknown) => fn(),
  }
  apply(ctx as never, {})
  if (handler === undefined) throw new Error('preset authoring handler was not registered')
  const call = async (method: string, payload: unknown, options: { host?: string; contentType?: string; httpMethod?: string; origin?: string } = {}) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const req = {
      headers: {
        host: options.host ?? 'localhost:4096',
        'content-type': options.contentType ?? 'application/json',
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
      method: options.httpMethod ?? 'POST',
      url: `/sidebar/presets/${method}`,
      async *[Symbol.asyncIterator]() {
        yield body
      },
    }
    let status = 0
    let text = ''
    const res = {
      writeHead: (s: number) => { status = s },
      end: (t: string) => { text = t },
    }
    await handler!(req, res)
    return { status, body: JSON.parse(text) as { ok: boolean; value?: any; error?: { code: string; message: string } } }
  }
  return { call, editor, insert, remove, edit, entries }
}

let harness: ReturnType<typeof makeHarness>

beforeEach(() => { harness = makeHarness() })
afterEach(() => { vi.restoreAllMocks() })

describe('presets.list', () => {
  it('maps declared presets with built-in, disabled, and persona metadata', async () => {
    const { status, body } = await harness.call('presets.list', {})
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const rows = body.value.presets as Array<Record<string, unknown>>
    expect(rows.map(row => row.id)).toEqual(['orchestrator', 'standard', 'sysadmin'])
    expect(rows.find(row => row.id === 'orchestrator')).toMatchObject({
      rowId: 'preset-orchestrator',
      name: 'Orchestrator',
      description: 'Default',
      order: 1,
      builtIn: true,
      disabled: false,
      hasPersona: true,
      suffixChars: 'Base doctrine.'.length,
    })
    expect(rows.find(row => row.id === 'standard')).toMatchObject({ builtIn: true, disabled: true })
  })

  it('returns one preset with its persona suffix', async () => {
    const { body } = await harness.call('presets.get', { id: 'orchestrator' })
    expect(body.value.suffix).toBe('Base doctrine.')
    expect(body.value.builtIn).toBe(true)
    const missing = await harness.call('presets.get', { id: 'nope' })
    expect(missing.status).toBe(404)
  })
})

describe('presets.create', () => {
  it('clones a base preset, rewrites only the suffix, and assigns the next order', async () => {
    const { status, body } = await harness.call('presets.create', {
      base: 'orchestrator',
      id: 'sandbox-agent',
      name: 'Sandbox Agent',
      description: 'Proof agent',
      suffix: 'You are Sandbox.',
    })
    expect(status).toBe(200)
    expect(body.value.rowId).toBe('preset-sandbox-agent')
    expect(harness.insert).toHaveBeenCalledTimes(1)
    const row = harness.insert.mock.calls[0]![0]
    expect(row.id).toBe('preset-sandbox-agent')
    expect(row.name).toBe('@deepseek-ai/dsh-agent-preset')
    const config = row.config as { id: string; name: string; order: number; plugins: typeof BASE_PLUGINS }
    expect(config).toMatchObject({ id: 'sandbox-agent', name: 'Sandbox Agent', order: 11 })
    const persona = config.plugins.find(plugin => plugin.id === 'persona')!
    expect(persona.config).toMatchObject({ prefix: SHARED_PREFIX, suffix: 'You are Sandbox.' })
  })

  it('refuses invalid ids, reserved ids, missing bases, and duplicates', async () => {
    const cases = [
      [{ base: 'orchestrator', id: 'Bad Id', name: 'n', description: '', suffix: 's' }, 'bad-request'],
      [{ base: 'orchestrator', id: 'orchestrator', name: 'n', description: '', suffix: 's' }, 'bad-request'],
      [{ base: 'nope', id: 'fine-id', name: 'n', description: '', suffix: 's' }, 'not-found'],
      [{ base: 'orchestrator', id: 'sysadmin', name: 'n', description: '', suffix: 's' }, 'bad-request'],
    ] as const
    for (const [payload, code] of cases) {
      const { status, body } = await harness.call('presets.create', payload)
      expect(body.error?.code, JSON.stringify(payload)).toBe(code)
      expect(status).toBeGreaterThanOrEqual(400)
    }
    expect(harness.insert).not.toHaveBeenCalled()
  })

  it('refuses a clone whose base declares no persona', async () => {
    harness.entries.push({ options: { id: 'preset-bare', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'bare', name: 'Bare', order: 20, plugins: [{ id: 'tool-bash' }] } } })
    const { status, body } = await harness.call('presets.create', {
      base: 'bare', id: 'clone-bare', name: 'n', description: '', suffix: 's',
    })
    expect(status).toBe(400)
    expect(body.error?.message).toContain('persona')
    expect(harness.insert).not.toHaveBeenCalled()
  })
})

describe('presets.update', () => {
  it('edits a user preset through the config editor with a suffix-only rewrite', async () => {
    harness.entries.push({ options: { id: 'preset-sandbox-agent', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'sandbox-agent', name: 'Old', description: 'Old', order: 11, plugins: structuredClone(BASE_PLUGINS) } } })
    const { status } = await harness.call('presets.update', {
      id: 'sandbox-agent', name: 'New Name', description: 'New description', suffix: 'New doctrine.',
    })
    expect(status).toBe(200)
    expect(harness.edit).toHaveBeenCalledTimes(1)
    const entry = harness.edit.mock.calls[0]![0] as Entry
    const next = entry.options.config as { name: string; plugins: typeof BASE_PLUGINS }
    expect(next.name).toBe('New Name')
    const persona = next.plugins.find(plugin => plugin.id === 'persona')!
    expect(persona.config).toMatchObject({ prefix: SHARED_PREFIX, suffix: 'New doctrine.' })
  })

  it('refuses built-ins and unknown presets', async () => {
    const builtIn = await harness.call('presets.update', { id: 'orchestrator', name: 'n', description: '', suffix: 's' })
    expect(builtIn.status).toBe(400)
    expect(builtIn.body.error?.code).toBe('protected')
    const missing = await harness.call('presets.update', { id: 'ghost', name: 'n', description: '', suffix: 's' })
    expect(missing.status).toBe(404)
    expect(harness.edit).not.toHaveBeenCalled()
  })
})

describe('presets.delete', () => {
  it('removes a user preset row', async () => {
    harness.entries.push({ options: { id: 'preset-sandbox-agent', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'sandbox-agent', plugins: BASE_PLUGINS } } })
    const { status } = await harness.call('presets.delete', { id: 'sandbox-agent' })
    expect(status).toBe(200)
    expect(harness.remove).toHaveBeenCalledWith('preset-sandbox-agent')
  })

  it('refuses built-ins and unknown presets', async () => {
    const builtIn = await harness.call('presets.delete', { id: 'creator' })
    expect(builtIn.status).toBe(400)
    expect(builtIn.body.error?.code).toBe('protected')
    const missing = await harness.call('presets.delete', { id: 'ghost' })
    expect(missing.status).toBe(404)
    expect(harness.remove).not.toHaveBeenCalled()
  })
})

describe('fence and method handling', () => {
  it('rejects an untrusted host, a non-JSON content type, and a non-POST method', async () => {
    const untrusted = await harness.call('presets.list', {}, { host: 'evil.example' })
    expect(untrusted.status).toBe(403)
    const wrongType = await harness.call('presets.list', {}, { contentType: 'text/plain' })
    expect(wrongType.status).toBe(415)
    const wrongMethod = await harness.call('presets.list', {}, { httpMethod: 'GET' })
    expect(wrongMethod.status).toBe(405)
    const crossOrigin = await harness.call('presets.list', {}, { origin: 'https://evil.example' })
    expect(crossOrigin.status).toBe(403)
    const loopbackOrigin = await harness.call('presets.list', {}, { origin: 'http://127.0.0.1:3100' })
    expect(loopbackOrigin.status).toBe(200)
  })

  it('404s an unknown method', async () => {
    const unknown = await harness.call('presets.nope', {})
    expect(unknown.status).toBe(404)
  })
})
