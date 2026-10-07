import { describe, expect, it } from 'vitest'
import {
  resolvePolicy, splitCompoundCommand, stripEnvPrefixes, matchBashPattern,
  mcpLadder, mcpServerNameOf, agentRoleOf, reviewerSeatOf, grantProposalFor, grantProposalForOutcome, standingGrantRecord,
  dangerVerbOfPattern, SHIPPED_TOOL_DEFAULTS, advertisedToolNames,
  isFullAccessMode, FULL_ACCESS_ASK_REASON,
  REVIEW_RUN_TOOL, REVIEW_ROLES, SHIPPED_SEAT_TOOL_DENY, SHIPPED_SEAT_TOOL_POLICY, seatToolDenyFor, type PermissionPolicyConfig,
} from '../src/policy'
import { buildReviewRunCommand, reviewRunTimeoutMs, shellQuote, validateReviewTarget } from '../src/review-run'

const EMPTY: PermissionPolicyConfig = {}

describe('compound command splitting', () => {
  it('splits && || ; | and newlines, never inside quotes', () => {
    expect(splitCompoundCommand('a && b || c; d | e')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(splitCompoundCommand('echo "a && b" && rm x')).toEqual(['echo "a && b"', 'rm x'])
    expect(splitCompoundCommand('grep "a; b" file')).toEqual(['grep "a; b" file'])
    expect(splitCompoundCommand('ls\nrm x')).toEqual(['ls', 'rm x'])
  })
})

describe('bash pattern semantics', () => {
  it('bare token matches argv0 exactly (rm ≠ rmdir)', () => {
    expect(matchBashPattern('rm', 'rm -rf /x')).toBe(true)
    expect(matchBashPattern('rm', 'rmdir /x')).toBe(false)
    expect(matchBashPattern('shutdown', 'shutdown now')).toBe(true)
  })
  it('rm* binds the star to args, not the argv0 prefix', () => {
    expect(matchBashPattern('rm*', 'rm -rf /x')).toBe(true)
    expect(matchBashPattern('rm*', 'rmdir /x')).toBe(false)
  })
  it('space patterns glob the full command', () => {
    expect(matchBashPattern('git *', 'git status --short')).toBe(true)
    expect(matchBashPattern('chmod -R *', 'chmod -R 755 /srv')).toBe(true)
    expect(matchBashPattern('git *', 'gitk')).toBe(false)
  })
  it('strips env prefixes before matching', () => {
    expect(stripEnvPrefixes('FOO=1 BAR=2 rm -rf /x')).toBe('rm -rf /x')
  })
})

describe('resolution order (Oracle-amended)', () => {
  it('agent pattern outranks the agent tool policy (patterns first at every tier)', () => {
    const cfg: PermissionPolicyConfig = {
      agents: { fixer: { tools: { bash: 'ask' }, bashPatterns: [{ pattern: 'git commit*', policy: 'allow' }] } },
    }
    const d = resolvePolicy({ toolName: 'bash', command: 'git commit -m fix', agent: 'fixer', config: cfg })
    expect(d.kind).toBe('allow')
    expect(d.source).toContain('agent pattern')
  })

  it('compound: deny in ANY sub-command denies; ask aggregates upward', () => {
    const cfg: PermissionPolicyConfig = { tools: { bash: 'allow' }, bashPatterns: [{ pattern: 'rm', policy: 'ask' }, { pattern: 'dd*', policy: 'deny' }] }
    const d = resolvePolicy({ toolName: 'bash', command: 'git status && rm -rf /', config: cfg })
    expect(d.kind).toBe('ask')
    expect(d.source).toContain('pattern:rm')
    const d2 = resolvePolicy({ toolName: 'bash', command: 'rm x && dd if=/dev/zero of=/dev/sda', config: cfg })
    expect(d2.kind).toBe('deny')
    expect(d2.source).toContain('dd')
  })

  it('deny terminates before ask anywhere in the compound', () => {
    const cfg: PermissionPolicyConfig = { bashPatterns: [{ pattern: 'reboot', policy: 'deny' }, { pattern: 'rm', policy: 'ask' }] }
    const d = resolvePolicy({ toolName: 'bash', command: 'rm x ; reboot', config: cfg })
    expect(d.kind).toBe('deny')
    expect(d.source).toContain('pattern:reboot')
  })

  it('agent deny outranks a global allow', () => {
    const cfg: PermissionPolicyConfig = { tools: { web_search: 'allow' }, agents: { designer: { tools: { web_search: 'deny' } } } }
    expect(resolvePolicy({ toolName: 'web_search', agent: 'designer', config: cfg }).kind).toBe('deny')
    expect(resolvePolicy({ toolName: 'web_search', agent: 'fixer', config: cfg }).kind).toBe('allow')
  })

  it('read-only veto denies mutations regardless of policy', () => {
    const cfg: PermissionPolicyConfig = { tools: { bash: 'allow', edit: 'allow' } }
    expect(resolvePolicy({ toolName: 'bash', command: 'ls', config: cfg, sandboxMode: 'read-only' }).kind).toBe('deny')
    expect(resolvePolicy({ toolName: 'edit', config: cfg, sandboxMode: 'read-only' }).kind).toBe('deny')
    expect(resolvePolicy({ toolName: 'read', config: cfg, sandboxMode: 'read-only' }).kind).toBe('allow')
  })

  it('grants short-circuit an ask at the same granularity only', () => {
    const cfg: PermissionPolicyConfig = {
      tools: { bash: 'ask' },
      grants: { g1: { id: 'g1', tool: 'bash', pattern: 'rm' } },
    }
    // pattern ask + matching pattern grant → allow
    expect(resolvePolicy({ toolName: 'bash', command: 'rm -rf /tmp/x', config: cfg }).kind).toBe('allow')
    // a different asking pattern is NOT absorbed by a pattern grant
    expect(resolvePolicy({ toolName: 'bash', command: 'dd if=x of=y', config: cfg }).kind).toBe('ask')
    // tool-level grant (no pattern) never absorbs a pattern ask
    const cfg2: PermissionPolicyConfig = {
      tools: { bash: 'ask' },
      grants: { g2: { id: 'g2', tool: 'bash' } },
      bashPatterns: [{ pattern: 'rm', policy: 'ask' }],
    }
    expect(resolvePolicy({ toolName: 'bash', command: 'rm x', config: cfg2 }).kind).toBe('ask')
  })

  it('an allowed-always tool grant absorbs the unknown-tool ask', () => {
    // Historical live flow (session 297eded4): whiteboard_write asked from
    // `defaults`, the host wrote the standing grant on `allowed-always`, and
    // the next call in the same session resolved allow — no second approval.
    // The whiteboard now ships allowed as one family policy, so the ask is
    // re-created with an explicit `tools` row to keep the grant semantics
    // under test.
    const askCfg: PermissionPolicyConfig = { tools: { whiteboard_write: 'ask' }, defaults: { unknownTools: 'ask' } }
    expect(resolvePolicy({ toolName: 'whiteboard_write', agent: 'orchestrator', config: askCfg }).kind).toBe('ask')
    const granted = resolvePolicy({
      toolName: 'whiteboard_write',
      agent: 'orchestrator',
      config: { ...askCfg, grants: { g: { id: 'g', tool: 'whiteboard_write' } } },
    })
    expect(granted).toMatchObject({ kind: 'allow', source: 'grant:tool' })
  })

  it('read-only introspection ships allowed, unknown mutations still ask', () => {
    const config: PermissionPolicyConfig = { defaults: { unknownTools: 'ask' } }
    for (const toolName of ['session_debug', 'diagnostics_report', 'fast_report', 'session_search']) {
      expect(resolvePolicy({ toolName, agent: 'orchestrator', config })).toMatchObject({ kind: 'allow' })
    }
    for (const toolName of ['some_unknown_tool', 'brand_new_mutation']) {
      expect(resolvePolicy({ toolName, agent: 'orchestrator', config }).kind).toBe('ask')
    }
  })

  it('the whiteboard is one permanent family policy (all five tools ship allowed)', () => {
    // Operator decision 2026-09-26: the per-feature asks (read/write/pin/
    // unpin grants) fold into one shipped family policy; the curated
    // `whiteboard_*` row in the Permissions UI edits this family as one entry.
    const config: PermissionPolicyConfig = { defaults: { unknownTools: 'ask' } }
    for (const toolName of ['whiteboard_read', 'whiteboard_write', 'whiteboard_pin', 'whiteboard_unpin', 'whiteboard_forget']) {
      expect(SHIPPED_TOOL_DEFAULTS[toolName]).toBe('allow')
      expect(resolvePolicy({ toolName, agent: 'orchestrator', config })).toMatchObject({ kind: 'allow', source: 'matrix:global' })
    }
    // An operator row still outranks the shipped family default.
    expect(resolvePolicy({ toolName: 'whiteboard_write', config: { tools: { whiteboard_write: 'deny' } } }).kind).toBe('deny')
  })

  it('agent-scoped grants only apply to that agent', () => {
    const cfg: PermissionPolicyConfig = {
      tools: { bash: 'ask' },
      grants: { g3: { id: 'g3', tool: 'bash', agent: 'fixer' } },
    }
    // The shipped catch-all now allows unpatterned commands — the grant only
    // matters when the tool-level policy would ask (a bare bash with no
    // patterns at all). Scope both to a patternless-ask config to keep the
    // grant-tier semantics under test.
    expect(resolvePolicy({ toolName: 'bash', command: 'ls', agent: 'fixer', config: cfg }).kind).toBe('allow')
    // The shipped catch-all allows unpatterned commands, so the agent-scope
    // grant check must use a config that makes THIS command ask: an explicit
    // user pattern (user patterns outrank the shipped catch-all).
    const designerCfg: PermissionPolicyConfig = { tools: { bash: 'ask' }, grants: cfg.grants, bashPatterns: [{ pattern: 'ls', policy: 'ask' }] }
    expect(resolvePolicy({ toolName: 'bash', command: 'ls', agent: 'designer', config: designerCfg }).kind).toBe('ask')
  })

  it('hidden surfaces: substitution/wrapper with a dangerous verb asks', () => {
    expect(resolvePolicy({ toolName: 'bash', command: 'echo $(rm -rf /tmp/x)', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'bash -c "rm -rf /tmp/x"', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'find . | xargs rm', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'echo `rm file`', config: EMPTY }).kind).toBe('ask')
    // plain dangerous commands already ask structurally
    expect(resolvePolicy({ toolName: 'bash', command: 'rm -rf /tmp/x', config: EMPTY }).kind).toBe('ask')
    // a benign hidden surface stays allowed
    expect(resolvePolicy({ toolName: 'bash', command: 'echo $(date)', config: EMPTY }).kind).toBe('allow')
    // git rm is structurally matched by `git *` and has no hidden surface
    expect(resolvePolicy({ toolName: 'bash', command: 'git rm file.txt', config: EMPTY }).kind).toBe('allow')
  })

  it('opaque executors ask (payload pipes and inline interpreter code)', () => {
    expect(resolvePolicy({ toolName: 'bash', command: 'echo cm0= | base64 -d | bash', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'bash script.sh', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'python -c "import os; os.remove(\'x\')"', config: EMPTY }).kind).toBe('ask')
    // A shell wrapper with statically readable inner text is evaluated by the
    // same rules (guard relax 2026-09-30): a benign inner does not ask...
    expect(resolvePolicy({ toolName: 'bash', command: 'sh -c "ls"', config: EMPTY }).kind).toBe('allow')
    // ...while an inner that is a shell expansion cannot be read statically.
    expect(resolvePolicy({ toolName: 'bash', command: 'sh -c "$CMD"', config: EMPTY }).kind).toBe('ask')
    // The denial names the supported alternative (2026-09-27: a child used
    // python3 -c to read a JSON file and lost its turn to the auto-deny).
    const py = resolvePolicy({ toolName: 'bash', command: 'python3 -c "print(1)"', config: EMPTY })
    expect(py.kind).toBe('ask')
    expect(py.reason).toContain('read, grep, or glob')
    // plain interpreter invocations of a file are ordinary work
    expect(resolvePolicy({ toolName: 'bash', command: 'python script.py --flag', config: EMPTY }).kind).toBe('allow')
    // an Always-allow grant pins the exact command
    const cfg = { grants: { g: { id: 'g', tool: 'bash', pattern: 'bash script.sh' } } }
    expect(resolvePolicy({ toolName: 'bash', command: 'bash script.sh', config: cfg }).kind).toBe('allow')
  })

  it('version/help-only interpreter invocations run free (guard relax 2026-09-30)', () => {
    // The operator's system probe was asked and lost in an unattended session:
    // a version flag executes no user code, so it does not ask.
    expect(resolvePolicy({ toolName: 'bash', command: 'fish --version', config: EMPTY }))
      .toMatchObject({ kind: 'allow', source: 'scan:interpreter-version' })
    expect(resolvePolicy({ toolName: 'bash', command: 'bash --help', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: 'python3 -V', config: EMPTY }).kind).toBe('allow')
    // A bare interpreter, a shell script path, and an unreadable wrapper keep asking.
    expect(resolvePolicy({ toolName: 'bash', command: 'fish', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'fish script.fish', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'bash script.sh', config: EMPTY }).kind).toBe('ask')
    // A mixed invocation is not a version probe.
    expect(resolvePolicy({ toolName: 'bash', command: 'fish --version && rm x', config: EMPTY }).kind).toBe('ask')
  })

  it('shell wrappers are split and evaluated recursively, bounded by depth', () => {
    expect(resolvePolicy({ toolName: 'bash', command: "bash -c 'rm -rf /tmp/x'", config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: "timeout 30 bash -c 'lspci'", config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: "bash -c \"bash -c 'rm'\"", config: EMPTY }).kind).toBe('ask')
    // `env` prefixes are skipped too, and a benign inner at every level allows.
    expect(resolvePolicy({ toolName: 'bash', command: "env LC_ALL=C timeout 60 bash -c 'lspci; uptime'", config: EMPTY }).kind).toBe('allow')
    // Three nested wrappers with a benign inner still resolve; the fourth is
    // past the bound and asks rather than recursing forever.
    expect(resolvePolicy({ toolName: 'bash', command: "bash -c 'bash -c \"bash -c ls\"'", config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({
      toolName: 'bash',
      command: 'bash -c "bash -c \'bash -c \\"bash -c ls\\"\'"',
      config: EMPTY,
    }).kind).toBe('ask')
    // A wrapper inner that is an expansion keeps the pre-recursion ask.
    expect(resolvePolicy({ toolName: 'bash', command: 'bash -c "$CMD"', config: EMPTY }).kind).toBe('ask')
  })

  it('allows the operator read-only probe inside a wrapper (no dangerous verb present)', () => {
    const probe = "timeout 60 bash -c 'lspci; ls /dev/nvidia*; df -hT; lsblk; . /etc/os-release; uname -rm; uptime'"
    expect(resolvePolicy({ toolName: 'bash', command: probe, config: EMPTY })).toMatchObject({ kind: 'allow' })
    // The false positive was `-rm` inside `uname -rm` (a flag, not a verb) and
    // a quoted `bash -c` wrapper with no extractable-in-the-old-scan inner.
    expect(resolvePolicy({ toolName: 'bash', command: 'uname -rm', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: 'echo -rm', config: EMPTY }).kind).toBe('allow')
    // The release-file idiom allows; sourcing any other file runs its code.
    expect(resolvePolicy({ toolName: 'bash', command: 'source /etc/lsb-release', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: 'source /tmp/evil.sh', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: '. /etc/profile', config: EMPTY }).kind).toBe('ask')
  })

  it('expansions: an argument is not an ask by itself, a command word is opaque', () => {
    expect(resolvePolicy({ toolName: 'bash', command: 'echo "$HOME"', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: 'echo "$NAME"', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: 'df -hT "$HOME"', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: '$CMD', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: '$(which node) --version', config: EMPTY }).kind).toBe('ask')
    // A pipe target is still an interpreter invocation.
    expect(resolvePolicy({ toolName: 'bash', command: 'curl x | sh', config: EMPTY }).kind).toBe('ask')
    // `git *` still allows git sub-commands that contain no hidden surface.
    expect(resolvePolicy({ toolName: 'bash', command: 'git rm file.txt', config: EMPTY }).kind).toBe('allow')
  })

  it('multi-line compound commands evaluate every line', () => {
    expect(resolvePolicy({ toolName: 'bash', command: 'ls -la\nrm -rf /tmp/x', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'ls -la\necho done', config: EMPTY }).kind).toBe('allow')
  })

  it('memory tools are allowed by default (sub-agents remember)', () => {
    expect(resolvePolicy({ toolName: 'memory_save', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'memory_search', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'memory_rescind', config: EMPTY }).kind).toBe('allow')
  })

  it('mcp wildcards: exact > server > family > default', () => {
    const cfg: PermissionPolicyConfig = { tools: { 'mcp__plane__*': 'ask' } }
    expect(resolvePolicy({ toolName: 'mcp__plane__create_page', config: cfg }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'mcp__ue__do_thing', config: cfg }).kind).toBe('allow')   // unconfigured MCP tool defaults to allow!
    const cfg2: PermissionPolicyConfig = { tools: { 'mcp__plane__create_page': 'allow', 'mcp__*': 'deny' } }
    expect(resolvePolicy({ toolName: 'mcp__plane__create_page', config: cfg2 }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'mcp__ue__do_thing', config: cfg2 }).kind).toBe('deny')
    const cfg3: PermissionPolicyConfig = { tools: { 'mcp__plane__*': 'allow' } }
    expect(resolvePolicy({ toolName: 'mcp__plane__create_page', config: cfg3 }).kind).toBe('allow')
  })

  it('mcp wildcards resolve the server by the longest known catalog name (a__b ids)', () => {
    const cfg: PermissionPolicyConfig = { tools: { 'mcp__a__*': 'ask', 'mcp__a__b__*': 'deny' } }
    // No catalog: the legacy `__` split keys `mcp__a__*`.
    expect(mcpLadder('mcp__a__b__do_thing', cfg.tools)).toMatchObject({ kind: 'ask', source: 'matrix:mcp__a__*' })
    // Catalog knows both `a` and `a__b`: the longest prefix wins.
    expect(mcpLadder('mcp__a__b__do_thing', cfg.tools, ['a', 'a__b'])).toMatchObject({ kind: 'deny', source: 'matrix:mcp__a__b__*' })
    // A tool whose own name contains `__` still resolves its server.
    const cfg2: PermissionPolicyConfig = { tools: { 'mcp__a__b__*': 'deny' } }
    expect(mcpLadder('mcp__a__b__create__page', cfg2.tools, ['a', 'a__b'])).toMatchObject({ kind: 'deny', source: 'matrix:mcp__a__b__*' })
  })

  it('mcp wildcards: normal catalog id, unknown server fallback, tool-name __', () => {
    const cfg: PermissionPolicyConfig = { tools: { 'mcp__plane__*': 'ask' } }
    expect(mcpLadder('mcp__plane__create_page', cfg.tools, ['plane'])).toMatchObject({ kind: 'ask', source: 'matrix:mcp__plane__*' })
    expect(resolvePolicy({ toolName: 'mcp__plane__create_page', config: cfg, mcpServerNames: ['plane'] }).kind).toBe('ask')
    // Unknown server (left the catalog): the `__` split still applies.
    const cfg2: PermissionPolicyConfig = { tools: { 'mcp__ghost__*': 'deny' } }
    expect(mcpLadder('mcp__ghost__tool', cfg2.tools, ['plane'])).toMatchObject({ kind: 'deny', source: 'matrix:mcp__ghost__*' })
    // Server name derivation mirrors the mount and the client grouping.
    expect(mcpServerNameOf('plane-mcp', { serverName: 'plane' })).toBe('plane')
    expect(mcpServerNameOf('a__b', {})).toBe('a__b')
    expect(mcpServerNameOf('other-mcp', undefined)).toBe('other')
  })

  it('a child-role ask resolves the role id and the grant record keeps it without scoping', () => {
    expect(agentRoleOf(undefined)).toBeUndefined()
    expect(agentRoleOf({ session: { header: {} } })).toBeUndefined()
    expect(agentRoleOf({ session: { header: { agentPreset: 'fixer' } } })).toBe('fixer')
    expect(agentRoleOf({ session: { header: { meta: { agentPreset: 'oracle' } } } })).toBe('oracle')
    // Projection reader (current preset) outranks the creation-time header.
    expect(agentRoleOf({ session: { header: { agentPreset: 'fixer' } } }, () => 'designer')).toBe('designer')
    // Last resort: a logged selection when neither header nor projection exist.
    expect(agentRoleOf({ session: { ownEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'fixer' } }] } })).toBe('fixer')

    const agent = agentRoleOf({ session: { header: { agentPreset: 'fixer' } } })
    const proposal = grantProposalFor({ kind: 'ask', reason: 'x', source: 'defaults', grantTier: 'tool' }, 'whiteboard_write', undefined, agent)
    expect(proposal).toEqual({ tool: 'whiteboard_write', agent: 'fixer' })
    const record = standingGrantRecord('g-new', proposal, '2026-09-23T00:00:00.000Z')
    expect(record).toMatchObject({ tool: 'whiteboard_write', agent: 'fixer', global: true })
    // The whiteboard now ships allowed; an explicit `ask` row re-creates the
    // grant-absorption path. The recorded agent is audit-only: a different
    // agent is still absorbed.
    const globalCfg = { tools: { whiteboard_write: 'ask' as const }, grants: { 'g-new': record } }
    expect(resolvePolicy({ toolName: 'whiteboard_write', agent: 'orchestrator', config: globalCfg }).kind).toBe('allow')
    // An agent-scoped grant (no `global`) still scopes, exactly as before.
    const scopedCfg = { tools: { whiteboard_write: 'ask' as const }, grants: { g2: { id: 'g2', tool: 'whiteboard_write', agent: 'fixer' } } }
    expect(resolvePolicy({ toolName: 'whiteboard_write', agent: 'orchestrator', config: scopedCfg }).kind).toBe('ask')
  })

  it('unconfigured tools default to ask; unpatterned bash runs free (catch-all)', () => {
    expect(resolvePolicy({ toolName: 'brand_new_tool', config: EMPTY }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'read', config: EMPTY }).kind).toBe('allow')
    // The OpenCode model: unpatterned commands allow; only the dangerous
    // list asks.
    expect(resolvePolicy({ toolName: 'bash', command: 'ls', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: 'rm -rf /tmp/x', config: EMPTY }).kind).toBe('ask')
  })

  it('shipped defaults: operator-like flow works out of the box', () => {
    expect(SHIPPED_TOOL_DEFAULTS.edit).toBe('allow')
    expect(SHIPPED_TOOL_DEFAULTS.bash).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'git status', config: EMPTY }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: 'shutdown now', config: EMPTY }).kind).toBe('ask')
  })

  it('present is allowed by the shipped row for any role that carries it, even unattended', () => {
    // Delivery-only tool: no ask means the unattended pre-execute hook returns
    // next() instead of parking on the absent client.
    expect(SHIPPED_TOOL_DEFAULTS.present).toBe('allow')
    for (const agent of ['orchestrator', 'fixer']) {
      const decision = resolvePolicy({
        toolName: 'present',
        agent,
        config: { defaults: { unknownTools: 'ask' } },
      })
      expect(decision).toEqual({ kind: 'allow', source: 'matrix:global' })
    }
    // The row resolves for an agent id the policy table does not name, too.
    expect(resolvePolicy({
      toolName: 'present',
      config: { defaults: { unknownTools: 'ask' } },
    })).toEqual({ kind: 'allow', source: 'matrix:global' })
    // The explicit row is the only change: unknownTools still asks, and an
    // operator row still outranks the shipped default.
    expect(resolvePolicy({ toolName: 'brand_new_tool', config: { defaults: { unknownTools: 'ask' } } }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'present', config: { tools: { present: 'ask' } } }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'present', agent: 'fixer', config: { agents: { fixer: { tools: { present: 'deny' } } } } }).kind).toBe('deny')
  })
})

