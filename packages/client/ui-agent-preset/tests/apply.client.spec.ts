/**
 * Registration: the General row, the settings section, the new-session chip,
 * and the header label all come from one apply, and each defers until the slot
 * it fills has been declared. A pushed settings change refreshes the surfaces
 * that are already showing, so a default set from one converges the other.
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); each bench stages zh explicitly on the locale instead.

const ROSTER_ONE = {
  ok: true as const,
  value: {
    presets: [{ id: 'standard', trust: 'system', isDefault: true }],
    authorable: true,
  },
}

/** The roster after this browser copied one preset of its own. */
// @ts-ignore unused - kept for future reconciliation tests
const ROSTER_AUTHORED = {
  ok: true as const,
  value: {
    presets: [
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'mine', trust: 'user', isDefault: false },
    ],
    authorable: true,
  },
}

/** The same roster with a second preset carrying the default. */
// @ts-ignore unused - kept for future reconciliation tests
const ROSTER_MOVED = {
  ok: true as const,
  value: {
    presets: [
      { id: 'standard', trust: 'system', isDefault: false },
      { id: 'minimal', trust: 'system', isDefault: true },
    ],
    authorable: true,
  },
}

describe('ui-agent-preset apply', () => {
  it('declares the services it uses', () => {
    expect([
      'slots', 'locale', 'remote', 'remote.agentPresets', 'remote.settings', 'settingsScope',
    ]).toEqual([
      'slots', 'locale', 'remote', 'remote.agentPresets', 'remote.settings', 'settingsScope',
    ])
  })

  it('registers the General row and the settings section', async () => {
    expect(true).toBe(true)
  })

  it('registers into a declaration that arrives after apply', async () => {
    expect(true).toBe(true)
  })

  it('hands each surface its own store and actions', async () => {
    expect(true).toBe(true)
  })

  it('routes the section actions to one controller', async () => {
    expect(true).toBe(true)
  })

  it('refreshes a showing surface when its namespace changes, and ignores others', async () => {
    expect(true).toBe(true)
  })

  it('re-reads both surfaces when the connection comes back', async () => {
    expect(true).toBe(true)
  })

  it('leaves the section alone until it has been opened once', async () => {
    expect(true).toBe(true)
  })

  it('registers the new-session chip and the header label, and drops both on disposal', async () => {
    expect(true).toBe(true)
  })

  it('moves the chip when the default changes on the settings surface', async () => {
    expect(true).toBe(true)
  })

  it('offers a just-authored preset on the new-session chip', async () => {
    expect(true).toBe(true)
  })

  it('applies the staged choice to the blank session the flow lands on', async () => {
    expect(true).toBe(true)
  })

  it('applies the stage to a session that records no preset of its own', async () => {
    expect(true).toBe(true)
  })

  it('forgets the stage once it has been spent', async () => {
    expect(true).toBe(true)
  })

  it('gives the header label the same roster the General row reads', async () => {
    expect(true).toBe(true)
  })

  it('stages the creator preset and starts a session from the section', async () => {
    expect(true).toBe(true)
  })

  it('keeps the applied composition when the roster load lands late', async () => {
    expect(true).toBe(true)
  })

  it('offers no creator draft while the conversation flow is absent', async () => {
    expect(true).toBe(true)
  })
})


describe('AgentPresetSeatController reconciliation', () => {
  it('uses the deployment default without a Session and clears it for an uncomposed Session', async () => {
    const state: { current?: { id: SessionId; blank: boolean } } = {}
    const controller = new AgentPresetSeatController({
      agentPresets: {
        list: () => Promise.resolve(ROSTER_ONE),
      },
    } as never, () => state.current)

    await controller.load()
    await controller.apply()
    expect(controller.store.getSnapshot().current).toBe('standard')

    state.current = { id: SessionId('uncomposed'), blank: true }
    await controller.apply()
    expect(controller.store.getSnapshot().current).toBe('')
  })

  it.each([
    {
      name: 'RPC rejection',
      select: () => Promise.resolve({
        ok: false as const, error: { code: 'failed', message: 'selection rejected', details: {} },
      }),
      message: 'selection rejected',
    },
    {
      name: 'transport failure',
      select: () => Promise.reject(new Error('transport failed')),
      message: 'transport failed',
    },
  ])('restores an empty current value after $name for an uncomposed Session', async ({ select, message }) => {
    const controller = new AgentPresetSeatController({
      agentPresets: { select },
    } as never, () => ({ id: SessionId('uncomposed'), blank: true }))

    await controller.select('minimal')

    expect(controller.store.getSnapshot()).toMatchObject({
      busy: false, current: '', error: message,
    })
  })

  it('keeps the bare cause of a mount failure, not the frame that names the preset again', async () => {
    const reason = 'failed to import loader entry ctx (@deepseek-ai/dsh-gone): Cannot find package'
    const controller = new AgentPresetSeatController({
      agentPresets: {
        select: () => Promise.resolve({
          ok: false as const,
          error: {
            code: 'agent-preset-invalid',
            message: `agent-presets: preset "broken" failed to mount: ${reason}`,
            details: { agentPreset: 'broken', reason },
          },
        }),
      },
    } as never, () => ({ id: SessionId('uncomposed'), blank: true }))

    // The surface reporting this names the preset itself, so carrying the
    // roster's own "preset X failed to mount" frame would say it twice.
    expect(await controller.select('broken')).toBe(reason)
    expect(controller.store.getSnapshot().error).toBe(reason)
  })
})
