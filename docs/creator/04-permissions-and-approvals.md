# 04 — Permissions & approvals

How a tool call becomes `allow`, `ask`, or `deny`; where the rules live; the approval card; child asks forwarded through a parent; the never-approvable rails; Full access. Path convention: `packages/enpoi-*` is the installed profile bundle's `packages/` tree; other `packages/...` paths are the harness checkout.

## 1. Where the rules live

One document, one namespace: `enpoi-orchestration.permissions` in the settings document (`settings.yaml`). The namespace shape is declared at `packages/enpoi-capabilities/src/index.ts:87-150`; the resolver reads it fresh on every tool dispatch (`packages/enpoi-capabilities/src/policy.ts:5-8`), so a settings edit applies to the next call — no rebuild, no restart.

| Field | Type | Meaning |
|---|---|---|
| `defaults.unknownTools` | `allow \| ask \| deny` (ship `ask`) | fallback for an unconfigured tool |
| `tools` | `{ <toolName>: allow \| ask \| deny }` | global per-tool policy; `'*'` is not special here |
| `bashPatterns` | `[{ pattern, policy }]` | ordered; FIRST match wins, then shipped patterns, then `tools.bash` |
| `agents.<role>.tools` | same map | per-agent override; absent key = inherit global |
| `agents.<role>.bashPatterns` | ordered list | per-agent bash rules, evaluated before global patterns |
| `agents.<role>.available` | `string[]` | per-role child tool allowlist (see §9) |
| `grants` | `{ <id>: StandingGrant }` | machine-written standing allows (see §5) |

Shipped defaults are code, not YAML: `SHIPPED_TOOL_DEFAULTS`, `SHIPPED_BASH_PATTERNS`, and `SHIPPED_TOOL_DEFAULT_EXEMPTIONS` in `packages/enpoi-capabilities/src/policy.ts`. The defaults principle: an integrated first-party tool works by default (`allow`) — reads, web, memory, whiteboard, delegation (`subagent`, `send_message`, `list_agents`), the goal/plan drivers (`create_goal`, `get_goal`, `update_goal`, `exit_plan_mode`, `ralph`, `workflow`, `tool_groups`), read-only introspection, and the harness-authoring tools (`plugin_manager`, `cordis_inspect_list`, `cordis_inspect_query`), which live in the `creator` tool group that pre-attaches only to the creator seat — that group is the structural mechanism that keeps them off the orchestrator and sysadmin advertised surfaces, and `SHIPPED_SEAT_TOOL_DENY` in the same file backs the absence at the pre-execute boundary. Because the advertised tool block is therefore not byte-identical across the main agents, switching from the creator to another operator rebuilds the provider's prompt prefix once; turns within one seat stay cached. `ask` is reserved for genuinely sensitive actions: `bash` (the danger-list patterns), `str_replace_editor`, `job_kill`, `interrupt_agent`, and `council_register` (it writes the shared council registry). Unknown tools fall to `ask`. A YAML row only needs to carry the rows the operator changes — everything else falls through to code. Capability toggles are a **different mechanism** and are not policy: `capabilities.tools`, `capabilities.skills`, `capabilities.mcp` (`index.ts:60-64`) strip the schema entirely (§8). Disabling a tool or skill is stronger than denying it: the model never sees it. For MCP the switch sets the **default world**, not a refusal: a switched-off server is absent from every session's surface and from the agent's `mcp list`, but a skill's `mcp:` hint, an explicit `mcp mount`, or the Capabilities center's per-session switch pulls it in for that session — the pulled server is then callable through the normal policy ladder, and a call to a switched-off server that was NOT pulled in is denied with the "disabled by the operator" reason (file 06 §5.1).

