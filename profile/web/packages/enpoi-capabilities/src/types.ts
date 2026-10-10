/**
 * enpoi-capabilities — Domain types, event shapes, and invariants.
 *
 * Invariants:
 * - B1: Execution-level enforcement via pre-dispatch waterfall.
 * - B2: Model-visible ⟺ logged (session overrides fold deterministically).
 * - B3: Persona bytes frozen; runtime-context snapshot reflects active/disabled state.
 * - I15: Protected infrastructure (contracts, keeper, cascade, living-brief) cannot be disabled.
 */

export type CapabilityKind = 'tool' | 'skill' | 'mcp'

export interface CapabilityToggleEventData {
  kind: CapabilityKind
  id: string
  enabled: boolean
  reason?: string
}

export interface CapabilitiesState {
  tools: Record<string, boolean>
  skills: Record<string, boolean>
  mcp: Record<string, boolean>
}

/** Invariant I15: Infrastructure capabilities that CANNOT be disabled by operator toggles. */
export const PROTECTED_CAPABILITIES = new Set<string>([
  'enpoi-contracts',
  'enpoi-context-keeper',
  'enpoi-cascade',
  'enpoi-living-brief',
  'read',
  'glob',
  'grep',
])

/** Known capability descriptors for display and defaults. */
export interface CapabilityDescriptor {
  id: string
  name: string
  kind: CapabilityKind
  description: string
  category: 'mcp' | 'skills' | 'supervision' | 'council' | 'workers' | 'core-tools'
  defaultEnabled: boolean
  protected?: boolean
}

export const KNOWN_CAPABILITIES: readonly CapabilityDescriptor[] = [
  // No MCP descriptors: MCP rows are settings-owned
  // (`enpoi-orchestration.mcpServers`); a descriptor here would seed a phantom
  // entry on every device, and a device-specific server (plane-mcp on one
  // host, UE MCP on another) must never ship as a default.

  // Skills (Default ON)
  { id: 'tier1-workflow', name: 'Tier 1 Guided Workflow', kind: 'skill', category: 'skills', description: 'Guided planning with Oracle supervision', defaultEnabled: true },
  { id: 'tier2-workflow', name: 'Tier 2 Ideation Workflow', kind: 'skill', category: 'skills', description: 'Ideation and Roundtable debate planning', defaultEnabled: true },
  { id: 'tier3-workflow', name: 'Tier 3 Full Workflow', kind: 'skill', category: 'skills', description: 'Complex implementation with continuous supervision', defaultEnabled: true },

  // Subagents & Higher-Order Tools (Default ON)
  { id: 'oracle_review', name: 'The Oracle (Supervisor)', kind: 'tool', category: 'supervision', description: 'Senior supervisor for architectural reviews and plan verification', defaultEnabled: true },
  { id: 'roundtable', name: 'Roundtable Debate', kind: 'tool', category: 'council', description: 'Colosseum dialectic 3-way debate across Skeptic, Architect & Pragmatist', defaultEnabled: true },
  { id: 'chorus', name: 'Chorus Brainstorm', kind: 'tool', category: 'council', description: 'Polyphonic brainstorming across Visionary, Experiencer & Integrator', defaultEnabled: true },
  { id: 'fixer', name: 'Fixer Worker', kind: 'tool', category: 'workers', description: 'Bounded code implementation and localized bug detection', defaultEnabled: true },
  { id: 'explorer', name: 'Explorer Worker', kind: 'tool', category: 'workers', description: 'Codebase mapping and structural pattern discovery', defaultEnabled: true },
  { id: 'librarian', name: 'Librarian Worker', kind: 'tool', category: 'workers', description: 'External documentation research and web fetching', defaultEnabled: true },
  { id: 'designer', name: 'Designer Worker', kind: 'tool', category: 'workers', description: 'UI/UX design systems, layout, and visual polish', defaultEnabled: true },

  // Core System Tools (Default ON)
  { id: 'edit', name: 'File Editor', kind: 'tool', category: 'core-tools', description: 'Direct filesystem edits and string replacements', defaultEnabled: true },
  { id: 'write', name: 'File Writer', kind: 'tool', category: 'core-tools', description: 'File creation and overwrite capabilities', defaultEnabled: true },
  { id: 'bash', name: 'Bash Terminal', kind: 'tool', category: 'core-tools', description: 'Terminal command execution in persistent session', defaultEnabled: true },
  { id: 'memory_save', name: 'Memory Save', kind: 'tool', category: 'core-tools', description: 'Store durable facts into CBDC memory.db', defaultEnabled: true },
  { id: 'memory_search', name: 'Memory Search', kind: 'tool', category: 'core-tools', description: 'Semantic recall across SQLite memory.db', defaultEnabled: true },
] as const
