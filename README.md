# Sandboxed Pi

This repository launches Pi in a fresh, isolated OrbStack Arch Linux ARM64
machine. The current project and a policy-controlled projection of the host Pi
configuration are mounted from macOS, Git metadata is remounted read-only,
sessions and project dependency state are kept in separate profile/project
directories, and Pi has rootless Docker and headless Chromium.

## Quick start

```bash
# Create or incrementally update the persistent stopped template with PyInfra.
~/.pi/agent/bin/pi-update

# Preview the PyInfra changes without modifying the template.
~/.pi/agent/bin/pi-diff

# From any project: clone the template, run Pi, then delete the clone on exit.
~/.pi/agent/bin/pi
```

`pi-diff` uses Rich to render only operations that would change and includes
syntax-highlighted unified diffs for managed files, avoiding PyInfra's
full-width all-operations table.
`pi-update` converges the persistent template in place with PyInfra, retaining
pacman, npm, mise, and container caches. It installs current Arch packages; the
latest Node, Bun, Rust, uv, Python, and Biome through mise; Pi; and
`chrome-devtools-mcp`. Run it to update tools or apply changes under
`vm/pyinfra/` and `vm/`. Host Pi configuration is mounted live at runtime and
does not require an update.

PyInfra's built-in operations manage pacman, users, files, downloads, and both
system and user systemd services. Because PyInfra has no mise operation, this
repository provides custom mise facts and operations in `vm/pyinfra/`. They
resolve current upstream versions and only install tools or npm packages when
the declared `latest` version has changed. The mise binary itself is a pinned,
checksummed `files.download`, rather than a piped installer script. The PyInfra
Python environment is locked by uv; run `uv sync` after cloning to give editors
and command-line tools the same dependency environment. Ruff owns formatting
and linting, while ty provides project type checking:

```bash
uv run ruff format --check vm/pyinfra
uv run ruff check vm/pyinfra
uv run ty check
```

The remaining
shell code is limited to OrbStack lifecycle orchestration and clone-time policy
that depends on invocation-specific mounts; those states do not exist while
PyInfra is converging the stopped template.

Useful overrides:

```bash
PI_VM_PROFILE=work pi                 # separate persistent session namespace
PI_VM_CPUS=6 PI_VM_MEMORY=8G pi-update
```

`PI_VM_TEMPLATE`, `PI_VM_DISK`, and `PI_VM_STATE_ROOT` are also supported.

## VM lifecycle

```text
stopped pi-template (Arch ARM64, provisioned)
        │ orb clone (copy-on-demand)
        ▼
fresh isolated machine
  ├─ project mounted read/write at /workspace
  ├─ /workspace/.git covered by a read-only bind mount
  ├─ Linux-native project dependencies overlaid at /workspace/node_modules
  ├─ profile/project sessions mounted at ~/.pi/agent/sessions
  ├─ root-owned egress firewall
  ├─ Pi runs as unprivileged user `pi` without sudo
  ├─ rootless Docker daemon
  └─ headless Chromium and Chrome DevTools MCP
        │ Pi exits
        ▼
clone deleted; template and mounted sessions remain
```

OrbStack clones are copy-on-demand and start stopped. The launcher only clones,
attaches invocation-specific mounts, starts the machine, and executes Pi. These
host paths are selectively mounted:

- the current project at `/workspace`;
- `$PI_VM_STATE_ROOT/sessions/<profile>/<project hash>` at Pi's session path;
- `$PI_VM_STATE_ROOT/dependencies/<profile>/<project hash>` as the project's
  Linux-native `node_modules` state;
- `$PI_VM_STATE_ROOT/pnpm-store` as the shared pnpm package store;
- the host Pi agent directory at a temporary, hidden projection source;
- a temporary directory used for invocation-specific runtime state.

The root-owned boot service also overlays JavaScript projects' host
`node_modules` with the per-project Linux-native dependency directory. Before Pi
starts, the guest activates the repository's mise environment and synchronizes
dependencies from conventional package-manager lockfiles. Changes to manifests,
lockfiles, or toolchain files invalidate the dependency stamp; no repository
name or dependency version is encoded in the VM.

