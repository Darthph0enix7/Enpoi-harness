import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerConfigError } from '../src/pairings.ts'
import {
  PeerJobBindingStore,
  isValidCredentialRefName,
  jobUpdatePayloadHash,
  validateCreateJob,
} from '../src/job-bindings.ts'
import type { PeerAlias, PeerJobBinding, PeerRequestId, PeerWorkerPolicy } from '../src/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const atomicWrite = vi.hoisted(() => ({ fail: false }))

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    writeFileAtomic: async (
      path: string,
      content: string,
      options: Parameters<typeof actual.writeFileAtomic>[2],
    ) => {
      if (atomicWrite.fail) throw new Error('disk full')
      return actual.writeFileAtomic(path, content, options)
    },
  }
})

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'peer-job-bindings-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeBinding(overrides: Partial<PeerJobBinding> = {}): PeerJobBinding {
  return {
    sessionId: 'peer-sess-1' as SessionId,
    jobId: 'job-1',
    fence: 1,
    expiresAt: Date.now() + 60_000,
    capabilities: ['read'],
    limits: { maxSteps: 10 },
    alias: 'worker' as PeerAlias,
    instanceId: 'inst-1',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('credentialRef validation', () => {
  it('accepts safe reference names and rejects tokens, URLs, and credentials', () => {
    for (const valid of ['vault:hub-read', 'cred_1', 'enpoi/mcp-token', 'google.cal-ro']) {
      expect(isValidCredentialRefName(valid, 128)).toBe(true)
    }
    for (const invalid of [
      '',
      'a'.repeat(129),
      'https://user:pass@example.com',
      'http://localhost:8080/mcp?token=abc',
      'user:pass@host',
      'Bearer secret-token',
      'sk-1234567890abcdef',
      'sk_live_abcdef',
      'ghp_1234567890abcdef',
      'github_pat_12345',
      'eyJhbGciOiJIUzI1NiJ9.abc.def',
      'AKIAIOSFODNN7EXAMPLE',
      'token=secret',
      'scrypt$salt$hash',
      '0123456789abcdef0123456789abcdef',
      'bad\u0000ref',
      'has space',
    ]) {
      expect(isValidCredentialRefName(invalid, 128)).toBe(false)
    }
  })
})

describe('validateCreateJob', () => {
  const policy: PeerWorkerPolicy = {
    allowedCapabilities: ['read', 'search'],
    maxLimits: { maxSteps: 20, maxToolCalls: 40, maxWallMs: 120_000, maxTotalTokens: 50_000 },
    allowedMcpEndpoints: ['jarvis-hub'],
    allowedToolNames: ['read', 'grep', 'mcp__jarvis__knowledge_search'],
  }
  const bounds = {
    jobIdMaxLength: 128,
    jobMaxTtlMs: 3_600_000,
    jobIdentifierMaxLength: 128,
    jobCapabilitiesMax: 16,
    jobToolsMax: 32,
  }

  it('validates and merges policy limits when request limits are within bounds', () => {
    const now = 1_000_000
    const result = validateCreateJob({
      jobId: 'job-alpha',
      fence: 1,
      expiresAt: now + 60_000,
      capabilities: ['read'],
      limits: { maxSteps: 10 },
      mcpEndpointId: 'jarvis-hub',
      credentialRef: 'vault:hub-read',
      allowedToolNames: ['read'],
    }, policy, bounds, now)
    expect(result).toEqual({
      jobId: 'job-alpha',
      fence: 1,
      expiresAt: now + 60_000,
      capabilities: ['read'],
      limits: { maxSteps: 10, maxToolCalls: 40, maxWallMs: 120_000, maxTotalTokens: 50_000 },
      mcpEndpointId: 'jarvis-hub',
      credentialRef: 'vault:hub-read',
      allowedToolNames: ['read'],
    })
  })

  it('refuses (never silently clamps) out-of-policy capabilities, limits, endpoints, and tools', () => {
    const now = 1_000_000
    const base = {
      jobId: 'job-alpha',
      fence: 1,
      expiresAt: now + 60_000,
      capabilities: ['read'],
      limits: { maxSteps: 10 },
    }
    expect(() => validateCreateJob({ ...base, capabilities: ['write'] }, policy, bounds, now))
      .toThrow(/job-capability-not-allowed|not allowed/u)
    expect(() => validateCreateJob({ ...base, limits: { maxSteps: 21 } }, policy, bounds, now))
      .toThrow(/exceeds/u)
    expect(() => validateCreateJob({ ...base, limits: { maxToolCalls: 41 } }, policy, bounds, now))
      .toThrow(/exceeds/u)
    expect(() => validateCreateJob({ ...base, limits: { maxWallMs: 120_001 } }, policy, bounds, now))
      .toThrow(/exceeds/u)
    expect(() => validateCreateJob({ ...base, limits: { maxTotalTokens: 50_001 } }, policy, bounds, now))
      .toThrow(/exceeds/u)
    expect(() => validateCreateJob({ ...base, mcpEndpointId: 'other-mcp' }, policy, bounds, now))
      .toThrow(/mcpEndpointId/u)
    expect(() => validateCreateJob({ ...base, allowedToolNames: ['bash'] }, policy, bounds, now))
      .toThrow(/allowedToolNames|tool/u)
  })

  it('rejects expired timestamps, TTL over max, bad credentialRef, unknown keys, and non-positive ints', () => {
    const now = 1_000_000
    const base = {
      jobId: 'job-alpha',
      fence: 1,
      expiresAt: now + 60_000,
      capabilities: ['read'],
      limits: { maxSteps: 10 },
    }
    expect(() => validateCreateJob({ ...base, expiresAt: now }, policy, bounds, now)).toThrow(/future/u)
    expect(() => validateCreateJob({ ...base, expiresAt: now + bounds.jobMaxTtlMs + 1 }, policy, bounds, now))
      .toThrow(/TTL/u)
    expect(() => validateCreateJob({ ...base, fence: 0 }, policy, bounds, now)).toThrow(/fence/u)
    expect(() => validateCreateJob({ ...base, credentialRef: 'sk-live-secret' }, policy, bounds, now))
      .toThrow(/credentialRef/u)
    expect(() => validateCreateJob({ ...base, extraField: 1 }, policy, bounds, now)).toThrow(/unknown/u)
  })
})

describe('PeerJobBindingStore', () => {
  it('persists 0600 atomic bindings, reloads across restart, preserves expired and revoked records', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-job-bindings.json')
    const store = new PeerJobBindingStore(path, 16, 64 * 1024)
    expect(store.tryOpen().ok).toBe(true)

    const live = makeBinding({ sessionId: 's-live' as SessionId, jobId: 'j-live', expiresAt: Date.now() + 60_000 })
    const expired = makeBinding({ sessionId: 's-exp' as SessionId, jobId: 'j-exp', expiresAt: Date.now() - 10_000 })
    await store.put(live)
    await store.put(expired)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    // Revocation takes effect immediately on the next synchronous get().
    const revoked = store.revoke('s-live' as SessionId)
    expect(store.get('s-live' as SessionId)?.revoked).toBe(true)
    expect(await revoked).toBe(true)
    expect(store.get('s-live' as SessionId)?.revoked).toBe(true)
    expect(await store.revoke('s-missing' as SessionId)).toBe(false)

    // Restart reloads both the expired record and the revoked flag.
    const restarted = new PeerJobBindingStore(path, 16, 64 * 1024)
    expect(restarted.tryOpen().ok).toBe(true)
    expect(restarted.get('s-exp' as SessionId)?.expiresAt).toBe(expired.expiresAt)
    expect(restarted.get('s-live' as SessionId)?.revoked).toBe(true)
  })

  it('enforces count and complete byte limits and rolls back failed writes', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-job-bindings.json')
    const store = new PeerJobBindingStore(path, 2, 64 * 1024)
    await store.put(makeBinding({ sessionId: 's1' as SessionId, jobId: 'j1' }))
    await store.put(makeBinding({ sessionId: 's2' as SessionId, jobId: 'j2' }))
    await expect(store.put(makeBinding({ sessionId: 's3' as SessionId, jobId: 'j3' }))).rejects.toThrow(/count/u)
    expect(store.get('s2' as SessionId)).toBeDefined()
    expect(store.get('s1' as SessionId)).toBeDefined()
    expect(store.get('s3' as SessionId)).toBeUndefined()

    // Write failure rolls back put() without leaving a phantom binding.
    atomicWrite.fail = true
    try {
      const writable = new PeerJobBindingStore(path, 3, 64 * 1024)
      await expect(writable.put(makeBinding({ sessionId: 's4' as SessionId, jobId: 'j4' }))).rejects.toThrow('disk full')
      expect(writable.get('s4' as SessionId)).toBeUndefined()
    } finally {
      atomicWrite.fail = false
    }
    expect(store.get('s4' as SessionId)).toBeUndefined()

    // Tiny byte cap fails loud without losing existing entries.
    const tiny = new PeerJobBindingStore(path, 16, 32)
    await expect(tiny.put(makeBinding({ sessionId: 's5' as SessionId, jobId: 'j5' }))).rejects.toThrow(/maxBytes/u)
    expect(readFileSync(path, 'utf8')).toContain('s2')
  })

  it('rejects corrupt persisted documents on load', () => {
    const root = tempRoot()
    const path = join(root, 'corrupt.json')
    writeFileSync(path, '{"version": 9}')
    expect(new PeerJobBindingStore(path).tryOpen().ok).toBe(false)
    expect(() => new PeerJobBindingStore(path).get('s1' as SessionId)).toThrow(PeerConfigError)

    const badHash = jobUpdatePayloadHash('worker', {
      alias: 'worker' as PeerAlias,
      requestId: 'r1' as PeerRequestId,
      jobId: 'j1',
      fence: 2,
    })
    expect(badHash).toMatch(/^[0-9a-f]{64}$/u)
  })
})
