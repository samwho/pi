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

mkdir -p "$agent_dir" "$agent_dir/sessions" "$agent_dir/npm" /mnt/pi-deps /home/pi/.cache/pnpm
chown pi:pi "$agent_dir/npm"

# Host node_modules may contain binaries for macOS, while this machine runs
# Linux ARM64. Keep both project dependencies and Pi's extension package tree
# in the persistent VM disk without mutating the host checkout. pi-update
# prepares the extension tree; only JavaScript projects get the project
# dependency overlay here.
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

# Project live host configuration into the machine-local Pi directory. Settings
# and credentials are copied at each VM launch instead of bind-mounted: Pi saves
# them atomically, and a file bind mount becomes stale when its host source is
# replaced. Other mutable state is writable by explicit policy; every remaining
# top-level config entry is read-only. Host sessions and atomic-write caches are
# never projected.
#
# MCP configuration is platform-specific. The host's mcp.json is for macOS;
# mcp-linux.json is mounted as the VM's mcp.json below.
launch_snapshot_entries=(
  auth.json
  settings.json
)
rw_entries=(
  models-store.json
  oauth.json
  trust.json
)

is_launch_snapshot_entry() {
  local candidate="$1" entry
  for entry in "${launch_snapshot_entries[@]}"; do
    [[ "$candidate" == "$entry" ]] && return 0
  done
  return 1
}

is_rw_entry() {
  local candidate="$1" entry
  for entry in "${rw_entries[@]}"; do
    [[ "$candidate" == "$entry" ]] && return 0
  done
  return 1
}

while IFS= read -r -d '' source; do
  name="$(basename "$source")"
  case "$name" in
    # SYSTEM.md is owned by the VM image. Do not let a host-global custom
    # prompt replace the VM-specific prompt.
    SYSTEM.md|sessions|mcp.json|mcp-linux.json|mcp-cache.json|mcp-npx-cache.json|pi-pretty|npm) continue ;;
  esac
  destination="$agent_dir/$name"

  if [[ -f "$source" ]] && is_launch_snapshot_entry "$name"; then
    # Keep the VM-local copy writable so Pi can safely replace it with rename(2).
    # Host configuration remains the source of truth on the next VM launch.
    install -o pi -g pi -m 0600 "$source" "$destination"

    # A stored llama.cpp credential contains the host-side URL, commonly
    # 127.0.0.1. That address is the guest itself, not the macOS host. Rewrite
    # only the VM-local snapshot so the host credentials remain unchanged and
    # the launcher can select the current host address for each VM.
    if [[ "$name" == "auth.json" && -r "$launch_config/llama-base-url" ]]; then
      llama_base_url="$(<"$launch_config/llama-base-url")"
      if [[ -n "$llama_base_url" && -s "$destination" ]]; then
        rewritten_auth="$(mktemp "$agent_dir/.auth.XXXXXX")"
        jq --arg base_url "$llama_base_url" '
          if .["llama.cpp"]? then
            .["llama.cpp"].env = ((.["llama.cpp"].env // {}) + {"LLAMA_BASE_URL": $base_url})
          else
            .
          end
        ' "$destination" >"$rewritten_auth"
        install -o pi -g pi -m 0600 "$rewritten_auth" "$destination"
        rm -f "$rewritten_auth"
      fi
    fi
    continue
  elif [[ -d "$source" ]]; then
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

# Replace the platform-specific host config with the Linux VM config while
# keeping it live and read-only like the other projected configuration.
linux_mcp="$host_config/mcp-linux.json"
if [[ ! -f "$linux_mcp" ]]; then
  echo "Linux MCP configuration is missing: $linux_mcp" >&2
  exit 1
fi
install -o pi -g pi -m 0644 /dev/null "$agent_dir/mcp.json"
mount --bind "$linux_mcp" "$agent_dir/mcp.json"
mount -o remount,bind,ro "$agent_dir/mcp.json"

# The source mount contains host sessions, so hide it after establishing the
# selected bind mounts. The unprivileged agent can only see the projection.
mkdir -p /run/pi-hidden-host-config /run/pi-hidden-launch
mount --bind /run/pi-hidden-host-config "$host_config"

# Apply the firewall while host-ips is still available, then hide the launch
# mount so the agent cannot read host-ips.
/usr/local/bin/pi-network-lockdown
mount --bind /run/pi-hidden-launch "$launch_config"
touch "$ready_file"
chmod 0644 "$ready_file"
