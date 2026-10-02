# 06 — Skills, MCP servers & tool definitions

Three extension surfaces a Creator must be able to add, remove, or repair: skills (instruction bundles), MCP servers (external tool bridges), and plugin-registered tool definitions. Permissions for all three live in the same document as file 04. Path convention: `packages/enpoi-*` is the installed profile bundle's `packages/` tree; other `packages/...` paths are the harness checkout.

## 1. Skills — what they are

A skill is a named, described Markdown instruction body. The model sees a summary catalog; loading the skill injects the full body as instructions. Nothing executes. Registry: `@deepseek-ai/dsh-skill` (`packages/skill/skill/src/index.ts:356-660`) with layered scopes — the nearest layer wins a duplicate name, and rank decides duplicates within one layer (`index.ts:551-581`).

## 2. Skills — where they live

Roots and ranks (`packages/skill/skill-filesystem/src/index.ts:36-40`, `245-264`):

| Rank | Root | Source |
|---|---|---|
| 100 | `<project>/.dsh/skills` | `project-dsh` |
| 200 | `<project>/.agents/skills` | `project-agents` |
| 300 | each `customSkillDirs` entry | `custom` |
| 400 | `$DSH_HOME/skills` (`.system` skipped) | `user-dsh` |
| 500 | `$DSH_AGENTS_HOME/skills` (default `~/.agents/skills`) | `user-agents` |
| 600 | `$DSH_BUNDLED_SKILL_DIR` | `bundled` |

Config (`Config`, `index.ts:48-89`): `providerName` (`filesystem`), `includeDefaultRoots` (`true`), `dshHome`/`agentsHome` (env/`~` defaults), `customSkillDirs` (`[]`), `watch` (`true`), `watchUsePolling` (`false`), `watchStabilityThresholdMs` (`200`), `watchPollIntervalMs` (`100`), `watchMaxProjects` (`128`), `watchFollowSymlinks` (`true`), `bundledSkillDir`.

**Two homes, one canonical shipped set.** The profile's `skills/` dir is the canonical home of the shipped tier skills, and every fleet preset (`orchestrator`, `sysadmin`, `creator`) mounts it as a `customSkillDirs` entry (rank 300) whose rows are identical across the three declarations. User-created skills live in `$DSH_HOME/skills` (rank 400), which every preset reads through the default roots. Because custom roots scan first, the profile's tiers win over any same-named copy in the user root; the sandbox/installer seed may place shadow copies there, and the Skills section shows those as shipped/read-only. A fresh install committed from the template therefore needs no user-root tier files at all.

