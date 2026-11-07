# dsh-enpoi-heavy-providers

English | [中文](README.zh.md)

The HEAVY provider class for the Enpoi Harness web profile. Providers are listed in Add Provider but install nothing until the operator adds one. Adding either reuses an instance already running on this device (zero install) or starts a polled local install job whose route is written only after every step and the trusted host receipt succeed. Removal unsets the route, runs the manifest teardown for an owned install, and cleans credentials, pool state, the discovered cache, host references, and the lifecycle record.

The package owns the manifest table, the `enpoiHeavy` Remote namespace, the job manager, the lifecycle store, and the CLIProxyAPI installer helper.

```sh
cd profile/web
pnpm vitest run packages/enpoi-heavy-providers/tests
```

## Providers and platforms

| Provider | Route | Local install |
| --- | --- | --- |
| `freellmapi` | `openai-completions`, one unified key | Docker/Podman compose on Linux; the vendor desktop app on macOS/Windows |
| `antigravity` | `openai-completions`, keyless | npm package behind a systemd user unit (Linux) or launchd agent (macOS) |
| `commandcode` | own adapter namespace with a credential pool | `install.mjs` from `enpoi-commandcode-provider` (direct vendor route) |
| `meridian` | `openai-completions`, keyless | npm packages behind a user service |
| `cliproxyapi` | `openai-completions`, optional unified key, endpoint catalog authority | verified release behind a systemd user unit (Linux) or launchd agent (macOS); no Windows local path |

Every service default address is loopback. Deployment-specific endpoints live in the private `$DSH_HOME/heavy-server-overlay.json`, never in the shipped table. A `delivery: 'direct'` manifest normally needs a key pool or a non-keyless auth kind.

## Install lifecycle

1. `enpoiHeavy.install` refuses a duplicate configured route, an unsupported platform, a missing runtime, a missing declared helper file, and a helper port refusal before it creates a job.
2. A Node/systemd variant also refuses when the user manager does not answer. CLIProxyAPI declares `requires: ['systemd-user']` on Linux, so the helper's unit provisioning is covered even though its step command only runs `node`.
3. The job runs the manifest steps through the subprocess seam. Steps read host paths from the environment (`DSH_HEAVY_HOME`, `DSH_HEAVY_DSH_HOME`, `DSH_HEAVY_PROFILE_DIR`, `DSH_HEAVY_HELPER`); the command text never interpolates a path, so `$`, a backtick, a quote, or a backslash in a path cannot expand or execute. The helper is resolved from this plugin's own module location, so the web profile's `packages/` layout is not assumed and a relative configured `profileDir` is refused at mount.
4. The finalizer re-checks the duplicate guard, reads the trusted receipt and the installer-seeded key, discovers the endpoint catalog, and commits the route plus credential atomically. `SETTINGS_CONFLICT` is retried with a freshly read revision; a route that appeared during the job is never overwritten.
5. An endpoint-authority route whose listing `failed` or was `unauthorized` writes no route (the installed service survives for a retry). A valid empty listing writes a known-empty discovered-cache record (`models: []`, `fetchedAt`) so `resolveRouteModels` answers `knownEmpty` instead of refusing a first install before any upstream account exists.

Removal takes the per-provider job lock first. A route-only delete of an owned local install keeps the lifecycle record and the installer-generated credential: the service is still running, and a later detected-instance add reads that key again instead of failing the anonymous authorization guard. `uninstall: true` runs the manifest teardown and clears both.

## Key semantics

- An owned CLIProxyAPI install seeds its own client key. `enpoiHeavy.install` deliberately ignores a client-supplied `key` for that provider: the installer-generated value is read through the verified receipt, stored before discovery, and never returned on the wire, in the job snapshot, or in a route profile.
- A detected or external instance accepts an operator-typed key (`reuse.key`); it is stored through the credentials seam only when the route commit succeeds.
- `auth.kind: 'none'` routes are always anonymous. A `unified` route becomes keyed as soon as an explicit or stored key exists.
- The helper's bootstrap/management key is separate from the client key. `enpoiHeavy.status` exposes `bootstrapPath` and `managementKeyPath` (paths only) for an owned local install so the dashboard can show where to read the login secret locally.

## Wire surface

`enpoiHeavy.manifests`, `status`, `reuse`, `install`, `job`, and `remove` are the only entry points. Relevant shapes:

