// plugin.spec.ts — registration, hot-update, the guard seam, and execution
// through a fake shell executor.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { apply, readCustomToolRecords, renderCustomToolResult } from '../src/index.js'

interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
}

interface Harness {
  tools: Map<string, RegisteredTool>
  disposals: string[]
  seam: { render: (name: string, args: unknown) => { command?: string } | undefined } | undefined
  handlers: Array<(ns: unknown) => void>
  setDocument: (customTools: unknown) => void
  shellCalls: Array<Record<string, unknown>>
  shellResult: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: { text: string }; stderr: { text: string } }
  shellThrows: boolean
}

function makeHarness(initial: unknown): Harness {
  let document: Record<string, unknown> = { customTools: initial }
  const harness: Harness = {
    tools: new Map(),
    disposals: [],
    seam: undefined,
    handlers: [],
    setDocument: (customTools) => { document = { customTools } },
    shellCalls: [],
    shellResult: { exitCode: 0, signal: null, timedOut: false, stdout: { text: 'ok\n' }, stderr: { text: '' } },
    shellThrows: false,
  }
  const ctx = {
    get(name: string) {
      if (name === 'settings') return { get: (ns: string) => ns === 'enpoi-orchestration' ? document : undefined }
      if (name === 'shell') {
        return {
          sandboxMode: 'workspace-write',
          resolve: (request: Record<string, unknown>) => request,
          execute: async (spec: Record<string, unknown>) => {
            harness.shellCalls.push(spec)
            if (harness.shellThrows) throw new Error('executor refused')
            return { result: async () => harness.shellResult }
          },
        }
      }
      if (name === 'shellEnv') {
        return { collect: () => ({ DSH_HOME: '/tmp/dsh-home', DSH_PROFILE_DIR: '/tmp/dsh-home/profiles/web' }) }
      }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/tmp/ws' }) }
      return undefined
    },
    tools: {
      register: (definition: RegisteredTool) => {
        harness.tools.set(definition.name, definition)
        return () => {
          harness.tools.delete(definition.name)
          harness.disposals.push(definition.name)
        }
      },
    },
    provide: (name: string, value: Harness['seam']) => { if (name === 'customToolCommands') harness.seam = value },
    on: (event: string, handler: (ns: unknown) => void) => { if (event === 'settings/document-updated') harness.handlers.push(handler) },
    effect: (fn: () => unknown) => fn(),
  }
  apply(ctx as never, {})
  return harness
}

const RECORD = {
  id: 'echo-tool',
  name: 'Echo Tool',
  description: 'Echo a message',
  params: [{ name: 'message', type: 'string', required: true, description: 'Text to echo' }],
  command: 'echo {{message}}',
}

let harness: Harness

beforeEach(() => { harness = makeHarness([RECORD]) })

describe('registration', () => {
  it('registers one real tool per record with the model-facing schema', () => {
    const tool = harness.tools.get('custom_echo-tool')
    expect(tool).toBeDefined()
    expect(tool?.description).toBe('Echo a message')
    expect(tool?.parameters).toEqual({
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo' } },
      required: ['message'],
    })
  })

  it('skips invalid records without dropping the valid ones', () => {
    const h = makeHarness([RECORD, { id: 'Bad Id', description: 'x', command: 'y' }, { id: 'no-command', description: 'x' }])
    expect([...h.tools.keys()]).toEqual(['custom_echo-tool'])
  })

  it('hot-applies additions, edits, and removals on settings updates', () => {
    harness.setDocument([RECORD, { id: 'second-tool', description: 'Second', command: 'true' }])
    harness.handlers[0]!('enpoi-orchestration')
    expect([...harness.tools.keys()].sort()).toEqual(['custom_echo-tool', 'custom_second-tool'])

    harness.setDocument([{ ...RECORD, description: 'Edited description' }])
    harness.handlers[0]!('enpoi-orchestration')
    expect(harness.disposals).toContain('custom_echo-tool')
    expect(harness.tools.get('custom_echo-tool')?.description).toBe('Edited description')
    expect(harness.tools.has('custom_second-tool')).toBe(false)

    harness.setDocument([])
    harness.handlers[0]!('enpoi-orchestration')
    expect(harness.tools.size).toBe(0)
  })

  it('ignores updates for other namespaces', () => {
    harness.setDocument([RECORD, { id: 'other', description: 'x', command: 'y' }])
    harness.handlers[0]!('llm-pi-ai')
    expect(harness.tools.has('custom_other')).toBe(false)
  })
})