The Permissions page cannot import this host file, so the client renders from a generated mirror (`packages/client/ui-brand-enpoi/src/client/permissions-defaults.generated.ts`, written by `packages/client/ui-brand-enpoi/scripts/generate-permissions-mirror.ts`). The generator reads the host policy tables, the tool-group catalog, the seat guard, the child role tables, and the advertised main-agent surface; `--check` fails on drift. A parity pair fails too: the client spec re-reads the host tables and the preset inventory, and the host `tool-defaults-completeness.spec.ts` verifies the mirror's embedded `HOST_DEFAULTS_DIGEST`, so a host default change fails there until the mirror is regenerated. The mirror is never hand-edited.

The defaults are complete by construction: `packages/enpoi-capabilities/tests/tool-defaults-completeness.spec.ts` asserts that every tool in the `scripts/tool-inventory/expected-<preset>.json` fixtures (orchestrator, sysadmin, creator) has an explicit `SHIPPED_TOOL_DEFAULTS` row or matches a documented `SHIPPED_TOOL_DEFAULT_EXEMPTIONS` prefix (`custom_*`, `mcp__*`, `peer_*`). A newly registered tool therefore fails that spec until its default is decided, instead of silently riding `defaults.unknownTools`; the spec's fixture copies must equal the canonical inventory, so `scripts/preset-tool-inventory.mjs --update` surfaces the new name. The first-party on-demand peer family (`peer_ask`, `peer_asks`, `peer_answer`, `peer_cancel`, `peer_status`) never appears in the preset fixtures, so that spec exercises it by name and pins its `defaults.unknownTools` ask, matching the documented exemption.

## 2. Resolution order (fresh per dispatch)

Implemented in `resolvePolicy` (`policy.ts:560-693`); the listener that calls it runs after the capability-disabled check in `index.ts:852-934`. Deny at any tier terminates immediately; grants never upgrade a deny.
1. **Capability disabled** → deny (`index.ts:856-860`). For MCP this fires only when the server is switched off AND is not in the session's world (not pulled in); a pulled server continues to the policy ladder.
2. **Read-only session veto**: sandbox mode `read-only` denies `bash`, `edit`, `write`, `str_replace_editor` (`policy.ts:73`, `565-567`).
3. **Bash** goes through the pattern ladder (§3). **Every other tool**: agent `tools[tool]` → global `tools[tool]` / shipped default → MCP wildcard ladder (`policy.ts:273-299`) → `defaults.unknownTools`.
4. **Grants** short-circuit an `ask` at its own granularity (pattern-level grants never absorb tool-level asks, and vice versa — `policy.ts:307-326`).
5. **Default**: `defaults.unknownTools`, ship `ask` (`policy.ts:684-692`).

`review_run` is a fixed exception: reviewer/oracle seats (`REVIEW_ROLES`, descriptor labels) get `allow`; every other role gets a named `deny` (`policy.ts:85-101`, `649-653`).

## 3. Bash: compound commands, patterns, scans

