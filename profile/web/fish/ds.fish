function ds --description "Enpoi Harness (DeepSeek Harness) CLI & Service Controller"
    set -g g_dsh_home "$HOME/.dsh"
    set -g g_local_url "http://127.0.0.1:3080"
    set -g g_dsh_bin "$HOME/.local/bin/dsh"
    set -g g_dsh_repo "$HOME/deepseek-harness"

    # Tailnet endpoints are per-device: DSH_TAILNET_URL wins, otherwise derive
    # this node's MagicDNS name and IPv4 from Tailscale. No Tailscale on this
    # machine → both stay empty and the CLI falls back to the local URL.
    # DSH_TAILNET_PORT (default 8443) is the HTTPS port for both the derived
    # URL and `ds serve`, so a second HTTPS service can move this one instead
    # of colliding silently.
    set -g g_tailnet_port 8443
    if set -q DSH_TAILNET_PORT; and test -n "$DSH_TAILNET_PORT"
        set g_tailnet_port "$DSH_TAILNET_PORT"
    end
    set -g g_tailnet_url "$DSH_TAILNET_URL"
    set -g g_tailnet_ip ""
    if command -v tailscale >/dev/null 2>&1
        set g_tailnet_ip (tailscale ip -4 2>/dev/null | head -1)
        if test -z "$g_tailnet_url"
            set -l ts_dns (string match -r '"DNSName"\s*:\s*"([^"]+)"' (tailscale status --json 2>/dev/null))
            if test (count $ts_dns) -ge 2
                set g_tailnet_url "https://"(string replace -r '\.$' '' -- $ts_dns[2])":$g_tailnet_port"
            end
        end
    end

    set -l os (uname)
    set -g g_is_darwin 0
    set -g g_is_linux 0
    if test "$os" = "Darwin"
        set g_is_darwin 1
    else
        set g_is_linux 1
    end

    set -g g_dotfiles "$HOME/dotfiles/dsh-dotfiles"
    set -g g_dotfiles_remote "https://github.com/Darthph0enix7/dsh-enpoi-web-profile.git"

    # ── Helpers ─────────────────────────────────────────────────────────────

    function __ds_health_probe
        # The Web UI answers 401 without a session cookie; any HTTP response
        # proves the server is up, so accept anything but a connection failure.
        set -l code (curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/ 2>/dev/null)
        if test -n "$code"; and test "$code" != "000"
            return 0
        end
        return 1
    end

    function __ds_rpc -a method payload
        if test -z "$payload"
            set payload "{}"
        end
        curl -s -X POST http://127.0.0.1:3080/api/$method \
            -H "Content-Type: application/json" \
            -d "{\"type\":\"client-request\",\"rpcId\":\"ds-cli\",\"method\":\"$method\",\"payload\":$payload}" 2>/dev/null
    end

    function __ds_sync_file -a src dest
        set src (string replace -r '^~' "$HOME" -- "$src")
        set -l target "$g_dotfiles/$dest"
        if test -f "$src"
            mkdir -p (dirname "$target")
            cp "$src" "$target"
        end
    end

    function __ds_sync_dir -a src dest
        set src (string replace -r '^~' "$HOME" -- "$src")
        set -l target "$g_dotfiles/$dest"
        if test -d "$src"
            mkdir -p "$target"
            cp -r "$src"/* "$target/" 2>/dev/null; or true
        end
    end

    # Node for every JS CLI: PATH first, then the installer's version-independent
    # runtime link ($PREFIX/runtime/node/current), then nvm. An explicit
    # DSH_NODE_VERSION pins one; the descending version sort picks the newest
    # install otherwise, so a Node bump cannot orphan a subcommand behind a
    # stale v-pin. Prints the path; non-zero when no usable Node exists.
    function __ds_resolve_node
        set -l node_bin (command -v node 2>/dev/null)
        if test -n "$node_bin"
            printf '%s\n' "$node_bin"
            return 0
        end
        if test -x "$g_dsh_home/runtime/node/current/bin/node"
            printf '%s\n' "$g_dsh_home/runtime/node/current/bin/node"
            return 0
        end
        if set -q DSH_NODE_VERSION; and test -x "$HOME/.local/share/nvm/v$DSH_NODE_VERSION/bin/node"
            printf '%s\n' "$HOME/.local/share/nvm/v$DSH_NODE_VERSION/bin/node"
            return 0
        end
        set -l nvm_root "$HOME/.local/share/nvm"
        if test -d "$nvm_root"
            # `ls` + `string match`, not a `v*` glob: fish aborts an unmatched
            # glob with a "No matches for wildcard" error, which would leak to
            # the terminal on every host without version-manager installs.
            for version_dir in (ls -1 "$nvm_root" 2>/dev/null | string match 'v*' | sort -V -r)
                set -l candidate "$nvm_root/$version_dir/bin/node"
                if test -x "$candidate"
                    printf '%s\n' "$candidate"
                    return 0
                end
            end
        end
        return 1
    end

    # Run one JS CLI with the resolved Node: $argv[1] is the script, the rest
    # are its arguments. $HOME/.local/bin, PATH resolution, and the exit status
    # match a direct `node <script>` call; only the binary resolution differs.
    function __ds_run_node_cli
        set -l script "$argv[1]"
        set -l node_bin (__ds_resolve_node)
        if test -z "$node_bin"
            echo "✖ No Node.js found (need >= 22.19); install it or add it to PATH"
            return 1
        end
        command $node_bin "$script" $argv[2..-1]
    end

    # ── Subcommand Dispatch ──────────────────────────────────────────────────

    set -l cmd $argv[1]
    set -l subargs $argv[2..-1]

    switch "$cmd"
        case "start"
            echo "Starting Enpoi Harness..."
            if test $g_is_linux -eq 1
                systemctl --user start dsh-web.service dsh-tailnet.service 2>/dev/null; or systemctl --user start dsh-web.service
                sleep 2
                if systemctl --user is-active -q dsh-web.service
                    echo "✔ Service active at $g_local_url"
                else
                    echo "✖ Failed to start. Check: journalctl --user -u dsh-web.service -n 20 --no-pager"
                end
            else
                $g_dsh_bin service start; or echo "✖ Start failed. Install the service with: dsh service install"
            end

        case "stop"
            echo "Stopping Enpoi Harness..."
            if test $g_is_linux -eq 1
                systemctl --user stop dsh-web.service
                echo "✔ Service stopped."
            else
                $g_dsh_bin service stop; or echo "✖ Stop failed. Check: dsh service status"
                echo "✔ Service stopped."
            end

        case "restart"
            echo "Restarting Enpoi Harness..."
            if test $g_is_linux -eq 1
                systemctl --user restart dsh-web.service
            else
                $g_dsh_bin service restart; or begin
                    echo "✖ Restart failed. Install the service with: dsh service install"
                    return 1
                end
            end
            echo -n "Waiting for service to warm up..."
            for i in (seq 1 15)
                sleep 1
                echo -n "."
                if __ds_health_probe
                    echo " ✔ Ready!"
                    return 0
                end
            end
            echo ""
            echo "⚠️ Service restarted but health probe is pending. Check: ds doctor"

        case "status"
            if test $g_is_linux -eq 1
                systemctl --user status dsh-web.service --no-pager
            else
                $g_dsh_bin service status
            end

        case "web"
            echo "Opening Enpoi Harness Web UI..."
            set -l open_url "$g_local_url"
            if test -n "$g_tailnet_url"
                set open_url "$g_tailnet_url"
            end
            if command -v xdg-open >/dev/null 2>&1
                xdg-open "$open_url" 2>/dev/null; or xdg-open "$g_local_url" 2>/dev/null
            else if command -v open >/dev/null 2>&1
                open "$open_url" 2>/dev/null; or open "$g_local_url" 2>/dev/null
            else
                echo "Open in browser: $open_url"
            end

        case "urls"
            echo "═══════════════════════════════════════════════════════════════"
            echo " Enpoi Harness (DSH) Endpoints"
            echo "═══════════════════════════════════════════════════════════════"
            echo "  Local Web UI:    $g_local_url"
            if test -n "$g_tailnet_url"
                echo "  Tailscale HTTPS: $g_tailnet_url"
            end
            if test -n "$g_tailnet_ip"
                echo "  Tailscale IP:    http://$g_tailnet_ip:3080"
            end
            if test -z "$g_tailnet_url" -a -z "$g_tailnet_ip"
                echo "  Tailscale:       not detected (install tailscale or set DSH_TAILNET_URL)"
            end
            echo "  Config Root:     $g_dsh_home"
            echo "═══════════════════════════════════════════════════════════════"

        case "serve"
            echo "Configuring Tailscale HTTPS serve on port $g_tailnet_port..."
            tailscale serve --https=$g_tailnet_port http://127.0.0.1:3080

        case "serve-off"
            echo "Resetting Tailscale serve..."
            tailscale serve --reset

        case "doctor"
            # Full diagnostic report lives in the standalone Node script, shared
            # with `dsh doctor`; pass through flags such as --json or --strict.
            set -l doctor_script ""
            for candidate in "$g_dsh_repo/scripts/doctor.mjs" "$g_dsh_home/harness/current/scripts/doctor.mjs"
                if test -f "$candidate"
                    set doctor_script "$candidate"
                    break
                end
            end
            if test -z "$doctor_script"
                echo "✖ doctor.mjs not found (checked $g_dsh_repo/scripts and $g_dsh_home/harness/current/scripts)"
                return 1
            end

            # The shared resolver: PATH → runtime/current → DSH_NODE_VERSION →
            # newest nvm.
            set -l node_bin (__ds_resolve_node)
            if test -z "$node_bin"
                echo "✖ No Node.js found (need >= 22.19); install it or add it to PATH"
                return 1
            end

            command $node_bin $doctor_script $subargs

        case "heal"
            echo "=== Healing Enpoi Harness ==="
            if test -f "$g_dsh_home/.credentials.yaml"
                chmod 600 "$g_dsh_home/.credentials.yaml"
                echo "  ✔ Secured credentials (chmod 600)"
            end

            if test $g_is_linux -eq 1
                systemctl --user daemon-reload
                systemctl --user restart dsh-web.service
                echo -n "  Restarting service..."
                for i in (seq 1 20)
                    sleep 1
                    echo -n "."
                    if __ds_health_probe
                        echo " ✔ Live & healthy!"
                        return 0
                    end
                end
                echo ""
                echo "  ⚠️ Service took longer than 20s to respond. Check journalctl --user -u dsh-web.service"
            end

        case "skills"
            echo "═══════════════════════════════════════════════════════════════"
            echo " Installed Skills ($g_dsh_home/skills/)"
            echo "═══════════════════════════════════════════════════════════════"
            if not test -d "$g_dsh_home/skills"
                echo "  No skills directory found at $g_dsh_home/skills/"
                return 1
            end

            for dir in $g_dsh_home/skills/*/
                set -l name (basename "$dir")
                set -l skill_md "$dir/SKILL.md"
                if test -f "$skill_md"
                    set -l desc (grep '^description:' "$skill_md" | head -1 | sed 's/^description:[ ]*//')
                    if test -z "$desc"
                        set desc "(no description)"
                    end
                    printf "  • \e[1;36m%-24s\e[0m %s\n" "$name" "$desc"
                end
            end
            echo "═══════════════════════════════════════════════════════════════"

        case "presets"
            echo "═══════════════════════════════════════════════════════════════"
            echo " Available Agent Presets"
            echo "═══════════════════════════════════════════════════════════════"
            set -l res (__ds_rpc "agentPreset.list")
            echo "$res" | node -e '
