/**
 * Kilo baseline parity: the wizard's free route and the deletion cleanup's
 * reset route (`route-references.ts` consumes WIZARD_FREE_*) are deliberate
 * client copies of the host `agent-default-model` baseline. Strict equality
 * keeps a rename on either side from drifting silently.
 */
import { expect, it } from 'vitest'
import { BASELINE_MODEL, BASELINE_PROVIDER } from '@deepseek-ai/dsh-agent-default-model'
import { WIZARD_FREE_MODEL, WIZARD_FREE_PROVIDER } from '../src/client/welcome-wizard.ts'

it('the client Kilo defaults equal the host agent-default-model baseline', () => {
  expect(WIZARD_FREE_PROVIDER).toBe(BASELINE_PROVIDER)
  expect(WIZARD_FREE_MODEL).toBe(BASELINE_MODEL)
})
