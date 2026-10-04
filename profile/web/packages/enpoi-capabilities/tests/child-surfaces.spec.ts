/**
 * Child-surface guard: every child role's effective catalog must be disjoint
 * from every execution-time refusal source.
 *
 * The operator principle (2026-10-02, the main-agent seat-hidden tools): a tool
 * that would be refused at execution must not exist in the model's catalog.
 * The main seats get that from the creator tool group plus the seat guard; this
 * spec extends the discipline to every child role and fails when a future tool
 * joins the registry without a role table naming it:
 *
 *   - generic delegation roles (fixer/explorer/librarian/designer) — the
 *     shared floor in `tool-subagent` plus the role deny map;
 *   - the Oracle review child — `ORACLE_TOOL_FILTER` in `enpoi-oracle`;
 *   - evidence research children — `EVIDENCE_CHILD_DENY` in `enpoi-oracle`;
 *   - council seats (roundtable debaters/referee/chair, chorus
 *     debaters/curator, broker) — the council deny tables in
 *     `enpoi-council/core/fiber.ts`.
 *
 * The refusal sources cross-checked here:
 *   1. the creator-only seat guard (`SHIPPED_SEAT_TOOL_DENY` — a child carries
 *      its parent's preset, so the guard resolves the parent seat);
 *   2. the policy resolver's hard denies (the `review_run` reviewer gate);
 *   3. tool-group-only tools (on-demand members not attached for the child's
 *      seat) — the group filter is part of the composed surface, so the guard
 *      checks the composition applies it and no refused member survives;
 *   4. capability-disabled and MCP-world filters — both strip the schema in
 *      the assemble pass, so no shipped fixture can leak them (no shipped tool
 *      is disabled and no fixture carries an MCP row).
 *
 * The keeper has no child catalog: it is a service making direct model
 * requests, never a subagent spawn.
 */

import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHARED_CHILD_DENY, SHARED_CHILD_KEEP, listRoleRegistry } from '@deepseek-ai/dsh-tool-subagent/src/index.ts'
import {
  denyNames, preAttachFor, resolveToolGroups, seatOfDescriptorLabel,
  SHIPPED_TOOL_GROUPS,
} from '../../enpoi-tool-groups/src/catalog.ts'
import {
  BROKER_KEPT_TOOLS, COUNCIL_DENIED_TOOLS, COUNCIL_KEPT_TOOLS, DEBATER_DENIED_TOOLS,
} from '../../enpoi-council/src/core/fiber.ts'
import { CHORUS_SPEC } from '../../enpoi-council/src/profiles/chorus.ts'
import { ROUNDTABLE_SPEC } from '../../enpoi-council/src/profiles/roundtable.ts'
import { EVIDENCE_CHILD_DENY, ORACLE_TOOL_FILTER } from '../../enpoi-oracle/src/index.ts'
import { resolvePolicy, reviewerSeatOf, seatToolDenyFor } from '../src/policy.ts'
import creatorInventory from './fixtures/tool-inventory/expected-creator.json'
import orchestratorInventory from './fixtures/tool-inventory/expected-orchestrator.json'
import sysadminInventory from './fixtures/tool-inventory/expected-sysadmin.json'

/** Every main seat a delegated child can inherit as its execution role. */
const PARENT_SEATS = ['orchestrator', 'sysadmin', 'creator'] as const
type ParentSeat = (typeof PARENT_SEATS)[number]

/** The first-party registry a child can inherit, from the canonical inventory. */
const REGISTRY: readonly string[] = [...new Set([
  ...orchestratorInventory.tools,
  ...sysadminInventory.tools,
  ...creatorInventory.tools,
  ...SHIPPED_TOOL_GROUPS.flatMap(group => group.members),
  // Registered by enpoi-capabilities whenever a confining executor exists; the
  // preset inventory fixtures are captured without one.
  'review_run',
])].sort()

/** One child role fixture: how its catalog is composed at spawn. */
interface ChildRoleFixture {
  /** Role id the operator surface names. */
  id: string
  /** The code that owns the surface (for the failure message). */
  source: string
  /** Whether the shared worker floor (`SHARED_CHILD_DENY`) applies. */
  sharedFloor: boolean
  /** The role's own deny list. */
  denies: readonly string[]
  /**
   * The tool-groups seat the spawner's descriptor label resolves to; absent =
   * the parent's mount seat (the generic/oracle/evidence paths).
   */
  seat?: string
  /** The `subagent/descriptor` label/persona the spawner writes. */
  descriptor?: { label?: string; persona?: string }
}

