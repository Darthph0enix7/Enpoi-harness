/**
 * Settings-page capability catalog — the operator vocabulary the Settings →
 * Dynamic panels author from.
 *
 * The Capabilities drawer reads only this list's supervision tool entries
 * (`kind: 'tool'`, `category: 'supervision'`), which are listed unconditionally
 * because no host registry enumerates the core tool names. Every other drawer
 * row comes from a live host source (skills.list, enpoiRoles.list,
 * enpoiCouncil.list, the stored mcpServers/capabilities records). This module
 * exists so the settings page has stable labels/descriptions for the shipped
 * tools and skills it lets the operator pre-seed; new live entries still appear
 * in the drawer and the settings panel without a code change.
 *
 * No MCP descriptor ships here: every MCP row is owned by the settings
 * document (`enpoi-orchestration.mcpServers`). A descriptor with no stored
 * record would be a phantom row the operator cannot delete — and a device's
 * server (plane-mcp on one host, UE on another) would appear on every install.
 */

/** Capability family the enforcement state keys on. */
export type CapabilityKind = 'tool' | 'skill' | 'mcp'

/** One catalog entry shown by the Settings → Dynamic panels. */
export interface CapabilityDescriptor {
  id: string
  name: string
  kind: CapabilityKind
  description: string
  category: 'mcp' | 'skills' | 'supervision' | 'council' | 'workers' | 'core-tools'
  defaultEnabled: boolean
  protected?: boolean
}

/** Invariant I15: infrastructure capabilities an operator toggle cannot disable. */
export const PROTECTED_CAPABILITIES = new Set<string>([
  'enpoi-contracts',
  'enpoi-context-keeper',
  'enpoi-cascade',
  'enpoi-living-brief',
  'read',
  'glob',
  'grep',
])

/** Shipped catalog descriptors for the settings panels (never read by the drawer). */
export const KNOWN_CAPABILITIES: readonly CapabilityDescriptor[] = [
  // MCP rows are settings-owned (`enpoi-orchestration.mcpServers`); no
  // descriptor here may fabricate one, so a row always has a stored record
  // the settings page can delete.

  // Skills (Default ON)
  { id: 'project-management', name: 'Project Management', kind: 'skill', category: 'skills', description: 'Plane documentation and progress journaling', defaultEnabled: true },
  { id: 'ue-mcp', name: 'UE5 Automation Skill', kind: 'skill', category: 'skills', description: 'Unreal Engine 5 MCP workflows', defaultEnabled: true },
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
