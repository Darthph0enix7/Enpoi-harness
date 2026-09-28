# 07 — Agents & orchestration

How agent presets, seats, councils, the Oracle, and delegation work, and how to add, retarget, or disable each. Sources are cited repo-relative: `packages/…` is the harness repo, `profiles/<profile>/packages/…` is the installed profile (the fork packages live there, not upstream). Read the file you are about to edit before changing anything.

## 1. Presets — the session's agent identity

- A preset is a directory `profiles/<profile>/presets/<id>/` holding two files:
  - `preset.yml` — roster metadata: `name`, `description`, `order`.
  - `agent.cordis.yml` — the Cordis composition mounted for sessions on this preset: persona prefix, tool rows, skill dirs, each row `- id: / name: / config:`; `disabled:` takes a JS expression.
- Shipped presets (fork): `orchestrator` (default implementer, order 1), `sysadmin` (ops, 2), `creator` (harness-only repair, 3). Upstream adds headless/web/desktop presets.
- Upstream row contract: `packages/preset/agent-preset/src/index.ts:11-20` (`id`, `name`, `description`, `order`, `plugins`), registered via `ctx.agentPresets.register`, listed by `packages/preset/agent-preset-registry/src/preset.ts` (roster + `default`/`selectedDefault`).
- Create a new agent: copy an existing preset dir, change `order`, keep the composition minimal, add skill dirs under `<preset>/skills/` and reference them from a `skill-filesystem` row (`config.customSkillDirs`). Then restart the web service — use `dsh restart --after-turn` from a hosted session, never a bare restart (see 02-install-and-update).
- Failure modes: a composition that fails to mount is surfaced as `broken` on the roster; a row naming an unmounted plugin disables that row only. If a session "loses" a tool, diff the preset's `agent.cordis.yml` against the plugin's row name before debugging deeper.

## 2. Main agents vs subagents

- One session = one main agent (the preset composition). A subagent is a separate child session spawned through the `subagent` tool (`packages/subagent/tool-subagent/src/index.ts`), with its own log, tool surface, and durable id.
- Two shapes (`packages/subagent/subagent/README.md:12,59`): one-shot (single result, optional structured output) and continuable (later messages, interrupt; default `backgroundMode: one-shot`).
- Context inheritance is explicit, not implied: a fork child sees the parent's completed turns, a fresh child does not — the tool description changes accordingly (`tool-subagent/src/index.ts:260-284`). Children return a result, not intermediate steps.
- `maxDepth` per delegation (`tool-subagent/src/index.ts:95-102`): omit → Host depth setting, default `1`; `0` forbids delegation; integer → provider-enforced (mount fails loud if the provider has no `depthLimit`); `'provider-managed'` leaves it to the provider.
- Parent-controlled spawn options: provider (`spawn` = in-process), label, `run_in_background` (continuable providers resolve at inbox acceptance; one-shot backgrounds become jobs), `quiet` (no parent-facing turn noise), and `agentOptions` (provider/model/effort for the child route) (`tool-subagent/src/index.ts:905-935`; `subagent/src/types.ts:56`; council spawn at `enpoi-council/src/core/fiber.ts:353-369`).
- Nested children exist: a continuable child can spawn its own children, and a settled resident (nested) parent keeps the waking flow for settlement notices because a quiet hold would strand its activation (`subagent/README.md:111`).

## 3. Seats and fleet routing

- A **seat** is a named model assignment key. Seat routing lives in `enpoi-orchestration.personas[<seatId>]` = `{ provider, model, reasoningEffort?, chain? }` (read freshest per spawn, `profiles/web/packages/enpoi-orchestration` consumers; e.g. council `core/fiber.ts:274-290`).
- Fleet groups render in fixed order (`packages/client/ui-brand-enpoi/src/client/role-registry.ts:50-58`): `supervision`, `specialists`, `council`, `custom` — plus one group per registered council and `UNGROUPED` for persona-only ids.
- Shipped seats per group: supervision — The Oracle, Context Keeper, Compaction Summariser; specialists — Fixer, Explorer, Librarian, Designer; council — Referee, Chair, and each council's debaters (role-registry.ts:152-183).
- Unassigned seats fall back two ways (`fleetSeatState`, role-registry.ts:89-92): `inherit` = the dispatching/session model; `builtin-default` = the seat's own plugin route.
  - **Keeper:** always `builtin-default: freellmapi/auto` (role-registry.ts:61,157) — it runs outside a conversation and has no parent model to inherit from. Do not expect it to follow the session model.
  - **Compaction Summariser:** designated seat, always rendered, `inherit` (session model). The footer states the economics: a different summariser model loses the prompt-prefix cache and pays full input price for the region (`AgentModelsBody.tsx:217`); the panel explains all three states — assigned / inherit / built-in default (AgentModelsBody.tsx:8-18).