describe('danger-list always-allow pins the exact command', () => {
  it('the default always-allow pins the exact raw command and re-allows only it', () => {
    const ask = resolvePolicy({ toolName: 'bash', command: 'rm -rf /tmp/a', config: EMPTY })
    expect(ask).toMatchObject({ kind: 'ask', grantTier: 'pattern', pattern: 'rm', broadAllow: { label: 'rm' } })
    const proposal = grantProposalFor(ask, 'bash', 'rm -rf /tmp/a', 'fixer')
    expect(proposal).toEqual({ tool: 'bash', pattern: 'rm -rf /tmp/a', broadPattern: 'rm', agent: 'fixer' })
    // The default outcome writes the exact pin, never the broad rule pattern.
    const exact = grantProposalForOutcome(proposal, false)
    expect(exact).toMatchObject({ pattern: 'rm -rf /tmp/a' })
    const cfg: PermissionPolicyConfig = {
      grants: { g: standingGrantRecord('g', exact, '2026-09-27T00:00:00.000Z') },
    }
    const same = resolvePolicy({ toolName: 'bash', command: 'rm -rf /tmp/a', config: cfg })
    expect(same).toMatchObject({ kind: 'allow', source: 'grant:command' })
    // A verb-level grant is no longer implied by an exact pin: a different rm asks again.
    expect(resolvePolicy({ toolName: 'bash', command: 'rm -rf /tmp/b', config: cfg }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'bash', command: 'rm /tmp/b', config: cfg }).kind).toBe('ask')
  })

  it('the explicit broad action still works (rule-level pin absorbs every rm)', () => {
    const ask = resolvePolicy({ toolName: 'bash', command: 'rm -rf /tmp/a', config: EMPTY })
    const proposal = grantProposalFor(ask, 'bash', 'rm -rf /tmp/a', undefined)
    const broad = grantProposalForOutcome(proposal, true)
    expect(broad).toMatchObject({ pattern: 'rm' })
    const cfg: PermissionPolicyConfig = { grants: { g: standingGrantRecord('g', broad, '2026-09-27T00:00:00.000Z') } }
    expect(resolvePolicy({ toolName: 'bash', command: 'rm -rf /tmp/anything', config: cfg }))
      .toMatchObject({ kind: 'allow', source: 'grant:pattern:rm' })
  })

  it('names the broad verb for every danger rail and no other rule', () => {
    expect(dangerVerbOfPattern('rm')).toBe('rm')
    expect(dangerVerbOfPattern('rm *')).toBe('rm')
    expect(dangerVerbOfPattern('dd*')).toBe('dd')
    expect(dangerVerbOfPattern('chmod -R *')).toBe('chmod')
    expect(dangerVerbOfPattern('mkfs.ext4 *')).toBe('mkfs.ext4')
    expect(dangerVerbOfPattern('git *')).toBeUndefined()
    expect(dangerVerbOfPattern('*')).toBeUndefined()
    for (const pattern of ['rm', 'rmdir', 'unlink', 'dd', 'shutdown', 'reboot', 'chmod -R *', 'chown -R *']) {
      expect(dangerVerbOfPattern(pattern)).toBeDefined()
    }
    // A non-danger bash rule keeps the historical rule-pattern pin.
    const ask = resolvePolicy({ toolName: 'bash', command: 'docker run img', config: { bashPatterns: [{ pattern: 'docker *', policy: 'ask' }] } })
    expect(ask).toMatchObject({ kind: 'ask', pattern: 'docker *' })
    expect((ask as { broadAllow?: unknown }).broadAllow).toBeUndefined()
    const safeProposal = grantProposalFor(ask, 'bash', 'docker run img', undefined)
    expect(safeProposal).toEqual({ tool: 'bash', pattern: 'docker *' })
    // The safe verb's default always-allow writes the rule pattern (no exact pin).
    expect(grantProposalForOutcome(safeProposal, false)).toEqual({ tool: 'bash', pattern: 'docker *' })
  })

  it('path-less patterns match the command word basename and version stem', () => {
    // The danger scan already treats /bin/rm as `rm`; the structural rule
    // matcher now does too, so the ask cannot be sidestepped with a path.
    expect(matchBashPattern('rm', '/bin/rm -rf /tmp/x')).toBe(true)
    expect(matchBashPattern('rm', '/usr/bin/rmdir /tmp/x')).toBe(false)
    expect(matchBashPattern('rm *', '/bin/rm -rf /tmp/x')).toBe(true)
    expect(matchBashPattern('chmod -R *', '/bin/chmod -R 777 /tmp/x')).toBe(true)
    expect(matchBashPattern('shutdown', '/sbin/shutdown now')).toBe(true)
    // A version suffix normalizes for membership (`mkfs*` catches mkfs.ext4).
    expect(matchBashPattern('mkfs*', 'mkfs.ext4 /dev/sdb1')).toBe(true)
    expect(matchBashPattern('mkfs*', '/sbin/mkfs.ext4 /dev/sdb1')).toBe(true)
    expect(matchBashPattern('rm*', 'rmdir /x')).toBe(false)
    // A pattern that names a path keeps literal matching.
    expect(matchBashPattern('/usr/bin/rm', '/usr/bin/rm -rf /tmp/x')).toBe(true)
    expect(matchBashPattern('/usr/bin/rm', '/bin/rm -rf /tmp/x')).toBe(false)
  })

  it('the card copy states the exact scope of "Always allow" for a danger rail only', () => {
    const danger = resolvePolicy({ toolName: 'bash', command: 'rm -f /tmp/a', config: EMPTY })
    expect(danger.kind).toBe('ask')
    const dangerReason = (danger as { reason: string }).reason
    expect(dangerReason).toContain('"Always allow" grants this exact command only')
    expect(dangerReason).toContain('"Allow all rm" grants every rm command')
    // A safe verb's ask says nothing about an exact command: its default pin IS
    // the rule pattern, so the added sentence would be false there.
    const safe = resolvePolicy({
      toolName: 'bash',
      command: 'mkdir /tmp/x',
      config: { bashPatterns: [{ pattern: 'mkdir *', policy: 'ask' }] },
    })
    expect((safe as { reason: string }).reason).not.toContain('Always allow')
    expect((safe as { reason: string }).reason).toBe('bash rule "mkdir *" requires approval')
  })
})

