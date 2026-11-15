/** Settings-owned Connection diagnosis projection: optional host compatibility and bounded copy. */
import { describe, expect, it } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  CONNECTION_DIAGNOSIS_MAX_CHARS,
  connectionDiagnosisSource,
  sanitizeConnectionDiagnosis,
} from '../src/client/connection-status.ts'

function handleWith(
  getDiagnosis?: () => string | undefined,
  subscribe: (listener: () => void) => () => void = () => () => {},
): ConnectionHandle {
  return {
    state: {
      getSnapshot: () => undefined,
      subscribe,
      ...(getDiagnosis === undefined ? {} : { getDiagnosis }),
    },
  } as unknown as ConnectionHandle
}

describe('connection diagnosis source', () => {
  it('works when an older host exposes no diagnosis getter', () => {
    const source = connectionDiagnosisSource(handleWith())
    expect(source.getSnapshot()).toBeUndefined()
    expect(() => { source.subscribe(() => {})() }).not.toThrow()
  })

  it('forwards the optional getter and the state subscription', () => {
    const listeners = new Set<() => void>()
    const source = connectionDiagnosisSource(handleWith(
      () => 'connection: recovery paused; reload the page',
      (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    ))
    expect(source.getSnapshot()).toContain('reload the page')
    const dispose = source.subscribe(() => {})
    expect(listeners.size).toBe(1)
    dispose()
    expect(listeners.size).toBe(0)
  })

  it('treats a throwing branded getter as absent', () => {
    const source = connectionDiagnosisSource(handleWith(() => { throw new Error('branded proxy') }))
    expect(source.getSnapshot()).toBeUndefined()
  })

  it('folds control characters, clips bounded copy, and drops empty text', () => {
    expect(sanitizeConnectionDiagnosis('\u0000 connection:\n recovery\t stalled \u007f')).toBe('connection: recovery stalled')
    expect(sanitizeConnectionDiagnosis('   ')).toBeUndefined()
    expect(sanitizeConnectionDiagnosis(undefined)).toBeUndefined()
    const clipped = sanitizeConnectionDiagnosis('x'.repeat(CONNECTION_DIAGNOSIS_MAX_CHARS + 20))
    expect(clipped).toHaveLength(CONNECTION_DIAGNOSIS_MAX_CHARS)
    expect(clipped?.endsWith('…')).toBe(true)
  })
})
