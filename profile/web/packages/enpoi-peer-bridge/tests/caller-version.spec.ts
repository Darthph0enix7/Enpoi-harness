/**
 * Caller identity resolution for the peer handshake: no invented version, no
 * hardcoded literal, and a documented env override when no install exists.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  adjacentPeerManifest, CALLER_HARNESS_VERSION_ENV, CallerVersionError, resolveCallerHarnessVersion,
} from '../src/caller-version.ts'

function dir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('caller harness version', () => {
  it('prefers the explicit option, then the env override', () => {
    expect(resolveCallerHarnessVersion({ harnessVersion: '9.9.9-option', env: { [CALLER_HARNESS_VERSION_ENV]: '9.9.9-env' } }))
      .toBe('9.9.9-option')
    expect(resolveCallerHarnessVersion({ env: { [CALLER_HARNESS_VERSION_ENV]: '9.9.9-env' } })).toBe('9.9.9-env')
    // A blank override is not an identity.
    expect(resolveCallerHarnessVersion({ peerManifestPath: undefined, dshHome: dir('peer-version-blank-'), env: { [CALLER_HARNESS_VERSION_ENV]: '   ' } }))
      .not.toBe('   ')
  })

  it('reads the adjacent peer manifest, then the installed harness identity', () => {
    const home = dir('peer-version-home-')
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(join(home, 'harness', 'install-state.json'), JSON.stringify({ version: '9.9.9-installed' }))
    const manifestDir = dir('peer-version-manifest-')
    writeFileSync(join(manifestDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-api-peer', version: '9.9.9-manifest' }))
    const manifest = join(manifestDir, 'package.json')
    expect(resolveCallerHarnessVersion({ peerManifestPath: manifest, dshHome: home, env: {} })).toBe('9.9.9-manifest')
    // An unreadable manifest falls through to the installer's identity.
    expect(resolveCallerHarnessVersion({ peerManifestPath: join(manifestDir, 'missing.json'), dshHome: home, env: {} }))
      .toBe('9.9.9-installed')
  })

  it('skips a malformed manifest or install state instead of reporting garbage', () => {
    const home = dir('peer-version-malformed-')
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(join(home, 'harness', 'install-state.json'), '{ not json')
    const manifest = join(home, 'package.json')
    writeFileSync(manifest, JSON.stringify({ version: '' }))
    expect(() => resolveCallerHarnessVersion({ peerManifestPath: manifest, dshHome: home, env: {} }))
      .toThrowError(CallerVersionError)
    writeFileSync(join(home, 'harness', 'install-state.json'), JSON.stringify({ version: '9.9.9-recovered' }))
    expect(resolveCallerHarnessVersion({ peerManifestPath: manifest, dshHome: home, env: {} })).toBe('9.9.9-recovered')
  })

  it('fails closed naming the env override when no source resolves', () => {
    const empty = dir('peer-version-empty-')
    expect(() => resolveCallerHarnessVersion({
      peerManifestPath: join(empty, 'missing-package.json'),
      dshHome: empty,
      env: {},
    })).toThrowError(CallerVersionError)
    expect(() => resolveCallerHarnessVersion({
      peerManifestPath: join(empty, 'missing-package.json'),
      dshHome: empty,
      env: {},
    })).toThrowError(new RegExp(`cannot determine the caller harness version.*${CALLER_HARNESS_VERSION_ENV}`, 'u'))
  })

  it('finds the peer manifest beside the running profile', () => {
    const manifest = adjacentPeerManifest(import.meta.url)
    expect(manifest).toBeDefined()
    expect(manifest).toContain(join('node_modules', '@deepseek-ai', 'dsh-api-peer', 'package.json'))
  })
})