- To retarget a seat: Settings → Agent Models → Fleet Routing, pick a provider/model for the row (writes `personas[<id>]`); Reset clears it back to the default. A chain assignment resolves to the first enabled link at run time (compaction: `compaction-basic/src/settings.ts:138-161`; councils: `fiber.ts:238-272`).

## 4. Councils

- Two shipped councils, data-defined specs (`profiles/web/packages/enpoi-council/src/profiles/`):
  - **roundtable** — Skeptic / Architect / Pragmatist debate a decision; ledger kinds `crux` (C-, terminal `invariant|falsified|dissent`) and `risk` (R-); mandatory steelman before an attack flip; deliverable sections Decision / Options Considered / Evidence / Established Invariants / Binding Dissents / Action Items; defaults `defaultMaxRounds 6`, `stagnationLimit 2`, `challengeRound true` (`roundtable.ts:31-57`).
  - **chorus** — Visionary / Experiencer / Integrator in forest mode (SPROUT/BRANCH/FUSE/TENSION, nothing deleted); topological-saturation stopping; harvest with lineage (`chorus.ts:31-56`).
- Every council runs with two fixed arbiter roles, never seats: `referee`, `chair` (`enpoi-council/src/registry.ts:37`). Seat ids must be 2–32 chars `[a-z0-9_-]`; 2–8 contenders (`core/spec.ts:141,214`); ledger transitions are a DAG enforced by the engine, not the model (`spec.ts:51-64`).
- Tools: `roundtable` and `chorus` (one per enabled council), plus `council_register` / `council_list` (`tools.ts:174-176,256,421,522`). Registered councils get a tool named by their id.
- Running a council: the tool call is blocking; params come from `enpoi-orchestration.parameters.council`, read fresh per run (hot-swap) — `defaultMaxRounds` (6), `debaterTimeoutMs` (300 s), `runDeadlineMs` (30 min, on breach it skips to the chair), `evidenceBroker` (true), `evidenceTimeoutMs` (120 s) (`params.ts:22-38`; clamps at 48-62).
- **Evidence broker + vault:** debater fibers deny all retrieval tools and `bash` (`core/fiber.ts:93-149`, keep-list only whiteboard tools + `send_message` denied); a seat asks for ground truth with `NEED_EVIDENCE(target:, question:)` text lines. At each epoch boundary the engine batches the queue into ONE research child (`explorer` for codebase targets, `librarian` for external), one `SHEET n / CITATION / FACTS / CONFIDENCE` per question, committed to the append-only **evidence vault** as `F-n` before the referee pass (`core/broker.ts:120-132,193,236-245`; `core/vault.ts:10-18`). Missing/excess sheets are named failures, never silent; placeholder citations degrade to `unverified`.
- **Referee:** one flagship fiber per pass returns strict JSON only — `admissions`, `flips`, `directives`, `floor`, `scopeWarnings` (`core/referee.ts:78-94`). The engine applies every mutation and rejects steelman-less attack flips procedurally (`referee.ts:252-270`), unknown ledger kinds with a named reason (`referee.ts:289-296`), and a pass with no JSON is a hard handoff failure (retry once).
- **Chair:** compiles the deliverable with EXACTLY the spec's `deliverableSections`; a missing/bodyless section is a reported `ChairOutputError`, retried once, then mechanically compiled — never an empty answer forwarded (`core/chair.ts:1-21,58-84`; `core/engine.ts:544-567`).
- Register/retire a council: write `enpoi-orchestration.councils[<id>]` (same shape `council_register` validates; `stoppingPolicy` + `chairTemplate` required) or use `council_register`. A settings entry with a built-in id overrides it; `disabled: true` retires it (tool disappears) — `registry.ts:1-19,306-335`. Invalid entries stay visible with their exact validation problem in the council UI; nothing is skipped silently.

## 5. The Oracle

- `oracle_review` consults a senior reviewer child: call #1 of a user query is fresh and self-contained; follow-ups are deltas in the same fiber. Blocking by default, `background: true` delivers the verdict as a message (`enpoi-oracle/src/index.ts:569-595`).
- Lifecycle: fiber resets at each new human user message; one consultation per session at a time (single-flight mutex returns `CONCURRENT_CALL_REJECTED`); timeout default `120_000 ms` via `parameters.oracle.timeoutMs`, resolved per call; on timeout the child is NOT cancelled and its verdict is delivered late as a message (`index.ts:629-638,647-663,685-690,216-218,864-867`).
- Surface: read-only review; the oracle may delegate (subagent tools) and use `request_evidence(target, question)`, which spawns one research child and returns a cited fact sheet (`index.ts:53-72,74-102`). Verdict JSON `{approved, concerns, unverified, blockers}` must be last (`index.ts:48-49`).
- Model: `personas.oracle` (provider/model/effort/chain). With a chain, a failed attempt disposes the child, respawns the SAME initial package on the next link, and fails open to exactly one wait without a chain (`index.ts:740-770`).

