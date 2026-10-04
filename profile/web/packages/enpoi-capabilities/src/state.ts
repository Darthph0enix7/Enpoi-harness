/**
 * enpoi-capabilities — Global capability state resolution.
 *
 * Enforces Invariant I15: Protected infrastructure capabilities (contracts, keeper, cascade, living-brief, read, glob, grep)
 * cannot be disabled by operator toggles.
 */

import type { CapabilitiesState } from './types'
import { KNOWN_CAPABILITIES, PROTECTED_CAPABILITIES } from './types'

export function initialCapabilitiesState(globalDefaults?: Partial<CapabilitiesState>): CapabilitiesState {
  const tools: Record<string, boolean> = {}
  const skills: Record<string, boolean> = {}
  const mcp: Record<string, boolean> = {}

  for (const cap of KNOWN_CAPABILITIES) {
    if (cap.kind === 'tool') tools[cap.id] = cap.defaultEnabled
    if (cap.kind === 'skill') skills[cap.id] = cap.defaultEnabled
    if (cap.kind === 'mcp') mcp[cap.id] = cap.defaultEnabled
  }

  // Merge global overrides from settings.yaml
  if (globalDefaults?.tools) Object.assign(tools, globalDefaults.tools)
  if (globalDefaults?.skills) Object.assign(skills, globalDefaults.skills)
  if (globalDefaults?.mcp) Object.assign(mcp, globalDefaults.mcp)

  // Enforce Invariant I15: Protected capabilities always true
  for (const p of PROTECTED_CAPABILITIES) {
    tools[p] = true
  }

  return { tools, skills, mcp }
}
