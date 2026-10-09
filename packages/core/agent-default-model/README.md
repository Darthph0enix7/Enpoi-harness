---
description: "The deployment default model selection for users and maintainers choosing, configuring, or debugging which model freshly created agents start on."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-default-model

English | [中文](README.zh.md)

## Summary

Give newly created agents a shared default provider and model when their sessions do not specify one. Provider, model, and reasoning effort are live Config fields. Saved selections update the active profile patch and apply to subsequent reads; per-session selection remains owned by the entry point.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package wherever agents are created without an explicit model route. The service answers one question — which model should a fresh agent use? — so entry points that create agents consult it instead of re-implementing a default.

### Configure the default

The composition requires a provider and model. Consumers read the live references even when no configuration editor is mounted. A blank `provider` or `model` is an unset selection: under the shipped `baseline: kilo` policy it resolves to the keyless Kilo Gateway free tier (`kilo` / `kilo-auto/free`), the route the first-run seed also writes, so a deployment that configures nothing still starts. That is why a fresh install depends on the Kilo Gateway free tier even with no provider configuration in the profile. `baseline: off` keeps blank fields blank, so a deployment that deliberately runs no Kilo fallback (for example one whose sessions always carry their own route) owns the missing route instead. The mode is a live field editable from Settings, and saving a selection preserves it.

```yaml
- name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek
    model: deepseek-chat
    baseline: off
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | Registered provider route for fresh agents |
| `model` | required | Provider-owned model id for fresh agents |
| `baseline` | `kilo` | Fallback for a blank provider or model: `kilo` resolves each blank to the keyless Kilo free tier; `off` keeps blanks blank |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-default-model) lists every accepted field. `reasoningEffort` is optional; saving a selection without it removes that field from the profile’s complete config override.

### Read and change the default

`currentSelection()` returns a detached `{ provider, model, reasoningEffort? }` for a newly created agent; `saveSelection()` stores the complete selection for later agents. A `chain` the optional `modelChains` registry cannot route is dropped with a warning before the profile write, so a pick that echoes a retired group cannot persist the reference. The deployment’s `baseline` policy is not part of a selection: `saveSelection()` carries the live value over, so a model pick never silently re-enables the Kilo fallback an owner turned off.

```text
const selection = ctx.agentDefaultModel.currentSelection()
await ctx.agentDefaultModel.saveSelection({ provider, model, reasoningEffort: 'high' })
```

Without a configuration editor, `saveSelection()` is a no-op. A selected provider that is not registered with the live `llm` registry logs one warning per provider: the Models page resets every operator reference when it deletes a route, but a route removed outside that path (a hand-edited settings document, a composition change) has no client-side writer, so this diagnostic names the dangling default without changing it. The service does not otherwise validate catalog membership; the consumer opening a model request owns availability failures.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The service retains its validated Config references and samples them in `currentSelection()`. `saveSelection()` captures the submitted values and serializes profile writes in submission order, including overlapping callers. Each caller observes its own write failure; a rejected write does not prevent later saves. Session-specific selection takes precedence in the consumer.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Live default selection and profile-backed writes |
| — | No invariant companion is published because Config references are the only owned values. |

### Behavior notes

`currentSelection()` returns a detached selection. A captured selection stays stable while later operations read updated Config references.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [Core subsystem](../../../docs/subsystems/core.md) — the `Agent` handle and `AgentOptions` route selection.
- [agent-loop package](../agent-loop/README.md) — how agents resolve provider and model at request time.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-default-model) — every accepted config field and its source declaration.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `ModelSelection` the service supplies to an entry point; request assembly and the provider adapters own the model-visible request.

#### KV Cache effect

Changing the default affects only agents that subsequently resolve from it. An existing session whose request log already names a selection keeps that selection, so this service does not invalidate its established prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the service's scope. They are current package constraints, not a task backlog.

- **One process-wide default** — the service owns a single default; per-session model selection remains the entry point's responsibility.
- **Persistence requires a profile configuration editor** — without it, saving a default does not retain the selection.
- **A route removed outside the Models page is only diagnosed, not repaired** — the service never rewrites the stored selection; resetting references is the deleting writer's job. Other settings consumers (keeper, summariser, seats, groups, favorites) read their references live and fail the request instead of substituting a default.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