/** The Oracle review child's descriptor (spawned by `oracle_review`). */
const ORACLE_DESCRIPTOR = { label: 'oracle review: child-surfaces guard' }

/** The evidence research child's descriptor (spawned by `request_evidence`). */
const EVIDENCE_DESCRIPTOR = { label: 'evidence request: child-surfaces guard' }

/** The council deny list for one debater/arbiter seat. */
const councilDebaterDeny = DEBATER_DENIED_TOOLS

/** The council broker's deny list (the research surface survives). */
const councilBrokerDeny = COUNCIL_DENIED_TOOLS.filter(name => !(BROKER_KEPT_TOOLS as readonly string[]).includes(name))

/** Roundtable debater fixtures, each with its own persona. */
const ROUNDTABLE_FIXTURES: ChildRoleFixture[] = ROUNDTABLE_SPEC.seats.map(seat => ({
  id: seat.id,
  source: 'enpoi-council/src/profiles/roundtable.ts + core/fiber.ts',
  sharedFloor: false,
  denies: councilDebaterDeny,
  seat: seat.id,
  descriptor: { label: `roundtable seat: ${seat.id}`, persona: seat.persona },
}))

/** Chorus debater fixtures, each with its own persona. */
const CHORUS_FIXTURES: ChildRoleFixture[] = CHORUS_SPEC.seats.map(seat => ({
  id: seat.id,
  source: 'enpoi-council/src/profiles/chorus.ts + core/fiber.ts',
  sharedFloor: false,
  denies: councilDebaterDeny,
  seat: seat.id,
  descriptor: { label: `chorus seat: ${seat.id}`, persona: seat.persona },
}))

/** Every child role fixture the deployment can spawn. */
function childRoleFixtures(): ChildRoleFixture[] {
  const registry = listRoleRegistry(undefined)
  const generic: ChildRoleFixture[] = ['fixer', 'explorer', 'librarian', 'designer'].map(id => ({
    id,
    source: 'tool-subagent/src/index.ts (SHARED_CHILD_DENY + ROLE_CHILD_DENY)',
    sharedFloor: true,
    denies: registry[id]?.deny ?? [],
  }))
  return [
    ...generic,
    {
      id: 'oracle',
      source: 'enpoi-oracle/src/index.ts (ORACLE_TOOL_FILTER)',
      sharedFloor: false,
      denies: ORACLE_TOOL_FILTER.deny,
      descriptor: ORACLE_DESCRIPTOR,
    },
    {
      id: 'evidence-research',
      source: 'enpoi-oracle/src/index.ts (EVIDENCE_CHILD_DENY)',
      sharedFloor: false,
      denies: EVIDENCE_CHILD_DENY,
      descriptor: EVIDENCE_DESCRIPTOR,
    },
    ...ROUNDTABLE_FIXTURES,
    ...CHORUS_FIXTURES,
    {
      id: 'referee',
      source: 'enpoi-council/src/core/referee.ts (DEBATER_DENIED_TOOLS)',
      sharedFloor: false,
      denies: councilDebaterDeny,
      seat: 'referee',
      descriptor: {
        label: 'council referee: child-surfaces guard',
        persona: 'You are the Referee of a high-stakes multi-agent council. You are not a debater.',
      },
    },
    {
      id: 'chair',
      source: 'enpoi-council/src/core/engine.ts (seatDenyList)',
      sharedFloor: false,
      denies: councilDebaterDeny,
      seat: 'chair',
      descriptor: {
        label: 'council chair: child-surfaces guard',
        persona: 'You are the Chair of the Architecture Roundtable council.',
      },
    },
    {
      id: 'curator',
      source: 'enpoi-council/src/core/engine.ts (chorus chair persona)',
      sharedFloor: false,
      denies: councilDebaterDeny,
      seat: 'chair',
      descriptor: {
        label: 'council chair: chorus',
        persona: 'You are the Chair of the Idea Chorus council.',
      },
    },
    {
      id: 'broker',
      source: 'enpoi-council/src/core/broker.ts (COUNCIL_DENIED_TOOLS − BROKER_KEPT_TOOLS)',
      sharedFloor: false,
      denies: councilBrokerDeny,
      seat: 'broker',
      descriptor: {
        label: 'council broker: child-surfaces guard',
        persona: 'You are the Council Evidence Broker — a precision research assistant.',
      },
    },
  ]
}

