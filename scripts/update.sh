#!/usr/bin/env bash
# dsh mechanical updater — delegates to the installer engine (single implementation).
# Invoked by the `dsh` shim as `dsh update [flags]`; runnable directly too.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
exec "$HERE/install.sh" --update "$@"