- The raw command is split at quote-depth-0 `&&`, `||`, `;`, `|`, newlines (`splitCompoundCommand`, `policy.ts:300-343`); leading `KEY=VAL` prefixes are stripped (`policy.ts:346-351`). Any sub-command deny denies the whole call; the first ask wins.
- **Command prefixes are seen through** before the rules evaluate: `timeout`, `env`, `sudo`, `doas`, `nice`, and `command` are skipped together with their value-taking flags (`sudo -u root`, `nice -n 10`, `timeout -s KILL 5`), so `sudo rm -f x` matches the `rm` rule instead of the catch-all. A `command -v`/`-V` query only reports the operand's path and is allowed (`scan:command-query`); a privilege wrapper with no command word left (`sudo -i`, `doas -s`) asks as `scan:privileged-shell`; a wrapper-only version probe (`sudo --version`) stays free (`scanWrapperPrefix`, `policy.ts:694-742`; `evaluateSubCommand`, `policy.ts:847-905`). The child rails strip the same transparent wrappers before classifying (`forwarding.ts:407-441`).
- Pattern matching (`matchBashPattern`, `policy.ts:369-384`): a bare token (`rm`) matches the command word, compared by basename for a path-less pattern, so `/bin/rm` is the `rm` rule; a trailing star binds to arguments (`rm*` ≡ `rm`, `rmdir` stays distinct) and a version suffix normalizes for membership (`mkfs*` catches `mkfs.ext4`); a pattern containing a space is a glob over the full sub-command; a pattern that itself names a path (`/usr/bin/rm`) matches literally.
- **Interpreter invocations**: an interpreter called with only version/help flags (`--version`, `-V`, `--help`, `-h`) runs no user code and is allowed; a bare interpreter, a shell script path, inline `-c`/`-e`/`--eval` code, `eval`, and `.`/`source` without a path still ask regardless of visible verbs (`policy.ts:555-570`, `847-905`).
- **Shell wrappers**: `<shell> -c '<inner>'` (optionally behind a `timeout N` / `env …` prefix) has its inner split and evaluated by the same rules, so it asks only when the inner evaluation asks; the recursion is bounded at depth 3, and an unextractable inner (missing, an expansion) keeps the pre-recursion ask (`policy.ts:853-866`).
- **Hidden-surface scan**: a `$( )`, backtick, `<(...)`, heredoc, `xargs`, or `find -exec`/`-execdir` span containing a danger-list verb as a stand-alone shell word asks explicitly (`policy.ts:479`, `504-521`, `894`); a flag fragment (`uname -rm`) and an ordinary argument expansion (`echo "$HOME"`) are not verbs. An expansion used as the command word (`$CMD …`, `$(cmd) …`) is opaque execution and asks (`policy.ts:847-905`).
- An Always-allow grant for any scan pins the **exact raw command string** (`policy.ts:764-772`, `1315-1337`).

## 4. The approval card

When a policy resolves `ask` the registry presents a card (`packages/client/ui-approval/src/client/ApprovalPanel.tsx:88-95`). Outcomes are closed (`packages/interaction/user-approval/src/types.ts:36`):

| Action | Outcome | Effect |
|---|---|---|
| Allow once | `allowed-once` | this call only |
| Allow always | `allowed-always` | host writes the default pin (§5) |
| Allow all `<verb>` | `allowed-always-broad` | only offered when the ask carries `broadAllow`; pins the rule-level pattern |
| Reject | `rejected` | corrective tool error to the asker |
| Cancel / nobody | `cancelled` / `unavailable` | fail closed |

The ask/outcome pair is durable audit (`approval/asked` + `approval/decided`, `packages/interaction/user-approval/src/index.ts:223-242`). For a danger-list rule the card headline states the exact scope of the default action — "Always allow" grants only that exact command, while every command of the verb requires the separate "Allow all `<verb>`" opt-in; an ordinary rule keeps its wording because its default pin is the rule pattern. Session policy: `'never'` rejects deterministically **before any answerer** (`index.ts:275-283`); a missing/throwing answerer yields `unavailable`; a pending ask expires after `answerTimeoutMs` (default 15 min, `0` disables) and resolves `unavailable` (`index.ts:151`, `315-365`).

## 5. Grants (standing allows)