/** The tool-groups seat one fixture's child resolves to. */
function effectiveSeat(fixture: ChildRoleFixture, parentSeat: ParentSeat): string {
  if (fixture.seat !== undefined) return fixture.seat
  const derived = seatOfDescriptorLabel(fixture.descriptor?.label)
  return derived ?? parentSeat
}

/** Whether the fixture's child passes the reviewer gate (`reviewerSeatOf`). */
function isReviewerChild(fixture: ChildRoleFixture, parentSeat: ParentSeat): boolean {
  return reviewerSeatOf({
    session: {
      header: { agentPreset: parentSeat },
      ownEvents: () => fixture.descriptor === undefined
        ? []
        : [{ type: 'subagent/descriptor', data: fixture.descriptor }],
    },
  })
}

/** One role's composed surface: role tables + the tool-groups presentation filter. */
function composeSurface(
  fixture: ChildRoleFixture,
  parentSeat: ParentSeat,
  registry: readonly string[] = REGISTRY,
): string[] {
  const catalog = resolveToolGroups(undefined)
  const hidden = new Set(denyNames(catalog, new Set(preAttachFor(catalog, effectiveSeat(fixture, parentSeat)))))
  const denied = new Set([
    ...fixture.denies,
    ...(fixture.sharedFloor ? SHARED_CHILD_DENY : []),
  ].filter(name => !(SHARED_CHILD_KEEP as readonly string[]).includes(name)))
  return registry.filter(name => !denied.has(name) && !hidden.has(name))
}

/** One execution-time refusal a composed surface must never contain. */
interface SurfaceLeak {
  role: string
  parentSeat: ParentSeat
  tool: string
  guard: 'seat' | 'policy'
}

/**
 * Cross-check every fixture against the refusal sources. Pure so the guard can
 * prove it fails on an injected future tool.
 * @param fixtures - the child role fixtures.
 * @param registry - the first-party registry the children can inherit.
 * @param seatGuardOverrides - extra seat-guard entries for the fail-proof test.
 * @returns every composed tool a guard would refuse.
 */
function findSurfaceLeaks(
  fixtures: readonly ChildRoleFixture[],
  registry: readonly string[] = REGISTRY,
  seatGuardOverrides?: Readonly<Record<string, readonly string[]>>,
): SurfaceLeak[] {
  const leaks: SurfaceLeak[] = []
  for (const fixture of fixtures) {
    for (const parentSeat of PARENT_SEATS) {
      const composed = composeSurface(fixture, parentSeat, registry)
      const seatGuard = new Set([
        ...seatToolDenyFor(parentSeat, undefined),
        ...(seatGuardOverrides?.[parentSeat] ?? []),
      ])
      const reviewer = isReviewerChild(fixture, parentSeat)
      for (const tool of composed) {
        if (seatGuard.has(tool)) {
          leaks.push({ role: fixture.id, parentSeat, tool, guard: 'seat' })
          continue
        }
        // Mirror `neverRunsTool`: bash has no command here, so its empty-command
        // guard is not a tool-level refusal — only a deny row would refuse it.
        if (tool === 'bash') continue
        if (resolvePolicy({ toolName: tool, agent: parentSeat, config: {}, reviewer }).kind === 'deny') {
          leaks.push({ role: fixture.id, parentSeat, tool, guard: 'policy' })
        }
      }
    }
  }
  return leaks
}

/**
 * Render the per-role surface table for the evidence file: role → surfaced
 * tools (parent orchestrator, the strictest case) → on-demand groups reachable
 * → guard-refused tools the role tables remove.
 * @returns the markdown table.
 */
