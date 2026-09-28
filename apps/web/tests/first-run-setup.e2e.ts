// Live first-run proof against a TEMP $DSH_HOME (never the developer's home):
// the booted real composition must seed the keyless Kilo route into the temp
// settings document, the background analysis must land the sysadmin context,
// and a real settings write must persist for the next launch. The browser
// wizard UI itself needs a client bundle build, so this lane proves the host
// half end to end.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

describe('first-run setup live proof', () => {
  let scaffold: WebScaffold

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
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

  it('runs the read-only analysis in the background and lands the sysadmin context', async () => {
    const started = await scaffold.hostFetch('/system-analysis/start', { method: 'POST' })
    expect(started.ok).toBe(true)
    let job = (await started.json() as { job: { state: string; pct: number } }).job
    for (let attempt = 0; attempt < 80 && job.state === 'running'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 250))
      job = (await (await scaffold.hostFetch('/system-analysis/status')).json() as { job: { state: string; pct: number } }).job
    }
    expect(job.state).toBe('succeeded')
    const context = await readFile(join(scaffold.harnessHome, 'system-context.md'), 'utf8')
    expect(context).toContain('# System context')
    expect(context).toContain('## Hardware')
  }, 60_000)

  it('persists a real settings write for the second launch', async () => {
    await scaffold.ctx.settings.update('ui-settings-general', { onboardingCompleted: '2026-09-28.1' })
    const patch = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('onboardingCompleted')
  }, 60_000)
})