const chunks = []
process.stdin.on("data", c => chunks.push(c))
process.stdin.on("end", () => {
  let d = {}
  try { d = JSON.parse(chunks.join("")) } catch {}
  for (const p of d?.result?.value?.presets ?? []) {
    console.log(`  • \x1b[1;36m${String(p.id ?? "").padEnd(16)}\x1b[0m ${p.name ?? ""} [${p.trust ?? ""}]`)
  }
})
' 2>/dev/null
            echo "═══════════════════════════════════════════════════════════════"

        case "pool"
            set -l provider $subargs[1]
            if test -z "$provider"
                set provider "opencode-go"
            end
            echo "═══════════════════════════════════════════════════════════════"
            echo " Provider Pool Status: $provider"
            echo "═══════════════════════════════════════════════════════════════"
            set -l res (__ds_rpc "llm.poolStatus" "{\"settingsNs\":\"llm-pi-ai\",\"provider\":\"$provider\"}")
            echo "$res" | node -e '
const chunks = []
process.stdin.on("data", c => chunks.push(c))
process.stdin.on("end", () => {
  let d = {}
  try { d = JSON.parse(chunks.join("")) } catch {}
  const idents = d?.result?.value?.identities ?? []
  const now = Date.now()
  if (idents.length === 0) console.log("  No pool identities configured for this provider.")
  for (const i of idents) {
    const rem = Math.max(0, (i.cooldownUntil ?? 0) - now)
    const enabled = i.enabled ?? true
    let status = "🟢 Ready"
    if (!enabled) status = "⚪ Disabled"
    else if (rem > 0) status = `🟡 Cooling (${Math.floor(rem / 60000)}m left)`
    else if ([401, 403].includes(i.lastStatus ?? 0)) status = "🔴 Auth Error"
    console.log(`  • ${`P${i.priority ?? 1}`.padEnd(4)} \x1b[1;36m${String(i.id ?? "").padEnd(18)}\x1b[0m ${status.padEnd(22)} ${i.credentialRef ?? ""}`)
  }
})
' 2>/dev/null
            echo "═══════════════════════════════════════════════════════════════"

        case "reset-cooldown"
            set -l provider $subargs[1]
            set -l identity $subargs[2]
            if test -z "$provider"
                echo "Usage: ds reset-cooldown <provider> [identityId]"
                return 1
            end
            set -l payload "{\"settingsNs\":\"llm-pi-ai\",\"provider\":\"$provider\""
            if test -n "$identity"
                set payload "$payload,\"identityId\":\"$identity\""
            end
            set payload "$payload}"
            __ds_rpc "llm.poolResetCooldown" "$payload" >/dev/null
            echo "✔ Cooldowns reset for $provider $identity"

        case "sync"
            echo "=== Syncing Enpoi Harness configs to dotfiles ==="
            if not test -d "$g_dotfiles"
                echo "  Cloning dotfiles repo from $g_dotfiles_remote..."
                mkdir -p (dirname "$g_dotfiles")
                git clone "$g_dotfiles_remote" "$g_dotfiles"
            else
                git -C "$g_dotfiles" pull --ff-only 2>/dev/null; or true
            end

            set -l host (hostname -s 2>/dev/null; or hostname)
            set -l sync_local "$HOME/.dsh/sync-local.yaml"
            if not test -f "$sync_local"
                set sync_local /dev/null
            end

            # Ensure directory tree
            mkdir -p "$g_dotfiles/device-patches"
            mkdir -p "$g_dotfiles/presets"
            mkdir -p "$g_dotfiles/skills"
            mkdir -p "$g_dotfiles/packages"
            mkdir -p "$g_dotfiles/sidebar-patch"
            mkdir -p "$g_dotfiles/fish/completions"
            mkdir -p "$g_dotfiles/systemd"
            mkdir -p "$g_dotfiles/skin-center"
            mkdir -p "$g_dotfiles/scripts"

            # 0. Settings: strip device sections → baseline, extract device patch
            if test -f "$HOME/.local/bin/dsh-sync-merge.mjs"
                node "$HOME/.local/bin/dsh-sync-merge.mjs" strip "$HOME/.dsh/settings.yaml" "$g_dotfiles/settings.yaml" "$sync_local" "$g_dotfiles/settings.yaml"
                node "$HOME/.local/bin/dsh-sync-merge.mjs" extract "$HOME/.dsh/settings.yaml" "$g_dotfiles/settings.yaml" "$sync_local" "$g_dotfiles/device-patches/$host.yaml"
                echo "  ✔ Settings synced (device sections → device-patches/$host.yaml)"
            else
                echo "  ⚠ dsh-sync-merge.mjs not found — settings.yaml NOT synced"
            end

            # 1. Skills
            if test -d "$g_dsh_home/skills"
                rsync -a --delete "$g_dsh_home/skills/" "$g_dotfiles/skills/" 2>/dev/null; or __ds_sync_dir "$g_dsh_home/skills" "skills"
                echo "  ✔ Skills synced"
            end

            # 2. Agent Presets (device-specific ones → device patch)
            set -l device_presets ""
            if test -f "$HOME/.local/bin/dsh-sync-merge.mjs" -a -f "$HOME/.dsh/sync-local.yaml"
                set device_presets (node "$HOME/.local/bin/dsh-sync-merge.mjs" device-presets "$HOME/.dsh/sync-local.yaml" 2>/dev/null)
            end
            if test -d "$g_dsh_home/.agent-presets"
                for preset_dir in "$g_dsh_home/.agent-presets"/*/
                    set -l name (basename "$preset_dir")
                    if contains -- "$name" $device_presets
                        # Device-specific: extract to device patch, keep global version in repo
                        mkdir -p "$g_dotfiles/device-patches/$host/presets/$name"
                        rsync -a --delete "$preset_dir/" "$g_dotfiles/device-patches/$host/presets/$name/" 2>/dev/null; or true
                        echo "  ✔ Preset $name → device-patches/$host/presets/ (device-specific)"
                    else
                        mkdir -p "$g_dotfiles/presets/$name"
                        rsync -a --delete "$preset_dir/" "$g_dotfiles/presets/$name/" 2>/dev/null; or true
                    end
                end
                echo "  ✔ Agent Presets synced"
            end

            # 3. Profile packages (src+tests only — lib/node_modules rebuilt locally)
            for pkg_dir in "$g_dsh_home/profiles/web/packages"/enpoi-*/
                set -l name (basename "$pkg_dir")
                rsync -a --delete --exclude node_modules --exclude lib "$pkg_dir/" "$g_dotfiles/packages/$name/" 2>/dev/null; or true
            end
            echo "  ✔ Profile packages synced"

            # 4. Sidebar patch + rebuild script
            if test -d "$g_dsh_home/profiles/web/sidebar-patch"
                rsync -a --delete "$g_dsh_home/profiles/web/sidebar-patch/" "$g_dotfiles/sidebar-patch/" 2>/dev/null; or true
            end
            __ds_sync_file "$g_dsh_home/profiles/web/rebuild-sidebar.sh" "rebuild-sidebar.sh"
            echo "  ✔ Sidebar patch synced"

            # 5. Profile config files
            __ds_sync_file "$g_dsh_home/profiles/web/cordis.patch.yml" "cordis.patch.yml"
            __ds_sync_file "$g_dsh_home/profiles/web/cordis.yml" "cordis.yml"
            __ds_sync_file "$g_dsh_home/profiles/web/package.json" "package.json"
            __ds_sync_file "$g_dsh_home/profiles/web/pnpm-workspace.yaml" "pnpm-workspace.yaml"
            __ds_sync_file "$g_dsh_home/profiles/web/pnpm-lock.yaml" "pnpm-lock.yaml"
            __ds_sync_file "$g_dsh_home/profiles/web/vitest.config.ts" "vitest.config.ts"
            echo "  ✔ Profile config synced"

            # 6. Skin
            if test -d "$g_dsh_home/skin-center"
                rsync -a --delete --exclude .cache "$g_dsh_home/skin-center/" "$g_dotfiles/skin-center/" 2>/dev/null; or true
            end
            if test -d "$g_dsh_home/skins"
                rsync -a --delete --exclude .cache "$g_dsh_home/skins/" "$g_dotfiles/skins/" 2>/dev/null; or true
            end
            __ds_sync_file "$g_dsh_home/skin-center-active.json" "skin-center-active.json"
            echo "  ✔ Skin synced"

            # 7. Fish CLI & Completions
            __ds_sync_file ~/.config/fish/functions/ds.fish "fish/ds.fish"
            __ds_sync_file ~/.config/fish/completions/ds.fish "fish/completions/ds.fish"
            echo "  ✔ Fish CLI synced"

            # 8. Systemd service templates
            __ds_sync_file ~/.config/systemd/user/dsh-web.service "systemd/dsh-web.service"
            __ds_sync_file ~/.config/systemd/user/dsh-tailnet.service "systemd/dsh-tailnet.service"
            echo "  ✔ Systemd units synced"

            # 9. Sync merge script
            if test -f "$HOME/.local/bin/dsh-sync-merge.mjs"
                __ds_sync_file "$HOME/.local/bin/dsh-sync-merge.mjs" "scripts/dsh-sync-merge.mjs"
            end

            # Status check & commit
            set -l changes (git -C "$g_dotfiles" status --porcelain)
            if test -n "$changes"
                echo ""
                echo "Changes staged in $g_dotfiles:"
                git -C "$g_dotfiles" status --short
                echo ""
                set -l ts (date "+%Y-%m-%dT%H:%M:%S")
                git -C "$g_dotfiles" add -A
                git -C "$g_dotfiles" commit -m "sync: $ts"
                echo "✔ Committed: sync: $ts"
                read -l -P "Push to GitHub? [y/N] " confirm
                if test "$confirm" = "y" -o "$confirm" = "Y"
                    git -C "$g_dotfiles" push origin main 2>/dev/null; or git -C "$g_dotfiles" push origin master 2>/dev/null
                    echo "✔ Pushed to dotfiles repository."
                end
            else
                echo "  ✔ Repository already up to date."
            end

