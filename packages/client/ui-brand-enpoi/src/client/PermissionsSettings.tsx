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
  buildAgentList,
  buildPermissionToolRows,
  effectivePolicy,
  getPermissionsViewState,
  mergeServerPermissionsWithPending,
  persistAgentAvailable,
  persistBashPatterns,
  provenanceFor,
  refreshFromServer,
  setPermissionPath,
  subscribePermissionsView,
  unsetPermissionPath,
  type BashPatternRule,
  type McpServerRef,
  type PermissionGrant,
  type PermissionsConfig,
  type PermissionToolRow,
  type PolicyValue,
  builtRoleAvailability,
  BUILT_ROLE_SURFACE,
} from './permissions-model.ts'
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

/** One glass section: icon + title header over row content. */
function Group({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <section className={c('group')}>
      <div className={c('groupHead')}>
        <span className={c('groupIcon')}><Icon d={icon} /></span>
        <span className={c('groupTitle')}>{title}</span>
      </div>
      {children}
    </section>
  )
}

/** One tool policy row: label + provenance, availability eye (agents), cycle chip. */
function PolicyRow({ row, provenance, effective, ownOverride, onCycle, available, onToggleAvailable }: {
  row: PermissionToolRow
  provenance: string
  effective: PolicyValue
  /** The subject's OWN override for this tool (undefined = inherit). The chip shows and cycles THIS. */
  ownOverride: PolicyValue | undefined
  onCycle: (next: PolicyValue | undefined) => void
  available?: boolean
  onToggleAvailable?: () => void
}) {
  return (
    <div className={c('row')}>
      <div className={c('rowLabel')}>
        <span className={c('rowName')}>{row.name}</span>
        <span className={c('rowHint')}>{provenance}</span>
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
              className={`${c('segBtn')} ${ownOverride === policy ? c('segActive') : ''} ${ownOverride === undefined && effective === policy ? c('segDefault') : ''}`}
              title={
                ownOverride === policy
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

/** One standing grant row: tool · pattern · agent, with revoke. */
function GrantRow({ grant, onRevoke }: { grant: PermissionGrant; onRevoke: (grantId: string) => void }) {
  return (
    <div className={c('row')}>
      <div className={c('rowLabel')}>
        <span className={c('rowName')}>{grant.pattern !== undefined ? `${grant.tool} · ${grant.pattern}` : grant.tool}</span>
        <span className={c('rowHint')}>
          {grant.agent !== undefined ? `agent: ${grant.agent} · allow always` : 'all agents · allow always'}
        </span>
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
function GlobalPane({ perms, toolRows, onCycleTool, onSetUnknownTools, onAddPattern, onRemovePattern, onRevokeGrant }: {
  perms: PermissionsConfig
  toolRows: readonly PermissionToolRow[]
  onCycleTool: (tool: string, next: PolicyValue | undefined) => void
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
        {toolRows.map(row => (
          <PolicyRow
            key={row.id}
            row={row}
            provenance={provenanceFor(perms, undefined, row.id)}
            effective={effectivePolicy(perms, undefined, row.id)}
            ownOverride={perms.tools?.[row.id]}
            onCycle={(next) => { onCycleTool(row.id, next) }}
          />
        ))}
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
function AgentPane({ agent, perms, toolRows, onCycleTool, onToggleAvailable, onRevokeGrant }: {
  agent: string
  perms: PermissionsConfig
  toolRows: readonly PermissionToolRow[]
  onCycleTool: (agent: string, tool: string, next: PolicyValue | undefined) => void
  onToggleAvailable: (agent: string, tool: string) => void
  onRevokeGrant: (grantId: string) => void
}) {
  const available = perms.agents?.[agent]?.available
  const agentGrants = Object.values(perms.grants ?? {}).filter(grant => grant.agent === agent)
  return (
    <>
      <Group title={`Agent rules — ${agent}`} icon={ICONS.agent}>
        <div className={c('paneHint')}>
          Rules refine the global policy. The eye marks a tool in this role allowlist.
        </div>
        {toolRows.filter(row => !row.id.startsWith('mcp__')).map(row => (
          <PolicyRow
            key={row.id}
            row={row}
            provenance={provenanceFor(perms, agent, row.id)}
            effective={effectivePolicy(perms, agent, row.id)}
            ownOverride={perms.agents?.[agent]?.tools?.[row.id]}
            onCycle={(next) => { onCycleTool(agent, row.id, next) }}
            available={(available !== undefined && available.includes(row.id)) || builtRoleAvailability(agent, row.id) === true}
            onToggleAvailable={() => { onToggleAvailable(agent, row.id) }}
          />
        ))}
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
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(() => {
    void (async () => {
      await refreshFromServer()
      const state = getPermissionsViewState()
      if (state.view === undefined) {
        setFailed(true)
        return
      }
      setFailed(false)
      setPerms(state.view.value?.permissions ?? {})
      setMcpServers(state.view.value?.mcpServers ?? {})
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
  }), [])

  const toolRows = useMemo(() => buildPermissionToolRows(mcpServers), [mcpServers])
  const agents = useMemo(() => buildAgentList(AGENT_ROSTER, Object.keys(perms?.agents ?? {})), [perms])

  // --- writes (0ms optimistic, rollback on rejected persistence) ---

  /** Cycle one tool override on the Global subject: ['tools', tool]. */
  const cycleGlobalTool = (tool: string, next: PolicyValue | undefined) => {
    const previous = perms
    if (perms === null) return
    const tools: Record<string, PolicyValue> = { ...(perms.tools ?? {}) }
    if (next === undefined) {
      const { [tool]: _drop, ...rest } = tools
      void _drop
      setPerms({ ...perms, tools: rest })
    } else {
      tools[tool] = next
      setPerms({ ...perms, tools })
    }
    void (next === undefined ? unsetPermissionPath(['tools', tool]) : setPermissionPath(['tools', tool], next))
      .then((ok) => { if (!ok) setPerms(previous) })
  }

  /** Cycle one tool override on an agent subject: ['agents', agent, 'tools', tool]. */
  const cycleAgentTool = (agent: string, tool: string, next: PolicyValue | undefined) => {
    const previous = perms
    if (perms === null) return
    const agentCfg = { ...(perms.agents?.[agent] ?? {}), tools: { ...(perms.agents?.[agent]?.tools ?? {}) } }
    if (next === undefined) delete agentCfg.tools?.[tool]
    else agentCfg.tools = { ...agentCfg.tools, [tool]: next }
    setPerms({ ...perms, agents: { ...(perms.agents ?? {}), [agent]: agentCfg } })
    void (next === undefined
      ? unsetPermissionPath(['agents', agent, 'tools', tool])
      : setPermissionPath(['agents', agent, 'tools', tool], next))
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

  /** Toggle one tool in an agent allowlist — 0ms optimistic, fenced background write. */
  const toggleAgentToolAvailable = (agent: string, tool: string) => {
    const previous = perms
    if (perms === null) return
    // Seed the allowlist from the built-in role surface when no explicit
    // override exists yet, so the FIRST flip writes a complete list (the
    // built-in visible set plus/minus this tool) instead of a bare [tool].
    const seed = BUILT_ROLE_SURFACE[agent]
    const members = [...(perms.agents?.[agent]?.available ?? (seed !== undefined ? [...seed] : []))]
    const available = members.includes(tool)
      ? members.filter(name => name !== tool).sort((left, right) => left.localeCompare(right))
      : [...members, tool].sort((left, right) => left.localeCompare(right))
    const agentCfg = { ...(perms.agents?.[agent] ?? {}), available }
    setPerms({ ...perms, agents: { ...(perms.agents ?? {}), [agent]: agentCfg } })
    // Re-apply the toggle to the freshest server list on every attempt; an
    // explicit empty override stays empty, an absent one seeds from the role surface.
    void persistAgentAvailable(agent, (fresh) => {
      const base = fresh ?? (seed !== undefined ? [...seed] : [])
      const next = base.includes(tool) ? base.filter(name => name !== tool) : [...base, tool]
      return next.sort((left, right) => left.localeCompare(right))
    }).then((writeOk) => { if (!writeOk) setPerms(previous) })
  }

  if (perms === null) {
    return (
      <div className={c('container')}>
        <div className={c('statusLine')}>
          {failed ? 'Permission policy unavailable — check the gateway connection.' : 'Loading policy…'}
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
          allow; bash and unknown tools ship ask. Everything is settings-backed and applies from the next dispatch.
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
          {agents.map(agent => (
            <button
              type="button"
              key={agent}
              className={`${c('railCell')} ${selected === agent ? c('railCellActive') : ''}`}
              onClick={() => { setSelected(agent) }}
            >
              {agent}
            </button>
          ))}
        </nav>
        <div className={c('pane')}>
          {selected === null ? (
            <GlobalPane
              perms={perms}
              toolRows={toolRows}
              onCycleTool={cycleGlobalTool}
              onSetUnknownTools={setUnknownToolsDefault}
              onAddPattern={addBashPattern}
              onRemovePattern={removeBashPattern}
              onRevokeGrant={revokeGrant}
            />
          ) : (
            <AgentPane
              agent={selected}
              perms={perms}
              toolRows={toolRows}
              onCycleTool={cycleAgentTool}
              onToggleAvailable={toggleAgentToolAvailable}
              onRevokeGrant={revokeGrant}
            />
          )}
        </div>
      </div>
    </div>
  )
}
