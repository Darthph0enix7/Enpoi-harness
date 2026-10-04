# Completions for Enpoi Harness CLI (ds)

complete -c ds -f

# Main subcommands
complete -c ds -n "__fish_use_subcommand" -a "start" -d "Start dsh-web.service"
complete -c ds -n "__fish_use_subcommand" -a "stop" -d "Stop dsh-web.service"
complete -c ds -n "__fish_use_subcommand" -a "restart" -d "Restart dsh-web.service with health wait"
complete -c ds -n "__fish_use_subcommand" -a "status" -d "Show systemd service status"
complete -c ds -n "__fish_use_subcommand" -a "web" -d "Open web UI in browser"
complete -c ds -n "__fish_use_subcommand" -a "urls" -d "Show local & Tailscale endpoints"
complete -c ds -n "__fish_use_subcommand" -a "serve" -d "Enable Tailscale HTTPS serve (:8443)"
complete -c ds -n "__fish_use_subcommand" -a "serve-off" -d "Reset Tailscale serve"
complete -c ds -n "__fish_use_subcommand" -a "doctor" -d "Comprehensive system diagnostic"
complete -c ds -n "__fish_use_subcommand" -a "heal" -d "Quick permissions & service repair"
complete -c ds -n "__fish_use_subcommand" -a "skills" -d "List all installed skills"
complete -c ds -n "__fish_use_subcommand" -a "presets" -d "List available agent presets"
complete -c ds -n "__fish_use_subcommand" -a "pool" -d "Show live multi-key pool status"
complete -c ds -n "__fish_use_subcommand" -a "reset-cooldown" -d "Reset rate-limit cooldown for a key"
complete -c ds -n "__fish_use_subcommand" -a "update" -d "Rebuild & update harness from source"
complete -c ds -n "__fish_use_subcommand" -a "backfill" -d "Reindex derived per-session projection caches (status|run)"
complete -c ds -n "__fish_use_subcommand" -a "repair" -d "Verify the install and fix the safe breaks"
complete -c ds -n "__fish_use_subcommand" -a "uninstall" -d "Remove the install (--keep-data default, --purge)"
complete -c ds -n "__fish_use_subcommand" -a "sync" -d "Sync local configs to dotfiles repo"
complete -c ds -n "__fish_use_subcommand" -a "pull" -d "Pull configs from dotfiles repo"
complete -c ds -n "__fish_use_subcommand" -a "help" -d "Show help"

# Subcommand arguments
complete -c ds -n "__fish_seen_subcommand_from pool reset-cooldown" -a "opencode-go deepseek antigravity openrouter minimax huggingface opencode" -d "Provider route"
