import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHeaderProvider, type WorkerBinding } from '../src/index.ts'

const canary = 'fabricated.canary-never-in-errors'
const sessionId = 'test-session'

describe('worker request credentials', () => {
  let root: string
  let secretDir: string
  let binding: WorkerBinding
  let provider: ReturnType<typeof createHeaderProvider>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-worker-secret-'))
    secretDir = join(root, 'worker-secrets')
    await mkdir(secretDir, { mode: 0o700 })
    binding = {
      jobId: 'test-job', fence: 2, expiresAt: Date.now() + 60_000,
      mcpEndpointId: 'jarvis', credentialRef: 'attempt-2',
    }
    provider = createHeaderProvider({ secretDir, serverId: 'jarvis' }, id => id === sessionId ? binding : undefined)
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('resolves the bound destination on each request, never when unbound', async () => {
    const path = join(secretDir, 'attempt-2')
    await writeFile(path, `${canary}\n`, { mode: 0o600 })
    const first = await provider.headersFor(sessionId, 'jarvis')
    expect(first?.Authorization === `Bearer ${canary}`).toBe(true)
    expect(first?.['X-Jarvis-Job-ID']).toBe('test-job')
    expect(first?.['X-Jarvis-Job-Fence']).toBe('2')
    await expect(provider.headersFor(undefined, 'jarvis')).resolves.toBeUndefined()
    await expect(provider.headersFor('other-session', 'jarvis')).resolves.toBeUndefined()
    await expect(provider.headersFor(sessionId, 'other-endpoint')).resolves.toBeUndefined()
    binding = { ...binding, mcpEndpointId: 'other-endpoint' }
    await expect(provider.headersFor(sessionId, 'jarvis')).resolves.toBeUndefined()
    binding = { ...binding, mcpEndpointId: 'jarvis', revoked: true }
    await expect(provider.headersFor(sessionId, 'jarvis')).resolves.toBeUndefined()
    binding = { ...binding, revoked: false, expiresAt: Date.now() - 1 }
    await expect(provider.headersFor(sessionId, 'jarvis')).resolves.toBeUndefined()
    binding = { ...binding, expiresAt: Date.now() + 60_000 }
    await rm(path)
    await expect(provider.headersFor(sessionId, 'jarvis')).resolves.toBeUndefined()
  })

  it('refuses unsafe files and directories with a fixed, value-free error', async () => {
    const path = join(secretDir, 'attempt-2')
    const refusal = async (): Promise<void> => {
      await expect(provider.headersFor(sessionId, 'jarvis')).rejects.toThrow(/^Worker MCP credential unavailable$/u)
    }
    await writeFile(path, canary, { mode: 0o640 })
    await refusal()
    await chmod(path, 0o600)
    await chmod(secretDir, 0o750)
    await refusal()
    await chmod(secretDir, 0o700)
    await writeFile(path, `${canary}\r\nInjected: yes`)
    await refusal()
    await writeFile(path, canary.repeat(1000))
    await refusal()
    await rm(path)
    const outside = join(root, 'outside')
    await writeFile(outside, canary, { mode: 0o600 })
    await symlink(outside, path)
    await refusal()
    binding = { ...binding, credentialRef: '../outside' }
    await refusal()
    binding = { ...binding, credentialRef: 'attempt-2' }
    await rm(secretDir, { recursive: true })
    await mkdir(outside + '-dir', { mode: 0o700 })
    await symlink(outside + '-dir', secretDir)
    await refusal()
  })

  it('checks the returned authority again after asynchronous disk access', async () => {
    await writeFile(join(secretDir, 'attempt-2'), canary, { mode: 0o600 })
    const result = provider.headersFor(sessionId, 'jarvis')
    binding = { ...binding, fence: 3 }
    await expect(result).resolves.toBeUndefined()
  })
})
