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

Example: the sysadmin persona is generic globally ("operational
system-administration agent for this device") while serverlocal's patch
carries the fleet-specific persona (systemd, Docker, Cloudflare, CLAIX,
P40).
