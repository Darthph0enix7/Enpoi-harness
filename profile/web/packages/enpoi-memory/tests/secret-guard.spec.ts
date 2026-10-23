import { describe, expect, it } from 'vitest'
import { containsSecret } from '../src/secret-guard'

describe('secret guard — compaction-derived facts', () => {
  it('rejects every copied key shape', () => {
    for (const secret of [
      'api key sk-live-abcdefghijklmnop',
      'token ghp_abcdefghijklmnopqrst',
      'pat github_pat_11ABCDEFG0123456789',
      'aws AKIAIOSFODNN7EXAMPLE',
      'slack xoxb-1234567890-abcd',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij',
      'Authorization: Bearer abcdefghijklmnop',
      'password = hunter2secret',
    ]) {
      expect(containsSecret(secret), secret).toBe(true)
    }
  })

  it('keeps ordinary durable facts, including long identifiers and hashes', () => {
    for (const fact of [
      'the archive bucket is eu-central-3',
      'cloudflare tunnel id is 9db9e1f7-657e-4278-8c94-c02143d066fe',
      'build hash 4f9c2ab1d7e03568aa12bc34de56f78901234567 is the last green commit',
      'deploy with make deploy after the tests pass',
      '',
    ]) {
      expect(containsSecret(fact), fact).toBe(false)
    }
  })

  it('does not depend on regex lastIndex across calls', () => {
    expect(containsSecret('sk-abcdefghijklmnop')).toBe(true)
    expect(containsSecret('sk-abcdefghijklmnop')).toBe(true)
    expect(containsSecret('an ordinary sentence')).toBe(false)
  })

  it('never throws on non-string input', () => {
    expect(containsSecret(undefined as unknown as string)).toBe(false)
    expect(containsSecret(null as unknown as string)).toBe(false)
  })
})