describe('guard seam', () => {
  it('renders the command for the policy guard and refuses unknown tools', () => {
    expect(harness.seam?.render('custom_echo-tool', { message: "a'b" })).toEqual({ command: "echo 'a'\\''b'" })
    expect(harness.seam?.render('custom_missing', {})).toBeUndefined()
    expect(harness.seam?.render('bash', { command: 'rm -rf /' })).toBeUndefined()
  })

  it('renders nothing when a required parameter is missing', () => {
    expect(harness.seam?.render('custom_echo-tool', {})).toBeUndefined()
  })
})

describe('execution', () => {
  it('runs the rendered command through the shell and returns stdout/stderr/exit honestly', async () => {
    const tool = harness.tools.get('custom_echo-tool')!
    harness.shellResult = { exitCode: 3, signal: null, timedOut: false, stdout: { text: 'out\n' }, stderr: { text: 'err\n' } }
    const value = await tool.execute({ message: 'hello world' }, { agent: { session: {} }, signal: undefined }) as Record<string, unknown>
    expect(harness.shellCalls[0]).toMatchObject({ command: "echo 'hello world'", description: 'Echo Tool' })
    expect(harness.shellCalls[0]?.sandboxPolicy).toMatchObject({ mode: 'workspace-write' })
    // The trusted DSH_* overlay rides with the spec, exactly like tool-bash, so
    // a template may reference $DSH_HOME / $DSH_PROFILE_DIR instead of a
    // machine-absolute path (the subprocess scrub strips DSH_* otherwise).
    expect(harness.shellCalls[0]?.dshEnv).toEqual({ DSH_HOME: '/tmp/dsh-home', DSH_PROFILE_DIR: '/tmp/dsh-home/profiles/web' })
    expect(value).toMatchObject({ command: "echo 'hello world'", exitCode: 3, stdout: 'out\n', stderr: 'err\n', error: '' })
    const rendered = tool.output.render({}, value)
    expect(rendered[0]?.text).toContain('out')
    expect(rendered[0]?.text).toContain('[stderr]\nerr')
    expect(rendered[0]?.text).toContain('[exit code: 3]')
  })

  it('lets the registry reject missing required arguments before execute', async () => {
    const tool = harness.tools.get('custom_echo-tool')!
    await expect(tool.execute({}, {})).rejects.toThrow('missing required property "message"')
    expect(harness.shellCalls).toHaveLength(0)
  })

  it('reports a render failure without touching the shell', async () => {
    const h = makeHarness([{ ...RECORD, command: 'echo {{nope}}' }])
    const tool = h.tools.get('custom_echo-tool')!
    const value = await tool.execute({ message: 'x' }, {}) as Record<string, unknown>
    expect(h.shellCalls).toHaveLength(0)
    expect(String(value.error)).toContain('unknown parameter "nope"')
  })

  it('reports a shell failure as an honest error value', async () => {
    const tool = harness.tools.get('custom_echo-tool')!
    harness.shellThrows = true
    const value = await tool.execute({ message: 'x' }, {}) as Record<string, unknown>
    expect(value.exitCode).toBeNull()
    expect(String(value.error)).toContain('executor refused')
  })
})

describe('readCustomToolRecords', () => {
  it('reads the document array and reports duplicates', () => {
    const reader = { get: () => ({ customTools: [RECORD, RECORD] }) }
    const { records, errors } = readCustomToolRecords(reader)
    expect(records).toHaveLength(1)
    expect(errors[0]).toContain('duplicate')
  })

  it('fails open on a missing or malformed document', () => {
    expect(readCustomToolRecords(undefined)).toEqual({ records: [], errors: [] })
    expect(readCustomToolRecords({ get: () => ({ customTools: 'nope' }) }).errors[0]).toContain('array')
  })
})

describe('renderCustomToolResult', () => {
  it('marks timeouts and signals', () => {
    const text = renderCustomToolResult({}, {
      command: 'sleep 1', exitCode: null, signal: 'SIGKILL', timedOut: true, stdout: '', stderr: '', error: '',
    })[0]!.text
    expect(text).toContain('[timed out')
    expect(text).toContain('[killed by signal: SIGKILL]')
  })
})
