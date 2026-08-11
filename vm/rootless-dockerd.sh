#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/pi
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"

rm -f "$XDG_RUNTIME_DIR/docker.sock"
mkdir -p "$HOME/.local/share/docker" "$HOME/.local/state"

# OrbStack's synthetic 0.250.250.200 resolver is not reachable through
# slirp4netns. Nested containers use an explicit public resolver instead.
resolver="${PI_DOCKER_DNS:-1.1.1.1}"

# Nested container traffic leaves through this unprivileged RootlessKit process,
# so it remains subject to the machine-level OUTPUT firewall.
exec rootlesskit \
  --net=slirp4netns \
  --mtu=1500 \
  --disable-host-loopback \
  --port-driver=builtin \
  --copy-up=/etc \
  dockerd \
    --data-root="$HOME/.local/share/docker" \
    --exec-root="$XDG_RUNTIME_DIR/dockerd" \
    --host="$DOCKER_HOST" \
    --dns="$resolver" \
    --storage-driver=fuse-overlayfs
