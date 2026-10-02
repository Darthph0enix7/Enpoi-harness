/**
 * Parity guard for the generated permissions mirror.
 *
 * The client cannot runtime-import the host policy resolver (a different
 * repository/profile package), so the shipped defaults are mirrored into
 * `src/client/permissions-defaults.generated.ts` and this spec fails whenever
 * that mirror drifts from the sources it was generated from:
 *
 *   - host policy defaults/exemptions (`$DSH_HOST_POLICY_FILE` or the local
 *     profile path);
 *   - the fork's child role tables (`packages/subagent/tool-subagent`);
 *   - the shipped preset inventory
 *     (`scripts/tool-inventory/expected-orchestrator.json`).
 *
 * The host repository's `tool-defaults-completeness.spec.ts` verifies the
 * embedded `HOST_DEFAULTS_DIGEST` from the other side, so a host default
 * change fails there until the mirror is regenerated too.
 *
 * When the canonical host file is absent (a checkout without the deployment
 * profile), the source-derived comparisons are skipped and the committed
 * data's internal contract is asserted instead — mirroring the host
 * completeness guard's "when the canonical directory exists" posture.
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HOST_DEFAULTS_DIGEST,
  MIRROR_SOURCE_DIGEST,
  OPERATOR_SURFACE,
  ROLE_CHILD_DENY,
  SHARED_CHILD_DENY,
  SHARED_CHILD_KEEP,
  SHIPPED_TOOL_DEFAULT_EXEMPTIONS,
  SHIPPED_TOOL_DEFAULTS,
} from '../src/client/permissions-defaults.generated.ts'
import {
  BUILT_ROLE_SURFACE,
  buildPermissionToolRows,
  KEPT_BY_EVERY_ROLE,
  MAIN_AGENT_IDS,
  rowPolicyState,
  shippedPolicyFor,
} from '../src/client/permissions-model.ts'
import { buildMirrorData, buildRepoMirrorData, checkMirror, mirrorPaths } from '../scripts/generate-permissions-mirror.ts'

/** The eleven roster tools classified by the host on 2026-10-02. */
const INTEGRATED_TOOLS = [
  'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'ralph', 'workflow',
  'tool_groups', 'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager',
  'council_register',
] as const

/** The first-party on-demand peer family the host documents as exempt. */
const PEER_TOOLS = ['peer_ask', 'peer_asks', 'peer_answer', 'peer_cancel', 'peer_status'] as const

const HOST_PRESENT = existsSync(mirrorPaths().hostPolicy) && existsSync(mirrorPaths().roleSource)

describe('permissions mirror parity', () => {
  it('matches the canonical sources byte for byte when the deployment profile is present', () => {
    const result = checkMirror()
    if (result.skipped) {
      // No host profile on this machine: the committed mirror still has to be
      // internally coherent (asserted by the suites below).
      expect(existsSync(mirrorPaths().hostPolicy)).toBe(false)
      return
    }
    expect(result.ok, 'the mirror drifted from its sources — regenerate with:\n' +
      '  pnpm exec tsx packages/client/ui-brand-enpoi/scripts/generate-permissions-mirror.ts --write').toBe(true)
  })

  it('matches the harness-owned role tables and preset inventory', () => {
    const repo = buildRepoMirrorData(mirrorPaths())
    expect(SHARED_CHILD_KEEP).toEqual(repo.sharedChildKeep)
    expect(SHARED_CHILD_DENY).toEqual(repo.sharedChildDeny)
    expect(ROLE_CHILD_DENY).toEqual(repo.roleChildDeny)
    expect(OPERATOR_SURFACE).toEqual(repo.operatorSurface)
    expect(KEPT_BY_EVERY_ROLE).toEqual(repo.sharedChildKeep)
  })

  it('embeds digests of the exact payload the canonical sources produce', () => {
    if (!HOST_PRESENT) return
    const { data, hostDefaultsDigest, mirrorSourceDigest } = buildMirrorData(mirrorPaths())
    expect(HOST_DEFAULTS_DIGEST).toBe(hostDefaultsDigest)
    expect(MIRROR_SOURCE_DIGEST).toBe(mirrorSourceDigest)
    expect(SHIPPED_TOOL_DEFAULTS).toEqual(data.shippedToolDefaults)
    expect(SHIPPED_TOOL_DEFAULT_EXEMPTIONS).toEqual(data.shippedToolDefaultExemptions)
  })

  it('keeps the exemption list documented and non-overlapping with explicit rows', () => {
    expect(SHIPPED_TOOL_DEFAULT_EXEMPTIONS.map(entry => entry.prefix)).toEqual(
      expect.arrayContaining(['custom_', 'mcp__', 'peer_']),
    )
    for (const exemption of SHIPPED_TOOL_DEFAULT_EXEMPTIONS) {
      expect(exemption.prefix.length, 'exemption prefix must be non-empty').toBeGreaterThan(0)
      expect(exemption.reason.length, `exemption ${exemption.prefix} needs a reason`).toBeGreaterThan(20)
      const explicit = Object.keys(SHIPPED_TOOL_DEFAULTS).filter(tool => tool.startsWith(exemption.prefix))
      expect(explicit, `an explicit row inside exempted family ${exemption.prefix} is dead code`).toEqual([])
    }
  })
})