- Stored in `permissions.grants` keyed by generated id (`g-<base36>-<rand>`, `index.ts:951-953`). Host-written only: the card answers, the host observes `approval/decided` and persists the grant in a revision-fenced settings write, retrying up to 3 times on `SETTINGS_CONFLICT` (`index.ts:948-981`, `1018-1060`).
- Each grant records `tool`, optional `pattern`, the asking `agent` (audit only) and `global: true` — a card grant covers **all agents in main sessions** (`policy.ts:24-42`, `819-828`). A delegated child never consumes a config grant: its policy resolution always produces the ask for the forwarder, so a main session's "always allow" cannot silence a child call (`policy.ts:1055-1102`); the parent's own policy — grants included — still decides the rail ceiling (`forwarding.ts:672-696`).
- **Exact-command pin vs broad allow**: for a danger-list ask (`rm`, `rmdir`, `dd`, `mkfs*`, `chmod -R`, `shred`, `truncate`, …, `policy.ts:486-537`) the card's default "always" pins the exact raw command; the separate "allow all `<verb>`" pins the matched rule pattern and requires the caller to opt in (`policy.ts:1315-1337`). The ask copy states that scope on the card itself, so "Always allow" is never presented as a verb-level grant. An ordinary rule — including the find forms (`find * -delete*`, `find * -exec rm*`, `find * -execdir rm*`, `policy.ts:280-291`) — keeps its historical rule-pattern pin.
- A forwarded child's broad grant needs a **second confirmation card** before it is stored (`packages/enpoi-capabilities/src/forwarding.ts:954-986`).
- Grants are checked after deny rules in both resolvers; a grant can never turn `deny` into `allow` (`policy.ts:12-14`, `forwarding.ts:8-18`).

## 6. Forwarded child approvals

A delegated child runs with approval policy pinned `never`, so an ask used to dead-end. The child's own policy resolution never consumes a config standing grant — every ask is produced for the forwarder (`policy.ts:1055-1102`) — so a main session's "always allow" cannot let a child call run silently. The forwarder (`forwarding.ts`) resolves child asks through the nearest live root (≤32 hops, `index.ts:681-699`), in this order:
1. **Rails first** — never card-approvable; each resolves only through the parent's own effective policy (an `allow` there passes, anything else denies naming the class), `forwarding.ts:672-696`; the boundary rail additionally requires the root's sandbox to be `danger-full-access` (`index.ts:718-726`).
2. **Session-scoped grants** answered earlier on a forwarded card — in-memory, keyed to the requester's child session, process lifetime, never shared with siblings or another root (`forwarding.ts:592-596`, `1011-1030`); a forwarded answer never writes a global grant (`index.ts:1043-1045`).
3. **Root mode** (`index.ts:707-716`): `full-access` = parent judgement (§8); `interactive` = the human card; anything else (approval `never` without full access, or unknown) **fails closed** with a quiet stderr line (`forwarding.ts:704-711`, `1002-1009`).
4. **Card path**: the card names the child session, agent label, depth, and matched rule, plus a recommendation line. The line comes from ONE bounded call to the **root session's default model** (`packages/enpoi-capabilities/src/recommendation.ts:39-51`, `186-227`; wired at `index.ts:774-811`) or, on any miss, the derived heuristic (`forwarding.ts:471-516`). On the card it is presentation only — the human's answer resolves the ask; only in Full access is the suggestion applied (`forwarding.ts:753-824`).
5. **Batching**: identical concurrent asks (same child, tool, and call shape) share one card or one judgement (`forwarding.ts:713-726`). Denials come back as corrective tool errors; the child adapts, it is not killed. An undeliverable/unanswered ask fails closed and the child's turn settles (`forwarding.ts:46-49`).
6. **Finality**: an allowed call is recorded against the requester's session and call identity; a later outer ask or reviewer denial cannot re-open it (`forwarding.ts:655-657`, `index.ts:846-850`, `904-913`).
7. **Idle-parent park (park-and-replay)**: `ctx.approval.request` requires an open turn because the `approval/asked`/`approval/decided` pair must be turn-enclosed, so a forwarded ask that arrives while the nearest live root sits between turns used to fail closed (`approval.request() outside an open turn`). The forwarder now parks instead (`forwarding.ts`): the ask is recorded durably — reason, child session/label/depth, tool and command, park time, and a 10-minute window (`DEFAULT_PARK_TTL_MS`: long enough for the operator to finish the current task and start the next root turn, short enough that a forgotten child is denied before a work session is lost) — in `~/.dsh/cache/approval-parks.json` (`approval-parks.ts`). At the root's next `turn/start` the parked asks replay in FIFO park order, one at a time, under the root's policy at that moment: Full access applies the parent judgement (audit line, no card), any other resolvable mode dispatches the operator card, and a turn that closes mid-replay re-parks the ask for the next turn. Identical concurrent asks share one park and one replay; the queue is capped at `MAX_PARKED_ASKS`. Every exit settles the waiting child and the journal: the window's expiry denies with `approval was not resolved in time…`, the ask's abort signal cancels it, `session/disposed` releases the asks of that session, and plugin disposal releases the rest. A restart expires restored records (the waiting child died with the previous process) rather than replaying a card nobody waits for; a replay call made while the root is still idle is inert. The root's audit pair (`approval/asked` + `approval/decided`) is still written only inside the open turn, so replay keeps the turn-enclosure invariant.