describe('guard regression corpus (2026-10-02): danger vocabulary × forms', () => {
  // The shipped danger rules crossed with the forms an operator can write:
  // bare, flags, absolute path, wrapper shell, expansion, xargs, assignment,
  // and command prefixes (`sudo`/`doas`/`nice`/`env`/`command`/`timeout`).
  // Every one must ask or deny — never fall through to the catch-all.
  const DANGER_CORPUS: readonly string[] = [
    'rm /tmp/x',
    'rm -f /tmp/x',
    'rm -rf /tmp/x',
    'rm -r /tmp/x',
    '/bin/rm /tmp/x',
    '/usr/bin/rm -rf /tmp/x',
    'bash -c "rm -f /tmp/x"',
    "sh -c 'rm -rf /tmp/x'",
    'timeout 30 bash -c "rm -f /tmp/x"',
    'env FOO=1 bash -c "rm -f /tmp/x"',
    'echo $(rm -f /tmp/x)',
    'echo `rm -f /tmp/x`',
    '$(rm -f /tmp/x)',
    'echo /tmp/x | xargs rm',
    'xargs rm < /tmp/list',
    'tmp=$(mktemp); rm "$tmp"',
    'rmdir /tmp/x',
    '/bin/rmdir /tmp/x',
    'unlink /tmp/x',
    '/usr/bin/unlink /tmp/x',
    'dd if=/dev/zero of=/tmp/x bs=1 count=1',
    '/bin/dd if=/dev/zero of=/tmp/x',
    'fdisk /dev/sdb',
    '/sbin/fdisk /dev/sdb',
    'mkfs /dev/sdb1',
    'mkfs.ext4 /dev/sdb1',
    '/sbin/mkfs.ext4 /dev/sdb1',
    'shutdown now',
    '/sbin/shutdown now',
    'reboot',
    '/sbin/reboot',
    'poweroff',
    '/sbin/poweroff',
    'halt',
    '/sbin/halt',
    'chmod -R 777 /tmp/x',
    '/bin/chmod -R 777 /tmp/x',
    'chown -R adam /tmp/x',
    '/bin/chown -R adam /tmp/x',
    // Irreversible vocabulary (2026-10-02 lane): secure erase, truncation, and
    // find's own destructive forms.
    'shred /tmp/x',
    'shred -u /tmp/x',
    '/usr/bin/shred -u /tmp/x',
    'truncate -s 0 /tmp/x',
    '/usr/bin/truncate -s 0 /tmp/x',
    'find /tmp -delete',
    "find /tmp -name '*.tmp' -delete",
    'find /tmp -exec rm -f {} +',
    "find /tmp -exec rm -f {} \\;",
    'find /tmp -execdir rm -f {} +',
    'find /tmp -exec /bin/rm -f {} \\;',
    // Command-prefix transparency: the danger scan sees the command that runs.
    'sudo rm -f /tmp/x',
    '/usr/bin/sudo rm -f /tmp/x',
    'doas rm -f /tmp/x',
    'nice rm -f /tmp/x',
    'nice -n 10 rm -rf /tmp/x',
    'env FOO=1 rm -f /tmp/x',
    'command rm -f /tmp/x',
    'timeout 30 rm -f /tmp/x',
    'sudo -u root rm -f /tmp/x',
    'sudo bash -c "rm -f /tmp/x"',
    'sudo shred -u /tmp/x',
    'nice truncate -s 0 /tmp/x',
    'sudo find /tmp -delete',
    'sudo find /tmp -execdir rm -f {} +',
    'sudo -i',
    'doas -s',
  ]

  // The benign shapes the guard-relax pass (2026-09-30) must keep allowing:
  // unreadable-file probes, --version invocations, read-only bash -c probes,
  // and the wrappers' own non-executing forms.
  const BENIGN_CORPUS: readonly string[] = [
    'fish --version',
    'bash --version',
    'python3 --version',
    'uname -rm',
    'echo -rm',
    'echo "$HOME"',
    "timeout 60 bash -c 'lspci; ls /dev/nvidia*; df -hT; lsblk; . /etc/os-release; uname -rm; uptime'",
    'timeout 30 bash -c "lspci"',
    'ls -la /tmp',
    'cat /etc/os-release',
    '. /etc/os-release',
    'git status',
    'grep -rn "rm " /tmp/x',
    // Prefix transparency must not turn benign wrapper probes into asks.
    'command -v rm',
    'command -V ls',
    'command -v sudo',
    'nice --version',
    'sudo --version',
    'sudo ls /tmp',
    'sudo -n true',
    'env FOO=1 ls',
    'timeout 30 ls',
    'nice -n 10 ls',
    'env',
    'find /tmp -name "*.tmp"',
    'find /tmp -type f',
    'grep -rn "shred" /tmp/x',
    'echo truncate',
  ]

  it('every danger form asks or denies (shipped defaults, no grants)', () => {
    for (const command of DANGER_CORPUS) {
      const decision = resolvePolicy({ toolName: 'bash', command, config: EMPTY })
      if (decision.kind === 'allow') throw new Error(`danger form allowed: ${command} (${decision.source})`)
    }
  })

  it('every benign form allows (shipped defaults, no grants)', () => {
    for (const command of BENIGN_CORPUS) {
      expect(resolvePolicy({ toolName: 'bash', command, config: EMPTY }).kind).toBe('allow')
    }
  })

  it('sees through command wrappers and names the danger rule', () => {
    for (const command of [
      'sudo rm -f /tmp/x',
      'doas rm -f /tmp/x',
      'nice -n 10 rm -rf /tmp/x',
      'env FOO=1 rm -f /tmp/x',
      'command rm -f /tmp/x',
      'timeout 30 rm -f /tmp/x',
      'sudo -u root rm -f /tmp/x',
    ]) {
      expect(resolvePolicy({ toolName: 'bash', command, config: EMPTY })).toMatchObject({ kind: 'ask', pattern: 'rm' })
    }
    // A `command -v`/`-V` query reports a path; it never runs the operand.
    expect(resolvePolicy({ toolName: 'bash', command: 'command -v rm', config: EMPTY }))
      .toMatchObject({ kind: 'allow', source: 'scan:command-query' })
    // A privilege wrapper with no command word is an interactive root shell.
    expect(resolvePolicy({ toolName: 'bash', command: 'sudo -i', config: EMPTY }))
      .toMatchObject({ kind: 'ask', source: 'scan:privileged-shell' })
    expect(resolvePolicy({ toolName: 'bash', command: 'sudo --version', config: EMPTY }).kind).toBe('allow')
  })

  it('asks for the irreversible vocabulary and labels its broad action', () => {
    for (const command of [
      'shred -u /tmp/x',
      'truncate -s 0 /tmp/x',
      'find /tmp -delete',
      "find /tmp -name '*.tmp' -delete",
      'find /tmp -exec rm -f {} +',
      'find /tmp -execdir rm -f {} +',
    ]) {
      expect(resolvePolicy({ toolName: 'bash', command, config: EMPTY }).kind).toBe('ask')
    }
    // shred/truncate are danger-list verbs: the card offers the broad action.
    expect(resolvePolicy({ toolName: 'bash', command: 'shred -u /tmp/x', config: EMPTY }))
      .toMatchObject({ broadAllow: { label: 'shred' } })
    expect(resolvePolicy({ toolName: 'bash', command: 'truncate -s 0 /tmp/x', config: EMPTY }))
      .toMatchObject({ broadAllow: { label: 'truncate' } })
    // find is an ordinary rule: its default always-allow pins the rule pattern.
    expect(resolvePolicy({ toolName: 'bash', command: 'find /tmp -delete', config: EMPTY }))
      .toMatchObject({ pattern: 'find * -delete*' })
  })

  it('a standing grant never silences a delegated child danger form', () => {
    // The 2026-10-02 live incident: the global "Allow all rm" proof grant made
    // a delegated fixer's `rm -f /tmp/enpoi-approval-test` resolve allow with
    // no ask, so the forwarder never ran. A main session keeps the grant; a
    // child must surface the ask to the forwarding path.
    const grants: PermissionPolicyConfig['grants'] = {
      'g-exact': { id: 'g-exact', tool: 'bash', pattern: 'rm /tmp/opencode/grant-proof-one/victim-1.txt', agent: 'orchestrator', global: true },
      'g-broad': { id: 'g-broad', tool: 'bash', pattern: 'rm', agent: 'orchestrator', global: true },
    }
    const config: PermissionPolicyConfig = { grants }
    // Main session: the recorded consent still short-circuits.
    expect(resolvePolicy({ toolName: 'bash', command: 'rm -f /tmp/x', agent: 'orchestrator', config }))
      .toMatchObject({ kind: 'allow', source: 'grant:pattern:rm' })
    expect(resolvePolicy({ toolName: 'bash', command: 'rm /tmp/opencode/grant-proof-one/victim-1.txt', agent: 'orchestrator', config }))
      .toMatchObject({ kind: 'allow', source: 'grant:command' })
    // Delegated child: the ask must survive for the forwarder (rails first).
    for (const command of ['rm -f /tmp/enpoi-approval-test', 'rm /tmp/opencode/grant-proof-one/victim-1.txt', 'rm -rf /tmp/x']) {
      expect(resolvePolicy({ toolName: 'bash', command, agent: 'orchestrator', delegated: true, config }).kind).toBe('ask')
    }
    // A safe-verb rule behaves the same way: a child's ask forwards, the
    // main session's grant still short-circuits.
    const safeConfig: PermissionPolicyConfig = {
      bashPatterns: [{ pattern: 'mkdir *', policy: 'ask' }],
      grants: { g: { id: 'g', tool: 'bash', pattern: 'mkdir *', global: true } },
    }
    expect(resolvePolicy({ toolName: 'bash', command: 'mkdir /tmp/x', agent: 'orchestrator', config: safeConfig }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'bash', command: 'mkdir /tmp/x', agent: 'orchestrator', delegated: true, config: safeConfig }).kind).toBe('ask')
  })

  it('a tool-level grant never silences a delegated child ask either', () => {
    const config: PermissionPolicyConfig = {
      tools: { whiteboard_write: 'ask' },
      defaults: { unknownTools: 'ask' },
      grants: { g: { id: 'g', tool: 'whiteboard_write' } },
    }
    expect(resolvePolicy({ toolName: 'whiteboard_write', agent: 'orchestrator', config }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'whiteboard_write', agent: 'orchestrator', delegated: true, config }).kind).toBe('ask')
    const unknown: PermissionPolicyConfig = { defaults: { unknownTools: 'ask' }, grants: { g: { id: 'g', tool: 'brand_new_tool' } } }
    expect(resolvePolicy({ toolName: 'brand_new_tool', agent: 'orchestrator', config: unknown }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: 'brand_new_tool', agent: 'orchestrator', delegated: true, config: unknown }).kind).toBe('ask')
  })
})

