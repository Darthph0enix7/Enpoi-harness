/**
 * Permissions settings section (doc 55) — master-detail page over the
 * `enpoi-orchestration.permissions` policy. Left rail: the Global subject and
 * the shipped agent roster merged with user-added agents. Right pane: tool
 * policy chips with provenance, per-agent availability toggles, the bash
 * pattern editor and the standing-grants list (Global), and the unknown-tools
 * default. Glass theme, monochrome stroke icons, 0ms optimistic updates:
 * leaf paths persist as atomic per-path ops; whole-array keys (bashPatterns,
 * agents[name].available) go through the revision-fenced writers, which
 * re-read the live document per attempt and re-apply the operator's change
 * onto that fresh value. A pushed `settings/document-updated` refresh merges
 * the server view in without clobbering a path whose write is in flight.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AGENT_ROSTER,
  buildAgentSubjects,
  buildPermissionToolRows,
  builtRoleAvailability,
  fetchRegisteredToolNames,
  getPermissionsViewState,
  grantScopeHint,
  isAggregateRow,
  mergeServerPermissionsWithPending,
  persistAgentAvailable,
  persistBashPatterns,
  persistRowPolicyOps,
  refreshFromServer,
  roleSurfaceFor,
  rowPolicyOps,
  rowPolicyState,
  rowTargets,
  seatDeniesTool,
  setPermissionPath,
  subscribePermissionsView,
  unsetPermissionPath,
  type AgentPermissions,
  type BashPatternRule,
  type McpServerRef,
  type PermissionGrant,
  type PermissionsConfig,
  type PermissionToolRow,
  type PolicyValue,
} from './permissions-model.ts'
import {
  getRoleRegistry,
  normalizeRoleId,
  refreshFromServer as refreshRoleRegistry,
  subscribeRoleRegistry,
  type RoleRegistryMap,
} from './role-registry.ts'
import { getEnpoiNamespacePresence, isSettingsCacheFresh, SETTINGS_MOUNT_STALE_MS } from './settings-refresh.ts'
import { openSettingsSection } from './settings-nav.ts'
import css from './PermissionsSettings.module.css'

/** CSS-module reads are `string | undefined` under noUncheckedIndexedAccess; keys are static. */
function c(name: string): string {
  return css[name] ?? ''
}