A root-owned boot service projects each top-level host Pi configuration entry
except `sessions/` into `~/.pi/agent`. `settings.json`, `auth.json`, OAuth/model
state, trust, and MCP caches are read-write. All other entries—including
extensions, skills, prompts, themes, MCP configuration, and npm/git package
directories—are bind-mounted read-only. The original source mount is then
covered so Pi cannot traverse into host sessions or unselected files.

Changes to projected host files and directories are visible immediately. The
read-write entries can also be changed, corrupted, or deleted by the agent; this
is an explicit pragmatic concession. The host's general filesystem, host Pi
sessions, SSH agent, USB devices, sound, and normal macOS command integration
are not shared.

## Network policy

The machine is created with OrbStack's `--isolated` mode, but deliberately not
`--isolate-network`: OrbStack's latter option also blocks access to the local
LAN, which Pi needs for development services.

A root-owned firewall permits loopback, configured DNS, public IPv4 Internet,
and only the exact non-loopback IPv4 addresses assigned to the host machine for
that clone. It rejects every other private IPv4 address, including other devices
on the host's local subnet, plus carrier-grade NAT, link-local, OrbStack's
machine network, multicast, and reserved destinations. IPv6 egress is rejected
entirely because globally addressed LAN devices cannot be distinguished from
public IPv6 destinations by prefix. Rootless Docker traffic exits through an
unprivileged RootlessKit process and remains subject to this outer policy.

The launcher derives the address list from the host's interfaces and passes it
through the root-owned runtime mount as exact `/32` exceptions.

## Security model

OrbStack calls these “isolated machines,” but they are not full VMs with
independent kernels. OrbStack documents that its machines and containers share
one Linux VM and kernel; the boundary relies on Linux isolation plus OrbStack
hardening. It is appropriate for ordinary untrusted dependencies and coding
agents, not malware analysis or workloads actively attempting kernel escape.

Pi can intentionally modify every file in the mounted project except `.git`,
can reach public Internet services, and receives the live host credentials
mounted into its configuration. Any credential visible to an Internet-enabled
agent can be exfiltrated. It can also modify the explicitly read-write host Pi
state. Use separate `PI_VM_PROFILE` values for session isolation and keep only
deliberately allowed credentials in the host Pi configuration.

## Files

| Path | Responsibility |
| --- | --- |
| `agent/bin/pi` | Clone lifecycle, project dependency state, selective mounts, and Pi execution. |
| `agent/bin/pi-update` | Creates the template if absent and runs incremental PyInfra convergence. |
| `agent/bin/pi-diff` | Starts the template if necessary and previews PyInfra operations and file diffs. |
| `pyproject.toml`, `uv.lock` | Locked Python/PyInfra project used by updates and editor tooling. |
| `vm/pyinfra/inventory.py` | Connects PyInfra to the template through OrbStack's built-in SSH server. |
| `vm/pyinfra/deploy.py` | Declarative packages, users, files, services, and tool state. |
| `vm/pyinfra/facts.py` | Facts for installed and current upstream mise/npm versions. |
| `vm/pyinfra/operations.py` | Declarative mise tool and mise-scoped npm operations. |
| `vm/prepare-runtime.sh` | Projects live Pi config, protects Git metadata, overlays native dependencies, and applies network policy. |
| `vm/project-dependencies.sh` | Detects project package-manager inputs and installs Linux-native dependencies from the repository's own lockfiles. |
| `vm/network-lockdown.sh` | Root-owned runtime egress filtering. |
| `vm/pi-rootless-docker.service` | Declarative rootless Docker process configuration. |
| `vm/guest-entrypoint.sh` | Activates project tools, synchronizes dependencies, waits for runtime policy and Docker, then starts Pi in `/workspace`. |
| `agent/mcp.json` | Headless Chromium MCP configuration. |
