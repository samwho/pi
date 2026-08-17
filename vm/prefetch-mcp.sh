#!/usr/bin/env bash
set -euo pipefail

config="${1:-/home/pi/.pi/agent/mcp.json}"
log_dir="${TMPDIR:-/tmp}/pi-mcp-prefetch"

if [[ ! -f "$config" ]]; then
  echo "MCP configuration is missing: $config" >&2
  exit 1
fi

# MCP configuration uses $env:NAME references. Loading the template's copied
# environment makes those references available to servers during prefetch.
if [[ -f /home/pi/.pi/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /home/pi/.pi/.env
  set +a
fi

rm -rf "$log_dir"
mkdir -p "$log_dir"

while IFS= read -r encoded; do
  # jq's @sh output is shell-quoted. The config is already trusted Pi
  # configuration, and using an array preserves argument boundaries exactly.
  eval "parts=($encoded)"
  name="${parts[0]}"
  command=("${parts[@]:1}")
  log_file="$log_dir/$name.log"

  # uvx installs a package and all of its transitive dependencies before it
  # starts the server. Run --help first so a timeout from the long-running MCP
  # process cannot be mistaken for a successful download.
  case "${command[0]}" in
    uvx|*/uvx)
      package="${command[1]:-}"
      if [[ -z "$package" || "$package" == -* ]]; then
        echo "Cannot determine the uvx package for MCP server: $name" >&2
        exit 1
      fi
      echo "Downloading MCP package: $package"
      set +e
      uvx --from "$package" "$package" --help \
        >"$log_dir/$name-download.log" 2>&1
      status=$?
      set -e
      if [[ "$status" -ne 0 ]]; then
        cat "$log_dir/$name-download.log" >&2
        exit "$status"
      fi
      ;;
  esac

  echo "Prefetching MCP server: $name"
  set +e
  timeout --kill-after=5s 45s "${command[@]}" </dev/null >"$log_file" 2>&1
  status=$?
  set -e

  # MCP servers normally remain alive waiting for stdio, so timeout(124) is a
  # successful server run after the dependency prefetch above. A clean exit is
  # also fine for one-shot servers.
  case "$status" in
    0|124|137|143) ;;
    *)
      cat "$log_file" >&2
      exit "$status"
      ;;
  esac
done < <(
  jq -r \
    '.mcpServers | to_entries[] | [.key, .value.command, (.value.args[]?)] | @sh' \
    "$config"
)

echo "MCP server dependencies are cached in the template."
