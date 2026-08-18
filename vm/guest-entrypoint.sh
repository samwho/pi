#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/pi
export USER=pi
export LOGNAME=pi
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"
export PATH="/home/pi/.local/share/mise/installs/node/latest/bin:/home/pi/.local/bin:/home/pi/.local/share/mise/shims:$PATH"
export MISE_DATA_DIR=/home/pi/.local/share/mise
export MISE_TRUSTED_CONFIG_PATHS=/workspace

# Load the host-global Pi secrets file. This is copied into the persistent
# template by pi-update, then sourced by every guest Pi process. MCP children
# inherit these variables; the agent can therefore use the configured APIs.
if [[ -f /home/pi/.pi/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /home/pi/.pi/.env
  set +a
fi

# RTK must not send usage telemetry from sandboxed Pi sessions.
export RTK_TELEMETRY_DISABLED=1

export FACELIFT_THEME=gruvbox-dark-hard
export FACELIFT_MAX_PREVIEW_LINES=10

# The root-owned boot service applies mount and network policy before the agent
# may run. A missing marker means provisioning or runtime preparation failed.
for _ in $(seq 1 120); do
  [[ -e /run/pi-sandbox-ready ]] && break
  sleep 0.1
done
if [[ ! -e /run/pi-sandbox-ready ]]; then
  journalctl -u pi-sandbox-prepare.service --no-pager -n 100 >&2 || true
  exit 1
fi

# The user service starts at machine boot. Wait briefly so `docker` is ready by
# the time the Pi prompt appears, and show its log if startup failed.
for _ in $(seq 1 120); do
  docker info >/dev/null 2>&1 && break
  sleep 0.1
done
if ! docker info >/dev/null 2>&1; then
  journalctl --user -u pi-rootless-docker.service --no-pager -n 100 >&2 || true
  exit 1
fi

# Activate project-local mise tools so commands such as `pnpm` are available
# without requiring a shell rc file. The dependency preparer uses the
# repository's own package manager and lockfile, not repository-specific VM
# configuration, and keeps native modules on the VM's Linux architecture.
cd /workspace
eval "$('/home/pi/.local/bin/mise' activate bash)"
export pnpm_config_store_dir=/home/pi/.cache/pnpm/store
/usr/local/bin/pi-project-dependencies

exec /home/pi/.local/share/mise/installs/node/latest/bin/pi "$@"
