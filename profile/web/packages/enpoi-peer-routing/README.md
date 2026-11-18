# dsh-enpoi-peer-routing

English | [中文](README.zh.md)

Policy-gated model discovery and selection for the device-to-device peer API.
The plugin provides the `peerRouting` service the peer host resolves through
`ctx.get('peerRouting')`: a paired controller can discover the chains and models
its pairing actually allows, ask whether one selection is permitted, and let the
host apply the resolved route at create or switch time. The service is inert
until a pairing carries a `routing` block, but it is mounted by default so the
peer handshake advertises `model-discovery`, `model-routing-at-create`, and
`model-switch`.

Nothing this service returns carries credentials, base URLs, headers, provider
error text, a settings document, or an allowlist: a refusal names only the
offending identifier.

## Service

`evaluate(policy, selection)` resolves the catalogue, the chain registry, and
route health at call time and answers either
`{ allowed: true, selection: { provider, model, chain?, reasoningEffort? } }` or
`{ allowed: false, reason, denied }` with one of the peer contract's reasons:
`chain-not-allowed`, `model-not-allowed`, `price-unproven`,
`training-unproven`, `tools-unproven`, `effort-not-allowed`, `unknown-route`.

`discover(policy, { filter?, cursor?, limit? })` returns the allowed chains with
their live member state (`ready` / `cooldown` plus `cooldownUntil`, or
`deprecated` for a catalogue record the endpoint dropped) and the
models that pass the same predicate `evaluate` uses. Results are ordered by
`(provider, model)` and paginated with an opaque base64url cursor; an invalid
cursor throws `invalid cursor` for the host to map.

Facts come from the same sources the model picker uses, never from a local
guess:

- catalogue entries through `dsh-enpoi-catalog-rules` (`readCatalogue`, or the
  live `catalogRules` engine projection so manual gated overrides apply);
- the zero-price predicate through that package's selector expansion, so
  "unknown price" stays unknown and is refused when the policy demands proof;
- privacy through `resolvePrivacy`; `trainsOnData` is `yes`, `no`, or `unknown`,
  and only `no` satisfies `requireNoTraining`;
- `tools` from the catalogue projection; only `true` satisfies `requireTools`, and
  `false` and `unknown` are refused as `tools-unproven`;
- `reasoningEfforts` from the raw `llm-pi-ai` model row (the catalogue projection
  does not carry the ladder);
- chains from the `modelChains.resolved` artifact (`settings.readArtifact`),
  and route health from `ctx.llm.routeHealth()` (`coolingUntil`); an absent
  artifact means no chains, and an absent health row means ready.

## Policy evaluation

The policy is the pairing's `routing` block. Chain ids are exact values;
`allowModels` entries are anchored globs where `*` is the only wildcard (it
spans `/` too) and every other character is literal. An empty `routing: {}`
block selects nothing (deny-all) while still making the routing policy
authoritative for the pairing.

- **Chain only** (`{ chain }`): the chain must be listed in `allowChains` (an
  absent or empty list allows nothing) and must resolve through
  `modelChains.resolved`. Every resolved member is re-checked against the
  policy at selection time; one paid, unknown-price, training, unknown-training,
  gated, deprecated, or non-matching member refuses the whole chain and names
  that member.
  The first member that is not cooling becomes the concrete selection; when
  every member is cooling the first declared member is used.
- **Pinned route** (`{ provider, model }`): the route must exist in the
  catalogue, must match an `allowModels` glob (an absent or empty list selects
  no pinned route), and must satisfy `requireZeroPrice` / `requireNoTraining`.
- **Pinned route plus chain**: both grants apply and the chain must contain that
  exact member. The member re-check above still runs.
- **Tools**: `requireTools: true` refuses any route without a proven
  `tools: true`; a catalogue `false` or `unknown` answers `tools-unproven`.
- **Effort**: a caller-named effort must be inside `allowReasoningEfforts` and
  the selected model's advertised ladder. A chain link's own effort is part of
  the effective selection and is checked the same way.
- **Gated or deprecated**: a gated route and a catalogue record marked
  `deprecated` (kept only for a route-local reference after the endpoint dropped
  it) are always refused, even when a glob matches. A chain containing a
  deprecated member refuses the whole chain by name, and discovery still lists
  the chain with that member's state as `deprecated`.