## 6. Delegation rules

- **Budgets:** every delegated child gets a standing clause — `CHILD_TOOL_BUDGET = 20` tool calls is a ceiling for exploration, not a counter to satisfy; report best evidence or report what is missing (`packages/subagent/subagent/src/continuation-messages.ts:99-120`). The clause is appended on every path (continuable, background, foreground — `tool-subagent/src/index.ts:1121,1140`).
- **Quiet single delivery:** foreground delegation returns one result; background/continuable settlement injects ONE notice into the parent containing the outcome line and the child's closing report only (reasoning and tool blocks stripped) — `continuation-messages.ts:129-195`. A settlement that lands while the parent is parked/reverted is held quietly in the durable next-turn inbox for a root parent (`subagent/README.md:111`).
- **Ping-pong asks:** children do not stream intermediate steps back; a continuable child can send a message mid-task (`withContinuableReturnGuidance`, `continuation-messages.ts:81-97`) and the parent can send follow-ups — each message is a bounded child turn, while the Oracle keeps its own single-flight mutex so a session can never have two consultations in flight. The design's auto-wake guardrails (per-query wake budget, ping-pong circuit breaker) are recorded in `~/dsh-migration/34-concurrency-and-race-conditions.md` §I5; verify present code before promising them.
- **Nested children:** depth is capped by `maxDepth` (default 1, see §2); stopping a parent parks the descendant tree — the cancel cascade recursively enumerates the whole session tree, including continuable grandchildren (`profiles/web/packages/enpoi-cascade/src/index.ts:58-114`).
- **Failure forwarding:** a failed child never reports success — `settlementSummary` names the ending (aborted / max-tokens / refusal / error / abnormal) and providers append the failure detail plus any preserved partial answer to the error (`continuation-messages.ts:129-152`; `tool-subagent/src/index.ts:171-180`).
- **Keeper exemption:** the context keeper is not a subagent, so the ancestor-cancel cascade never enumerates it — it keeps running through stop-all/revert cascades (`enpoi-cascade/src/index.ts:21`; doc 34 invariant I9).

## 7. Enable / disable switches

- Capabilities Control Center (`enpoi-orchestration.capabilities`) is the master switchboard (`profiles/web/packages/enpoi-capabilities/src/state.ts`, `types.ts:44-70`): `skills[<name>] !== false` strips a skill from the catalog AND shadows it pre-dispatch; `tools[<id>]` false strips the tool from the model-facing list and denies it; `mcp[<id>] === true` is required to mount an MCP server.
- Protected infrastructure cannot be disabled: `enpoi-contracts`, `enpoi-context-keeper`, `enpoi-cascade`, `enpoi-living-brief`, `read`, `glob`, `grep` (`types.ts:27-35`).
- The keeper's own tool flag is `capabilities.tools.keeper` (default true); disabled means prose distillation and claims extraction are skipped and consumers degrade to the deterministic fold (`enpoi-context-keeper/src/index.ts:102-113,586-588`).
- A registry role is hidden from the fleet with `roles[<id>].seat: false` or `disabled: true`; `null` deletes it (`role-registry.ts:203-261`). A role may carry `tools.available` (a tool-id allowlist for its persona, `role-registry.ts:253-257`). A tool-only role (Oracle, `spawnable: false`) is never matched by delegation text (`tool-subagent/src/index.ts:340-350`).

## 8. Failure modes → fix

| Symptom | Cause | Fix |
|---|---|---|
| Seat runs on an unexpected model | No assignment → inherit, or stale `personas[<id>]` | Agent Models → Fleet Routing: assign or Reset the row; check the row's state label |
| Council tool missing | Council retired (`disabled: true`) or invalid entry | Council list shows the validation problem; fix the spec or remove `disabled` |
| Council produces empty deliverable | Chair output failed shape validation and mechanical compilation also failed | Check the council log (`$DSH_HOME/logs/enpoi-council.log`); inspect ledger/referee records in the result |
| `oracle_review` blocked (`CONCURRENT_CALL_REJECTED`) | Another consultation in flight for the session | Wait for the verdict or the timeout; the child is not cancelled |
| Child floods the parent with messages | Continuable child sending per-finding messages | Tighten the task prompt; the 20-call budget clause is already appended |
| Keeper still runs after stop-all | Cascade exemption (by design) | Disable it via `capabilities.tools.keeper` if truly unwanted |
| Preset missing after install | Composition row unmounted / preset dir not shipped | `dsh plugin list`/`cordis_inspect` for the row; see 02-install-and-update |
