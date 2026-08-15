#!/usr/bin/env bash
set -euo pipefail

agent_dir="${PI_CODING_AGENT_DIR:-/home/pi/.pi/agent}"
npm_root="$agent_dir/npm"
package_json="$npm_root/package.json"
lockfile="$npm_root/package-lock.json"
stamp_file="$agent_dir/.npm-dependencies.sha256"

# The host package store is intentionally not mounted into the VM. pi-update
# copies only the manifests here, so npm can resolve native optional
# dependencies for the guest platform.
[[ -f "$package_json" ]] || exit 0

platform="$(node -p '`${process.platform}-${process.arch}`')"
digest="$({
  printf 'platform=%s\n' "$platform"
  sha256sum "$package_json"
  if [[ -f "$lockfile" ]]; then
    sha256sum "$lockfile"
  fi
} | sha256sum | awk '{ print $1 }')"

if [[ -r "$stamp_file" && "$(<"$stamp_file")" == "$digest" && -d "$npm_root/node_modules" ]]; then
  echo "Pi extension dependencies are up to date."
  exit 0
fi

echo "Installing VM-native Pi extension dependencies..."
if [[ -f "$lockfile" ]]; then
  npm ci \
    --prefix "$npm_root" \
    --include=optional \
    --legacy-peer-deps \
    --no-audit \
    --no-fund
else
  npm install \
    --prefix "$npm_root" \
    --include=optional \
    --legacy-peer-deps \
    --no-audit \
    --no-fund
fi

printf '%s\n' "$digest" >"$stamp_file"
echo "Pi extension dependencies are ready for $platform."
