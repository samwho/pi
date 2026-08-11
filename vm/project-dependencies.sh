#!/usr/bin/env bash
set -euo pipefail

project=/workspace
cd "$project"

[[ -f package.json ]] || exit 0

# Reinstall when the repository's dependency or toolchain inputs change. The
# list is intentionally based on conventional filenames rather than a
# repository-specific package name or dependency.
mapfile -d '' dependency_inputs < <(
  find "$project" \
    -path '*/node_modules' -prune -o \
    -path '*/.git' -prune -o \
    -type f \( \
      -name 'package.json' -o \
      -name 'pnpm-lock.yaml' -o \
      -name 'package-lock.json' -o \
      -name 'npm-shrinkwrap.json' -o \
      -name 'yarn.lock' -o \
      -name '.yarnrc' -o \
      -name '.yarnrc.yml' -o \
      -name 'bun.lock' -o \
      -name 'bun.lockb' -o \
      -name 'mise.toml' -o \
      -name '.mise.toml' -o \
      -name '.nvmrc' -o \
      -name '.tool-versions' -o \
      -name '.npmrc' -o \
      -name '.pnpmfile.cjs' -o \
      -name '.pnpmfile.mjs' \
    \) -print0 | sort -z
)

if ((${#dependency_inputs[@]} == 0)); then
  exit 0
fi

digest="$({
  for input in "${dependency_inputs[@]}"; do
    printf '%s\0' "${input#"$project"/}"
    sha256sum "$input"
  done
} | sha256sum | awk '{ print $1 }')"

stamp_file="$project/node_modules/.pi-dependencies.sha256"
if [[ -r "$stamp_file" ]] && [[ "$(<"$stamp_file")" == "$digest" ]]; then
  echo "Project dependencies are up to date."
  exit 0
fi

# A project mise config owns its tool versions. Installing it here means a
# branch can change Node or its package manager without requiring a VM update.
if [[ -f mise.toml || -f .mise.toml || -f .tool-versions || -f .nvmrc ]]; then
  mise install
fi

# Prefer package.json#packageManager, then infer the manager from its lockfile.
package_manager="$(awk -F'"' '$2 == "packageManager" { print $4; exit }' package.json)"
manager="${package_manager%@*}"
if [[ -z "$manager" || "$manager" == "$package_manager" ]]; then
  if [[ -f pnpm-lock.yaml ]]; then
    manager=pnpm
  elif [[ -f yarn.lock ]]; then
    manager=yarn
  elif [[ -f bun.lock || -f bun.lockb ]]; then
    manager=bun
  else
    manager=npm
  fi
fi

run_manager() {
  mise x -- "$@"
}

case "$manager" in
  pnpm)
    export pnpm_config_store_dir=/home/pi/.cache/pnpm/store
    if [[ -f pnpm-lock.yaml ]]; then
      run_manager pnpm install --frozen-lockfile
    else
      run_manager pnpm install
    fi
    ;;
  npm)
    if [[ -f package-lock.json || -f npm-shrinkwrap.json ]]; then
      run_manager npm ci
    else
      run_manager npm install
    fi
    ;;
  yarn)
    if [[ -f yarn.lock ]]; then
      run_manager yarn install --immutable
    else
      run_manager yarn install
    fi
    ;;
  bun)
    if [[ -f bun.lock || -f bun.lockb ]]; then
      run_manager bun install --frozen-lockfile
    else
      run_manager bun install
    fi
    ;;
  *)
    echo "Unsupported package manager '$manager' in $project/package.json" >&2
    exit 1
    ;;
esac

printf '%s\n' "$digest" >"$stamp_file"
echo "Project dependencies are ready for Linux ARM64."
