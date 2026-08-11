# Sandboxed Pi

This repository launches Pi in a fresh, isolated OrbStack Arch Linux ARM64
machine. The current project and a policy-controlled projection of the host Pi
configuration are mounted from macOS, Git metadata is remounted read-only,
sessions are kept in a separate profile/project directory, and Pi has rootless
Docker and headless Chromium.

A legacy Docker-on-OrbStack launcher remains available for comparison.

## Quick start

```bash
# Create or incrementally update the persistent stopped template with PyInfra.
~/.pi/agent/bin/pi-rebuild

# From any project: clone the template, run Pi, then delete the clone on exit.
~/.pi/agent/bin/pi
```

Despite its historical name, `pi-rebuild` does not recreate an existing
template. PyInfra converges the persistent machine in place, retaining pacman,
npm, mise, and container caches. It installs current Arch packages; the latest
Node, Bun, Rust, uv, Python, and Biome through mise; Pi; and
`chrome-devtools-mcp`. Run it to update tools or apply changes under
`vm/pyinfra/` and `vm/`. Host Pi configuration is mounted live at runtime and
does not require an update.

Useful overrides:

```bash
PI_VM_PROFILE=work pi                 # separate persistent session namespace
PI_VM_HOST_IP=192.168.1.20 pi         # explicit allowed macOS address
PI_VM_CPUS=6 PI_VM_MEMORY=8G pi-rebuild
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
- the host Pi agent directory at a temporary, hidden projection source;
- a temporary directory containing the one allowed host IP.

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
`--isolate-network`: OrbStack's latter option also blocks host IPs, while Pi
needs one explicit macOS address.

A root-owned firewall permits loopback, configured DNS, public IPv4 Internet,
and exactly `PI_VM_HOST_IP`. It rejects private IPv4, carrier-grade NAT,
link-local, OrbStack's machine network, multicast, and reserved destinations.
IPv6 egress is rejected entirely because globally addressed LAN devices cannot
be distinguished from public IPv6 destinations by prefix. Rootless Docker
traffic exits through an unprivileged RootlessKit process and remains subject
to this outer policy.

The launcher derives the host address from macOS's default interface unless
`PI_VM_HOST_IP` is set. Prefer the explicit setting when VPN routing makes the
default ambiguous.

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
| `agent/bin/pi` | Default OrbStack launcher wrapper. |
| `agent/bin/pi-vm` | Clone lifecycle, selective mounts, host-IP policy, and Pi execution. |
| `agent/bin/pi-rebuild` | Default template-rebuild wrapper. |
| `agent/bin/pi-vm-rebuild` | Creates the template if absent and runs incremental PyInfra convergence. |
| `vm/pyinfra/inventory.py` | Connects PyInfra to the template through OrbStack's built-in SSH server. |
| `vm/pyinfra/deploy.py` | Declarative packages, users, files, services, and explicit tool updates. |
| `vm/prepare-runtime.sh` | Projects live Pi config, protects Git metadata, and applies network policy. |
| `vm/network-lockdown.sh` | Root-owned egress filtering. |
| `vm/rootless-dockerd.sh` | Rootless Docker daemon. |
| `vm/guest-entrypoint.sh` | Waits for runtime policy and Docker, then starts Pi in `/workspace`. |
| `agent/mcp.json` | Headless Chromium MCP configuration. |

## Legacy Docker sandbox

The previous container implementation is retained:

```bash
~/.pi/agent/bin/pi-docker-rebuild
~/.pi/agent/bin/pi-docker
~/.pi/agent/bin/pi-dind
```

`pi-docker` runs Pi as uid 1000 with capabilities dropped after installing its
outer firewall. `pi-dind` additionally starts a separate, per-project rootless
Docker daemon without exposing the host Docker socket. The implementation is in
`docker/`, `agent/bin/pi-docker`, and `agent/bin/pi-docker-rebuild`.