**UI path** — Settings → Dynamic → **Skills & tools** (the harness `packages/client/ui-brand-enpoi` renders the panel; the profile's `packages/enpoi-fs-ops` plugin serves it): the skills group lists `$DSH_HOME/skills` plus the registry catalog (which contributes the shipped tiers from the profile root when no local copy exists), offers **+ Add** (name, description, body, MCP servers), **Edit** (description, body, MCP servers), and **Delete** (confirm) on editable rows through the fenced `/sidebar/fsops` `skills.*` routes — no filesystem or Creator session needed, beside the same + Add / Edit / Delete affordances the Roles and MCP tabs carry. Add writes `<root>/<name>/SKILL.md` (kebab-case name, `name`/`description` frontmatter, submitted body, optional `mcp` hint); Edit rewrites the `description:` and `mcp:` entries and body while preserving every other frontmatter line (an empty MCP selection removes the `mcp:` entry); Delete moves the bundle to `$DSH_HOME/trash/skills` (never `rm`). Add, Edit, and Delete all refuse the three shipped tier names with a `protected` error, and those rows render read-only (no Edit/Delete). Every mutation lands on disk, so the watcher refreshes the agent catalog exactly as a hand-written file does.

## 3. Skills — the file contract

Two forms per root, both requiring YAML frontmatter (`skill-filesystem/src/index.ts:723-733`, `797-839`):

- directory bundle: `<root>/<name>/SKILL.md` (resources resolve against `<name>/`)
- flat file: `<root>/<name>.md` (resources resolve against the root)

Frontmatter fields:

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | — | kebab-case `[a-z0-9]+(-[a-z0-9]+)*` |
| `description` | yes | — | non-empty; shown in the catalog |
| `mcp` | no | — | string array of configured MCP server ids (`[test-mcp]`); loading the skill pulls them into the session (§5.1) — a switched-off server included |
| `whenToUse` | no | — | extra routing guidance |
| `metadata` | no | — | free record returned to consumers |
| `disable-model-invocation` | no | `false` | true = hidden from catalog and `skill` tool |
| `user-invocable` | no | `true` | false = hidden from the `/name` gesture |

Legacy keys (`disableModelInvocation`, `modelInvocable`, `userInvocable`) are rejected; booleans accept `true/false/yes/no/on/off/1/0` (`index.ts:1000-1037`).

**Add**: write the file, or create it in Settings → Dynamic → Skills & tools (name, description, body) — the UI writes `$DSH_HOME/skills/<name>/SKILL.md`, a hand-written file may target any root; the watcher invalidates the catalog, so the next turn sees it — no restart. **Remove**: delete it in Settings → Dynamic → Skills & tools (trash-staged; the shipped tier skills are refused), or delete the file, or keep it installed and shadow it by setting `enpoi-orchestration.capabilities.skills.<name>: false` — the disabled skill vanishes from the catalog, the `skill` tool result, and the `/name` gesture, and its execution is denied before dispatch (B4: `packages/enpoi-capabilities/src/index.ts:531-559`; enforcement `enforcement.ts:72-81`). Zero token cost either way.

## 4. Skills — how they are invoked and permitted

- Model: the tool-skill plugin publishes an `<available_skills>` catalog into the session and registers the `skill` tool; the tool loads one body and renders `<skill_content>` (`packages/skill/tool-skill/src/index.ts:81-161`, `253-311`). The catalog republishes only when its entries actually change.
- Human: a `/name` gesture in claimed user text injects the body as instructions; only `user-invocable` skills, and the only path that reaches `disable-model-invocation` skills (`tool-skill/src/index.ts:163-204`).
- Permissions: the `skill` tool itself ships `allow` (`policy.ts:112`); per-skill access is the `capabilities.skills` toggle, not a policy row. A skill's body is trusted local content — it can describe running anything, but every tool it suggests still resolves through file 04.
- Failure modes: missing/invalid frontmatter or a bad name → the file is skipped with a `ctx.logger.warn` and never surfaces (`skill-filesystem:807-829`); duplicate name → higher-priority candidate wins with a warning (`skill/src:570-581`); a provider error makes the catalog incomplete and it is not cached, so it retries next request (`skill/src:602-609`).

## 5. MCP servers — catalog and mounting

The catalog is `enpoi-orchestration.mcpServers.<id>` (`packages/enpoi-capabilities/src/index.ts:66-74`):

| Key | Meaning |
|---|---|
| `serverName` | mounted namespace; default `<id>` minus a `-mcp` suffix |
| `url` | Streamable-HTTP endpoint; **required to mount** |
| `headers` | extra request headers |
| `apiKeyEnv` | credential reference resolved to a bearer token |
| `transport`, `toolCallTimeoutMs` | reserved; the mount pins `streamable-http` and `toolCallTimeoutMs ?? 60000` |

A catalog entry alone does nothing. The Capabilities center switch (`capabilities.mcp[id]`, `enpoi-orchestration.capabilities.mcp`) sets the **default world**: `true` puts an always-on server into every session by default; `false` means the server is absent by default — the agent does not even see it (no tools, no `mcp list` row). The switch is **not a refusal**: a skill's `mcp:` hint, an explicit `mcp mount`, or the center's per-session switch pulls a switched-off server into that session for the work at hand, and the pull persists for the session. A call to a switched-off server that was **not** pulled in is denied with `disabled by the operator` (never "unknown"). Within the default world, the record's `mode` decides the **session scope**: `always-on` (default) is in every session and auto-mounts at boot; `on-demand` never auto-connects — the agent mounts it for its session with the `mcp` tool or a skill's `mcp:` hint, and a server that failed once stays down until explicitly mounted. Heavy servers (hundreds of tools) belong on-demand so they stop taxing every query.

**Mount/unmount = the disposable-fiber pattern** (`index.ts:381-425`): one enabled server is one `ctx.plugin(mcpClient.apply, { transport: 'streamable-http', serverName, url, headers, toolCallTimeoutMs, failOnStartupError: false })` fiber, awaited so its tools register before the toggle settles; disabling it or removing it from the catalog calls `fiber.dispose()`, which disconnects and unregisters every tool of that server. A settings update re-runs the sync, a boot retry fires after 3 s, and a failed mount is retried on the next settings change rather than spamming.

Tool names are server-qualified: `mcp__<serverName>__<rawName>`, normalized to the 64-char `[A-Za-z0-9_-]` function-name contract with a 12-hex SHA-256 suffix when normalization is lossy (`packages/mcp/mcp-client/src/tools.ts:48-87`). Registration is two-phase (fetch the full generation, then swap); a conflict rolls back to zero tools from that server, never a partial set (`tools.ts:113-162`).

## 5.1 MCP — the default world, pulls, and on-demand mounting (session-scoped)

Three layers, kept distinct: the **Capabilities center switch** (`capabilities.mcp[id] === true`) sets the DEFAULT world; the record's **`mode`** (`always-on` vs `on-demand`) says whether a default-world server is in every session or mounts on demand; a session's **pulls** (a skill's `mcp:` hint, an explicit `mcp mount`, or the center's "This session" switch) bring servers in regardless of the switch. The session world is `(session mounts ∪ default-world always-on ∪ session override true) − session override false`, so a switched-off, unpulled server is purely absent while a pulled one is fully usable for that work. Persistent config says what a server IS (configured + mode); the agent's mounts are SESSION-scoped and durable through the session log (`mcp/mounts` event → `mcpMounts` projection), so a resumed session comes back with exactly the servers it had pulled, and `session/disposed` releases them (a server outside the default world that nobody else holds disconnects).

- **The `mcp` tool** (one tool, three actions): `list` shows the servers available to THIS session with mode (`always-on | on-demand`), switch (`enabled | default-off`), state (`mounted | available | unavailable`), reason, and tool count — a switched-off server that was not pulled in is omitted entirely. `mount <server>` connects ANY configured server (a switched-off one included — the explicit pull is the point) and registers its tools for this session; a failed connection returns the structured reason from the mcp-client path. `unmount <server>` releases this session's pull (durable mount and/or session switch). Permission row: shipped **allow** — `list` is read-only, and mount/unmount only touch servers the operator configured, scoped to the calling session and reversible. The mounted server's OWN tools keep their own rows (`defaults.unknownTools` = `ask`), so the dangerous surface still asks.
- **Honest listing**: the operator RPC (`enpoiCapabilities.mcpMounts`) lists every configured server, switched-off ones included and marked `enabled:false` with a `disabled` state when unpulled; the agent's `list` omits those. `mounted` requires both the session's world and a live connection; a failed/pending server reports `unavailable` with its reason and its real (usually 0) tool count, so a broken or tool-less server never masquerades as mounted.
- **Surface honesty**: a server's `mcp__<server>__*` tools are absent from a session unless the server is in that session's world (default world or a pull) — the `system-prompt/assemble` filter — and the pre-execute listener is the execution backstop: a switched-off server that was not pulled in denies with the disabled reason, an on-demand server the session has not mounted denies as on-demand, and a session-scoped off denies as session-scoped. Model-visible ⟺ in world ⟺ logged: the drop is announced on stderr and the harness's tool-registry message records the additions/removals.
- **Skill hint**: a skill's frontmatter may carry `mcp: [server]`; loading the skill pulls the listed servers into the session and attaches a note to the load result (`mcp: mounted "x" for this session (N tools)`, or the failure reason). A switched-off server mounts here too — this is exactly the "our skill requires the MCP, so it should be available for that query" path. Each entry is attempted independently: one unreachable server does not stop the others, and a failed mount leaves the server available for a later explicit `mcp mount`. A skill without the hint behaves exactly as before. Settings → Dynamic → Skills & tools edits the hint: the form lists the configured `mcpServers` as selection chips (free-text when the catalog is empty), Add/Edit write or replace the one-line `mcp:` entry while preserving every other frontmatter line, and an empty selection removes it. The writer also parses a hand-written `mcp:` block list and double-quotes non-scalar entries; a row carrying the hint shows an `mcp: …` badge. The UI never live-validates a server id — the mount result is the honest check. To test: load the skill and read `mcp list` (`mounted` / `available`) plus the mount note on the load result; remove the line in the panel and confirm the next load mounts nothing (`$PROFILE/packages/enpoi-fs-ops`; sandbox recipe `$EVIDENCE/skill-mcp-hint/`).
- **Operator surface**: the session header's MCP chip lists the session's mounted servers (tool counts) and closes each one through the `enpoiCapabilities.mcpUnmount` remote; the Capabilities center's "This session" switch on an MCP row writes the session override, which the host turns into a real pull (a switched-off always-on server mounts) or a release.
- **Doctrine**: the `mcp:lifecycle` system-prompt section states the lifecycle — the center switch sets the default world; a skill's requirement, an explicit mount, or the session switch pulls a switched-off server in; mounts for continuing work stay; one-shot errands unmount when done; when unsure, leave it mounted.

## 6. MCP — auth, status, permissions, removal

- **Auth**: `apiKeyEnv` is resolved through the `credentials` service (environment plus the deployment's credentials file); the value is inserted as `Authorization: Bearer …` unless `headers` already set one (`index.ts:336-353`, `395-397`). Credentials are never logged.
- **Status heartbeat**: `mcpStatus` is written every 15 s (plus 4 s after boot): mounted = online; unmounted = one 2.5 s JSON-RPC `initialize` POST (any HTTP response online, 401/403 flagged as `authError`); unreachable = down. A last mount error travels on the entry (`index.ts:444-527`).
- **Permissions**: three tiers. The capability switch `capabilities.mcp[id] !== true` denies and strips the schema only while the server is not in the session's world (not pulled in); a pulled switched-off server proceeds to the policy ladder — exact `mcp__<server>__<tool>` row, then `mcp__<server>__*`, then `mcp__*`, then `defaults.unknownTools` (ship `ask`) (`policy.ts:273-299`); grants/denies behave exactly as file 04. Mounted server names feed the ladder (`index.ts:603-606`).
- **Removal cleans up**: removing a catalog entry unsets `mcpServers.<id>` **and** every policy row that server owned — the wildcard and exact rows, global and per agent — in one revision-fenced settings write with up to 3 retries; a catalog shrink through another writer is caught by a backstop pruning pass (`packages/enpoi-capabilities/src/mcp-tools.ts:116-141`; `index.ts:168-188`, `983-1016`).

| Failure | Symptom | Fix |
|---|---|---|
| no `url` | never mounts, no error | add the endpoint |
| endpoint unreachable | `mcpStatus` down / grey, mount stderr line | fix the URL/auth; the next settings update retries |
| bad/expired token | status `authError: true` | fix `apiKeyEnv` or the credentials file |
| duplicate `serverName` | second server fails at load with an actionable error | give each server a unique `serverName` (`mcp-client/src/index.ts:169-175`) |
| MCP tool requires task execution | call rejects "task-based execution … not supported" | use the server's synchronous tool variant |
| slow tool | call rejects after `toolCallTimeoutMs` (default 60 s) | raise `toolCallTimeoutMs` in the catalog entry |

## 7. Tool definitions for custom tools

Tools are registered by plugins on the `ctx.tools` registry; `register()` returns the exact disposer (a Cordis effect), and a scoped plugin registers only for its preset (`tool-skill/src/index.ts:161`; `enpoi-tool-groups/src/index.ts:412-469`). A definition carries:

| Field | Purpose |
|---|---|
| `name`, `description` | model-facing identity and routing text |
| `parameters` | JSON schema the model must satisfy |
| `execute(args, exec)` | the implementation; `exec.agent`/`exec.signal` available |
| `output.schema` + `output.render` | canonical value plus model-facing text |
| `isConcurrencySafe` | false for state-changing tools (no sibling overlap) |
| `presentCall` | optional UI card hint (`title`, `kind`, `rawInput`) |

A new tool with no `permissions.tools` row falls to `defaults.unknownTools` (ship: `ask`) — add a row to make it run silently (file 04). For the full authoring contract read `docs/cookbook/adding-a-tool.md`, `docs/tool-catalog.md`, and `docs/tool-execution-pipeline.md` in the harness checkout. Registration is verified: a tool that "registers" into nothing makes the mounting plugin fail loud (`enpoi-tool-groups/src/index.ts:471-475`), and the roster gate (`expected-*.json`) catches an unintended surface change.

### 7.1 Operator-authored command tools (no Creator round-trip)

`profiles/web/packages/enpoi-custom-tools` turns records in `enpoi-orchestration.customTools` into real tools, authored in Settings → Dynamic → Skills & tools → Tools → **+ Add tool** (name, description, parameter rows, command template). A record is `{ id, name, description, params: [{ name, type: string|number|boolean, required, description }], command }`; the plugin registers `custom_<id>` via `ctx.tools.register(defineTool(...))` and hot-applies on `settings/document-updated` (add/edit/delete without a restart).

- **Execution**: `{{param}}` placeholders are replaced with POSIX single-quoted values — never raw interpolation — and the rendered command runs through `ctx.shell` under the session's standing sandbox policy; stdout, stderr, exit code, signal, and timeout come back honestly.
- **Guard**: the plugin provides the `customToolCommands` seam; the enpoi-capabilities `tools/pre-execute` listener renders the command through it and feeds it to the SAME evaluator bash uses (`resolvePolicy` → `evaluateCommandPolicy`: compound splitting, env-prefix stripping, dangerous verbs/wrappers/interpreters). A destructive match asks or denies per the operator's policy and can never be downgraded by the tool's own row.
- **Permissions**: every custom tool gets its own `permissions.tools.custom_<id>` row, seeded to `ask` on creation (and removed with the tool); the Permissions page lists it automatically from the live tool registry. First use is operator-granted.
- **V2 (not in scope)**: composite/workflow tools (a tool = a chain of steps).
