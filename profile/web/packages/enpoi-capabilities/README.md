# dsh-enpoi-capabilities

The profile's capability and permission plane: the `enpoi-orchestration`
settings document (capabilities, MCP catalog, permissions, roles, councils,
chains, custom tools), the monotonic pre-dispatch guard, the model-facing
surface filters, the permission policy engine, and the MCP mount supervisor.

## Settings-editable document fields

Every operator-editable field of the document is declared volatile, so the
settings service projects it into the live form and the Dynamic panels edit it
through `settings.mutate` — an owner never edits the profile patch by hand:

- `customTools` — operator-authored command tools, added/removed in
  Settings → Dynamic → Skills & tools. `enpoi-custom-tools` re-registers the
  tool set on each `settings/document-updated`. The shipped
  `research-fetch`/`research-verify` rows are seed state like any other record:
  deleting them in the panel persists the edited array, and the running plugin
  drops the corresponding `custom_<id>` tool. `custom-tools-model.ts` in the
  client package parses the same records for the panel.
- `extendBuiltins` — merge-mode `{ add?, remove? }` edits over the delegation
  tool's compiled child surfaces (`roles.<id>`, `sharedDeny`, `sharedKeep`), so
  one entry changes without replacing the whole list. An explicit
  `roles.<id>.tools.available` or `permissions.agents.<id>.available` entry
  still replaces the built-in surface and its extension wholesale.

## MCP default world, pulls, and on-demand mounting (V1)

Persistent config says what a server IS; the Capabilities switch sets the
DEFAULT world; the agent's pulls are session-scoped and durable.

