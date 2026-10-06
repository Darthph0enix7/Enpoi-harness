# Device Patches

Per-device settings deltas for the Enpoi Harness dotfiles sync.

**How it works:**
- `settings.yaml` in the repo root is the GLOBAL baseline (secret-free, no
  device-specific sections).
- Each device has a patch file `<hostname>.yaml` here. On `ds pull`, the
  baseline + this device's patch + `~/.dsh/sync-local.yaml` are merged into
  the local `~/.dsh/settings.yaml`.
- On `ds sync`, the device's patch is regenerated automatically from the
  local settings (device-specific sections only: `mcpServers`,
  `capabilities`).

**Which patch applies on an unknown machine:** the host is resolved with
`hostname` (falling back to `uname -n`, then the literal `this-host`). The
merge uses `device-patches/<host>.yaml`; when that file does not exist the
patch input is empty (`/dev/null` in the `ds` CLI, a missing-file read in the
installer engine) and the result is the baseline plus `~/.dsh/sync-local.yaml`
only. `serverlocal.yaml` therefore applies on exactly one machine; a friend's
machine never reads it. The canonical installer
(`scripts/install.sh copy_profile_tree`) additionally excludes
`device-patches/` from what it stages, so a fresh install does not even
contain another device's patch file.

**Patch format:**
```yaml
merge:    # deep-merged into the baseline
  enpoi-orchestration:
    mcpServers:
      ue-mcp:
        serverName: ue
        transport: streamable-http
        url: http://127.0.0.1:8010/mcp
remove:   # keys deleted from the baseline
  enpoi-orchestration:
    mcpServers: [plane-mcp]
```

**Example — main PC (Unreal Engine MCP only there):**
```yaml
merge:
  enpoi-orchestration:
    mcpServers:
      ue-mcp:
        serverName: ue
        transport: streamable-http
        url: http://127.0.0.1:8010/mcp
    capabilities:
      mcp:
        ue-mcp: true
      skills:
        ue-mcp: true
```

**Never synced (device-local):** `.credentials.yaml`, `pools/`, `memory.db*`,
`sessions/`, `logs/`, `storages/`, `trash/`, `file-history/`, `revert-ledger/`,
`task-board/`, `pet.json`, `legacy-memory.json`, `sync-local.yaml`,
`profiles/web/node_modules/`, `packages/*/lib/`, `packages/*/node_modules/`.
## Device-specific agent presets

Presets are global by default. A device can mark presets as device-specific
via `~/.dsh/sync-local.yaml`:

```yaml
devicePresets:
  - sysadmin
```

- **On sync**: the marked preset is extracted to
  `device-patches/<hostname>/presets/<name>/` (the repo keeps the generic
  global version in `presets/`).
- **On pull**: three layers are applied — global `presets/` (mirror), then
  `device-patches/<hostname>/presets/` (additive overlay), then
  `~/.dsh/local-patches/presets/` (additive, never synced, highest
  precedence).

Example: the sysadmin persona ships generic globally ("operational
system-administration agent for this device"); a device's overlay directory
can carry a fleet-specific version (hostnames, service names, hardware) that
only that machine loads. The tracked `serverlocal/presets/sysadmin/` copy is
one such device snapshot.

**Engine note:** directory presets are only read by pre-0.1.7 engines. The
0.1.7 host mounts the preset declarations inside `cordis.patch.yml`
("declarations, not directories"); the `presets/` directory and this overlay
path stay for older engines and for the settings-import flow, and changing
them does not change what a 0.1.7 host mounts.
