import { describe, expect, it } from 'vitest'
import { installSearchNudge, isSearchLeadingCommand, SEARCH_NUDGE_TEXT } from '../src/search-nudge.js'

/** Fake ctx capturing the listeners installSearchNudge registers. */
function harness() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>()
  const ctx = {
    on: (name: string, handler: (...args: any[]) => any) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
  }
  installSearchNudge(ctx as any)
  const session = { id: 'session-nudge' }
  const result = { content: [{ type: 'text', text: 'shell output' }], isError: false }
  const accept = () => Promise.resolve({ kind: 'accept' })
  const call = (exec: any, next: () => Promise<any> = accept) => {
    const handler = (handlers.get('tools/post-execute') ?? [])[0]
    return handler(exec, result, next)
  }
  const bash = (command: string) => ({ name: 'bash', arguments: { command }, agent: { session } })
  return {
    session,
    handlers,
    call,
    bash,
    fire: (name: string, ...args: any[]) => { for (const handler of handlers.get(name) ?? []) handler(...args) },
    turnStart: () => { for (const handler of handlers.get('session/event') ?? []) handler(session, { type: 'turn/start', data: { turn: 1 } }) },
    toolCall: (tool: string) => { for (const handler of handlers.get('session/event') ?? []) handler(session, { type: 'tool/call', data: { name: tool } }) },
  }
}

describe('search-leading predicate', () => {
  it('matches only a command whose FIRST word is a search tool', () => {
    expect(isSearchLeadingCommand('rg foo')).toBe(true)
    expect(isSearchLeadingCommand('  grep -rn foo .')).toBe(true)
    expect(isSearchLeadingCommand('sudo find . -name "*.ts"')).toBe(true)
    expect(isSearchLeadingCommand('fd pattern')).toBe(true)
    expect(isSearchLeadingCommand('ls -la')).toBe(true)
  })

  it('rejects pipelines, unrelated commands, and search tools in non-leading positions', () => {
    expect(isSearchLeadingCommand('cat f | grep x')).toBe(false)
    expect(isSearchLeadingCommand('npm test')).toBe(false)
    expect(isSearchLeadingCommand('git grep foo')).toBe(false)
    expect(isSearchLeadingCommand('git status')).toBe(false)
    expect(isSearchLeadingCommand('echo rg')).toBe(false)
    expect(isSearchLeadingCommand('printf "grep"')).toBe(false)
  })
})

describe('bash search nudge', () => {
  it('appends exactly one advisory line to a search-leading bash result', async () => {
    const { call, bash, turnStart } = harness()
    turnStart()
    const decision = await call(bash('rg foo'))
    expect(decision.kind).toBe('accept')
    expect(decision.content).toHaveLength(2)
    expect(decision.content[0]).toEqual({ type: 'text', text: 'shell output' })
    expect(decision.content[1]).toEqual({ type: 'text', text: SEARCH_NUDGE_TEXT })
  })

  it('never hints twice in one turn and never denies', async () => {
    const { call, bash, turnStart } = harness()
    turnStart()
    const first = await call(bash('rg foo'))
    expect(first.content).toHaveLength(2)
    const second = await call(bash('grep -r x .'))
    expect(second).toEqual({ kind: 'accept' })
    const third = await call(bash('find . -name "*.md"'))
    expect(third).toEqual({ kind: 'accept' })
  })

  it('does not hint after grep or glob ran this turn', async () => {
    const grepTurn = harness()
    grepTurn.turnStart()
    grepTurn.toolCall('grep')
    expect(await grepTurn.call(grepTurn.bash('rg foo'))).toEqual({ kind: 'accept' })

    const globTurn = harness()
    globTurn.turnStart()
    globTurn.toolCall('glob')
    expect(await globTurn.call(globTurn.bash('find .'))).toEqual({ kind: 'accept' })
  })

  it('resets the latch on a new turn', async () => {
    const { call, bash, turnStart } = harness()
    turnStart()
    expect((await call(bash('rg foo'))).content).toHaveLength(2)
    turnStart()
    expect((await call(bash('rg bar'))).content).toHaveLength(2)
  })

  it('ignores non-search bash, non-bash tools, and sessions with no id', async () => {
    const { call, bash, turnStart } = harness()
    turnStart()
    expect(await call(bash('npm test'))).toEqual({ kind: 'accept' })
    expect(await call({ name: 'read', arguments: { filePath: 'x' }, agent: { session: { id: 'session-nudge' } } })).toEqual({ kind: 'accept' })
    expect(await call({ name: 'bash', arguments: { command: 'rg foo' }, agent: undefined })).toEqual({ kind: 'accept' })
  })

  it('delegates a value replacement and a block decision untouched', async () => {
    const { call, bash, turnStart } = harness()
    turnStart()
    const replaced = await call(bash('rg foo'), () => Promise.resolve({ kind: 'accept', value: 42 }))
    expect(replaced).toEqual({ kind: 'accept', value: 42 })
    const blocked = await call(bash('rg foo'), () => Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] }))
    expect(blocked.kind).toBe('block')
  })
})