- **Catalog record** (`enpoi-orchestration.mcpServers.<id>`): `url`, optional
  `serverName`/`headers`/`apiKeyEnv`/`toolCallTimeoutMs`, and `mode`:
  - `always-on` (default): a master-on server is in every session's default
    world and auto-mounts at boot; the shared connection stays up. A
    switched-off always-on server is absent by default and connects only when a
    session pulls it.
  - `on-demand`: **never auto-connected**. The agent mounts it for its session
    with the `mcp` tool (or a skill's `mcp:` hint). A server that failed once
    stays down until explicitly mounted.
- **Default world vs pulls**: `capabilities.mcp[id] === true` (the Capabilities
  center switch) sets the default world, NOT a refusal. `false` means the
  server is absent by default — no tools, no agent-facing `mcp list` row — but
  a skill's `mcp:` hint, an explicit `mcp mount`, or the center's "This
  session" switch pulls it into that session anyway ("our skill requires the
  MCP, so it should be available for that query"). Session world:
  `(session mounts ∪ default-world always-on ∪ session override true) −
  session override false`. A call to a switched-off server that was NOT pulled
  in is denied with `its MCP server "<id>" is disabled by the operator
  (capabilities.mcp.<id> is not true). Pull it in ...` — never "unknown".
- **Pull durability**: a pull is recorded in the session log (`mcp/mounts`
  event → `mcpMounts` projection), so a resumed session comes back with exactly
  the servers it had pulled; `session/disposed` releases them, and a server
  outside the default world that nobody else holds disconnects. A session-created
  pull reconnects on the session's next turn (`reconcileSessionWorld`).
- **Surface**: a server's `mcp__<server>__*` tools are absent unless the server
  is in that session's world (default world or a pull) — the
  `system-prompt/assemble` filter — and the pre-execute listener is the
  execution backstop (disabled-not-pulled first, then on-demand-unmounted, then
  session-scoped-off). The drop is logged (`[enpoi-capabilities] mcp world
  surface: …`), and the harness's own tool-registry message records the
  additions/removals — model-visible ⟺ logged.
- **The `mcp` tool** (one tool, three actions): `list` (the servers available
  to THIS session: mode `always-on | on-demand`, switch `enabled | default-off`,
  state `mounted | available | unavailable`, reason, tool count; a switched-off
  unpulled server is omitted), `mount <server>` (pull ANY configured server,
  switched-off included, and register its tools for THIS session; failures
  return the structured connection reason), `unmount <server>` (release this
  session's pull). Permission row: shipped `allow` — `list` is read-only and
  mount/unmount only touch servers the operator configured, scoped to the
  calling session and reversible. The mounted server's OWN tools keep their own
  rows; a mounted server with no exact row or server wildcard falls to the
  shipped MCP default (`allow`), so an operator must set a row or wildcard to
  gate that server's surface.
- **Honest listing**: the operator view (`enpoiCapabilities.mcpMounts`) lists
  every configured server, switched-off unpulled ones marked `enabled:false`
  with state `disabled`; `mounted` requires both the session's world and a live
  connection; a failed/pending server reports `unavailable` with its reason and
  its real (usually 0) tool count, so a broken or tool-less server never
  masquerades as mounted.
- **Skill hint**: a skill's frontmatter may carry `mcp: [server]`; loading the
  skill pulls the listed servers into the session (a switched-off one included)
  and attaches a note to the load result (`mcp: mounted "x" for this session
  (N tools)` or the failure reason). A skill without the hint behaves exactly as
  before.
- **Operator surface**: the session header's MCP chip lists the session's
  mounted servers (tool counts) and closes each one through the
  `enpoiCapabilities.mcpUnmount` remote; the center's "This session" switch
  writes the session override, which the host materialises as a real pull or a
  release.
- **Doctrine**: the `mcp:lifecycle` system-prompt section states the lifecycle —
  the center switch sets the default world; a skill requirement, an explicit
  mount, or the session switch pulls a switched-off server in; mounts for
  continuing work stay; one-shot errands unmount when done; when unsure, leave
  it mounted.

**V2 (not in scope)**: composite/workflow tools (a tool = a chain of steps).


## Permission semantics: execution vs forwarded asks

- The resolver runs fresh per dispatch. `allow` executes immediately; `ask`
  goes to the session's card, a delegated child's parent ask, or the root's
  Full-access standing consent; `deny` refuses.
- In a `read-only` sandbox session, the early veto (`READ_ONLY_VETO_TOOLS`)
  blocks local mutation tools (`bash`, `edit`, `write`, `str_replace_editor`)
  and mutating peer controls (`peer_switch_model`, `peer_ask`, `peer_answer`,
  `peer_cancel`), while peer discovery and status reads (`peer_status`,
  `peer_sessions`, `peer_models`, `peer_asks`) remain allowed.
- Session authority uses `classifySessionAuthority`: user-created forks
  (`parentSession` with `isSeeded: true`, no `origin`, and `delegationDepth`
  absent or 0, matching persisted JSONL fork headers) stay root sessions so
  they retain grants, seat defaults, Full-access standing consent, and act as
  the live root in `liveRootOf` for their own children (because real subagent
  children always stamp `origin: 'subagent'` and `delegationDepth >= 1`, and a
  caller able to forge arbitrary headers already controls a forged session).
  `origin: 'subagent'`, positive `delegationDepth`, an unseeded `parentSession`
  without `origin`, or malformed lineage classifies as delegated and blocks
  root standing grants, root seat defaults, and Full-access consent; an ask from
  a delegated marker without a usable `parentSession` fails closed instead of
  falling through to root authority.
- **Rails are a forwarded-ask ceiling, not a global execution boundary.** They
  run only after a child's call resolves `ask`. A call resolved `allow` never
  enters the forwarder, so the credentials, recursive-delete, exfiltration,
  history-rewrite, and privilege rails do not run for it. Do not read the rail
  list as a secret-read or general side-effect guard for allow-resolved calls.
- Mode matrix: root normal = ask becomes the operator card; root Full access =
  ask becomes `allowed` with `FULL_ACCESS_ASK_REASON` (the mode is the operator's
  standing consent); delegated child under a normal root = ask is forwarded to
  the root card; delegated child under a Full-access root = the root's own
  standing consent (match parent), with no model judgement and no quota.
- **PTC / `run_code`:** arbitrary program execution is bounded by the OS
  sandbox mode, not by the request permission realm. Direct filesystem and
  process effects inside a program are not individually approved; only nested
  tool calls re-enter the guarded pipeline. Treat it as an execution surface,
  not as a request-scoped capability.
- Bash precedence is agent patterns → agent `tools.bash` → operator patterns →
  operator `tools.bash` deny → shipped non-catch-all rules → operator
  `tools.bash` ask/allow → shipped catch-all/default. A global `tools.bash:
  allow` does not absorb the shipped `rm`/`dd`/`shutdown` asks, and a grant is
  never blanket danger consent.
- Shell analysis is bounded: one quote-aware extractor covers ordinary
  arguments, double quotes, arithmetic `$((...))`/`${...}`, here-strings, and
  unquoted heredoc substitutions; quoted heredoc bodies stay literal data. The
  resolver refuses with `[ANALYSIS_LIMIT]` beyond 64,000 characters or three
  nested substitution levels, or for an unsupported shape, instead of turning
  uncertainty into an auto-allowable ask. This is a policy-analysis bound, not
  a Bash sandbox.
- Full access does not invoke a root model judgement. The child matches the
  root's actual effective authority: explicit root/child denies still win;
  otherwise the root's Full-access standing consent allows the ask. Normal
  interactive cards keep their advisory recommendation, but that recommendation
  never resolves the ask.

## Compressor locator ownership

- `dsh-compressor` stores crushed tool outputs under `$DSH_HOME/dsh-compressor/<sha256>` keyed solely by content hash. `enpoi-capabilities` observes `contextCompression/after` and `tools/post-execute` (excluding `read`/`glob`/`grep`/`write`/`edit`/`web_*`/`compressor_retrieve` and pre-existing locators) to record the originating session and its ancestor chain whenever the compressor emits a locator, and enforces ownership at both `tools/pre-execute` and `ctx.tools.guard` so only the emitting session, its ancestors, and its descendants may retrieve it; unauthorized, unknown, and malformed locators receive the same uniform refusal without revealing whether a hash exists elsewhere.
- The ownership map (`2,048` hashes, `16` owners per hash, `1,024` parent links) persists atomically to `$DSH_HOME/enpoi-capabilities/compressor-ownership.json` so legitimate retrievals and multi-hop parent/child lineage survive restarts without adding a new `SessionEventMap` type or bumping `SESSION_FORMAT_VERSION`, while preserving `spill-policy` bounding and re-spilling.
