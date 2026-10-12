---
description: "Ephemeral feedback triage: one isolated, disposed Kilo session classifies a payload into strict JSON; for users and maintainers of the feedback pipeline."
kind: "package-reference"
---

# @deepseek-ai/dsh-feedback-triage

English | [中文](README.zh.md)

## Summary

Ephemeral feedback triage: one isolated, disposed Kilo session classifies a payload into strict JSON. It is one stage of the feedback pipeline: the `sessionFeedback.record` Remote orchestrates collect → triage → submit, and each stage is fail-soft so the local record always succeeds.

## Table of Contents

- [Use this package](#use-this-package)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the base composition; it registers `ctx.feedbackCollect` (feedback-collect), `ctx.feedbackSubmit` (feedback-submit, config: `enabled` default true, `endpoint` default `https://enpoi.vip/feedback`, `timeoutMs` 15000, `retryDelayMs` 500), or `ctx.feedbackTriage` (feedback-triage). Without the plugin the record path still records locally and returns null results.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The collector reads the live session's event snapshot; cross-session context is out of scope.
- The redactor is focused (secret-looking tokens, emails, home paths); the telemetry waterfall remains export-scoped.
- Triage depends on the keyless Kilo free route; an unreachable route degrades to a null analysis.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