describe('reviewer-exec policy seat', () => {
  it('allows review_run for reviewer/oracle seats and denies every other role', () => {
    for (const role of REVIEW_ROLES) {
      expect(resolvePolicy({ toolName: REVIEW_RUN_TOOL, agent: role, config: EMPTY }))
        .toEqual({ kind: 'allow', source: 'review:seat' })
    }
    expect(resolvePolicy({ toolName: REVIEW_RUN_TOOL, agent: 'fixer', config: EMPTY }).kind).toBe('deny')
    expect(resolvePolicy({ toolName: REVIEW_RUN_TOOL, config: EMPTY }).kind).toBe('deny')
    // The seat's grant is not weakened by an operator ask row, and no other
    // bash grant interacts with it.
    expect(resolvePolicy({ toolName: REVIEW_RUN_TOOL, agent: 'oracle', config: { tools: { [REVIEW_RUN_TOOL]: 'ask' } } }).kind).toBe('allow')
  })

  it('honors the descriptor-derived reviewer flag for a delegated child', () => {
    const child = { session: { header: { agentPreset: 'orchestrator' } } }
    expect(reviewerSeatOf(child)).toBe(false)
    expect(resolvePolicy({ toolName: REVIEW_RUN_TOOL, agent: 'orchestrator', reviewer: false, config: EMPTY }).kind).toBe('deny')
    expect(resolvePolicy({ toolName: REVIEW_RUN_TOOL, agent: 'orchestrator', reviewer: true, config: EMPTY }))
      .toEqual({ kind: 'allow', source: 'review:seat' })
  })

  it('identifies reviewer children from the newest subagent descriptor, not the parent preset', () => {
    expect(reviewerSeatOf(undefined)).toBe(false)
    expect(reviewerSeatOf({ session: { header: { agentPreset: 'fixer' } } })).toBe(false)
    expect(reviewerSeatOf({ session: { header: { agentPreset: 'oracle' } } })).toBe(true)
    // The oracle child's label/persona are written by the spawning tool.
    expect(reviewerSeatOf({
      session: {
        header: { agentPreset: 'orchestrator' },
        ownEvents: () => [{ type: 'subagent/descriptor', data: { label: 'oracle review: plan', persona: 'You are the Oracle — senior reviewer.' } }],
      },
    })).toBe(true)
    expect(reviewerSeatOf({
      session: {
        header: { agentPreset: 'orchestrator' },
        ownEvents: () => [{ type: 'subagent/descriptor', data: { persona: 'You are the Oracle — senior reviewer.' } }],
      },
    })).toBe(true)
    // A writer child with the same parent preset is refused.
    expect(reviewerSeatOf({
      session: {
        header: { agentPreset: 'orchestrator' },
        ownEvents: () => [{ type: 'subagent/descriptor', data: { label: 'fixer: probe', persona: 'You are the Fixer — implementation specialist.' } }],
      },
    })).toBe(false)
    // Only the NEWEST descriptor counts.
    expect(reviewerSeatOf({
      session: {
        header: { agentPreset: 'orchestrator' },
        ownEvents: () => [
          { type: 'subagent/descriptor', data: { label: 'oracle review: first' } },
          { type: 'subagent/descriptor', data: { label: 'fixer: second' } },
        ],
      },
    })).toBe(false)
  })

  it('builds fixed runner argv with one quoted, validated target', () => {
    expect(buildReviewRunCommand('pytest', undefined)).toBe('python3 -m pytest -q')
    expect(buildReviewRunCommand('pytest', 'tests/unit/test_x.py')).toBe("python3 -m pytest -q 'tests/unit/test_x.py'")
    expect(buildReviewRunCommand('go-test', undefined)).toBe("go test './...'")
    expect(() => buildReviewRunCommand('rm', undefined)).toThrow(/unknown runner/)
    expect(() => buildReviewRunCommand('pytest', '../etc/passwd')).toThrow(/no `..`/)
    expect(() => buildReviewRunCommand('pytest', '/etc/passwd')).toThrow(/workspace-relative/)
    expect(() => buildReviewRunCommand('pytest', 'a; rm -rf /')).toThrow(/may contain only/)
    expect(validateReviewTarget('tests/unit/test_x.py')).toBe('tests/unit/test_x.py')
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
    expect(reviewRunTimeoutMs(undefined)).toBe(120_000)
    expect(reviewRunTimeoutMs(1)).toBe(1000)
    expect(reviewRunTimeoutMs(9999)).toBe(600_000)
  })
})