## Discovery

`discover` reads one snapshot per request, so a dynamic chain that drifts
between discovery and evaluation is caught by the evaluation — the caller may
have seen the old membership, but the host never applies a member the current
policy refuses. A boolean filter requires exact equality, so `zeroPrice: false`
and `tools: false` exclude rows whose fact is `unknown`.

## Pairing usage (free-only worker)

A worker alias restricted to the free group. The `routing` block lives on the
alias owner's fleet member (the member whose `exposure` and `create` the entry
already uses); the generator renders it into that alias's pairing entry.

`fleet.yaml` form:

```yaml
members:
  - name: jarvis
    alias: jarvis-worker-test
    exposure: answer-only
    create: jarvis-readonly
    hostnames: [jarvis-worker-*]
    ip: 100.64.0.9
    routing:
      allowChains: [free]
      allowModels: ["kilo/*:free", "openrouter/*:free"]
      requireZeroPrice: true
      requireNoTraining: false
      requireTools: true
      allowReasoningEfforts: [minimal, medium]
      allowSwitch: idle-only
      maxTotalTokens: 200000
```

The matching `$DSH_HOME/pairings.yaml` entry:

```yaml
pairings:
  - alias: jarvis-worker-test
    peer: jarvis
    exposure: answer-only
    create:
      agentPreset: jarvis-readonly
      workspaceId: ws-example
    routing:
      allowChains: [free]
      allowModels: ["kilo/*:free", "openrouter/*:free"]
      requireZeroPrice: true
      requireNoTraining: false
      requireTools: true
      allowReasoningEfforts: [minimal, medium]
      allowSwitch: idle-only
      maxTotalTokens: 200000
```

Set `requireNoTraining: true` for any run that is not using fabricated knowledge
and fake files: free providers may train on prompts, and `unknown` training is
refused. Add `requireTools: true` for a worker that must call tools: on the
shipped catalogue every free row reports `tools: true`; a route whose tool
capability is unknown is refused rather than assumed.

The fleet generator carries `create.agentPreset` only. A workspace placeholder
therefore belongs in the pairing document or, for a generated document, on the
`peer.create` request itself; the host's create defaults apply otherwise.

### Create request

Chain only — the host resolves the first non-cooling member:

```json
{
  "alias": "jarvis-worker-test",
  "participant": { "kind": "peer", "name": "jarvis", "device": "jarvis-host" },
  "chain": "free",
  "reasoningEffort": "medium",
  "maxTotalTokens": 200000
}
```

Pinned route:

```json
{
  "alias": "jarvis-worker-test",
  "participant": { "kind": "peer", "name": "jarvis", "device": "jarvis-host" },
  "provider": "kilo",
  "model": "nvidia/nemotron-3-ultra-550b-a55b:free",
  "reasoningEffort": "minimal"
}
```

Pinned route plus chain — the route must be a member of that chain:

```json
{
  "alias": "jarvis-worker-test",
  "participant": { "kind": "peer", "name": "jarvis", "device": "jarvis-host" },
  "provider": "kilo",
  "model": "nvidia/nemotron-3-ultra-550b-a55b:free",
  "chain": "free"
}
```

### Chain versus pinned route

A chain selection rolls over: the concrete route is the first ready member and
may change as members cool and recover, so it is the right choice for the
rate-limited free group. A pinned route is stable and refused as soon as the
catalogue can no longer prove its price, training verdict, or effort — it never
falls back to another model. In both cases the host reports the route that
actually ran, and the policy is re-evaluated at switch time.

## Failure posture

Every read fails closed. A missing chain artifact means no chain resolves; a
rules-engine failure answers no catalogue routes rather than an ungated one; a
missing zero-price proof refuses a price-requiring policy; an absent or
malformed cursor is an error, not a silent first page. The plugin never inspects
the settings document to invent chain membership and never proxies
`settings.describe`.

## Tests

The package specs run with the profile Vitest config and cover the glob
semantics, the catalogue fact table (zero-price, paid, unknown price, gated,
trains, no-train, unknown training), chain resolution and drift between
discovery and evaluation, pinned and chain grants, effort validation, filters,
pagination, and the `apply` wiring. `tests/generate-pairings-routing.spec.ts`
pins the fleet routing golden render and its strict validation.
