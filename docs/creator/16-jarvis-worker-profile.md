# 16 — Jarvis worker profile

Do not enable Jarvis dispatch against the human `web` profile. `jarvis-worker` is a separate host composition for one job attempt; selecting a preset within `web` cannot unload host plugins. Deploy only after the pruned-release inventory, the keyless drill, and live confinement pass. The default human profile is unchanged.

## Profile layout and release delivery

The [version-owned bundle](../../profile/web/packages/enpoi-jarvis-worker/cordis.patch.yml) starts from an explicit subset of the base host, not a negative patch over `web`. It keeps persistence, checkpointing, and metering. It omits memory and its compaction-fact capture, keeper writes, whiteboard, goals, subagents, Oracle, council, jobs/terminal, built-in skills, web tools, compressor retrieval, shell/filesystem tools, PTC, the model-facing peer bridge, and runtime plugin changes. The internal `fs` provider is a Session Controller dependency; it does not register model tools or public Session Controller RPCs. The sole HTTP listener binds `127.0.0.1`; it serves `peer` unary calls and `peer/follow`, never browser/operator RPCs. An authenticated TLS front end may proxy those paths if required; it must preserve the bearer and rewrite `Host` to the loopback upstream.

[`knowledge-tools.json`](../../profile/web/packages/enpoi-jarvis-worker/knowledge-tools.json) owns the two model schemas. The MCP client registers those schemas without a connection, refuses differing remote input schemas, and ignores remote descriptions and instructions. On the first bound call the [credential provider](../../profile/web/packages/enpoi-worker-credentials/README.md) resolves `credentialRef` under `$DSH_HOME/worker-secrets` (0700 dir, 0600 file) and supplies the bearer, job ID, and fence to the hub for discovery and execution. The hub checks them on every request. The preset limits model presentation to the two qualified names and denies `run_code`; the guard independently vetoes disallowed tool execution.

Run the local release's `bash "$RELEASE/scripts/install.sh" --seed-worker "$DSH_HOME"` with its compatible Node on `PATH` and an existing 0700 attempt home. This copies only the selector and an empty root, and links the sole bundle to that immutable release. It never runs the standard installer, merges the human profile, writes an update record, or installs profile dependencies. The same selector is seeded by the unit before `dsh --profile jarvis-worker`. To update, drain the running attempts, select a different immutable release, and seed new homes; seeding refuses an existing attempt pinned to another release or carrying an override. Do not invoke the general profile update against an attempt home. Its additive merge cannot remove previously enabled rows.

## Pairing and one pinned model route

Write `$DSH_HOME/pairings.yaml` (0600) before startup. Replace the token hash, workspace path, and model ID. Do not add a bound `sessionId`. `peer.create` carries `requestId`, `agentPreset: jarvis-worker`, the identical `provider` and `model`, and a job with `jobId`, `fence`, `expiresAt`, `limits`, the two hub capabilities and qualified tool names, `mcpEndpointId: jarvis`, and `credentialRef` as a filename, never a bearer. Provision `$DSH_HOME/peer-exports` (0700) and the job workspace. Before prompting, match the bound `peer.ready` profile identity against the create receipt and the expected profile hash for that job.

```yaml
version: 1
device: worker-host
pairings:
  - alias: jarvis
    peer: jarvis-hub
    exposure: answer-only
    tokenHash: '<generated inbound token hash>'
    create:
      cwd: '<absolute worker job working directory>'
      agentPreset: jarvis-worker
      allowAgentPresets: [jarvis-worker]
      freshOnly: true
    routing:
      allowModels: [jarvis-worker/worker-model]
      allowChains: []
      requireTools: true
      allowSwitch: never
    worker:
      allowedCapabilities: [knowledge.search, knowledge.facts]
      allowedMcpEndpoints: [jarvis]
      allowedToolNames: [mcp__jarvis__knowledge_search, mcp__jarvis__knowledge_facts]
      maxLimits:
        maxSteps: 8
        maxToolCalls: 8
        maxWallMs: 120000
        maxTotalTokens: 32000
```

Use one approved, tool-capable OpenAI-compatible model at a keyless trusted broker; do not provision a provider key to this worker. `DSH_WORKER_MODEL` is the exact model ID; `DSH_WORKER_MODEL_URL` is the broker base URL; `DSH_WORKER_MCP_URL` is the authorized Jarvis MCP endpoint; `DSH_WORKER_PEER_PORT` is the unique local port for this attempt. These are non-secret values. There are no automatic approval grants, mutable route settings, model chains, or fallback providers. A zero-price or no-training claim is not inferred from a keyless route.

