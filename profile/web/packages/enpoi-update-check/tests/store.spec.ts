import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { readDismissedVersion, writeDismissedVersion } from '../src/store.js'

const cleanups: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enpoi-update-check-store-'))
  cleanups.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

describe('dismissed store', () => {
  it('round-trips the dismissed version, creating the directory', () => {
    const file = join(scratch(), 'update-check', 'dismissed.json')
    expect(readDismissedVersion(file)).toBeNull()
    expect(writeDismissedVersion(file, '0.1.7-enpoi.2.84', () => new Date('2026-10-13T12:00:00.000Z'))).toBe(true)
    expect(readDismissedVersion(file)).toBe('0.1.7-enpoi.2.84')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: '0.1.7-enpoi.2.84',
      at: '2026-10-13T12:00:00.000Z',
    })
  })

  it('leaves no temporary file behind', () => {
    const dir = scratch()
    const file = join(dir, 'dismissed.json')
    writeDismissedVersion(file, '0.1.7-enpoi.2.84')
    expect(readdirSync(dir).filter(name => name.includes('.tmp.'))).toEqual([])
  })

  it('overwrites a previous skip', () => {
    const file = join(scratch(), 'dismissed.json')
    writeDismissedVersion(file, '0.1.7-enpoi.2.84')
    writeDismissedVersion(file, '0.1.7-enpoi.2.85')
    expect(readDismissedVersion(file)).toBe('0.1.7-enpoi.2.85')
  })

  it('degrades to null for missing and malformed files', () => {
    const file = join(scratch(), 'dismissed.json')
    writeFileSync(file, '{ broken')
    expect(readDismissedVersion(file)).toBeNull()
    expect(readDismissedVersion(join(file, '..', 'missing.json'))).toBeNull()
    writeFileSync(file, JSON.stringify({ version: '' }))
    expect(readDismissedVersion(file)).toBeNull()
  })

  it('reports a write failure instead of throwing', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'blocked'), { recursive: true })
    // A directory at the target path makes the rename fail.
    expect(writeDismissedVersion(join(dir, 'blocked'), '0.1.7-enpoi.2.84')).toBe(false)
  })
})
