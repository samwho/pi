#!/usr/bin/env bash
set -euo pipefail

host_config=/mnt/pi-host
launch_config=/mnt/pi-launch
agent_dir=/home/pi/.pi/agent
ready_file=/run/pi-sandbox-ready

rm -f "$ready_file"
mountpoint -q "$host_config"
mountpoint -q "$launch_config"
mountpoint -q /workspace

mkdir -p "$agent_dir" "$agent_dir/sessions" /mnt/pi-deps /home/pi/.cache/pnpm

# Host node_modules may contain binaries for macOS, while this machine runs
# Linux ARM64. Keep the dependency tree in the persistent VM disk so package
# managers install optional native packages for this machine without mutating
# the host checkout. Only JavaScript projects get the overlay.
if [[ -f /workspace/package.json ]]; then
  mkdir -p /workspace/node_modules
  mount --bind /mnt/pi-deps /workspace/node_modules
fi

# Keep pnpm's content-addressable store in the persistent VM disk as well.
mkdir -p /home/pi/.cache/pnpm

# Project files are intentionally writable, but repository metadata is not.
if [[ -e /workspace/.git ]]; then
  mount --bind /workspace/.git /workspace/.git
  mount -o remount,bind,ro /workspace/.git
fi

# Project live host configuration into the machine-local Pi directory. Mutable
# Pi state is writable by explicit policy; every other top-level config entry is
# read-only. Host sessions are never projected.
rw_entries=(
  auth.json
  mcp-cache.json
  mcp-npx-cache.json
  models-store.json
  oauth.json
  settings.json
  trust.json
)

is_rw_entry() {
  local candidate="$1" entry
  for entry in "${rw_entries[@]}"; do
    [[ "$candidate" == "$entry" ]] && return 0
  done
  return 1
}

while IFS= read -r -d '' source; do
  name="$(basename "$source")"
  [[ "$name" == sessions ]] && continue
  destination="$agent_dir/$name"

  if [[ -d "$source" ]]; then
    mkdir -p "$destination"
  elif [[ -f "$source" ]]; then
    install -o pi -g pi -m 0600 /dev/null "$destination"
  else
    # Skip sockets and unusual entries rather than widening the projection.
    continue
  fi

  mount --bind "$source" "$destination"
  if ! is_rw_entry "$name"; then
    mount -o remount,bind,ro "$destination"
  fi
done < <(find "$host_config" -mindepth 1 -maxdepth 1 -print0)

# The source mount contains host sessions, so hide it after establishing the
# selected bind mounts. The unprivileged agent can only see the projection.
mkdir -p /run/pi-hidden-host-config
mount --bind /run/pi-hidden-host-config "$host_config"

/usr/local/bin/pi-network-lockdown
touch "$ready_file"
chmod 0644 "$ready_file"