function buildSurfaceTable(): string {
  const fixtures = childRoleFixtures()
  const catalog = resolveToolGroups(undefined)
  const lines: string[] = [
    '| Role | Source | Surfaced tools (parent `orchestrator`) | Refused removed by the tables | On-demand groups reachable |',
    '|---|---|---|---|---|',
  ]
  for (const fixture of fixtures) {
    const seat = effectiveSeat(fixture, 'orchestrator')
    const attached = new Set(preAttachFor(catalog, seat))
    const groups = SHIPPED_TOOL_GROUPS
      .filter(group => group.mode === 'on-demand' && group.enabled && (group.seats === undefined || group.seats.includes(seat)))
      .map(group => attached.has(group.id) ? `${group.id} (attached)` : `${group.id} (attachable)`)
      .join(', ')
    const surface = composeSurface(fixture, 'orchestrator')
    const reviewer = isReviewerChild(fixture, 'orchestrator')
    const deniedByTables = REGISTRY.filter(name =>
      !surface.includes(name)
      && (seatToolDenyFor('orchestrator', undefined).includes(name)
        || (name !== 'bash'
          && resolvePolicy({ toolName: name, agent: 'orchestrator', config: {}, reviewer }).kind === 'deny')))
    lines.push(`| \`${fixture.id}\` | ${fixture.source} | ${surface.length}: ${surface.join(', ')} | ${deniedByTables.join(', ') || '—'} | ${groups || '—'} |`)
  }
  lines.push('')
  lines.push('Parent-seat execution refusals cross-checked for every row above:')
  lines.push('')
  lines.push('| Parent seat | Seat-guard denies | Reviewer gate denies |')
  lines.push('|---|---|---|')
  for (const seat of PARENT_SEATS) {
    lines.push(`| \`${seat}\` | ${seatToolDenyFor(seat, undefined).join(', ') || '—'} | ${isReviewerChild({ id: 'probe', source: '', sharedFloor: true, denies: [] }, seat) ? '—' : '`review_run`'} |`)
  }
  return `${lines.join('\n')}\n`
}