describe('never-policy tool surface (forwarding makes asks usable)', () => {
  const TOOLS = ['read', 'bash', 'oracle_review', 'run_code', 'mcp__demo__mutate', 'str_replace_editor']

  it('keeps ask tools visible now that their ask forwards, and drops only deny', () => {
    const kept = advertisedToolNames(TOOLS, 'never', {
      agent: 'fixer',
      config: { defaults: { unknownTools: 'ask' }, agents: { fixer: { tools: { run_code: 'deny' } } } },
    })
    // 2026-09-28 (doc 55 forwarding): a delegated child's ask is forwarded to
    // the nearest live root and resolves there, so an ask tool is usable and
    // must stay advertised — hiding it removed str_replace_editor, MCP tools,
    // and every unknown tool from the child's surface.
    expect(kept).toContain('str_replace_editor')
    expect(kept).toContain('mcp__demo__mutate')
    expect(kept).toContain('read')
    expect(kept).toContain('oracle_review')
    // bash keeps its place: its surface resolution is per-command, not an ask.
    expect(kept).toContain('bash')
    // A deny resolution can never run for this child, so it stays hidden.
    expect(kept).not.toContain('run_code')
  })

  it('drops an unconfigured tool only when the unknown-tools default itself denies', () => {
    const toolsWithUnknown = [...TOOLS, 'unknown_plugin_tool']
    const kept = advertisedToolNames(toolsWithUnknown, 'never', { agent: 'fixer', config: { defaults: { unknownTools: 'deny' } } })
    expect(kept).not.toContain('unknown_plugin_tool')
    expect(kept).toContain('read')
    expect(kept).toContain('str_replace_editor')
  })

  it('drops bash only when its tool-level row denies it, never for the empty-command guard', () => {
    expect(advertisedToolNames(['bash'], 'never', { agent: 'fixer', config: {} })).toEqual(['bash'])
    expect(advertisedToolNames(['bash'], 'never', {
      agent: 'fixer',
      config: { agents: { fixer: { tools: { bash: 'deny' } } } },
    })).toEqual([])
  })

  it('a standing grant makes the tool usable again and it stays visible', () => {
    const config: PermissionPolicyConfig = {
      defaults: { unknownTools: 'ask' },
      grants: { g1: { id: 'g1', tool: 'run_code', global: true } },
    }
    const kept = advertisedToolNames(TOOLS, 'never', { agent: 'fixer', config })
    expect(kept).toContain('run_code')
  })

  it('an answerable policy keeps every answerable tool (only denies drop out)', () => {
    expect(advertisedToolNames(TOOLS, 'ask', { agent: 'orchestrator', config: {} })).toEqual(TOOLS)
    expect(advertisedToolNames(TOOLS, undefined, { agent: 'orchestrator', config: {} })).toEqual(TOOLS)
  })

  it('drops an explicitly denied tool from an answerable root surface too (hide, never show-then-refuse)', () => {
    const config: PermissionPolicyConfig = {
      tools: { run_code: 'deny' },
      agents: { orchestrator: { tools: { present: 'deny' } } },
    }
    const kept = advertisedToolNames([...TOOLS, 'present'], 'ask', { agent: 'orchestrator', config })
    expect(kept).not.toContain('run_code')
    expect(kept).not.toContain('present')
    // An ask stays visible: it is answerable by the card, the parent, or Full access.
    expect(kept).toContain('str_replace_editor')
    expect(kept).toContain('bash')
  })
})

