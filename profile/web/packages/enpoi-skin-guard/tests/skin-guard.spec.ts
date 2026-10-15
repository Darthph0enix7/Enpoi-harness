import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { apply, restoreIfNull } from '../src/index.js'

const cleanups: string[] = []
const originalDshHome = process.env.DSH_HOME

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enpoi-skin-guard-'))
  cleanups.push(dir)
  return dir
}

function writeState(dir: string, content: string): string {
  const file = join(dir, 'skin-center-active.json')
  writeFileSync(file, content)
  return file
}

afterEach(() => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

describe('restoreIfNull', () => {
  it('restores a null selection, sets initialized, and preserves other keys', () => {
    const dir = scratch()
    const file = writeState(dir, JSON.stringify({
      active: null,
      background: { enabled: true, backgroundOpacity: 30 },
    }))

    expect(restoreIfNull(file, 'summer-liquid-glass')).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      active: 'summer-liquid-glass',
      initialized: true,
      background: { enabled: true, backgroundOpacity: 30 },
    })
    expect(readdirSync(dir)).toEqual(['skin-center-active.json'])
  })

  it('treats an undefined selection like null', () => {
    const file = writeState(scratch(), JSON.stringify({ initialized: false }))

    expect(restoreIfNull(file, 'summer-liquid-glass')).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      initialized: true,
      active: 'summer-liquid-glass',
    })
  })

  it('never overrides an explicit different skin', () => {
    const file = writeState(scratch(), JSON.stringify({ active: 'blue-fantasy', initialized: true }))

    expect(restoreIfNull(file, 'summer-liquid-glass')).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ active: 'blue-fantasy', initialized: true })
  })

  it('no-ops when the state file is missing', () => {
    const file = join(scratch(), 'skin-center-active.json')

    expect(restoreIfNull(file, 'summer-liquid-glass')).toBe(false)
  })

  it('no-ops on malformed JSON and on non-object documents', () => {
    const malformed = writeState(scratch(), '{ not json')
    expect(restoreIfNull(malformed, 'summer-liquid-glass')).toBe(false)
    expect(readFileSync(malformed, 'utf8')).toBe('{ not json')

    const scalar = writeState(scratch(), '"summer-liquid-glass"')
    expect(restoreIfNull(scalar, 'summer-liquid-glass')).toBe(false)
    expect(readFileSync(scalar, 'utf8')).toBe('"summer-liquid-glass"')

    const array = writeState(scratch(), '[]')
    expect(restoreIfNull(array, 'summer-liquid-glass')).toBe(false)
    expect(readFileSync(array, 'utf8')).toBe('[]')
  })

  it('honors a skin override', () => {
    const file = writeState(scratch(), JSON.stringify({ active: null }))

    expect(restoreIfNull(file, 'blue-fantasy')).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ active: 'blue-fantasy', initialized: true })
  })
})

describe('apply', () => {
  it('restores a null write after mount via the poll path', async () => {
    const dir = scratch()
    process.env.DSH_HOME = dir
    const file = join(dir, 'skin-center-active.json')
    writeFileSync(file, JSON.stringify({ active: 'summer-liquid-glass', initialized: true }))

    const on = vi.fn()
    apply({ on } as never, { skin: 'summer-liquid-glass', pollMs: 25 })

    writeFileSync(file, JSON.stringify({ active: null }))
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(file, 'utf8')).active).toBe('summer-liquid-glass')
    }, { timeout: 3000, interval: 10 })

    const dispose = on.mock.calls.find(([event]) => event === 'dispose')?.[1] as (() => void) | undefined
    dispose?.()
  })

  it('stops enforcing after dispose', async () => {
    const dir = scratch()
    process.env.DSH_HOME = dir
    const file = join(dir, 'skin-center-active.json')
    writeFileSync(file, JSON.stringify({ active: 'summer-liquid-glass' }))

    const on = vi.fn()
    apply({ on } as never, { skin: 'summer-liquid-glass', pollMs: 25 })
    const dispose = on.mock.calls.find(([event]) => event === 'dispose')?.[1] as (() => void) | undefined
    expect(dispose).toBeTypeOf('function')
    dispose!()

    writeFileSync(file, JSON.stringify({ active: null }))
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(JSON.parse(readFileSync(file, 'utf8')).active).toBeNull()
  })
})
