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

# The user service starts at machine boot. Wait briefly so `docker` is ready by
# the time the Pi prompt appears, and show its log if startup failed.
for _ in $(seq 1 120); do
  docker info >/dev/null 2>&1 && break
  sleep 0.1
done
if ! docker info >/dev/null 2>&1; then
  journalctl --user -u pi-docker.service --no-pager -n 100 >&2 || true
  exit 1
fi

exec /home/pi/.local/share/mise/installs/node/latest/bin/pi "$@"