/** Minimalistic monochrome stroke icons (currentColor, 1.25 stroke). */
function Icon({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  shield: 'M8 2l4.5 1.8v3.2c0 2.9-1.9 5-4.5 5.8C5.4 12 3.5 9.9 3.5 7V3.8z',
  globe: 'M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2.5 8h11M8 2.5c1.9 1.6 1.9 9.4 0 11M8 2.5c-1.9 1.6-1.9 9.4 0 11',
  agent: 'M8 4.5a2.25 2.25 0 110 4.5 2.25 2.25 0 010-4.5zM3.75 13c.7-2 2.3-3.25 4.25-3.25S11.55 11 12.25 13',
  pattern: 'M2 5h3.5M8.5 5H14M2 11h6M11 11h3',
  grant: 'M4.5 2.75h7A1.25 1.25 0 0112.75 4v8a1.25 1.25 0 01-1.25 1.25h-7A1.25 1.25 0 013.25 12V4A1.25 1.25 0 014.5 2.75zM3.25 6.75h9.5M6 6.75V13.25',
  eye: 'M1.75 8S4.15 3.75 8 3.75 14.25 8 14.25 8 11.85 12.25 8 12.25 1.75 8 1.75 8ZM8 5.9a2.1 2.1 0 100 4.2 2.1 2.1 0 000-4.2Z',
  eyeOff: 'M2 8S4.4 3.75 8.25 3.75c.9 0 1.7.2 2.45.5M14 8s-2.4 4.25-6.25 4.25c-.9 0-1.7-.2-2.45-.5M3 13L13 3',
  add: 'M8 3.5v9M3.5 8h9',
  remove: 'M4 4l8 8M12 4l-8 8',
}

/** Chip color class per effective policy. */
/** Text tint per policy (pattern chip labels). */
function policyTint(policy: PolicyValue): string {
  return policy === 'allow' ? c('tintAllow') : policy === 'ask' ? c('tintAsk') : c('tintDeny')
}

/** One glass section: icon + title header over row content, with an optional trailing action. */
function Group({ title, icon, action, children }: { title: string; icon: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={c('group')}>
      <div className={c('groupHead')}>
        <span className={c('groupIcon')}><Icon d={icon} /></span>
        <span className={c('groupTitle')}>{title}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

/** One tool policy row: label + provenance, availability eye (agents), cycle chip. */
function PolicyRow({ row, provenance, effective, ownOverride, mixed, onCycle, available, onToggleAvailable }: {
  row: PermissionToolRow
  provenance: string
  effective: PolicyValue
  /** The subject's OWN override for this tool (undefined = inherit). The chip shows and cycles THIS. */
  ownOverride: PolicyValue | undefined
  /** True for an aggregate row whose members disagree — no chip is highlighted. */
  mixed?: boolean
  onCycle: (next: PolicyValue | undefined) => void
  available?: boolean
  onToggleAvailable?: (() => void) | undefined
}) {
  const isGroup = isAggregateRow(row)
  return (
    <div className={isGroup ? `${c('row')} ${c('rowGroup')}` : c('row')}>
      <div className={c('rowLabel')}>
        <span className={c('rowName')}>{row.name}</span>
        <span className={c('rowHint')}>{mixed === true ? `${provenance} — click to set every tool in this row` : provenance}</span>
      </div>
      <div className={c('rowTools')}>
        {onToggleAvailable !== undefined && (
          <button
            type="button"
            className={`${c('eyeBtn')} ${available ? c('eyeOn') : ''}`}
            onClick={onToggleAvailable}
            title={available ? 'Remove from this role allowlist' : 'Add to this role allowlist'}
            aria-pressed={available === true}
          >
            <Icon d={available ? ICONS.eye : ICONS.eyeOff} size={12} />
          </button>
        )}
        <div className={c('policySeg')} role="group" aria-label="Policy">
          {(['allow', 'ask', 'deny'] as const).map(policy => (
            <button
              key={policy}
              type="button"
              className={`${c('segBtn')} ${mixed !== true && ownOverride === policy ? c('segActive') : ''} ${mixed !== true && ownOverride === undefined && effective === policy ? c('segDefault') : ''}`}
              title={
                mixed === true
                  ? `Set ${policy} for every tool in this row (currently mixed)`
                  : ownOverride === policy
                    ? `Clear this rule (return to ${effective === policy && provenance === 'inherit (default)' ? 'the shipped default' : 'inherit'})`
                    : `Set ${policy} for this subject. Effective now: ${effective}`
              }
              onClick={() => { onCycle(ownOverride === policy ? undefined : policy) }}
            >
              {policy}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** One standing grant row: tool · pattern · scope, with revoke. */
function GrantRow({ grant, onRevoke }: { grant: PermissionGrant; onRevoke: (grantId: string) => void }) {
  return (
    <div className={c('row')}>
      <div className={c('rowLabel')}>
        <span className={c('rowName')}>{grant.pattern !== undefined ? `${grant.tool} · ${grant.pattern}` : grant.tool}</span>
        <span className={c('rowHint')}>{grantScopeHint(grant)}</span>
      </div>
      <div className={c('rowTools')}>
        <button type="button" className={c('revokeBtn')} title="Revoke this grant" onClick={() => { onRevoke(grant.id) }}>
          <Icon d={ICONS.remove} size={10} />
        </button>
      </div>
    </div>
  )
}

/** Global subject: unknown-tools default, tool policy, bash patterns, all grants. */
function GlobalPane({ perms, toolRows, onCycleRow, onSetUnknownTools, onAddPattern, onRemovePattern, onRevokeGrant }: {
  perms: PermissionsConfig
  toolRows: readonly PermissionToolRow[]
  onCycleRow: (row: PermissionToolRow, next: PolicyValue | undefined) => void
  onSetUnknownTools: (next: PolicyValue) => void
  onAddPattern: (pattern: string, policy: PolicyValue) => void
  onRemovePattern: (pattern: string) => void
  onRevokeGrant: (grantId: string) => void
}) {
  const [draftPattern, setDraftPattern] = useState('')
  const [draftPolicy, setDraftPolicy] = useState<PolicyValue>('ask')
  const unknownTools = perms.defaults?.unknownTools ?? 'ask'
  const patterns = perms.bashPatterns ?? []
  const grants = Object.values(perms.grants ?? {})
  const submitDraft = () => {
    onAddPattern(draftPattern, draftPolicy)
    setDraftPattern('')
  }
  return (
    <>
      <Group title="Defaults" icon={ICONS.shield}>
        <div className={c('row')}>
          <div className={c('rowLabel')}>
            <span className={c('rowName')}>Unknown tools</span>
            <span className={c('rowHint')}>Policy for tools without an explicit rule</span>
          </div>
          <div className={c('segGroup')}>
            {(['allow', 'ask', 'deny'] as const).map(policy => (
              <button
                key={policy}
                type="button"
                className={`${c('segBtn')} ${unknownTools === policy ? c('segBtnActive') : ''}`}
                onClick={() => { onSetUnknownTools(policy) }}
                aria-pressed={unknownTools === policy}
              >
                {policy}
              </button>
            ))}
          </div>
        </div>
      </Group>
      <Group title="Tool policy" icon={ICONS.globe}>
        {toolRows.map((row) => {
          const state = rowPolicyState(perms, undefined, row)
          return (
            <PolicyRow
              key={row.id}
              row={row}
              provenance={state.provenance}
              effective={state.effective}
              ownOverride={state.ownOverride}
              mixed={state.mixed}
              onCycle={(next) => { onCycleRow(row, next) }}
            />
          )
        })}
      </Group>
      <Group title="Bash patterns" icon={ICONS.pattern}>
        {patterns.length === 0 && (
          <div className={c('empty')}>No pattern rules. Every bash command follows the tool policy.</div>
        )}
        <div className={c('patternList')}>
          {patterns.map(pat => (
            <span className={c('patternChip')} key={pat.pattern}>
              <span className={c('patternText')}>{pat.pattern}</span>
              <span className={c('patternArrow')}>→</span>
              <span className={policyTint(pat.policy)}>{pat.policy}</span>
              <button type="button" className={c('patternRemove')} title="Remove this pattern" onClick={() => { onRemovePattern(pat.pattern) }}>
                <Icon d={ICONS.remove} size={9} />
              </button>
            </span>
          ))}
        </div>
        <div className={c('addRow')}>
          <input
            type="text"
            className={c('addInput')}
            placeholder="Command pattern, e.g. npm *"
            value={draftPattern}
            onChange={(e) => { setDraftPattern(e.target.value) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitDraft()
            }}
          />
          <select className={c('addSelect')} value={draftPolicy} onChange={(e) => { setDraftPolicy(e.target.value as PolicyValue) }}>
            <option value="allow">allow</option>
            <option value="ask">ask</option>
            <option value="deny">deny</option>
          </select>
          <button type="button" className={c('addBtn')} onClick={submitDraft}>
            <Icon d={ICONS.add} size={10} />
          </button>
        </div>
      </Group>
      <Group title="Standing grants" icon={ICONS.grant}>
        {grants.length === 0 && (
          <div className={c('empty')}>No standing grants. Allow-always grants the host writes appear here.</div>
        )}
        {grants.map(grant => (
          <GrantRow key={grant.id} grant={grant} onRevoke={onRevokeGrant} />
        ))}
      </Group>
    </>
  )
}

/** One agent subject: overlay tool rules with provenance, allowlist eyes, agent-scoped grants. */
function AgentPane({ agent, registry, perms, toolRows, removable, onRemoveSubject, onCycleRow, onToggleRow, onRevokeGrant }: {
  agent: string
  registry: RoleRegistryMap
  perms: PermissionsConfig
  toolRows: readonly PermissionToolRow[]
  /** True when the subject exists only in `permissions.agents` (never a shipped roster row). */
  removable: boolean
  onRemoveSubject: (agent: string) => void
  onCycleRow: (agent: string, row: PermissionToolRow, next: PolicyValue | undefined) => void
  onToggleRow: (agent: string, row: PermissionToolRow) => void
  onRevokeGrant: (grantId: string) => void
}) {
  const available = perms.agents?.[agent]?.available
  const agentGrants = Object.values(perms.grants ?? {}).filter(grant => grant.agent === agent)
  /**
   * Every concrete member of the row (or the row itself) is available to the
   * role. An explicit allowlist IS the answer (the hard gate); only without
   * one does the shipped/registry surface decide — OR-ing the surface back in
   * would leave every toggle of a shipped-surface tool looking inert. A
   * seat-denied member can never become available: the seat's presentation
   * filter and pre-execute guard both keep it out, so its row shows off and
   * carries no toggle.
   */
  const rowAvailable = (row: PermissionToolRow): boolean => {
    const targets = rowTargets(row)
    return targets.length > 0
      && !targets.some(target => seatDeniesTool(agent, target))
      && targets.every(target => available !== undefined
        ? available.includes(target)
        : builtRoleAvailability(agent, target, registry) === true)
  }
  return (
    <>
      <Group
        title={`Agent rules — ${agent}`}
        icon={ICONS.agent}
        action={removable ? (
          <button
            type="button"
            className={c('revokeBtn')}
            title="Remove this subject (its rules and allowlist are deleted)"
            aria-label={`Remove subject ${agent}`}
            onClick={() => { onRemoveSubject(agent) }}
          >
            <Icon d={ICONS.remove} size={10} />
          </button>
        ) : undefined}
      >
        <div className={c('paneHint')}>
          Rules refine the global policy. The eye marks a tool in this role allowlist — the hard gate: it wins over the
          role's Dynamic surface for the tools it names. MCP rows follow the live registry; their server and "All MCP
          tools" rows set every tool below them at once.
          {' '}
          <button type="button" className={c('crossLink')} onClick={() => { openSettingsSection('dynamic') }}>
            Open Dynamic → Roles
          </button>
        </div>
        {toolRows.map((row) => {
          const state = rowPolicyState(perms, agent, row)
          // An aggregate with no live members has nothing to toggle, and a
          // seat-denied row can never be made available: no eye.
          const targets = rowTargets(row)
          const toggleable = targets.length > 0 && !targets.some(target => seatDeniesTool(agent, target))
          return (
            <PolicyRow
              key={row.id}
              row={row}
              provenance={state.provenance}
              effective={state.effective}
              ownOverride={state.ownOverride}
              mixed={state.mixed}
              onCycle={(next) => { onCycleRow(agent, row, next) }}
              available={rowAvailable(row)}
              onToggleAvailable={toggleable ? () => { onToggleRow(agent, row) } : undefined}
            />
          )
        })}
      </Group>
      <Group title="Standing grants" icon={ICONS.grant}>
        {agentGrants.length === 0 && (
          <div className={c('empty')}>No standing grants for this agent.</div>
        )}
        {agentGrants.map(grant => (
          <GrantRow key={grant.id} grant={grant} onRevoke={onRevokeGrant} />
        ))}
      </Group>
    </>
  )
}

/** The Permissions settings section — registered as `settings.section` id 'permissions'. */
export function PermissionsSettings(_props: { close: () => void }): React.ReactNode {
  const [perms, setPerms] = useState<PermissionsConfig | null>(null)
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerRef>>({})
  const [liveToolNames, setLiveToolNames] = useState<readonly string[]>([])
  const [registry, setRegistry] = useState<RoleRegistryMap>(() => getRoleRegistry())
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [draftSubject, setDraftSubject] = useState('')
  /** Last rendered MCP-status fingerprint; a mounted/down flip re-reads the tool list. */
  const mcpFingerprint = useRef('')

  const load = useCallback(() => {
    void (async () => {
      // Mount re-reads only when this store never loaded or the shared cache
      // aged past the window; a fresh cache paints without a request.
      if (getPermissionsViewState().view === undefined || !isSettingsCacheFresh(SETTINGS_MOUNT_STALE_MS)) {
        await Promise.all([refreshFromServer(), refreshRoleRegistry()])
      }
      setRegistry(getRoleRegistry())
      const state = getPermissionsViewState()
      if (state.view === undefined) {
        setFailed(true)
        return
      }
      setFailed(false)
      setPerms(state.view.value?.permissions ?? {})
      setMcpServers(state.view.value?.mcpServers ?? {})
      const names = await fetchRegisteredToolNames()
      if (names !== undefined) setLiveToolNames(names)
    })()
  }, [])

  useEffect(() => { load() }, [load])

  // Cross-client live sync: every pushed refresh re-merges the server view over
  // the local optimistic one, except at paths whose write is still in flight.
  const permsRef = useRef<PermissionsConfig | null>(null)
  permsRef.current = perms
  useEffect(() => subscribePermissionsView(() => {
    const state = getPermissionsViewState()
    if (state.view === undefined) return
    const local = permsRef.current
    setPerms(local === null
      ? (state.view.value?.permissions ?? {})
      : mergeServerPermissionsWithPending(state.view.value?.permissions, local))
    setMcpServers(state.view.value?.mcpServers ?? {})
    setFailed(false)
    // Mounting/unmounting or a liveness flip changes what the registry holds;
    // re-read the live tool list only when the mounted flags moved (the 15s
    // heartbeat's checkedAt must not re-describe).
    const fingerprint = JSON.stringify(
      Object.entries(state.view.value?.mcpStatus ?? {})
        .map(([id, status]) => [id, status?.mounted === true, status?.state ?? ''])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    )
    if (fingerprint !== mcpFingerprint.current) {
      mcpFingerprint.current = fingerprint
      void fetchRegisteredToolNames().then((names) => { if (names !== undefined) setLiveToolNames(names) })
    }
  }), [])

  // The role registry is its own store: rebuild the rail whenever it changes.
  useEffect(() => subscribeRoleRegistry(() => { setRegistry(getRoleRegistry()) }), [])

  // Rows are derived from the LIVE registry projection (every registered tool
  // plus the curated order/family overlay), so a new tool appears with no code
  // change. MCP names are routed into their server groups inside the builder.
  const toolRows = useMemo(() => buildPermissionToolRows(mcpServers, [], liveToolNames), [mcpServers, liveToolNames])
  const subjects = useMemo(
    () => buildAgentSubjects(registry, AGENT_ROSTER, Object.keys(perms?.agents ?? {})),
    [registry, perms],
  )

  // --- writes (0ms optimistic, rollback on rejected persistence) ---

  /**
   * Apply one row's toggle to a tools map locally: every concrete member for
   * an aggregate, the row itself for a plain tool, and the legacy aggregate
   * key dropped (the aggregate is never an independent second key).
   */
  const applyRowPolicy = (
    tools: Record<string, PolicyValue>,
    row: PermissionToolRow,
    next: PolicyValue | undefined,
  ): Record<string, PolicyValue> => {
    const targets = new Set(rowTargets(row))
    const legacyAggregate = isAggregateRow(row) ? row.id : undefined
    const updated: Record<string, PolicyValue> = {}
    for (const [key, value] of Object.entries(tools)) {
      if (key === legacyAggregate || (next === undefined && targets.has(key))) continue
      updated[key] = next !== undefined && targets.has(key) ? next : value
    }
    if (next !== undefined) {
      for (const target of rowTargets(row)) {
        if (target !== legacyAggregate && !Object.hasOwn(updated, target)) updated[target] = next
      }
    }
    return updated
  }

  /** Cycle one row override on the Global subject: ['tools', …]. */
  const cycleGlobalRow = (row: PermissionToolRow, next: PolicyValue | undefined) => {
    const previous = perms
    if (perms === null) return
    setPerms({ ...perms, tools: applyRowPolicy(perms.tools ?? {}, row, next) })
    void persistRowPolicyOps(rowPolicyOps(row, ['tools'], next))
      .then((ok) => { if (!ok) setPerms(previous) })
  }

  /** Cycle one row override on an agent subject: ['agents', agent, 'tools', …]. */
  const cycleAgentRow = (agent: string, row: PermissionToolRow, next: PolicyValue | undefined) => {
    const previous = perms
    if (perms === null) return
    const agentCfg = { ...(perms.agents?.[agent] ?? {}), tools: applyRowPolicy(perms.agents?.[agent]?.tools ?? {}, row, next) }
    setPerms({ ...perms, agents: { ...(perms.agents ?? {}), [agent]: agentCfg } })
    void persistRowPolicyOps(rowPolicyOps(row, ['agents', agent, 'tools'], next))
      .then((ok) => { if (!ok) setPerms(previous) })
  }

  /** Write the unknown-tools default: ['defaults', 'unknownTools']. */
  const setUnknownToolsDefault = (next: PolicyValue) => {
    const previous = perms
    if (perms === null) return
    setPerms({ ...perms, defaults: { ...(perms.defaults ?? {}), unknownTools: next } })
    void setPermissionPath(['defaults', 'unknownTools'], next)
      .then((ok) => { if (!ok) setPerms(previous) })
  }

  /** Whole-array bash pattern write — optimistic on the current document, fenced persist. */
  const writeBashPatterns = (build: (fresh: readonly BashPatternRule[]) => BashPatternRule[]) => {
    const previous = perms
    if (perms === null) return
    setPerms({ ...perms, bashPatterns: build(perms.bashPatterns ?? []) })
    void persistBashPatterns(build).then((ok) => { if (!ok) setPerms(previous) })
  }

  const addBashPattern = (pattern: string, policy: PolicyValue) => {
    const trimmed = pattern.trim()
    if (trimmed === '') return
    writeBashPatterns((fresh) => {
      const patterns = [...fresh]
      const existing = patterns.findIndex(pat => pat.pattern === trimmed)
      if (existing >= 0) patterns[existing] = { pattern: trimmed, policy }
      else patterns.push({ pattern: trimmed, policy })
      return patterns
    })
  }

  const removeBashPattern = (pattern: string) => {
    writeBashPatterns(fresh => fresh.filter(pat => pat.pattern !== pattern))
  }

  /** Revoke one standing grant: ['grants', id]. */
  const revokeGrant = (grantId: string) => {
    const previous = perms
    if (perms === null) return
    const grants: Record<string, PermissionGrant> = { ...(perms.grants ?? {}) }
    const { [grantId]: _drop, ...rest } = grants
    void _drop
    setPerms({ ...perms, grants: rest })
    void unsetPermissionPath(['grants', grantId])
      .then((ok) => { if (!ok) setPerms(previous) })
  }

  /**
   * Toggle one row in an agent allowlist — 0ms optimistic, fenced background
   * write. An aggregate row flips every concrete member together (present only
   * when all members are), so the server/master/family rows stay one control.
   */
  const toggleAgentRow = (agent: string, row: PermissionToolRow) => {
    const previous = perms
    if (perms === null) return
    const targets = rowTargets(row)
    if (targets.length === 0) return
    const toggle = (base: readonly string[]): string[] => {
      const present = targets.every(target => base.includes(target))
      const next = present
        ? base.filter(name => !targets.includes(name))
        : [...base, ...targets.filter(target => !base.includes(target))]
      return next.sort((left, right) => left.localeCompare(right))
    }
    // Seed the allowlist from the built-in role surface (then the registry
    // role's surface, then empty), so the FIRST flip writes a complete list
    // (the built-in visible set plus/minus this row) instead of a bare set.
    const seed = roleSurfaceFor(agent, registry)
    const members = [...(perms.agents?.[agent]?.available ?? (seed !== undefined ? [...seed] : []))]
    const agentCfg = { ...(perms.agents?.[agent] ?? {}), available: toggle(members) }
    setPerms({ ...perms, agents: { ...(perms.agents ?? {}), [agent]: agentCfg } })
    // Re-apply the toggle to the freshest server list on every attempt; an
    // explicit empty override stays empty, an absent one seeds from the role surface.
    void persistAgentAvailable(agent, (fresh) => {
      const base = fresh ?? (seed !== undefined ? [...seed] : [])
      return toggle(base)
    }).then((writeOk) => { if (!writeOk) setPerms(previous) })
  }

  /**
   * Create one user-defined subject in `permissions.agents`, seeded from the
   * registry role's allowlist when the id matches, empty otherwise.
   * @param raw - the operator-typed role id.
   */
  const addSubject = (raw: string) => {
    const previous = perms
    if (perms === null) return
    const id = normalizeRoleId(raw)
    if (id === '' || Object.hasOwn(perms.agents ?? {}, id)) return
    const seed: AgentPermissions = {}
    const available = registry[id]?.tools?.available
    if (available !== undefined) seed.available = [...available]
    setPerms({ ...perms, agents: { ...(perms.agents ?? {}), [id]: seed } })
    setSelected(id)
    setDraftSubject('')
    void setPermissionPath(['agents', id], seed)
      .then((ok) => { if (!ok) setPerms(previous) })
  }

  /**
   * Delete a subject that exists only in `permissions.agents`; a shipped
   * roster row is never removed.
   * @param agent - the subject id to delete.
   */
  const removeSubject = (agent: string) => {
    const previous = perms
    if (perms === null) return
    if (AGENT_ROSTER.includes(agent) || !Object.hasOwn(perms.agents ?? {}, agent)) return
    // Rebuild instead of deleting: the removed subject drops out of the map.
    const agentsMap = Object.fromEntries(
      Object.entries(perms.agents ?? {}).filter(([candidate]) => candidate !== agent),
    ) as NonNullable<typeof perms.agents>
    setPerms({ ...perms, agents: agentsMap })
    setSelected(null)
    void unsetPermissionPath(['agents', agent])
      .then((ok) => { if (!ok) setPerms(previous) })
  }

  if (perms === null) {
    return (
      <div className={c('container')}>
        <div className={c('statusLine')}>
          {failed
            ? getEnpoiNamespacePresence() === 'missing'
              ? 'Permission settings are not available in this profile — the enpoi-orchestration service is not mounted.'
              : 'Permission policy unavailable — check the gateway connection.'
            : 'Loading policy…'}
        </div>
        {failed && (
          <button type="button" className={c('retryBtn')} onClick={load}>Retry</button>
        )}
      </div>
    )
  }

  return (
    <div className={c('container')}>
      <div className={c('intro')}>
        <span className={c('introIcon')}><Icon d={ICONS.shield} size={14} /></span>
        <span>
          <b>Global is the source of truth</b> — agent panes inherit it and override only where you set a rule.
          Legend: <b>filled segment</b> = your rule · <b>dashed segment</b> = shipped default applying · the eye = whether the
          role sees the tool at all (unavailable tools are stripped — their policy is irrelevant). Reads and web ship
          allow; bash and unknown tools ship ask; mounted MCP servers default to allow. Rows grouped under <b>Whiteboard</b> are
          derived: they set every tool they cover at once. Everything is
          settings-backed and applies from the next dispatch.
        </span>
      </div>
      <div className={c('layout')}>
        <nav className={c('rail')} aria-label="Permission subjects">
          <button
            type="button"
            className={`${c('railCell')} ${selected === null ? c('railCellActive') : ''}`}
            onClick={() => { setSelected(null) }}
          >
            Global (all agents)
          </button>
          {subjects.map((subject, index) => (
            <span key={subject.id} className={c('railEntry')}>
              {subject.main !== true && subjects[index - 1]?.main === true && (
                <span className={c('railDivider')} role="separator" aria-label="Sub-agents" />
              )}
              <button
                type="button"
                className={`${c('railCell')} ${selected === subject.id ? c('railCellActive') : ''} ${subject.main === true ? c('railCellMain') : ''}`}
                onClick={() => { setSelected(subject.id) }}
              >
                {subject.main === true && <span className={c('railMainTag')}>main</span>}
                {subject.label}
              </button>
            </span>
          ))}
          <div className={c('railAdd')}>
            <input
              type="text"
              className={c('railAddInput')}
              placeholder="New role id"
              value={draftSubject}
              onChange={(e) => { setDraftSubject(e.target.value) }}
              onKeyDown={(e) => { if (e.key === 'Enter') addSubject(draftSubject) }}
              aria-label="New permission subject id"
            />
            <button
              type="button"
              className={c('railAddBtn')}
              title="Add subject"
              aria-label="Add subject"
              onClick={() => { addSubject(draftSubject) }}
            >
              <Icon d={ICONS.add} size={11} />
            </button>
          </div>
        </nav>
        <div className={c('pane')}>
          {selected === null ? (
            <GlobalPane
              perms={perms}
              toolRows={toolRows}
              onCycleRow={cycleGlobalRow}
              onSetUnknownTools={setUnknownToolsDefault}
              onAddPattern={addBashPattern}
              onRemovePattern={removeBashPattern}
              onRevokeGrant={revokeGrant}
            />
          ) : (
            <AgentPane
              agent={selected}
              registry={registry}
              perms={perms}
              toolRows={toolRows}
              removable={!AGENT_ROSTER.includes(selected) && Object.hasOwn(perms.agents ?? {}, selected)}
              onRemoveSubject={removeSubject}
              onCycleRow={cycleAgentRow}
              onToggleRow={toggleAgentRow}
              onRevokeGrant={revokeGrant}
            />
          )}
        </div>
      </div>
    </div>
  )
}
