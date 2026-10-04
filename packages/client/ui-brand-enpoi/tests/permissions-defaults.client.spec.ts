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
  SHIPPED_SEAT_TOOL_DENY,
  SHIPPED_TOOL_DEFAULT_EXEMPTIONS,
  SHIPPED_TOOL_DEFAULTS,
  SHIPPED_TOOL_GROUP_CATALOG,
} from '../src/client/permissions-defaults.generated.ts'
import {
  BUILT_ROLE_SURFACE,
  buildPermissionToolRows,
  KEPT_BY_EVERY_ROLE,
  MAIN_AGENT_IDS,
  POLICY_FAMILIES,
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

/** The tools the creator tool group presents to the creator seat alone. */
const CREATOR_ONLY: readonly string[] = ['cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager']

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
    expect(SHIPPED_TOOL_GROUP_CATALOG).toEqual(data.toolGroups)
    expect(SHIPPED_SEAT_TOOL_DENY).toEqual(data.seatToolDeny)
  })

  it('keeps the exemption list documented and non-overlapping with explicit rows', () => {
    expect(SHIPPED_TOOL_DEFAULT_EXEMPTIONS.map(entry => entry.prefix)).toEqual(
      expect.arrayContaining(['custom_', 'mcp__', 'peer_']),
    )
    for (const exemption of SHIPPED_TOOL_DEFAULT_EXEMPTIONS) {
      expect(exemption.prefix.length, 'exemption prefix must be non-empty').toBeGreaterThan(0)
      expect(exemption.reason.length, `exemption ${exemption.prefix} needs a reason`).toBeGreaterThan(20)
      const explicit = Object.keys(SHIPPED_TOOL_DEFAULTS).filter(tool =>
        tool.startsWith(exemption.prefix) && !(exemption.except ?? []).includes(tool))
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

  it('shows the asking council register as its own row, not behind the allow-classified Councils family', () => {
    const rows = buildPermissionToolRows(undefined, [], ['council_list', 'council_register'])
    const family = rows.find(row => row.id === 'councils_*')!
    expect(family.members).toEqual(['chorus', 'council_list', 'oracle_review', 'request_evidence', 'roundtable'])
    const register = rows.find(row => row.id === 'council_register')!
    expect(register.kind).toBe('tool')
    const state = rowPolicyState({}, undefined, register)
    expect(state.effective).toBe('ask')
    expect(state.provenance).toBe('inherit (default)')
  })
})

describe('role-surface mirror', () => {
  it('takes the shared operator surface from the host preset inventory', () => {
    // The generated inventory is the orchestrator's advertised surface: the
    // shared main-agent block WITHOUT the creator tool group.
    expect(BUILT_ROLE_SURFACE.orchestrator).toEqual(OPERATOR_SURFACE)
    expect(BUILT_ROLE_SURFACE.sysadmin).toEqual(OPERATOR_SURFACE)
    for (const tool of INTEGRATED_TOOLS) {
      if (CREATOR_ONLY.includes(tool)) continue
      expect(OPERATOR_SURFACE, `${tool} missing from the shared operator surface`).toContain(tool)
    }
    for (const tool of CREATOR_ONLY) {
      expect(OPERATOR_SURFACE, `${tool} leaked into the shared operator surface`).not.toContain(tool)
    }
  })

  it('extends the creator seat with the creator tool group and keeps the seat deny absent from every seat', () => {
    // The creator-only group pre-attaches to the creator alone: the creator
    // surface is the shared inventory plus the three harness-authoring tools.
    for (const tool of CREATOR_ONLY) {
      expect(BUILT_ROLE_SURFACE.creator, `${tool} missing from the creator surface`).toContain(tool)
      expect(BUILT_ROLE_SURFACE.orchestrator).not.toContain(tool)
      expect(BUILT_ROLE_SURFACE.sysadmin).not.toContain(tool)
    }
    expect(BUILT_ROLE_SURFACE.creator).toHaveLength(OPERATOR_SURFACE.length + CREATOR_ONLY.length)
    // The seat guard is the execution backstop; a shipped surface never names
    // a tool its own seat denies.
    for (const [seat, denied] of Object.entries(SHIPPED_SEAT_TOOL_DENY)) {
      for (const tool of denied) {
        expect(BUILT_ROLE_SURFACE[seat], `${seat} surfaces its own denied ${tool}`).not.toContain(tool)
      }
    }
  })

  it('derives the policy families from the shipped tool-group catalog', () => {
    const groups = new Map(SHIPPED_TOOL_GROUP_CATALOG.map(group => [group.id, group]))
    for (const family of POLICY_FAMILIES) {
      const group = groups.get(family.id.replace(/_?\*$/, ''))
      expect(group, `${family.id} names no catalog group`).toBeDefined()
      expect(family.name).toBe(group?.label)
      for (const member of family.members) {
        expect(group?.members, `${family.id} member ${member} is not in ${group?.id}`).toContain(member)
        for (const other of family.members) {
          expect(shippedPolicyFor(other) ?? 'ask', `${family.id} folds mixed policies`).toBe(shippedPolicyFor(member) ?? 'ask')
        }
      }
      for (const excluded of family.exclude ?? []) {
        expect(group?.members, `${family.id} excludes an outside tool ${excluded}`).toContain(excluded)
        expect(family.members).not.toContain(excluded)
      }
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
        ...SHARED_CHILD_DENY.filter(name => !((role === 'oracle' || role === 'librarian') && name === 'subagent')),
        ...(ROLE_CHILD_DENY[role] ?? []),
      ].filter(name => !SHARED_CHILD_KEEP.includes(name)))
      const promised = surface.filter(name => denied.has(name))
      expect(promised, `${role} surfaces host-denied tools`).toEqual([])
    }
  })

  it('never surfaces a tool the creator-only seat guard refuses to a child parent', () => {
    // A delegated child carries its parent's preset, so every main seat is a
    // possible execution role for every child surface. The seat guard is the
    // refusal source the child tables must not fight: orchestrator and sysadmin
    // deny the harness-authoring trio to their children.
    const parentSeats = Object.keys(SHIPPED_SEAT_TOOL_DENY)
    for (const [role, surface] of Object.entries(BUILT_ROLE_SURFACE)) {
      const seats = MAIN_AGENT_IDS.includes(role) ? [role] : parentSeats
      for (const seat of seats) {
        const denied = SHIPPED_SEAT_TOOL_DENY[seat] ?? []
        const promised = surface.filter(name => denied.includes(name))
        expect(promised, `${role} surfaces tools seat ${seat} refuses`).toEqual([])
      }
    }
  })

  it('never surfaces review_run outside the reviewer seats', () => {
    // `review_run` is allow for the reviewer/oracle seats and a named deny for
    // every other role (host `REVIEW_ROLES` in
    // `profiles/web/packages/enpoi-capabilities/src/policy.ts`). The shipped
    // surfaces stay conservative: no role fixture carries it today, and a
    // non-reviewer fixture that ever adds it fails here.
    const reviewerRoles = new Set(['oracle', 'reviewer', 'critic', 'referee', 'chair', 'skeptic', 'architect', 'pragmatist'])
    for (const [role, surface] of Object.entries(BUILT_ROLE_SURFACE)) {
      if (reviewerRoles.has(role)) continue
      expect(surface, `${role} surfaces reviewer-exec`).not.toContain('review_run')
    }
  })

  it('never surfaces a member of a seat-restricted tool group to another seat', () => {
    // The creator group is the only `seats`-restricted family: its three tools
    // are the creator's own surface and stay absent from every other role.
    for (const [role, surface] of Object.entries(BUILT_ROLE_SURFACE)) {
      for (const group of SHIPPED_TOOL_GROUP_CATALOG) {
        if (group.seats === undefined || group.seats.includes(role)) continue
        const promised = surface.filter(name => group.members.includes(name))
        expect(promised, `${role} surfaces ${group.id}-restricted tools`).toEqual([])
      }
    }
  })
})