## Confinement and evidence

Install [the template](../../profile/web/systemd/dsh-worker@.service) only for a dedicated worker identity. Arrange immutable, read-only release and Node paths at `/opt/dsh-worker/release` and `/opt/dsh-worker/node` or override all related paths consistently in a trusted drop-in. Do not repoint a shared `current` symlink during an attempt. Provision the instance state under the worker manager's `%S/dsh-worker-ATTEMPT` and place the four non-secret deployment values in the operator-owned `/etc/dsh-worker/ATTEMPT.env`. Use a unique unit instance per attempt. The supervisor is required: attest network isolation before starting, revoke the hub grant before cancellation, and stop and await the whole instance on deadline or uncertainty. Never reuse the attempt home for a different job.

Keep `IPAddressDeny=any`. In an operator-owned drop-in, replace the documentation-only CIDRs below with the hub and broker IPs (or reviewed destination CIDRs); keep loopback only where the peer front end requires it. A privileged service manager or a separate network namespace/firewall may be necessary; a user unit's declared IP filters do not establish kernel enforcement.

```ini
# dsh-worker@ATTEMPT.service.d/20-network.conf
[Service]
IPAddressAllow=192.0.2.10/32
IPAddressAllow=198.51.100.24/32
IPAddressAllow=127.0.0.1/32
```

Start with `systemctl --user start dsh-worker@ATTEMPT.service` only on the verified worker manager; stop with `systemctl --user stop dsh-worker@ATTEMPT.service`. Run `node "$RELEASE/scripts/worker-evidence.mjs" [dsh-worker@ATTEMPT.service]` to record declared secret-free argv, release version and hashes, selected `systemctl --user show` values, and independent transient probe outcomes. `WORKER_EVIDENCE_READY_ORIGIN`, `WORKER_EVIDENCE_ALIAS`, and `WORKER_EVIDENCE_AUTH_FILE` optionally enable a bound loopback `peer.ready`; the latter names a protected bearer file. Without it, the release-patch hash is not a live session identity. The probe connects only to owned loopback servers, including destinations deliberately outside the IP allow-list. The local user-manager test saw the mount rules block the hidden read and write to a read-only bind and make bash inaccessible, but both denied addresses were reachable: IP policy failed on that host. Resource settings were observed, not stress-tested.

IP rules do not constrain DNS queries to an allowed resolver, distinguish hostnames or ports on a shared CDN IP, or block other services at an allowed loopback address. They cannot stop same-UID processes from racing state or credentials. `ProtectSystem=strict` does not block arbitrary reads outside hidden or inaccessible paths; private temporary storage remains writable. Hiding bash and dash does not remove every possible interpreter. Tool denial and OS confinement are independent.

## Drill and operational limits

Run `vitest run --config scripts/worker-drill.vitest.config.ts` from a scratch environment with `DSH_WIRE_*` unset. The table and JSON count declared limits separately from passes, failures, and skips. Only failures exit nonzero. External confinement and hub-side verification are skipped. The built [inventory test](../../apps/web/tests/keyless-tool-inventory.e2e.ts) runs only with `DSH_KEYLESS_INVENTORY_CAPTURE=1` after the central build has refreshed the bundle fingerprints; without that it reports `CAPTURE_BLOCKED`. The release build regenerates bundle fingerprints, the generated config and tool reference, and recaptures the inventory (human presets plus the worker roster) before publishing.

There is no hard cost cap. One in-flight model call can overshoot its token reservation. Chain fallback and provider-internal retries are not rechecked by the guard, so pin one route. Counters are process-local. Requirement N-ASK-1 restart-survival is not met: pending questions become `expired` with reason `host-restarted`, so the hub must re-ask after a worker restart. An answer committed before restart can be replayed with the same request ID and payload, but is not delivered again. Held notices are not proof of restart recovery either. Worker `peer.cancel` defaults to dropping that alias's pending peer prompts; check `droppedQueued` and each prompt's receipt instead of interpreting `accepted` as disposition or quiescence. The worker cannot certify its own success; the hub independently verifies artifacts and results.