describe('child surfaces vs execution refusals', () => {
  it('composes no tool any execution guard refuses, for every role and parent seat', () => {
    const leaks = findSurfaceLeaks(childRoleFixtures())
    expect(
      leaks,
      `a composed child catalog names a refused tool:\n${leaks
        .map(leak => `  ${leak.role} (parent ${leak.parentSeat}): ${leak.tool} refused by ${leak.guard}`)
        .join('\n')}`,
    ).toEqual([])
  })

  it('keeps the creator trio and review_run out of every worker surface by name', () => {
    const seatGuardTools = ['plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query']
    // The shared worker floor (generic delegation).
    for (const tool of [...seatGuardTools, 'review_run']) {
      expect(SHARED_CHILD_DENY, `shared floor must name ${tool}`).toContain(tool)
    }
    // The Oracle child keeps review_run (reviewer seat) but never harness authoring.
    for (const tool of seatGuardTools) expect(ORACLE_TOOL_FILTER.deny).toContain(tool)
    expect(ORACLE_TOOL_FILTER.deny).not.toContain('review_run')
    // The evidence research child is a worker on both counts.
    for (const tool of [...seatGuardTools, 'review_run']) {
      expect(EVIDENCE_CHILD_DENY, `evidence fence must name ${tool}`).toContain(tool)
    }
    // Every council seat (debaters, arbiters, broker) is fenced from both.
    for (const tool of [...seatGuardTools, 'review_run']) {
      expect(COUNCIL_DENIED_TOOLS, `council fence must name ${tool}`).toContain(tool)
      expect(councilBrokerDeny, `broker fence must name ${tool}`).toContain(tool)
    }
  })

  it('cannot re-surface a refused tool through a stored role allowlist', () => {
    const registry = listRoleRegistry(undefined)
    for (const id of ['fixer', 'explorer', 'librarian', 'designer']) {
      const fixture = childRoleFixtures().find(candidate => candidate.id === id)!
      // The allowlist path: allow = the operator's list ∪ keep; deny = shared floor.
      const allowed = new Set([...REGISTRY, ...SHARED_CHILD_KEEP])
      const denied = new Set([
        ...SHARED_CHILD_DENY,
        ...(registry[id]?.deny ?? []),
      ])
      const effective = [...allowed].filter(name => !denied.has(name))
      for (const parentSeat of PARENT_SEATS) {
        const seatGuard = new Set(seatToolDenyFor(parentSeat, undefined))
        const leaked = effective.filter(name =>
          seatGuard.has(name)
          || (name !== 'bash'
            && resolvePolicy({ toolName: name, agent: parentSeat, config: {}, reviewer: isReviewerChild(fixture, parentSeat) }).kind === 'deny'))
        expect(leaked, `${id} allowlist surfaces refused tools for ${parentSeat}`).toEqual([])
      }
    }
  })

  it('fails when a future tool joins the registry under a seat guard without a role fence', () => {
    const future = 'future_manager_tool'
    const registry = [...REGISTRY, future]
    // Without a role fence and without a guard entry the tool is ordinary.
    expect(findSurfaceLeaks(childRoleFixtures(), registry)).toEqual([])
    // Onboarding it into the orchestrator/sysadmin seat guard must fail the
    // guard until every child role table fences it.
    const leaks = findSurfaceLeaks(childRoleFixtures(), registry, {
      orchestrator: [...seatToolDenyFor('orchestrator', undefined), future],
      sysadmin: [...seatToolDenyFor('sysadmin', undefined), future],
    })
    expect(leaks.length).toBeGreaterThan(0)
    expect(leaks.every(leak => leak.tool === future && leak.guard === 'seat')).toBe(true)
  })

  it('keeps tool_groups reachable and on-demand groups mountable for every child role', () => {
    for (const fixture of childRoleFixtures()) {
      expect(fixture.denies, `${fixture.id} must keep tool_groups`).not.toContain('tool_groups')
      for (const parentSeat of PARENT_SEATS) {
        expect(composeSurface(fixture, parentSeat), `${fixture.id} lost tool_groups`).toContain('tool_groups')
      }
    }
    // Every enabled on-demand group stays visible to at least one seat a child
    // can resolve to, so no family is statically unreachable.
    const catalog = resolveToolGroups(undefined)
    const seats = [...PARENT_SEATS, ...childRoleFixtures().map(fixture => fixture.seat).filter((seat): seat is string => seat !== undefined)]
    for (const group of SHIPPED_TOOL_GROUPS.filter(candidate => candidate.mode === 'on-demand' && candidate.enabled)) {
      const visible = seats.some(seat => group.seats === undefined || group.seats.includes(seat))
      expect(visible, `on-demand group ${group.id} is unreachable for every child seat`).toBe(true)
    }
  })

  it('pins the reviewer gate to the surfaces the reviewer seats keep', () => {
    // The Oracle review child and the roundtable/arbiter personas pass the
    // reviewer gate (`REVIEW_CHILD_PERSONA`); chorus debaters and the broker do
    // not. The council fence names review_run for every council seat anyway, so
    // the catalog never carries it — the fence is stronger than the gate.
    const fixtures = childRoleFixtures()
    const passes = ['oracle', 'referee', 'chair', 'curator', ...ROUNDTABLE_FIXTURES.map(fixture => fixture.id)]
    for (const id of passes) {
      expect(isReviewerChild(fixtures.find(candidate => candidate.id === id)!, 'orchestrator'), `${id} must pass the reviewer gate`).toBe(true)
    }
    for (const fixture of [...CHORUS_FIXTURES, fixtures.find(candidate => candidate.id === 'broker')!]) {
      expect(isReviewerChild(fixture, 'orchestrator'), `${fixture.id} unexpectedly passes the reviewer gate`).toBe(false)
    }
    // Every council fixture still excludes review_run from its composed surface.
    for (const fixture of fixtures.filter(candidate => candidate.source.includes('enpoi-council'))) {
      expect(composeSurface(fixture, 'orchestrator'), `${fixture.id} surfaces review_run`).not.toContain('review_run')
    }
  })

  it('fences the keeper as a service, not a child catalog', () => {
    // The keeper makes direct model requests and owns no subagent spawn path;
    // no role fixture and no deny table names it, so it can never surface as a
    // child tool. This is a documentation pin, not a runtime assertion.
    expect(SHARED_CHILD_DENY).not.toContain('keeper')
    expect(REGISTRY).not.toContain('keeper')
    expect(COUNCIL_KEPT_TOOLS.length).toBeGreaterThan(0)
  })

  it('renders the per-role evidence table when CHILD_SURFACES_TABLE names a path', () => {
    const out = process.env.CHILD_SURFACES_TABLE
    if (out === undefined || out === '') return
    writeFileSync(out, buildSurfaceTable())
    expect(buildSurfaceTable()).toContain('| Role | Source |')
  })
})
