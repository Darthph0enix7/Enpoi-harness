---
description: "Seed the keyless Kilo Gateway route on a fresh install, and run the opt-in read-only sysadmin investigation that feeds the system profile."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-first-run

English | [中文](README.zh.md)

## Summary

Two first-run facts of a new harness home. The seed writes the keyless Kilo Gateway route and points the default model at `kilo-auto/free` on the first settled boot of a fresh settings document; the route lives in the user layer, so the Models page can remove it and a marker stops any later re-seed. The system analysis is an explicit opt-in: the user starts it from the setup wizard's agents step or from the frame-wide chip, and one bounded sysadmin agent session then investigates this machine read-only with the harness's own tools over a seven-section checklist, publishing a structured `system-profile.json` and a comprehensive `system-profile.md` whose `## At a glance` capability summary opens the full detail. A sysadmin-mounted prompt context contributes only the essentials read from that JSON plus a reference to the document. Nothing schedules a run on its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the seed row where a fresh install should talk to a model with no key. The seeded route names the public gateway endpoint `https://api.kilo.ai/api/gateway` and never a machine-local server.

```yaml
- name: '@deepseek-ai/dsh-host-first-run'
  config:
    enabled: true
    provider: kilo
    model: kilo-auto/free
```

Mount the analysis routes where browsers can reach them, and the context row inside the sysadmin agent preset.

```yaml
- name: '@deepseek-ai/dsh-host-first-run/analysis'
  config:
    preset: sysadmin
    permissionPreset: workspace-write
    timeoutMinutes: 15

- name: '@deepseek-ai/dsh-host-first-run/context'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run the seed when no marker is stored |
| `provider`, `model` | `kilo`, `kilo-auto/free` | Route id and free model the seed writes |
| `seedVersion` | empty | Marker; any stored value means the seed already decided |
| `routes` | `true` | Register `/system-analysis/start`, `/status`, `/context`, `/accept`, and `/reject` |
| `preset` | `sysadmin` | Agent preset that investigates; it is mounted for that one session |
| `permissionPreset` | `workspace-write` | Permission preset enforced on the investigation session; it only opens the run's own scratch workspace |
| `timeoutMinutes` | `15` | Hard bound on one investigation |

The run is a singleton and only ever starts on an explicit client action. `start` answers the current view while a run is live or settled, `status` never changes it, `context` returns the stored document or null, and `accept`/`reject` record the operator's decision. The investigating agent keeps a todo list whose items are the checklist sections, and the host maps that list onto the chip's stage rail; the agent writes `profile.json` and `system-profile.md` into the run's scratch workspace with the ordinary `write` tool, and the host copies both to the harness home. A missing agent runtime, unknown preset, or expired bound fails the run with its reason in the job view and leaves the harness untouched.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The seed waits for the Loader to settle (`ctx.root.loader.await()`) so the `llm-pi-ai`, `agent-default-model`, and `first-run` entries are active, then writes provider route, default model, and marker in that order. A failure logs one warning and leaves the marker unset; the next boot retries. A settings document that already carries provider routes is a configured install: the seed writes only the marker.

One investigation is one root agent session on the configured preset: the runner resolves the preset, pins its revision (`acquireScope`), clears its scratch workspace under the harness home, creates the session with `cwd` there, sets the configured permission preset, titles it, and sends the checklist prompt as the opening user message. The prompt binds the agent to a read-only investigation of the host, requires the exact todo items that drive the stage rail, names every checklist section, requires CUDA to be checked through every path (`nvcc`, conda, language runtimes, `nvidia-smi`), defines absence as the state after every plausible path was checked, and requires `profile.json` plus `system-profile.md` (opened by the `## At a glance` capability summary) in the workspace. The runner follows the session's `todo_write` events for stages, waits for the turn to close, validates the two files, allows two bounded corrective turns, then writes `system-profile.json` and `system-profile.md` atomically and disposes the session. The whole run is cancelled by the configured time bound and by the plugin lifetime.

The context provider reads the document per assembly and falls back to `DEFAULT_SYSTEM_CONTEXT`; when the JSON is present it prepends one bounded essentials line read from it.

[`src/index.ts`](src/index.ts) owns the seed, [`src/analysis.ts`](src/analysis.ts) the runner and routes, [`src/investigation.ts`](src/investigation.ts) the session, prompt, stage mapping, and workspace, and [`src/context.ts`](src/context.ts) the preset-scoped contribution. No runtime invariant companion is published: the stored document is the only durable fact and it is read back in tests.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

A sysadmin session receives one dynamic context entry, `system-analysis`. Before any investigation ran — or after the operator rejected the document — its text is this verbatim default:

```markdown
System profile: no analysis is stored for this machine yet.
Hardware, operating system, service and hosting facts are unknown here.
Confirm them with read-only commands before acting, or run the system analysis.
```

Once a profile is stored, the entry is one essentials line read from `system-profile.json` (host kind, CPU, memory, GPU, disk; absent fields are omitted) followed by a reference to the full document:

```markdown
System profile essentials: server; CPU Xeon E5-2680 v4, 28 threads; memory 62 GiB; GPU Tesla P40, 24 GB; disk 30 GiB free of 232 GiB.
Read $DSH_HOME/system-profile.md for this machine.
It is the living, full record of this host; the structured profile sits beside it as system-profile.json.
Confirm anything the document does not state with read-only commands.
```

#### Token effect

One context block per assembly, bounded by the essentials line plus three reference lines; the full document is never inlined. The analysis row itself adds no prompt sections and no tools.

#### KV cache effect

The context text is stable between investigations, so the sysadmin prefix caches normally; a completed investigation replaces the text once, and later turns stay stable. The investigation session's own prompt is written once per run.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The sysadmin preset must mount `@deepseek-ai/dsh-host-first-run/context`; the fork profile owns that row. The harness repository ships the export only.
- The analysis starts only on an explicit action (the agents step or the chip); once a profile is accepted or a decision is recorded, nothing re-offers a run.
- The investigation session runs `workspace-write` scoped to its own scratch workspace so the agent can drop the two artifacts; the host outside that directory stays read-only to it, and the prompt forbids every other mutation.
- Enforcement depends on the deployment naming its permission presets; an unavailable `permissionPreset` logs a warning and continues with the prompt's read-only rule alone.
- The investigation session is not attached to a Workspace, so it appears in history but not in a workspace's session list.