## 7. Hard rails (never approvable via a forwarded card)

`RailClass` and detection: `forwarding.ts:108-117`, `408-459`. A child asking nicely can never lift them; a grant never absorbs them.

- **depth** — past the delegation cap (`ctx.subagents.resolveMaxDepth`, shipped `1`) (`forwarding.ts:672-680`; default at `index.ts:840-844`).
- **privilege-escalation** — `sudo`, `su`, `doas`, `pkexec` (`forwarding.ts:288`).
- **recursive-delete** — `rm -r/-f`, `rmdir`, `find -delete`/`-exec rm`/`-execdir rm`, `rsync --delete` (`forwarding.ts:505-525`); classification sees through the transparent wrappers (`timeout`, `env`, `nice`, `command`), so `nice rm -rf` is the same rail.
- **history-rewrite** — `git push --force*`, `git reset --hard`, `filter-branch`, `filter-repo` (`forwarding.ts:383-393`).
- **exfiltration** — `scp`, `sftp`, `ftp`, `nc`, `socat`, `sshpass`, remote rsync, `curl -T`, `wget --post-file`, `docker push` (`forwarding.ts:291`, `423-431`).
- **pipe-to-shell** — `… | sh`, `… | python`, `sh <(…)` (`forwarding.ts:401-406`).
- **credentials** — `.env`, `.ssh`, `id_rsa|ed25519|ecdsa`, `.pem`, `.netrc`, `.aws`, `.git-credentials`, `known_hosts`, gcloud/kube/docker config, `.npmrc` (`forwarding.ts:284-285`), checked in bash text and in declared path arguments (`forwarding.ts:279-282`, `350-370`).
- **boundary** — a path argument resolving outside the child's workspace (`forwarding.ts:364-370`, `453-458`); the parent-side ceiling is the root's sandbox mode (`index.ts:726`).

## 8. Full access semantics

Full access = the root session's permission preset `danger-full-access` (sandbox `danger-full-access` + approval `never`; `packages/interaction/permission-presets/src/index.ts:198-201`). It is a user-selected mode with an explicit GUI risk gate (`packages/client/ui-permission-presets/src/client/presentation.ts:4`). The mode matrix:

| Session | Mode | Dangerous command | Resolution |
|---|---|---|---|
| main/root | workspace-write + approval `ask` (normal) | card | the operator answers in the session (`approval/asked` + `approval/decided`) |
| main/root | danger-full-access + approval `never` (Full access) | no card, no delay | allowed with `FULL_ACCESS_ASK_REASON` and an audit line — the mode is the operator's standing consent (`index.ts:1547-1565`) |
| delegated child | parent normal (interactive) | forwarded card | the operator answers in the parent session, with child provenance and the recommendation line (`forwarding.ts:919-1002`) |
| delegated child | parent Full access | no operator UI | parent judgement applied (`forwarding.ts:753-802`) or the derived fallback; every outcome is audited |

