# Sandboxed Pi

Run Pi inside persistent, project-scoped OrbStack machines instead of directly
on macOS.

Each machine gets:

- the current project mounted read/write, with `.git` read-only;
- Linux-native dependencies stored outside the host checkout;
- isolated Pi sessions and mutable state;
- rootless Docker and headless Chromium;
- restricted network access; and
- no `sudo` access for Pi.

> [!WARNING]
> This is a practical development sandbox, not a malware-analysis environment.
> OrbStack machines share a Linux kernel, Pi can edit the project, and any
> credentials exposed to Pi may be sent over the Internet.

## Requirements

- macOS with [OrbStack](https://orbstack.dev/)
- [mise](https://mise.jdx.dev/)
- this repository at `~/.pi`

## Usage

```bash
# Create or update the base machine.
~/.pi/bin/pi-update

# Preview provisioning changes.
~/.pi/bin/pi-diff

# Launch Pi for the current project.
~/.pi/bin/pi

# Delete this project's stopped machines and their state.
~/.pi/bin/pi-delete
```

A bare `pi` resumes the machine's latest session. Arguments are passed to Pi,
so use `pi -c "prompt"` to resume with an initial prompt.

Machines persist after Pi exits. Concurrent launches use separate numbered
machines, while later launches reuse the lowest available one. Set
`PI_VM_PROFILE` to keep independent pools for the same project:

```bash
PI_VM_PROFILE=work ~/.pi/bin/pi
```

`pi-update` updates the base template, host Pi installation, extensions, and
Linux tooling. Existing project machines are not changed; run `pi-delete` from
a project when you want fresh clones of the updated template.

To bypass the sandbox and run Pi directly on macOS:

```bash
~/.pi/bin/pi-unsafe
```

## What lives where

| Data | Location and policy |
| --- | --- |
| Project files | Host checkout mounted at `/workspace`; writable except `.git`. |
| Project dependencies | VM disk, overlaid at `/workspace/node_modules`. |
| Pi sessions and caches | VM disk; separate for each project, profile, and machine. |
| Extensions, prompts, themes, and most Pi config | Live read-only mounts from `~/.pi/agent`. |
| `settings.json` and `auth.json` | Copied into the VM at launch; guest changes are not synced back. |
| `models-store.json`, `oauth.json`, and `trust.json` | Live read/write host mounts. |
| Linux MCP config | `agent/mcp-linux.json`, mounted as the guest's `mcp.json`. |

JavaScript dependencies are installed from the project's lockfile on first
launch and whenever dependency or toolchain inputs change. npm, pnpm, Yarn, and
Bun are supported.

If `~/.pi/.env` exists, `pi-update` copies it into the template and every Pi/MCP
process inherits it. The project’s `.env` is never sourced by the launcher.

## Credentials and host-managed tools

### GitHub CLI

The guest includes `gh`. For noninteractive authentication, place a
least-privilege token in `~/.pi/.env`, then update the template:

```bash
GH_TOKEN=github_pat_...
```

### Laravel Cloud

Authenticate on the host with `cloud auth:token --add`. During `pi-update`,
`~/.config/cloud/config.json` is copied into the template when present.

Agent skills are also host-managed. If `~/.agents` exists, `pi-update` copies
the complete directory into the template. Recreate existing project machines
to receive updated credentials or skills.

## Network policy

The guest may reach:

- loopback and configured DNS;
- public IPv4 addresses; and
- the Mac's exact non-loopback IPv4 addresses.

Other private IPv4 ranges and all IPv6 egress are blocked. This lets the guest
reach development services on the Mac without granting access to the rest of
the LAN. Rootless Docker remains subject to the same policy.

The launcher sets `LLAMA_BASE_URL` to the Mac at port `8080`. Override it when
needed:

```bash
PI_VM_LLAMA_BASE_URL=http://192.0.2.10:8080 ~/.pi/bin/pi
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_VM_PROFILE` | `default` | Separate VM pool for the current project. |
| `PI_VM_CPUS` | `4` | Template CPU count. |
| `PI_VM_MEMORY` | `4G` | Template memory. |
| `PI_VM_DISK` | `64G` | Template disk size. |
| `PI_VM_TEMPLATE` | `pi-template` | Base machine name. |
| `PI_VM_STATE_ROOT` | `~/.local/share/pi-vm` | Host runtime state. |
| `PI_CONFIG_DIR` | `~/.pi` | Host Pi configuration root. |

CPU, memory, and disk settings take effect through `pi-update`.

## Development

Provisioning is declarative PyInfra code under `vm/pyinfra`. The shell scripts
handle OrbStack lifecycle and launch-time mounts, dependency overlays, and
network policy.

```bash
uv sync
uv run ruff format --check vm/pyinfra
uv run ruff check vm/pyinfra
uv run ty check
```

Key files:

| Path | Purpose |
| --- | --- |
| `bin/pi` | Allocate a project machine and launch Pi. |
| `bin/pi-update` | Create and provision the template. |
| `bin/pi-diff` | Preview provisioning changes. |
| `bin/pi-delete` | Delete the current project/profile's stopped machines. |
| `vm/pyinfra/` | Packages, tools, users, files, and services. |
| `vm/prepare-runtime.sh` | Mount policy and runtime preparation. |
| `vm/network-lockdown.sh` | Egress firewall. |
| `vm/project-dependencies.sh` | Linux-native project dependency installation. |
| `vm/guest-entrypoint.sh` | Guest startup and Pi execution. |