case "pull"
            echo "=== Pulling Enpoi Harness configs from dotfiles ==="
            if not test -d "$g_dotfiles"
                echo "  Cloning dotfiles repo from $g_dotfiles_remote..."
                mkdir -p (dirname "$g_dotfiles")
                git clone "$g_dotfiles_remote" "$g_dotfiles"
            else
                set -l pull_exit 0
                set -l pull_output (git -C "$g_dotfiles" pull 2>&1)
                set pull_exit $status
                echo "$pull_output"
                if test $pull_exit -ne 0
                    if string match -qr "(?i)conflict|merge conflict|CONFLICT" "$pull_output"
                        echo ""
                        echo "🔴 MERGE CONFLICT detected — cannot safely apply files."
                        echo "   Resolve manually: cd $g_dotfiles && git status"
                        return 1
                    end
                    echo "  (git pull had non-zero exit — continuing anyway)"
                end
            end

            # Deploy the merge script first (needed for the settings merge)
            if test -f "$g_dotfiles/scripts/dsh-sync-merge.mjs"
                mkdir -p "$HOME/.local/bin"
                cp "$g_dotfiles/scripts/dsh-sync-merge.mjs" "$HOME/.local/bin/dsh-sync-merge.mjs"
                chmod +x "$HOME/.local/bin/dsh-sync-merge.mjs"
                echo "  ✔ Sync merge script deployed"
            end

            # Deploy the skin guard (keeps the liquid-glass skin from being
            # nulled by a ui-skin-center write of the stock selection)
            if test -f "$g_dotfiles/scripts/dsh-skin-guard.mjs"
                mkdir -p "$HOME/.local/bin"
                cp "$g_dotfiles/scripts/dsh-skin-guard.mjs" "$HOME/.local/bin/dsh-skin-guard.mjs"
                chmod +x "$HOME/.local/bin/dsh-skin-guard.mjs"
                for unit in dsh-skin-guard.service dsh-skin-guard.path
                    set -l unit_src "$g_dotfiles/systemd/$unit"
                    if test -f "$unit_src"
                        if grep -qE '/home/[A-Za-z0-9._-]+' "$unit_src"; and not grep -qE "/home/$(whoami)/" "$unit_src"
                            echo "  ⚠ systemd/$unit references another user's home — skipped (device-specific template)"
                            continue
                        end
                        cp "$unit_src" "$HOME/.config/systemd/user/$unit"
                    end
                end
                systemctl --user daemon-reload 2>/dev/null
                systemctl --user enable --now dsh-skin-guard.path 2>/dev/null
                echo "  ✔ Skin guard deployed"
            end

            # Check for locally-changed files before overwriting
            # (settings.yaml is EXCLUDED — local is always the merged
            # baseline+patch, repo holds the stripped baseline by design)
            set -l pending
            set -l checks \
                "cordis.patch.yml:~/.dsh/profiles/web/cordis.patch.yml" \
                "package.json:~/.dsh/profiles/web/package.json" \
                "fish/ds.fish:~/.config/fish/functions/ds.fish" \
                "fish/completions/ds.fish:~/.config/fish/completions/ds.fish"
            for entry in $checks
                set -l repo "$g_dotfiles/"(string split ":" $entry)[1]
                set -l local (string replace "~" "$HOME" -- (string split ":" $entry)[2])
                if test -f "$repo" -a -f "$local"
                    if not diff -q "$repo" "$local" >/dev/null 2>&1
                        set pending $pending $entry
                    end
                end
            end
            if set -q pending[1]
                echo ""
                echo "⚠️  These files differ from repo and WILL be overwritten:"
                for p in $pending
                    echo "  "(string split ":" $p)[1]
                end
                echo "  (backups saved in .backup-<timestamp>/)"
                read -P "Continue pull? [y/N] " -l confirm
                if test "$confirm" != y -a "$confirm" != Y
                    echo "Pull cancelled."
                    return 1
                end
            end

            # Apply files from repo to local
            set -g g_backup_dir ""
            set -g __ds_pull_updated 0
            set -g __ds_pkg_changed 0
            set -g __ds_sidebar_changed 0
            set -g __ds_profile_cfg_changed 0

            function __ds_apply_file -d "Apply file from repo to local, backup if different"
                set -l repo_path "$g_dotfiles/$argv[1]"
                set -l local_path "$argv[2]"
                if not test -f "$repo_path"
                    return 1
                end
                set local_path (string replace -r '^~' "$HOME" -- "$local_path")
                mkdir -p (dirname "$local_path")
                if test -f "$local_path"
                    if diff -q "$local_path" "$repo_path" >/dev/null 2>&1
                        return 0
                    end
                    if test -z "$g_backup_dir"
                        set -g g_backup_dir "$HOME/.dsh/.backup-"(date +%Y%m%d-%H%M%S)
                        mkdir -p "$g_backup_dir"
                        echo "Backup: $g_backup_dir"
                        set -l backup_dirs (ls -1d "$HOME/.dsh/.backup-"* 2>/dev/null | sort)
                        set -l keep 5
                        set -l total (count $backup_dirs)
                        if test $total -gt $keep
                            set -l to_delete (math $total - $keep)
                            for old_dir in $backup_dirs[1..$to_delete]
                                rm -rf "$old_dir"
                            end
                        end
                    end
                    set -l rel_path (string replace -r '^'$HOME'/' '' -- "$local_path")
                    set -l backup_name (string replace -a '/' '_' -- "$rel_path")
                    cp "$local_path" "$g_backup_dir/$backup_name"
                    echo "  Updated: $argv[1]  (old → $g_backup_dir)"
                else
                    echo "  Created: $argv[1]"
                end
                cp "$repo_path" "$local_path"
                set -g __ds_pull_updated 1
                switch "$argv[1]"
                    case "packages/*"
                        set -g __ds_pkg_changed 1
                    case "sidebar-patch/*"
                        set -g __ds_sidebar_changed 1
                    case "package.json" "pnpm-lock.yaml" "pnpm-workspace.yaml"
                        set -g __ds_profile_cfg_changed 1
                end
            end

            # Settings (merged: baseline + device patch + sync-local)
            set -l host (hostname -s 2>/dev/null; or hostname)
            set -l patch_file "$g_dotfiles/device-patches/$host.yaml"
            if not test -f "$patch_file"
                set patch_file /dev/null
            end
            set -l sync_local "$HOME/.dsh/sync-local.yaml"
            if not test -f "$sync_local"
                set sync_local /dev/null
            end
            if test -f "$HOME/.local/bin/dsh-sync-merge.mjs" -a -f "$g_dotfiles/settings.yaml"
                node "$HOME/.local/bin/dsh-sync-merge.mjs" merge "$g_dotfiles/settings.yaml" "$patch_file" "$sync_local" "$HOME/.dsh/settings.yaml"
                echo "  ✔ Settings merged (baseline + device-patches/$host.yaml + sync-local)"
            else
                echo "  ⚠ Merge script or baseline missing — settings.yaml NOT applied"
            end

            # Skills
            if test -d "$g_dotfiles/skills"
                mkdir -p "$g_dsh_home/skills"
                rsync -a --delete "$g_dotfiles/skills/" "$g_dsh_home/skills/" 2>/dev/null; or cp -r "$g_dotfiles/skills/"* "$g_dsh_home/skills/"
                echo "  ✔ Skills deployed"
            end

            # Agent Presets (3-layer: global → device patch → local patches)
            if test -d "$g_dotfiles/presets"
                mkdir -p "$g_dsh_home/.agent-presets"
                rsync -a --delete "$g_dotfiles/presets/" "$g_dsh_home/.agent-presets/" 2>/dev/null; or cp -r "$g_dotfiles/presets/"* "$g_dsh_home/.agent-presets/"
                echo "  ✔ Agent Presets deployed (global)"
            end
            # Device-patch presets overlay (device-specific versions — ADDITIVE,
            # never --delete: the patch may only override SOME presets)
            if test -d "$g_dotfiles/device-patches/$host/presets"
                rsync -a "$g_dotfiles/device-patches/$host/presets/" "$g_dsh_home/.agent-presets/" 2>/dev/null; or true
                echo "  ✔ Device presets overlaid (device-patches/$host/presets/)"
            end
            # Local patches overlay (never synced, highest precedence — ADDITIVE)
            if test -d "$HOME/.dsh/local-patches/presets"
                rsync -a "$HOME/.dsh/local-patches/presets/" "$g_dsh_home/.agent-presets/" 2>/dev/null; or true
                echo "  ✔ Local preset patches overlaid (~/.dsh/local-patches/presets/)"
            end

            # Profile packages (itemize-changes detects rebuild need)
            if test -d "$g_dotfiles/packages"
                mkdir -p "$g_dsh_home/profiles/web/packages"
                set -l pkg_out (rsync -a --delete --exclude node_modules --exclude lib --itemize-changes "$g_dotfiles/packages/" "$g_dsh_home/profiles/web/packages/" 2>/dev/null)
                if test -n "$pkg_out"
                    set -g __ds_pkg_changed 1
                end
                echo "  ✔ Profile packages deployed"
            end

            # Sidebar patch (itemize-changes detects rebuild need)
            if test -d "$g_dotfiles/sidebar-patch"
                mkdir -p "$g_dsh_home/profiles/web/sidebar-patch"
                set -l sb_out (rsync -a --delete --itemize-changes "$g_dotfiles/sidebar-patch/" "$g_dsh_home/profiles/web/sidebar-patch/" 2>/dev/null)
                if test -n "$sb_out"
                    set -g __ds_sidebar_changed 1
                end
                echo "  ✔ Sidebar patch deployed"
            end

            # Profile config files
            __ds_apply_file "rebuild-sidebar.sh" ~/.dsh/profiles/web/rebuild-sidebar.sh
            __ds_apply_file "cordis.patch.yml" ~/.dsh/profiles/web/cordis.patch.yml
            __ds_apply_file "cordis.yml" ~/.dsh/profiles/web/cordis.yml
            __ds_apply_file "package.json" ~/.dsh/profiles/web/package.json
            __ds_apply_file "pnpm-workspace.yaml" ~/.dsh/profiles/web/pnpm-workspace.yaml
            __ds_apply_file "pnpm-lock.yaml" ~/.dsh/profiles/web/pnpm-lock.yaml
            __ds_apply_file "vitest.config.ts" ~/.dsh/profiles/web/vitest.config.ts

            # Skin
            if test -d "$g_dotfiles/skin-center"
                mkdir -p "$g_dsh_home/skin-center"
                rsync -a --delete --exclude .cache "$g_dotfiles/skin-center/" "$g_dsh_home/skin-center/" 2>/dev/null; or true
            end
            if test -d "$g_dotfiles/skins"
                mkdir -p "$g_dsh_home/skins"
                rsync -a --delete --exclude .cache "$g_dotfiles/skins/" "$g_dsh_home/skins/" 2>/dev/null; or true
            end
            __ds_apply_file "skin-center-active.json" ~/.dsh/skin-center-active.json

            # Fish CLI & completions
            __ds_apply_file "fish/ds.fish" ~/.config/fish/functions/ds.fish
            __ds_apply_file "fish/completions/ds.fish" ~/.config/fish/completions/ds.fish

            # Systemd units (Linux only). A unit that hardcodes another
            # operator's home is a device template from someone else's
            # machine: skip it instead of installing a broken service.
            if test $g_is_linux -eq 1
                for unit in dsh-web.service dsh-tailnet.service
                    set -l unit_src "$g_dotfiles/systemd/$unit"
                    if test -f "$unit_src"
                        if grep -qE '/home/[A-Za-z0-9._-]+' "$unit_src"; and not grep -qE "/home/$(whoami)/" "$unit_src"
                            echo "  ⚠ systemd/$unit references another user's home — skipped (device-specific template)"
                            continue
                        end
                        __ds_apply_file "systemd/$unit" ~/.config/systemd/user/$unit
                    end
                end
                systemctl --user daemon-reload
                echo "  ✔ Systemd units updated and daemon reloaded"
            end

            # Rebuild profile packages if sources or profile config changed
            if test "$__ds_pkg_changed" = "1" -o "$__ds_profile_cfg_changed" = "1"
                echo "  Rebuilding profile packages..."
                cd "$g_dsh_home/profiles/web"
                pnpm install 2>/dev/null; or echo "  ⚠ pnpm install failed"
                for p in "$g_dsh_home/profiles/web/packages"/enpoi-*/
                    set -l pkg (basename "$p")
                    # Skip packages without a build script (bundle-patch plugins
                    # like enpoi-provider-sync are built by the harness itself).
                    if grep -q '"build"' "$p/package.json" 2>/dev/null
                        cd "$p"; and pnpm run build 2>/dev/null; or echo "  ⚠ build failed: $pkg"
                    end
                end
                echo "  ✔ Packages rebuilt"
            end

            # Rebuild sidebar if patch changed
            if test "$__ds_sidebar_changed" = "1"
                echo "  Rebuilding sidebar..."
                bash "$g_dsh_home/profiles/web/rebuild-sidebar.sh" 2>/dev/null; or echo "  ⚠ sidebar rebuild failed — run rebuild-sidebar.sh manually"
            end

            echo ""
            if test "$__ds_pull_updated" = "1"
                echo "✔ Pull complete! Run 'ds restart' to apply service changes."
            else
                echo "✔ Pull complete — nothing changed."
            end

        case "update"
            # Delegate to the built-in updater: it verifies the release,
            # refreshes the profile additively, switches versions, and rolls
            # back on failure. `ds pull`/`ds sync` remain for dotfiles.
            # No shell `exec`: this function runs in the operator's interactive
            # shell, and exec would replace that shell process.
            echo "=== Updating Enpoi Harness (built-in updater) ==="
            if test -x "$g_dsh_bin"
                $g_dsh_bin update $subargs
            else
                echo "Error: dsh CLI binary not found at $g_dsh_bin"
            end

        case "help" or "--help" or "-h"
            echo "Enpoi Harness CLI (ds)"
            echo ""
            echo "Usage: ds [command] [options]"
            echo ""
            echo "Service & Web Control:"
            echo "  ds start            Start dsh-web.service"
            echo "  ds stop             Stop dsh-web.service"
            echo "  ds restart          Restart dsh-web.service with health wait"
            echo "  ds status           Show systemd service status"
            echo "  ds web              Open web UI in default browser"
            echo "  ds urls             Show local & Tailscale endpoints"
            echo "  ds serve            Enable Tailscale HTTPS serve (DSH_TAILNET_PORT, default 8443)"
            echo "  ds serve-off        Reset Tailscale serve"
            echo ""
            echo "Diagnostics & Health:"
            echo "  ds doctor           Comprehensive system diagnostic"
            echo "  ds heal             Quick permissions & service repair"
            echo ""
            echo "Harness Inventory:"
            echo "  ds skills           List all installed skills"
            echo "  ds presets          List available agent presets"
            echo "  ds pool [provider]  Show live multi-key pool status"
            echo "  ds reset-cooldown   Reset rate-limit cooldown for a key"
            echo "  ds update           Update the harness through the built-in updater (dsh update)"
            echo "  ds backfill         Reindex derived per-session projection caches (context insights)"
            echo "                      status | run [--keys k1,k2] [--limit N] [--plugin-fallback]"
            echo "  ds repair           Verify the install and fix the safe breaks (--check reports only)"
            echo "  ds uninstall        Remove the install (default keeps \$HOME/.dsh; --purge removes all)"
            echo ""
            echo "Device-to-Device Peer (caller side):"
            echo "  ds peer [args]      Caller-side peer CLI (status/list/ask/asks/answer/follow/cancel)"
            echo ""
            echo "Cross-Device Sync:"
            echo "  ds sync             Push global configs (settings/presets/skills/packages/patches) to dotfiles repo"
            echo "  ds pull             Pull + apply global configs, merge device patch + sync-local overrides"
            echo "  ds sync-local       Show this device's sync-local.yaml (exclusions/overrides)"
            echo ""
            echo "All other commands pass through directly to the dsh CLI."

        case "sync-local"
            # Show this device's sync-local.yaml (device-local exclusions/overrides)
            if test -f "$HOME/.dsh/sync-local.yaml"
                echo "=== $HOME/.dsh/sync-local.yaml (device-local, NEVER synced) ==="
                cat "$HOME/.dsh/sync-local.yaml"
            else
                echo "No sync-local.yaml — this device uses the global config as-is."
                echo "Create ~/.dsh/sync-local.yaml to exclude or override entries:"
                echo ""
                echo "  exclude:"
                echo "    enpoiOrchestration:"
                echo "      mcpServers: [plane-mcp]      # don't apply this MCP server here"
                echo "  override:"
                echo "    enpoi-orchestration:"
                echo "      capabilities:"
                echo "        mcp:"
                echo "          plane-mcp: false"
            end

        case "keeper"
            # Context Keeper activity (last prose, claimed facts, raw output)
            if test -x "$HOME/.local/bin/dsh-keeper.mjs"
                __ds_run_node_cli "$HOME/.local/bin/dsh-keeper.mjs" $argv[2..-1]
            else
                echo "Error: dsh-keeper.mjs not found"
            end

        case "brief"
            # View active/newest session Living Brief
            if test -x "$HOME/.local/bin/dsh-brief.mjs"
                __ds_run_node_cli "$HOME/.local/bin/dsh-brief.mjs" $argv[2..-1]
            else
                echo "Error: dsh-brief.mjs not found"
            end

        case "memory"
            # Cross-session memory CLI (list/search/rescind/migrate/stats)
            set -l sub $argv[2]
            set -l rest $argv[3..-1]
            if test -x "$HOME/.local/bin/dsh-memory.mjs"
                __ds_run_node_cli "$HOME/.local/bin/dsh-memory.mjs" $sub $rest
            else
                echo "Error: dsh-memory.mjs not found"
            end

        case "backfill"
            # Projection-cache reindex CLI (status/run) — context insights data layer
            if test -x "$HOME/.local/bin/dsh-projections-backfill.mjs"
                __ds_run_node_cli "$HOME/.local/bin/dsh-projections-backfill.mjs" $argv[2..-1]
            else if test -f "$g_dsh_home/profiles/web/scripts/dsh-projections-backfill.mjs"
                __ds_run_node_cli "$g_dsh_home/profiles/web/scripts/dsh-projections-backfill.mjs" $argv[2..-1]
            else
                echo "Error: dsh-projections-backfill.mjs not found"
            end

        case "peer"
            # Caller-side peer CLI (device-to-device): the installer seeds
            # `dsh-peer` beside the dsh shim. Prefer PATH, then the shim's
            # directory, then the default bin dir; pass every argument through.
            set -l bin_dir (dirname "$g_dsh_bin")
            set -l peer_bin ""
            if command -v dsh-peer >/dev/null 2>&1
                set peer_bin (command -v dsh-peer)
            else
                for candidate in "$bin_dir/dsh-peer" "$HOME/.local/bin/dsh-peer"
                    if test -x "$candidate"
                        set peer_bin "$candidate"
                        break
                    end
                end
            end
            if test -z "$peer_bin"
                echo "✖ dsh-peer not found (checked PATH, $bin_dir, and $HOME/.local/bin); re-run the installer to seed it"
                return 1
            end
            command $peer_bin $subargs

        case "*"
            # Direct passthrough to dsh CLI binary
            if test -x "$g_dsh_bin"
                $g_dsh_bin $argv
            else
                echo "Error: dsh CLI binary not found at $g_dsh_bin"
            end
    end
end