What it does **not** mean:
- It is **not a rail bypass**: rails resolve first, through the parent's own effective policy, and a non-allow there denies (`forwarding.ts:682-696`, `index.ts:718-737`).
- It is **not "no limits"**: at most `PARENT_JUDGEMENT_BUDGET_PER_TURN = 8` judgements per root turn; beyond it the forwarder denies with a named reason and never queues forever (`forwarding.ts:277`, `866-876`).
- It is **not a silent allow**: a missed judgement (no reasoner, error, timeout, unparseable, no suggestion) falls back to `derivedRiskOf` — clean asks allow with a named reason, any risk signal denies with the signal named (`forwarding.ts:492-516`, `803-823`). A child still cannot self-escalate; only an ask the child's own policy produced is forwarded (`forwarding.ts:55-56`).
- It is **not a bypass of the child's own gate**: a delegated child's ask never borrows the root's Full-access allow; it always reaches the forwarder, and the parent's authority (judgement or card) resolves it (`index.ts:1516-1545`, `forwarding.ts:628-729`).

A root ask under approval `never` WITHOUT full access (unattended) is denied with a named reason, and only delegated children enter the forwarding path (`index.ts:1566-1569`).

## 9. Per-agent rules and changing any of it

- `permissions.agents.<role>.tools` / `.bashPatterns` override the global matrix for that role; an absent key inherits (`policy.ts:44-50`, `395-411`). The role id is resolved from the live agent, the session's preset projection, then the header (`agentRoleOf`, `policy.ts:489-521`); a delegated child carries the parent's preset, so reviewer seats are identified from the child's `subagent/descriptor` label (`reviewerSeatOf`, `policy.ts:537-553`).
- `permissions.agents.<role>.available` is the **child tool allowlist** consumed by delegation: it replaces the role registry's `tools.available` and the built-in deny map wholesale, and is read fresh per spawn (`packages/subagent/tool-subagent/src/index.ts:770-835`). It is stored operator data, so a name the live registry does not resolve is dropped with a `tool-subagent: role "…" stores unavailable tool "…"` warning at spawn and the child starts with the known subset; only the code-authored `toolFilter` config keeps the strict unknown-allow throw. The shared worker floor still wins over this allowlist: a stored entry can never re-surface a tool an execution guard refuses (`plugin_manager`/`cordis_inspect_*` for orchestrator- and sysadmin-parented children, `review_run` for non-reviewer children) because `SHARED_CHILD_DENY` names them. `profiles/web/packages/enpoi-capabilities/tests/child-surfaces.spec.ts` is the guard: it composes every child role fixture (generic roles, the Oracle review child, evidence research children, every council seat) for every parent seat and fails if the surface names a tool the seat guard, the reviewer gate, or a tool-group restriction would refuse — including the fail-proof that a future tool onboarded into a seat guard fails until its role table fences it. The client parity spec (`packages/client/ui-brand-enpoi/tests/permissions-defaults.client.spec.ts`) cross-checks the mirrored role surfaces against the same seat guard and the seat-restricted group catalog.
- Edit the document directly (settings YAML / `settings.mutate`) or via the operator's Capabilities & Tools drawer (`profiles/web/sidebar-patch/src/client/CapabilitiesView.tsx`); the UI is a view over the same document. Changing `capabilities.*` toggles is a separate edit from changing policy rows.
- Grants are never hand-edited in normal flow; to revoke, remove the row from `permissions.grants` and the next dispatch re-resolves without it.

## 10. Failure modes

- Settings unreadable → `readPermissionConfig()` returns `{}` and shipped defaults apply; denies do not silently become allows (`index.ts:572-578`).
- An empty ask for `bash` is a deny (`policy:empty`, `policy.ts:569-574`) — never a crash.
- A forwarded ask with no live root, with mode unknown, or unattended fails **closed** with a stderr line; the child sees a corrective tool error (`forwarding.ts:666-669`, `1002-1009`).
- A grant write that loses a revision race retries, then logs a persistence failure to stderr; the in-memory decision already happened (`index.ts:966-980`).
- Deleting/renaming an MCP server prunes its `mcp__<server>__*` policy rows in the same fenced write, so no inert rows survive (`packages/enpoi-capabilities/src/mcp-tools.ts:116-141`).
