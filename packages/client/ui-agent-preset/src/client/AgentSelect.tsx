/**
 * Input-card agent picker (Enpoi Harness).
 *
 * Shows the CURRENT session's agent preset (e.g. "Orchestrator") and opens a
 * menu of the deployment's user presets. Picking one switches the session
 * mid-flight (the host allows idle-session recomposition). The seat store
 * feeds both the roster and the session's live preset; `select()` stages and
 * applies through the same controller the hero chip uses.
 *
 * At phone widths the roster presents as a bottom sheet (search-free — the
 * preset list is short); desktop keeps the anchored menu.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconAgentPresetOutlineMedium, IconCheckOutlineMedium, IconChevronDownOutlineRegular, Menu, Sheet, useSheetPresentation,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentPresetSeatState } from './seat-store.ts'
import { presetDisplayText } from './locales.ts'
import css from './AgentSelect.module.css'

/** Full component props. */
export type AgentSelectProps =
  PropsRuntime<'conversation.input.agent'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentSelectInjected>

/** Injected face: the shared seat store + the select write path. */
export interface AgentSelectInjected {
  hooks: { agentPresetSeat: SnapshotStore<AgentPresetSeatState> }
  load: () => Promise<void>
  select: (id: string) => Promise<void>
}

/** The slot-declared inject face (store typed structurally). */
export type AgentSelectSlotInjected = import('@deepseek-ai/dsh-client-ui-conversation/client').AgentPresetSeatInjected

/**
 * Render the input-card agent picker.
 * @param props - composed slot props.
 * @returns the picker, or null when the deployment composes no presets.
 */
export function AgentSelect({ load, select, useAgentPresetSeat, t }: AgentSelectProps) {
  const state = useAgentPresetSeat(snapshot => snapshot) as AgentPresetSeatState
  const sheetMode = useSheetPresentation()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  // The session's live preset (fall back to the staged/default choice).
  const live = state.sessionPreset !== '' ? state.sessionPreset : state.current
  const chosen = state.options.find(option => option.id === live)
  const label = chosen === undefined ? undefined : presetDisplayText(chosen, t)
  const ready = state.options.length > 0 && live !== ''

  if (!ready) return null

  const options = state.options.map((option) => {
    const text = presetDisplayText(option, t)
    return {
      id: option.id,
      name: text.name,
      description: text.description ?? t('noDescription'),
      selected: option.id === live,
    }
  })

  const trigger = (
    <button
      type="button"
      className={css.trigger}
      aria-haspopup={sheetMode ? 'dialog' : 'menu'}
      aria-expanded={open}
      title={state.error ?? t('seatHint')}
      disabled={state.busy}
      data-agent-trigger
      onClick={() => { setOpen(value => !value) }}
    >
      <IconAgentPresetOutlineMedium className={css.triggerIcon} />
      <span className={css.triggerLabel}>{label?.name ?? live}</span>
      <IconChevronDownOutlineRegular className={css.chevron} />
    </button>
  )

  const pick = (id: string): void => {
    setOpen(false)
    if (id === live) return
    void select(id)
  }

  if (sheetMode) {
    return (
      <>
        {trigger}
        <Sheet
          open={open}
          onClose={() => { setOpen(false) }}
          title={t('nav')}
          closeLabel={t('close')}
          surfaceId="ui-agent-preset:picker"
          contentClassName={css.sheetContent ?? ''}
        >
          <div className={css.sheetList} role="listbox" aria-label={t('nav')}>
            {options.map(option => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.selected}
                className={option.selected ? `${css.sheetRow} ${css.sheetRowActive}` : css.sheetRow}
                onClick={() => { pick(option.id) }}
              >
                <span className={css.item}>
                  <span className={css.itemName}>{option.name}</span>
                  <span className={css.itemDesc}>{option.description}</span>
                </span>
                {option.selected && <IconCheckOutlineMedium className={css.check} />}
              </button>
            ))}
          </div>
        </Sheet>
      </>
    )
  }

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={options.map(option => ({
        id: option.id,
        label: (
          <span className={css.item}>
            <span className={css.itemName}>{option.name}</span>
            <span className={css.itemDesc}>{option.description}</span>
          </span>
        ),
      }))}
      selectedId={live}
      onSelect={pick}
      align="start"
      portal
      anchor={trigger}
    />
  )
}
