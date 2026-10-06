/**
 * Attach state persistence (fork): atomic 0600 writes, ownership-checked
 * removal, and the synchronous exit path used by the serving process.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeWebState, removeWebStateSync, webStatePath, writeWebState, type WebInstanceState } from '../src/state.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A temp DSH home for one test. */
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-state-'))
  dirs.push(dir)
  return dir
}

const record: WebInstanceState = {
  url: 'http://127.0.0.1:3080/?token=abc',
  host: '127.0.0.1',
  port: 3080,
  pid: 4242,
  startedAt: new Date(0).toISOString(),
}

describe('web attach state', () => {
  it('lives under the DSH home state directory', () => {
    expect(webStatePath('/h')).toBe(join('/h', 'state', 'web-url.json'))
  })

  it('writes atomically with owner-only permissions', async () => {
    const home = tempHome()
    await writeWebState(record, home)
    const path = webStatePath(home)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('removes only its own record', async () => {
    const home = tempHome()
    await writeWebState(record, home)
    await removeWebState(99, home)
    expect(JSON.parse(readFileSync(webStatePath(home), 'utf8')).pid).toBe(4242)
    await removeWebState(4242, home)
    expect(() => readFileSync(webStatePath(home), 'utf8')).toThrow()
  })

  it('removes synchronously only its own record', async () => {
    const home = tempHome()
    await writeWebState(record, home)
    removeWebStateSync(99, home)
    expect(JSON.parse(readFileSync(webStatePath(home), 'utf8')).pid).toBe(4242)
    removeWebStateSync(4242, home)
    expect(() => readFileSync(webStatePath(home), 'utf8')).toThrow()
  })

  it('tolerates absent and unreadable records', async () => {
    const home = tempHome()
    await expect(removeWebState(1, home)).resolves.toBeUndefined()
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(webStatePath(home), 'not json')
    await expect(removeWebState(1, home)).resolves.toBeUndefined()
    removeWebStateSync(1, home)
  })
})
