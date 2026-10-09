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
  rows (`defaults.unknownTools` = `ask`), so the dangerous surface still asks.
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
