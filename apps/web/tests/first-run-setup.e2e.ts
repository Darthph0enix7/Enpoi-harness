// Live first-run proof against a TEMP $DSH_HOME (never the developer's home):
// the booted real composition must seed the keyless Kilo route into the temp
// settings document, the background analysis must land the generalized system
// profile document with its structured JSON beside it and record the
// operator's decision, and a real settings write must persist for the next
// launch. The browser wizard UI itself needs a client bundle build, so this
// lane proves the host half end to end.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

// The same three exact-fact classes the investigation's `documentViolations`
// check pins in the package unit tests; this lane observes the live document a
// real model produced, which the package tests cannot.
const EXACT_FACTS = [
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/u, // IPv4 address
  /\b\d+\.\d+(?:\.\d+)*\b/u, // dotted version number
  /(?<![a-z0-9-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|ai|app|dev|cloud|vip|xyz|me|co|local)\b/iu, // domain-like string
]

// The scaffold composes the shipped bundles only, so the host's default
// `sysadmin` preset must exist here for the analysis to run: a minimal
// read-only composition with the tools the investigation needs.
const SYSADMIN_PRESET = {
  id: 'sysadmin',
  name: 'Sysadmin',
  description: 'Read-only machine investigator for the first-run analysis e2e.',
  plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are the sysadmin agent: precise, evidence-first, read-only.' } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  ],
}

describe('first-run setup live proof', () => {
  let scaffold: WebScaffold

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ agentPresets: { default: 'sysadmin', definitions: [SYSADMIN_PRESET] } })
  }, 120_000)

  afterAll(async () => {
    await scaffold?.close()
  })

  it('seeds the keyless Kilo route and the default model into the temp document', async () => {
    const patch = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('https://api.kilo.ai/api/gateway')
    expect(patch).toContain('kilo-auto/free')
    expect(patch).toContain('seedVersion')
  }, 60_000)

  it('runs the read-only analysis in the background and lands the system profile', async () => {
    const started = await scaffold.hostFetch('/system-analysis/start', { method: 'POST' })
    expect(started.ok).toBe(true)
    let job = (await started.json() as { job: { state: string; pct: number } }).job
    // The investigation is a real agent run on the seeded free route; it
    // takes a couple of minutes on a normal machine, so wait up to ten for it
    // to publish or fail.
    for (let attempt = 0; attempt < 1200 && job.state === 'running'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500))
      job = (await (await scaffold.hostFetch('/system-analysis/status')).json() as { job: { state: string; pct: number } }).job
    }
    expect(job.state, JSON.stringify(job)).toBe('succeeded')
    const profile = await readFile(join(scaffold.harnessHome, 'system-profile.md'), 'utf8')
    expect(profile).toContain('# System profile')
    expect(profile).toContain('Read-only investigation by the sysadmin agent.')
    // The generalized document carries the fixed section skeleton and no
    // exact machine facts (versions, addresses, domains).
    for (const section of [
      '## At a glance', '## Hardware', '## Usage & purpose', '## Hosting & services',
      '## Networking', '## Tooling & interests', '## Notes & limitations',
    ]) {
      expect(profile).toContain(section)
    }
    for (const pattern of EXACT_FACTS) {
      expect(profile).not.toMatch(pattern)
    }
    const structured = JSON.parse(await readFile(join(scaffold.harnessHome, 'system-profile.json'), 'utf8')) as {
      hostKind?: unknown
      purpose?: unknown
      hardware?: unknown
    }
    expect(typeof structured.hostKind).toBe('string')
    expect(typeof structured.purpose).toBe('string')
    expect(typeof structured.hardware).toBe('object')
  }, 660_000)

  it('records the accepted decision beside the stored profile', async () => {
    const accepted = await scaffold.hostFetch('/system-analysis/accept', { method: 'POST' })
    expect(accepted.ok).toBe(true)
    expect((await readFile(join(scaffold.harnessHome, 'system-profile.decision'), 'utf8')).trim()).toBe('accepted')
  }, 60_000)

  it('persists a real settings write for the second launch', async () => {
    await scaffold.ctx.settings.update('ui-settings-general', { onboardingCompleted: '2026-09-28.1' })
    const patch = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('onboardingCompleted')
  }, 60_000)
})
