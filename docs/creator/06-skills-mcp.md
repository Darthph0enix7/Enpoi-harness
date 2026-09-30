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

**UI path** — Settings → Skills (the harness `packages/client/ui-brand-enpoi` registers the section; the profile's `packages/enpoi-fs-ops` plugin serves it) lists `$DSH_HOME/skills` plus the registry catalog (which contributes the shipped tiers from the profile root when no local copy exists), and creates, edits, and deletes user skills through the fenced `/sidebar/fsops` `skills.*` routes — no filesystem or Creator session needed, the same convenience as the MCP and role panels. Create writes `<root>/<name>/SKILL.md` (kebab-case name, `name`/`description` frontmatter, submitted body); Edit rewrites the `description:` entry and body while preserving every other frontmatter line; Delete moves the bundle to `$DSH_HOME/trash/skills` (never `rm`). Create, Edit, and Delete all refuse the three shipped tier names with a `protected` error, and the section renders those rows read-only. Every mutation lands on disk, so the watcher refreshes the agent catalog exactly as a hand-written file does.

## 3. Skills — the file contract

Two forms per root, both requiring YAML frontmatter (`skill-filesystem/src/index.ts:723-733`, `797-839`):

- directory bundle: `<root>/<name>/SKILL.md` (resources resolve against `<name>/`)
- flat file: `<root>/<name>.md` (resources resolve against the root)

Frontmatter fields:

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | — | kebab-case `[a-z0-9]+(-[a-z0-9]+)*` |
| `description` | yes | — | non-empty; shown in the catalog |
| `whenToUse` | no | — | extra routing guidance |
| `metadata` | no | — | free record returned to consumers |
| `disable-model-invocation` | no | `false` | true = hidden from catalog and `skill` tool |
| `user-invocable` | no | `true` | false = hidden from the `/name` gesture |

Legacy keys (`disableModelInvocation`, `modelInvocable`, `userInvocable`) are rejected; booleans accept `true/false/yes/no/on/off/1/0` (`index.ts:1000-1037`).

**Add**: write the file, or create it in Settings → Skills (name, description, body) — the UI writes `$DSH_HOME/skills/<name>/SKILL.md`, a hand-written file may target any root; the watcher invalidates the catalog, so the next turn sees it — no restart. **Remove**: delete it in Settings → Skills (trash-staged; the shipped tier skills are refused), or delete the file, or keep it installed and shadow it by setting `enpoi-orchestration.capabilities.skills.<name>: false` — the disabled skill vanishes from the catalog, the `skill` tool result, and the `/name` gesture, and its execution is denied before dispatch (B4: `packages/enpoi-capabilities/src/index.ts:531-559`; enforcement `enforcement.ts:72-81`). Zero token cost either way.

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

A catalog entry alone does nothing: the mount requires `capabilities.mcp[id] === true` (`index.ts:313-318`, `358-365`).

**Mount/unmount = the disposable-fiber pattern** (`index.ts:381-425`): one enabled server is one `ctx.plugin(mcpClient.apply, { transport: 'streamable-http', serverName, url, headers, toolCallTimeoutMs, failOnStartupError: false })` fiber, awaited so its tools register before the toggle settles; disabling it or removing it from the catalog calls `fiber.dispose()`, which disconnects and unregisters every tool of that server. A settings update re-runs the sync, a boot retry fires after 3 s, and a failed mount is retried on the next settings change rather than spamming.

Tool names are server-qualified: `mcp__<serverName>__<rawName>`, normalized to the 64-char `[A-Za-z0-9_-]` function-name contract with a 12-hex SHA-256 suffix when normalization is lossy (`packages/mcp/mcp-client/src/tools.ts:48-87`). Registration is two-phase (fetch the full generation, then swap); a conflict rolls back to zero tools from that server, never a partial set (`tools.ts:113-162`).

## 6. MCP — auth, status, permissions, removal

- **Auth**: `apiKeyEnv` is resolved through the `credentials` service (environment plus the deployment's credentials file); the value is inserted as `Authorization: Bearer …` unless `headers` already set one (`index.ts:336-353`, `395-397`). Credentials are never logged.
- **Status heartbeat**: `mcpStatus` is written every 15 s (plus 4 s after boot): mounted = online; unmounted = one 2.5 s JSON-RPC `initialize` POST (any HTTP response online, 401/403 flagged as `authError`); unreachable = down. A last mount error travels on the entry (`index.ts:444-527`).
- **Permissions**: three tiers. Capability toggle `capabilities.mcp[id] === false` → deny and schema strip; otherwise the policy ladder — exact `mcp__<server>__<tool>` row, then `mcp__<server>__*`, then `mcp__*`, then `defaults.unknownTools` (ship `ask`) (`policy.ts:273-299`); grants/denies behave exactly as file 04. Mounted server names feed the ladder (`index.ts:603-606`).
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
