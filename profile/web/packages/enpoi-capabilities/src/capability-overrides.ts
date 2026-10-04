/**
 * dsh-enpoi-capabilities — session capability overrides.
 *
 * The effective surface is profile DEFAULTS (the orchestration document's
 * `capabilities` + per-role availability) ⊕ SESSION OVERRIDES. Editing on the
 * blank/new-session page edits the defaults; editing inside a live session
 * writes an override here. The record is durable through the session log: the
 * `capabilities/overrides` event carries the complete post-change record and
 * the `capabilityOverrides` projection folds it, so a resumed session comes
 * back with exactly the overrides it had. Only explicit overrides are stored —
 * an absent key inherits the default.
 *
 * @module dsh-enpoi-capabilities/capability-overrides
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { CapabilitiesState } from './types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable session-scoped capability override change. Carries the complete
     * post-change record; `ignorable` so a build that predates this event can
     * still read the log.
     */
    'capabilities/overrides': { skills: Record<string, boolean>; tools: Record<string, boolean>; mcp: Record<string, boolean> }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Session capability overrides (skills/tools). */
    capabilityOverrides: CapabilityOverrideRecord
  }
  interface SessionProjectionMap {
    /** Client-visible override record (the Capabilities center reads it). */
    capabilityOverrides: CapabilityOverrideRecord
  }
}

/** The kinds a session may override. */
export type CapabilityOverrideKind = 'skills' | 'tools' | 'mcp'

/** One session's explicit overrides; an absent key inherits the default. */
export interface CapabilityOverrideRecord {
  readonly skills: Readonly<Record<string, boolean>>
  readonly tools: Readonly<Record<string, boolean>>
  readonly mcp: Readonly<Record<string, boolean>>
}

/** The empty record (everything inherits). */
export const EMPTY_CAPABILITY_OVERRIDES: CapabilityOverrideRecord = { skills: {}, tools: {}, mcp: {} }

const capabilityOverridesSchema: z.ZodType<CapabilityOverrideRecord> = z.object({
  skills: z.record(z.string(), z.boolean()),
  tools: z.record(z.string(), z.boolean()),
  mcp: z.record(z.string(), z.boolean()),
})

/**
 * Fold one committed session event into the override record.
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference when the event is not ours).
 */
export function applyCapabilityOverridesProjection(
  state: CapabilityOverrideRecord,
  event: SessionEvent,
): CapabilityOverrideRecord {
  if (event.type !== 'capabilities/overrides') return state
  return { skills: { ...event.data.skills }, tools: { ...event.data.tools }, mcp: { ...event.data.mcp } }
}

/** The `capabilityOverrides` projection unit registered by the plugin. */
export const capabilityOverridesProjection: ProjectionDefinition<'capabilityOverrides', CapabilityOverrideRecord> = {
  key: 'capabilityOverrides',
  // The profile's zod instance differs from the harness's; the projection
  // registry validates with its own copy, so the schema crosses as-is.
  stateSchema: capabilityOverridesSchema as never,
  init: () => EMPTY_CAPABILITY_OVERRIDES,
  apply: applyCapabilityOverridesProjection,
  // Client-visible: the Capabilities center renders the override markers.
  wire: { viewSchema: capabilityOverridesSchema as never, view: state => state },
  stateVersion: 1,
}

/** Session-event name appended when the override record changes. */
export const CAPABILITY_OVERRIDES_EVENT = 'capabilities/overrides'

/**
 * Apply one override edit to a record.
 * @param record - the current record.
 * @param kind - the capability family.
 * @param id - the capability id.
 * @param value - the override value, or null to reset to the default.
 * @returns the next record (a fresh object).
 */
export function withCapabilityOverride(
  record: CapabilityOverrideRecord,
  kind: CapabilityOverrideKind,
  id: string,
  value: boolean | null,
): CapabilityOverrideRecord {
  const family: Record<string, boolean> = { ...record[kind] }
  if (value === null) delete family[id]
  else family[id] = value
  return {
    skills: kind === 'skills' ? family : { ...record.skills },
    tools: kind === 'tools' ? family : { ...record.tools },
    mcp: kind === 'mcp' ? family : { ...record.mcp },
  }
}

/**
 * The effective value of one capability: the override when present, the
 * default otherwise.
 * @param kind - the capability family.
 * @param id - the capability id.
 * @param defaults - the profile defaults for that family.
 * @param overrides - the session's override record.
 * @returns the effective value, or undefined when neither layer names it.
 */
export function effectiveCapability(
  kind: CapabilityOverrideKind,
  id: string,
  defaults: Readonly<Record<string, boolean>>,
  overrides: CapabilityOverrideRecord,
): boolean | undefined {
  const override = overrides[kind][id]
  return override !== undefined ? override : defaults[id]
}

/**
 * The effective capabilities state for one session: defaults ⊕ overrides.
 * @param defaults - the profile defaults.
 * @param overrides - the session's override record.
 * @returns a fresh state with the overrides applied.
 */
export function effectiveCapabilitiesState(
  defaults: CapabilitiesState,
  overrides: CapabilityOverrideRecord,
): CapabilitiesState {
  return {
    tools: { ...defaults.tools, ...overrides.tools },
    skills: { ...defaults.skills, ...overrides.skills },
    mcp: { ...defaults.mcp, ...overrides.mcp },
  }
}
