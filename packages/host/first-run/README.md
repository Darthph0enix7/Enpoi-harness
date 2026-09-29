---
description: "Seed the keyless Kilo Gateway route on a fresh install, and run the read-only system analysis that feeds the sysadmin context."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-first-run

English | [中文](README.zh.md)

## Summary

Two first-run facts of a new harness home. The seed writes the keyless Kilo Gateway route and points the default model at `kilo-auto/free` on the first settled boot of a fresh settings document; the route lives in the user layer, so the Models page can remove it and a marker stops any later re-seed. The analysis runs one bounded, read-only scan (hardware, operating system, services, disk, and the NVIDIA GPU when present) while the user keeps working, publishes it over `/system-analysis/*`, and stores it as the sysadmin system-context document.

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

Mount the analysis routes where browsers can reach them.

```yaml
- name: '@deepseek-ai/dsh-host-first-run/analysis'
  config:
    routes: true
```

Mount the context row inside the sysadmin agent preset, so the scan becomes that agent's machine context and the documented default applies before any scan ran.

```yaml
- name: '@deepseek-ai/dsh-host-first-run/context'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run the seed when no marker is stored |
| `provider`, `model` | `kilo`, `kilo-auto/free` | Route id and free model the seed writes |
| `seedVersion` | empty | Marker; any stored value means the seed already decided |
| `routes` | `true` | Register `/system-analysis/start`, `/status`, `/context`, `/accept`, and `/reject` |

The analysis is a singleton run: `start` answers the current view while a run is live or settled, `status` never changes it, `context` returns the stored document or null, and `accept`/`reject` record the operator's decision. The first-run client auto-starts the run while the setup marker is pending; outside first run nothing schedules a run. Every probe is independent and bounded to five seconds; a missing tool degrades one section to a named line and never fails the scan.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The seed waits for the Loader to settle (`ctx.root.loader.await()`) so the `llm-pi-ai`, `agent-default-model`, and `first-run` entries are active, then writes provider route, default model, and marker in that order. A failure logs one warning and leaves the marker unset; the next boot retries. A settings document that already carries provider routes is a configured install: the seed writes only the marker.

The scan uses `node:os`, `statfsSync`, and bounded `execFile` probes (`systemctl`, `nvidia-smi`); the document is written atomically under the harness home. The context provider reads that document per assembly and falls back to `DEFAULT_SYSTEM_CONTEXT`.

[`src/index.ts`](src/index.ts) owns the seed, [`src/analysis.ts`](src/analysis.ts) the run and routes, [`src/scan.ts`](src/scan.ts) the probes, and [`src/context.ts`](src/context.ts) the preset-scoped contribution. No runtime invariant companion is published: the stored document is the only durable fact and it is read back in tests.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

A sysadmin session receives one dynamic context entry, `system-analysis`, whose text is the stored scan document or this verbatim default:

```markdown
System context: no analysis is stored for this machine yet.
Hardware, operating system, service and disk facts are unknown here.
Confirm them with read-only commands before acting, or run the first-run system analysis.
```

#### Token effect

One context block per assembly, bounded by the document the scan writes (service names are capped at 20 units). No tools, schemas, or sections are added by this package.

#### KV cache effect

The context text is stable between scans, so the sysadmin prefix caches normally; a completed analysis replaces the text once, and later turns stay stable.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The sysadmin preset must mount `@deepseek-ai/dsh-host-first-run/context`; the fork profile owns that row. The harness repository ships the export only.
- The analysis auto-starts from the first-run client while that flow is pending; once the setup marker is stored or a decision is recorded, nothing schedules or re-offers a run.
- Service probing assumes `systemd`; other platforms record the section as unavailable.