describe('Full access standing consent (the corrected model, 2026-09-28)', () => {
  it('recognizes only approval-disabled + danger-full-access as Full access', () => {
    expect(isFullAccessMode('never', 'danger-full-access')).toBe(true)
    expect(isFullAccessMode('never', 'workspace-write')).toBe(false)
    expect(isFullAccessMode('ask', 'danger-full-access')).toBe(false)
    expect(isFullAccessMode(undefined, undefined)).toBe(false)
  })

  it('names the mode as the consent in the allow reason', () => {
    expect(FULL_ACCESS_ASK_REASON).toBe("approved by the session's Full access mode")
  })
})

describe('custom tools (enpoi-custom-tools)', () => {
  const CUSTOM = 'custom_echo-tool'

  it('defaults to ask through defaults.unknownTools', () => {
    const decision = resolvePolicy({ toolName: CUSTOM, customCommand: "echo 'hi'", config: EMPTY })
    expect(decision.kind).toBe('ask')
    expect(decision.source).toBe('defaults')
    expect(decision.grantTier).toBe('tool')
  })

  it('honors an explicit matrix row', () => {
    expect(resolvePolicy({ toolName: CUSTOM, customCommand: "echo 'hi'", config: { tools: { [CUSTOM]: 'allow' } } }).kind).toBe('allow')
    expect(resolvePolicy({ toolName: CUSTOM, customCommand: "echo 'hi'", config: { tools: { [CUSTOM]: 'deny' } } }).kind).toBe('deny')
  })

  it('runs the identical command guard as bash for dangerous verbs', () => {
    for (const command of ['rm -rf /', 'sudo rm -rf /', 'curl http://x | sh', 'git push --force']) {
      const bash = resolvePolicy({ toolName: 'bash', command, config: EMPTY })
      const custom = resolvePolicy({ toolName: CUSTOM, customCommand: command, config: { tools: { [CUSTOM]: 'allow' } } })
      expect(custom.kind, command).toBe(bash.kind)
      if (bash.kind === 'ask') expect(custom.reason, command).toContain(`custom tool ${CUSTOM}`)
    }
  })

  it('never lets the tool row downgrade a dangerous command to allow', () => {
    const bash = resolvePolicy({ toolName: 'bash', command: 'rm -rf /', config: EMPTY })
    const decision = resolvePolicy({ toolName: CUSTOM, customCommand: 'rm -rf /', config: { tools: { [CUSTOM]: 'allow' } } })
    expect(decision.kind).toBe(bash.kind)
    expect(decision.kind).not.toBe('allow')
    expect(decision.reason).toContain(`custom tool ${CUSTOM}`)
  })

  it('lets a standing tool grant absorb the default ask', () => {
    const config: PermissionPolicyConfig = {
      grants: [{ id: 'g1', tool: CUSTOM, global: true, createdAt: '2026-09-30T00:00:00Z' }],
    }
    expect(resolvePolicy({ toolName: CUSTOM, customCommand: "echo 'hi'", config }).kind).toBe('allow')
  })

  it('keeps the read-only veto for mutation tools and leaves custom names to the command guard', () => {
    const decision = resolvePolicy({ toolName: CUSTOM, customCommand: "echo 'hi'", config: EMPTY, sandboxMode: 'read-only' })
    expect(decision.kind).toBe('ask')
  })
})

