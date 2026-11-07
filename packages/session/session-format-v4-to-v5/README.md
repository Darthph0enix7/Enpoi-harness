---
description: "Complete V4-to-V5 Session edge: identity body conversion, released physical framing, inherited-cut preservation, and generation-owned refusal."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

English | [中文](README.zh.md)

## Summary

Restore supported released V4 Sessions as V5 without rewriting their stored generation. This page specifies the edge's conversion, preservation, and refusal. The body conversion is an identity: every event, compact run, coordinate, timestamp, reference, and payload is emitted unchanged. Persistence owns file reads and successor publication; this library owns header conversion, target admission, and validation.

## Table of Contents

- [Use this package](#use-this-package)
- [V4-to-V5 specification](#v4-to-v5-specification)
  - [Header and physical framing](#header-and-framing)
  - [Identity body preservation](#identity-body)
  - [Inherited cut](#inherited-cut)
  - [Legacy vocabulary](#legacy-vocabulary)
  - [Unknown events and refusal](#refusal)
  - [Recovery and successor publication](#recovery-and-publication)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the [catalog](../session-format-catalog/README.md) for complete restoration. Direct imports serve catalog assembly and tests; this library has no Cordis mount configuration. Its [public exports](src/index.ts) provide the adjacent migration, the released V5 codec and restorers, and the reused released V4 source codec and native row admission. The source codec remains owned by [V3-to-V4](../session-format-v3-to-v4/README.md).

Header-only migration validates and advances metadata without reading the body:

```text
const targetHeader = sessionFormatV4ToV5.migrateHeader(sourceHeader)
```

Every restore creates independent Stage state. Compact runs pass through without expansion. Persistence must read and verify the complete source before publishing a successor; a refusal publishes nothing.

-----

<a id="v4-to-v5-specification"></a>
## V4-to-V5 specification

This edge changes only the logical header version. It performs no event, message-slot, payload, coordinate, or reference conversion. Earlier V0–V3 inputs first pass through their existing edges to V4; those edges retain their own transformations and refusal policies.

<a id="header-and-framing"></a>
### Header and physical framing

| Input | V5 result | Preservation or refusal |
|---|---|---|
| Logical V4 header | `version: 4` becomes `5` | Released V4 header validation runs first; every other logical header field remains unchanged. |
| V4 physical rows | Released V4 source codec decodes events and compact runs | Source framing and native V4 row admission remain owned by the preceding package. |
| V5 physical rows | `releasedV5SessionFormatCodec` reuses released physical framing with native V4 row admission | Encoding and decoding do not run this incoming migration. |

<a id="identity-body"></a>
### Identity body preservation

Every source event is emitted with the same `type`, `seq`, `time`, `data`, `surfaceOp`, `sourceEventSeqs`, and `ignorable` values. The edge inserts, removes, renames, and reorders nothing. It creates no user message, system prompt, developer change, tool execution, or sidecar. Compact Assistant runs are forwarded without expansion and keep their run identity.

<a id="inherited-cut"></a>
### Inherited cut

The target inherited cut equals the source cut. An unseeded source declares cut zero before EOF. A seeded source takes its cut from the last `session/end-seed` event carrying `inherited: true`. When the input declares a source cut at construction, `finish()` verifies the marker agrees; an unknown or disagreeing cut is refused rather than replaced with zero.

<a id="legacy-vocabulary"></a>
### Legacy vocabulary

Legacy `user-approval` and `model-selection` message source kinds are preserved verbatim, including their metadata; they are not reinterpreted or dropped. Every approval outcome, old and new, is preserved. `session-log-deepseek/delivery-accepted` events keep their original `data.sessionFormatVersion` values, so a historical V4 watermark stays historical and only a native V5 watermark is validated as current.

<a id="refusal"></a>
### Unknown events and refusal

The source V4 codec and restorer refuse unknown required event types; this edge does not widen that admission. Unknown ignorable events remain opaque and are preserved. Non-V4 source headers, a target header that is not V5, malformed source bodies, and target bodies that fail native V4 row admission are refused. A refusal publishes no successor and leaves the source generation unchanged.

<a id="recovery-and-publication"></a>
### Recovery and successor publication

Persistence reads a historical V4 source with strict row decoding so every committed row is observed. A committed row that fails decoding ends the trusted prefix, and a later `turn/end` refuses the log exactly as the V4 reader does. A later row that fails native V4 admission — including retired content after an earlier failure — refuses the whole log instead of becoming an untrusted tail. Read open serves the trusted prefix the V4 reader admits without writing a successor. The V4 reader suppresses the same tail, so read parity already holds; publishing would still make the truncated prefix the only future-selected generation, so write open keeps the predecessor authoritative instead. Write open refuses publication when recovery dropped any committed row: the V4 generation stays selected and unchanged, no V5 successor appears, and a later write open retries only after the source becomes cleanly migratable. A torn final line or torn final frame is the documented V4 repair, not recovery, and migrates normally.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The migration declaration creates independent streaming stages. The Stage forwards each decoded event or compact run through the supplied context, tracks only the inherited marker, and returns the verified cut at `finish()`. The V5 codec wraps the released V4 codec for physical framing and row admission; it stamps the logical header version and runs the V4-native admission before delegating. The target restorer reuses the parameterized released-field and relationship validators from the preceding package with generation 5, so current-generation delivery ownership is checked against V5 while older markers remain historical.

No runtime invariant companion is published because this pure library owns no independently maintained runtime observations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Format version and release status](../../../docs/session-format-status.md) — checkout writer and published format authority.
- [Adding a Session format version](../../../docs/cookbook/adding-a-session-format-version.md) — adjacent-edge integration and validation.
- [JSONL persistence](../session-persistence-jsonl/README.md) — immutable generation selection and publication.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

Historical requests retain their recorded messages and model configuration. The identity stage adds no model-visible content: `request/header`, `request/context`, and every message event replay unchanged.

#### Token effect

The conversion changes no request text or token-bearing data.

#### KV Cache effect

The edge preserves the recorded request prefix. Provider cache availability and eviction remain outside this library.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Historical coverage** — this edge accepts only V4 bodies that the released V4 codec and restorer admit. Later V0–V3 edges retain their own refusal policies.
- **No downgrade** — a published V5 generation is refused by older V4 writers at the header. The V4 predecessor remains for inspection, not automatic fallback.
- **Accepted transition** — the [checkpoint](../../../docs/session-format-status.md#finalization-record) protects accepted history. The V5 change is acknowledged before it is finalized.
- **Current validation** — strict and current restoration additionally run installed Session validation, which owns complete message, surface, and descriptor checks.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