- `reuse` returns `{ ok, catalog, route, health, models, credentialStored, endpoint, port? }` on success; `catalog` is the typed `{ state: 'fresh' | 'empty' | 'unauthorized' | 'failed', models, status?, error?, source }` the route was written from. A client should treat `empty` as a valid known-empty answer and keep `failed`/`unauthorized` visible to the operator.
- `install` returns `{ ok, job }` or `{ ok: false, blocked | pendingRestart }`. A client-supplied `receipt` is rejected. A client-supplied `key` is accepted for providers whose installer does not generate one and ignored (logged) for CLIProxyAPI.
- `status` reports `mode: 'local' | 'reuse' | 'unknown'` and `installedByHarness`; a route-less owned install keeps `mode: 'local'` and `installedByHarness: true` so the row can still offer uninstall. Successful owned-local status also carries `bootstrapPath`/`managementKeyPath`.
- The overlay entry accepts `disabled`, `label`, `summary`, `dashboardUrl`, `docsUrl`, `reuseBaseURL`, `reuseHealthURL`, `installSteps`, `fallbackModel`, `pool`, and `releaseSource`.

The pre-connection fallback table in `packages/client/ui-settings-models` mirrors this manifest table. Regenerate the committed fixture after a manifest change:

```sh
node --experimental-strip-types profile/web/packages/enpoi-heavy-providers/scripts/write-client-mirror.mjs
```

## Release source

A manifest or private overlay may set `releaseSource` to an `https://` releases API URL or an `owner/repo` slug. The install step passes `--releases-api` or `--repo` only when the effective manifest declares one; omission keeps the helper's upstream default. A value that is neither an https URL (without embedded credentials or a fragment) nor an `owner/repo` slug is dropped by the overlay sanitizer and rejected by `manifestProblems`.

## Configuration

```yaml
- id: enpoi-heavy-providers
  name: dsh-enpoi-heavy-providers
  config:
    profileDir: /absolute/path/to/the/running/profile
```

`profileDir` is only the fallback for launcher-owned `profileContext.dir`; it must be absolute. Manifests that still use the `{profileDir}` placeholder (the commandcode setup step) need it. CLIProxyAPI no longer does.

## Model Experience

### Route registration (indirect)

#### What the model sees

Indirectly, through `dsh-llm-pi-ai`'s route resolution and the operator's model selection: this package writes the `providers.<id>` row (`baseURL`, auth, model entries, capacities, reasoning ladder) that the resolution layer later materializes into a request. It adds no prompt text, tool schema, or message content of its own. Endpoint-disclosed model fields are stored only when the listing or the shared registry supplies them; nothing is invented.

#### Token effect

Zero direct token effect. The route's model entries decide context and output budgets the consumer enforces; a valid empty listing serves an empty catalog rather than a fabricated model id.

#### KV Cache effect

Independent. This package never contributes request tokens, so it cannot invalidate an existing prefix by itself. Replacing a route (a new `baseURL`, key, or model list) changes what the consumer sends and can invalidate provider-side cache reuse for that route; appending models or capacity disclosures does not.

## Known Limitations and Deferred Work

- **Real-host verification** — no real install, upgrade, removal, service-manager transition, or dashboard fetch is exercised by the tests; Linux systemd, macOS launchd, and the release archive shape still need a disposable host before a ship decision.
- **Helper capabilities are optional** — the host consumes `preflightCliProxyApi` (port preflight) and the `--releases-api`/`--repo` flags only when the installed helper provides them; an older helper without those capabilities skips the preflight and rejects a declared `releaseSource` at the helper boundary.
- **macOS launchd logging** — the launchd plist now writes `StandardOutPath`/`StandardErrorPath` under the owned provider root (`logs/`), not `~/Library/Logs`; the manifest hint names the owned root and the real-host log rotation is unverified.
- **Discovered-cache concurrency** — the known-empty record is written with the shared file format/version, but this package's writer is not part of `enpoi-provider-sync`'s in-process write chain; a sync pass writing another route between the read and the rename can drop this route's record. It is repaired by the next successful add/sync.
- **Client mirror** — the committed `packages/client/ui-settings-models/tests/expected/heavy-provider-mirror.json` was regenerated from this table; the client fallback source must adopt the same command text (environment-variable helper invocation) before its parity spec passes.
- **Dashboard panel asset** — whether the released binary embeds `/management.html` or needs a `static/management.html` extracted by the installer is unverified; the manifest keeps the handoff URL but cannot guarantee the panel is served.
- **Windows** — CLIProxyAPI and Meridian have no supported Windows local install; detected-instance and custom routes still work. Other steps run through Git Bash and are unverified on Windows.
- **Single source of key truth** — a CLIProxyAPI key typed in the install form is ignored by design; the UI should disable or label that field instead of letting the value look applied.
