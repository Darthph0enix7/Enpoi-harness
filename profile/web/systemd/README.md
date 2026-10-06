# systemd units — serverlocal only (not shipped templates)

These units are the **serverlocal operator's hand-written dev units**. They are
kept in the profile so `ds sync`/`ds pull` can keep the serverlocal machine's
service definitions under version control. They are **not** a generic installer
input and must not be installed on another machine as-is: every file hardcodes
serverlocal paths, node, IP, or hostnames (`/home/adam`, `100.122.163.25`,
`serverlocal.pike-acrux.ts.net`).

- `dsh-web.service` — source-checkout web service on `127.0.0.1:3080` with the
  serverlocal trusted-host list, the lockfile `ExecStartPre`, and the skin-guard
  `ExecStartPre`.
- `dsh-tailnet.service` — `socat` forwarder binding the serverlocal Tailscale IP.
- `dsh-skin-guard.path` / `dsh-skin-guard.service` — watches
  `~/.dsh/skin-center-active.json` and restores the summer-liquid-glass skin
  (the script is `scripts/dsh-skin-guard.mjs`; the serverlocal unit expects it at
  `~/.local/bin/dsh-skin-guard.mjs`).

## Fresh installs

The canonical installer (`scripts/install.sh`) does not install these units; it
only copies the `systemd/` directory into the profile as a reference. Generate a
per-machine unit with:

```sh
dsh service install
```

which writes a unit generated for the local user (`dsh` refuses non-loopback
binds by design; expose the port with your own reverse proxy / Tailscale serve
if you need remote access).

## Sync guard

`ds pull` skips any repo unit whose text references a `/home/<user>/` path that
is not the current user's home, so another operator's unit cannot be installed
by accident. If you intentionally maintain cross-machine units, use `%h` for
the home directory (as `dsh-web.service` does for `HOME`/`DSH_HOME`) and keep
absolute paths out of `ExecStart`.
