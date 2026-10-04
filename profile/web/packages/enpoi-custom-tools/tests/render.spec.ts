// render.spec.ts — pure custom-tool model: parsing, quoting/injection, rendering.

import { describe, it, expect } from 'vitest'
import {
  isCustomToolId,
  parseCustomToolRecord,
  recordIdOf,
  renderCommand,
  shellQuote,
  toolNameOf,
  type CustomToolRecord,
} from '../src/render.js'

const RECORD: CustomToolRecord = {
  id: 'echo-tool',
  name: 'Echo Tool',
  description: 'Echo a message',
  params: [
    { name: 'message', type: 'string', required: true, description: 'Text to echo' },
    { name: 'times', type: 'number', required: false, description: 'Repeat count' },
    { name: 'loud', type: 'boolean', required: false, description: 'Uppercase' },
  ],
  command: 'echo {{message}}',
}

describe('ids and names', () => {
  it('accepts kebab-case ids and rejects other shapes', () => {
    expect(isCustomToolId('github-repo')).toBe(true)
    expect(isCustomToolId('tool2')).toBe(true)
    for (const bad of ['', 'Bad', 'a_b', 'a/b', '../x', 'a b']) expect(isCustomToolId(bad), bad).toBe(false)
  })

  it('maps ids to registered names and back', () => {
    expect(toolNameOf('github-repo')).toBe('custom_github-repo')
    expect(recordIdOf('custom_github-repo')).toBe('github-repo')
    expect(recordIdOf('bash')).toBeUndefined()
  })
})

describe('parseCustomToolRecord', () => {
  it('parses a full record and defaults the display name to the id', () => {
    const parsed = parseCustomToolRecord({
      id: 'github-repo',
      description: 'Query GitHub',
      params: [{ name: 'path', type: 'string', required: true, description: 'API path' }],
      command: 'gh api {{path}}',
    })
    expect(parsed.error).toBeUndefined()
    expect(parsed.record).toMatchObject({ id: 'github-repo', name: 'github-repo', description: 'Query GitHub' })
    expect(parsed.record?.params).toEqual([{ name: 'path', type: 'string', required: true, description: 'API path' }])
  })

  it('rejects malformed records with a reason', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'not an object'],
      [{ id: 'Bad Id', description: 'd', command: 'c' }, 'kebab-case'],
      [{ id: 'ok', description: '', command: 'c' }, 'description'],
      [{ id: 'ok', description: 'd', command: '  ' }, 'command'],
      [{ id: 'ok', description: 'd', command: 'c', params: 'nope' }, 'params must be an array'],
      [{ id: 'ok', description: 'd', command: 'c', params: [{ name: 'Bad', type: 'string' }] }, 'param name'],
      [{ id: 'ok', description: 'd', command: 'c', params: [{ name: 'a', type: 'date' }] }, 'unsupported type'],
      [{ id: 'ok', description: 'd', command: 'c', params: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }] }, 'duplicate'],
    ]
    for (const [value, fragment] of cases) {
      const parsed = parseCustomToolRecord(value)
      expect(parsed.record, JSON.stringify(value)).toBeUndefined()
      expect(parsed.error, JSON.stringify(value)).toContain(fragment)
    }
  })
})

describe('shellQuote', () => {
  it('single-quotes plain values and escapes embedded quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'")
    expect(shellQuote('')).toBe("''")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'")
    expect(shellQuote('a; rm -rf /')).toBe("'a; rm -rf /'")
    expect(shellQuote('`whoami`')).toBe("'`whoami`'")
  })
})

describe('renderCommand', () => {
  it('substitutes every placeholder as one quoted word', () => {
    const rendered = renderCommand(RECORD, { message: 'hello world' })
    expect(rendered.command).toBe("echo 'hello world'")
  })

  it('neutralizes injection attempts', () => {
    const rendered = renderCommand(RECORD, { message: "x'; rm -rf / #" })
    expect(rendered.command).toBe("echo 'x'\\''; rm -rf / #'")
    // The dangerous text stays inside one quoted word: no unquoted `;`.
    expect(rendered.command?.split("'").length).toBeGreaterThan(2)
  })

  it('coerces numbers and booleans and rejects wrong types', () => {
    expect(renderCommand({ ...RECORD, command: 'run {{times}} {{loud}}' }, { times: 3, loud: true }).command).toBe("run '3' 'true'")
    expect(renderCommand({ ...RECORD, command: 'run {{times}}' }, { times: '3' }).error).toContain('finite number')
    expect(renderCommand({ ...RECORD, command: 'run {{loud}}' }, { loud: 'yes' }).error).toContain('boolean')
  })

  it('reports missing required params, unknown placeholders, and malformed templates', () => {
    expect(renderCommand(RECORD, {}).error).toContain('missing required parameter "message"')
    expect(renderCommand({ ...RECORD, command: 'echo {{nope}}' }, { message: 'x' }).error).toContain('unknown parameter "nope"')
    expect(renderCommand({ ...RECORD, command: 'echo {{message' }, { message: 'x' }).error).toContain('malformed placeholder')
  })

  it('renders optional params as empty quoted words when omitted', () => {
    expect(renderCommand({ ...RECORD, command: 'echo {{message}} {{times}}' }, { message: 'x' }).command).toBe("echo 'x' ''")
  })
})