describe('shipped defaults drive the client decision', () => {
  it('reads job_kill as ask, the host decision, instead of the stale allow', () => {
    expect(SHIPPED_TOOL_DEFAULTS.job_kill).toBe('ask')
    expect(shippedPolicyFor('job_kill')).toBe('ask')
  })

  it('classifies the eleven roster tools with the host decisions', () => {
    const allow = INTEGRATED_TOOLS.filter(tool => shippedPolicyFor(tool) === 'allow')
    expect([...allow].sort()).toEqual(
      [...INTEGRATED_TOOLS].filter(tool => tool !== 'council_register').sort(),
    )
    expect(shippedPolicyFor('council_register')).toBe('ask')
    for (const tool of INTEGRATED_TOOLS) {
      expect(Object.hasOwn(SHIPPED_TOOL_DEFAULTS, tool), `${tool} has no shipped row`).toBe(true)
    }
  })

  it('accounts for the first-party on-demand peer tools through the documented family exemption', () => {
    for (const tool of PEER_TOOLS) {
      expect(Object.hasOwn(SHIPPED_TOOL_DEFAULTS, tool), `${tool} must not carry a hand row`).toBe(false)
      expect(shippedPolicyFor(tool), `${tool} falls through to the ask default`).toBeUndefined()
    }
  })

  it('shows the asking council register as its own row, not behind the allow-classified Council family', () => {
    const rows = buildPermissionToolRows(undefined, [], ['council_list', 'council_register'])
    const family = rows.find(row => row.id === 'council_*')!
    expect(family.members).toEqual(['council_list'])
    const register = rows.find(row => row.id === 'council_register')!
    expect(register.kind).toBe('tool')
    const state = rowPolicyState({}, undefined, register)
    expect(state.effective).toBe('ask')
    expect(state.provenance).toBe('inherit (default)')
  })
})

describe('role-surface mirror', () => {
  it('takes the operator surface from the host preset inventory', () => {
    expect(BUILT_ROLE_SURFACE.orchestrator).toBe(OPERATOR_SURFACE)
    expect(BUILT_ROLE_SURFACE.sysadmin).toBe(OPERATOR_SURFACE)
    expect(BUILT_ROLE_SURFACE.creator).toBe(OPERATOR_SURFACE)
    for (const tool of INTEGRATED_TOOLS) {
      expect(OPERATOR_SURFACE, `${tool} missing from the operator surface`).toContain(tool)
    }
  })

  it('derives the whiteboard keep list from the host table', () => {
    expect(KEPT_BY_EVERY_ROLE).toEqual(SHARED_CHILD_KEEP)
    expect(SHARED_CHILD_KEEP.length).toBeGreaterThan(0)
  })

  it('never surfaces a tool the host hard-denies for a child role', () => {
    for (const [role, surface] of Object.entries(BUILT_ROLE_SURFACE)) {
      if (MAIN_AGENT_IDS.includes(role)) continue
      const denied = new Set([
        ...SHARED_CHILD_DENY.filter(name => !(role === 'oracle' && name === 'subagent')),
        ...(ROLE_CHILD_DENY[role] ?? []),
      ].filter(name => !SHARED_CHILD_KEEP.includes(name)))
      const promised = surface.filter(name => denied.has(name))
      expect(promised, `${role} surfaces host-denied tools`).toEqual([])
    }
  })
})