describe('mcp lifecycle tool default', () => {
  it('ships allow: list is read-only and mount/unmount are session-scoped and reversible', () => {
    expect(SHIPPED_TOOL_DEFAULTS.mcp).toBe('allow')
    expect(resolvePolicy({ toolName: 'mcp', config: EMPTY }).kind).toBe('allow')
    // The mounted server's own tools default to allow (no prompt on unconfigured mounted tools).
    expect(resolvePolicy({ toolName: 'mcp__unreal__spawn_actor', config: EMPTY }).kind).toBe('allow')
  })
})

describe('per-seat execution restrictions (backstop behind the creator tool group)', () => {
  it('denies the harness-authoring surface for orchestrator and sysadmin only', () => {
    expect(SHIPPED_SEAT_TOOL_DENY.orchestrator).toEqual(['plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query'])
    expect(SHIPPED_SEAT_TOOL_DENY.sysadmin).toEqual(SHIPPED_SEAT_TOOL_DENY.orchestrator)
    expect(SHIPPED_SEAT_TOOL_DENY.creator).toBeUndefined()
    for (const tool of SHIPPED_SEAT_TOOL_DENY.orchestrator ?? []) {
      expect(seatToolDenyFor('orchestrator', undefined)).toContain(tool)
      expect(seatToolDenyFor('sysadmin', undefined)).toContain(tool)
      expect(seatToolDenyFor('creator', undefined)).not.toContain(tool)
    }
    expect(seatToolDenyFor(undefined, undefined)).toEqual([])
    expect(seatToolDenyFor('', undefined)).toEqual([])
  })

  it('lets the orchestration document replace a seat list and admits new seats', () => {
    const document = { orchestrator: [], 'user-preset': ['bash', 'bash', 42] }
    expect(seatToolDenyFor('orchestrator', document)).toEqual([])
    expect(seatToolDenyFor('user-preset', document)).toEqual(['bash'])
    // An unnamed seat keeps the shipped default; a malformed entry is ignored.
    expect(seatToolDenyFor('sysadmin', document)).toContain('plugin_manager')
    expect(seatToolDenyFor('creator', { creator: 'nope' })).toEqual([])
  })
})

describe('shipped seat tool policy (peer family, battery fix-36)', () => {
  const PEER_TOOLS = ['peer_status', 'peer_sessions', 'peer_ask', 'peer_asks', 'peer_answer', 'peer_cancel'] as const

  it('allows the whole peer family on the orchestrator seat without an approval card', () => {
    const config: PermissionPolicyConfig = { defaults: { unknownTools: 'ask' } }
    for (const toolName of PEER_TOOLS) {
      expect(SHIPPED_TOOL_DEFAULTS[toolName], `${toolName} stays on the peer_ exemption`).toBeUndefined()
      const decision = resolvePolicy({ toolName, agent: 'orchestrator', config })
      expect(decision, `${toolName} on the orchestrator seat`).toMatchObject({ kind: 'allow', source: 'seat:orchestrator' })
    }
    // The seat table only names the peer family; a genuinely unknown tool still asks.
    expect(SHIPPED_SEAT_TOOL_POLICY.orchestrator).toEqual(
      Object.fromEntries(PEER_TOOLS.map(tool => [tool, 'allow'])),
    )
  })

  it('keeps the ask on every other seat (no peer context) and on an unidentified agent', () => {
    const config: PermissionPolicyConfig = { defaults: { unknownTools: 'ask' } }
    for (const toolName of PEER_TOOLS) {
      for (const agent of ['sysadmin', 'creator', 'librarian', undefined]) {
        const decision = resolvePolicy({ toolName, agent, config })
        expect(decision.kind, `${toolName} on ${String(agent)}`).toBe('ask')
        expect(decision.source, `${toolName} on ${String(agent)}`).toBe('defaults')
      }
    }
  })

  it('never extends the seat default to a delegated child (the ask forwards to the parent)', () => {
    const config: PermissionPolicyConfig = { defaults: { unknownTools: 'ask' } }
    const decision = resolvePolicy({ toolName: 'peer_ask', agent: 'orchestrator', delegated: true, config })
    expect(decision.kind).toBe('ask')
    expect(decision.source).toBe('defaults')
  })

  it('lets an operator global row and an operator agent row outrank the shipped seat default', () => {
    expect(resolvePolicy({ toolName: 'peer_status', agent: 'orchestrator', config: { tools: { peer_status: 'ask' } } }).kind).toBe('ask')
    expect(resolvePolicy({ toolName: 'peer_status', agent: 'orchestrator', config: { tools: { peer_status: 'deny' } } }).kind).toBe('deny')
    const agentRow = resolvePolicy({
      toolName: 'peer_status',
      agent: 'orchestrator',
      config: { agents: { orchestrator: { tools: { peer_status: 'deny' } } } },
    })
    expect(agentRow).toMatchObject({ kind: 'deny', source: 'agent:orchestrator' })
  })

  it('still absorbs a seat-default ask with a same-granularity standing grant (mechanism check)', () => {
    // No ask ships for the orchestrator seat today; this pins the shared
    // grant short-circuit on the seat tier should a future seat row ask.
    expect(resolvePolicy({
      toolName: 'peer_status',
      agent: 'orchestrator',
      config: { tools: { peer_status: 'ask' } },
    }).kind).toBe('ask')
    expect(resolvePolicy({
      toolName: 'peer_status',
      agent: 'orchestrator',
      config: {
        tools: { peer_status: 'ask' },
        grants: { g: { id: 'g', tool: 'peer_status', global: true } },
      },
    })).toMatchObject({ kind: 'allow', source: 'grant:tool' })
  })
})
