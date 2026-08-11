# Sandboxed Pi

This repository is the configuration and launcher for running [Pi](https://pi.dev)
in a local Docker sandbox. It is designed for macOS with OrbStack, but the
launcher only requires a Docker-compatible CLI and a host that supports the
listed `docker run` security options.

The sandbox is intentionally useful rather than air-gapped: Pi can edit the
current project and access public Internet services, but it does not receive
the host's home directory, Docker socket, Pi credentials, or private-network
access. Docker-in-Docker (DinD) is available only when explicitly requested.

## Commands

Run these from the project Pi should work on:

```bash
# Rebuild after changing Dockerfile, agent configuration, or docker scripts.
~/.pi/agent/bin/pi-rebuild

# Normal sandbox: no nested Docker daemon is started.
~/.pi/agent/bin/pi

# Opt-in nested, rootless Docker for a task that needs `docker`.
~/.pi/agent/bin/pi-dind
```

The image defaults to the pinned official Arch Linux **amd64** manifest. The
official image has no ARM64 variant, so Apple Silicon runs this image under
emulation. Override the image/platform together only when testing a compatible
alternative:

```bash
PI_DOCKER_IMAGE=my-image PI_DOCKER_PLATFORM=linux/arm64 ~/.pi/agent/bin/pi
```

## Architecture

```text
host project directory
        │ bind mount at /workspace
        ▼
Pi agent container ────── default `pi`
  ├─ Pi runs as uid 1000 (`pi`) with all capabilities dropped
  ├─ outbound private/LAN ranges rejected by iptables/nftables
  ├─ project-local sessions and Pi state in named Docker volumes
  └─ optional socket mount
        │
        ▼
rootless daemon container ────── only `pi-dind`
  └─ RootlessKit → rootless dockerd → nested containers
```

`agent/bin/pi` is the common launcher. `agent/bin/pi-dind` is only a tiny
wrapper that sets `PI_ENABLE_DIND=1`, so the two modes cannot drift.

## Files and responsibilities

| Path | Responsibility |
| --- | --- |
| `docker/Dockerfile` | Pinned Arch base, Pi/tool installation, non-secret baked configuration, and runtime filesystem layout. |
| `agent/bin/pi` | Creates the agent sandbox, applies resource/security limits, mounts project/state, and optionally starts DinD. |
| `agent/bin/pi-dind` | Enables the optional DinD branch in the common launcher. |
| `agent/bin/pi-rebuild` | Builds `pi-sandbox` using the same image/platform defaults as the launcher. |
| `docker/entrypoint.sh` | Installs egress filtering while permitted, then starts Pi as unprivileged `pi` with capabilities dropped. |
| `docker/network-lockdown.sh` | Allows loopback, configured DNS, public Internet, and exact host LAN addresses; rejects private/link-local/multicast/reserved ranges. |
| `docker/dockerd-entrypoint.sh` | Starts the isolated rootless Docker daemon used by `pi-dind`. |
| `agent/mcp.json` | Chrome DevTools MCP server configuration for the container's Chromium. |
| `.dockerignore` | Prevents credentials, sessions, caches, and local binaries from entering an image layer. |

## Filesystem and state boundaries

The only writable host bind mount is the current working directory at
`/workspace`; edits there intentionally write through to the host. If a Git
repository exists, its `.git` directory is also mounted read-only. This allows
Pi to inspect status, history, and diffs while preventing sandboxed Git from
committing, checking out, rebasing, or altering host metadata.

State is stored in Docker volumes rather than the host Pi directory:

- `pi-agent-sessions-<project hash>` stores conversations for that project.
- `pi-agent-runtime` stores `auth.json` and model metadata behind image-baked
  symlinks.
- In DinD mode only, `pi-agent-docker-<project hash>` stores nested images and
  containers, and `pi-agent-docker-socket-<project hash>` carries its Unix
  socket.

The agent configuration is copied into the image at build time. It is **not**
covered by an anonymous `/home/pi/.pi/agent` volume, which previously hid the
baked files and added startup work. The agent container's writable layer is
ephemeral because Pi creates a `settings.json.lock` next to its configuration;
that layer is discarded when the agent exits.

## Network policy

The firewall is an egress restriction, not an Internet denylist. It permits
public endpoints, which Pi needs for model providers, package installation, and
MCP services. It blocks destinations that can commonly reach host-side or LAN
services:

- IPv4 private, carrier-grade NAT, link-local, benchmarking, multicast, and
  reserved ranges;
- IPv6 unique-local, link-local, and multicast ranges;
- all such traffic except the host's exact non-loopback IPv4 addresses, passed
  by the launcher in `PI_HOST_LAN_IPS`.

The exception is necessary for host Chrome DevTools/LAN services. It is exact
address matching, not a blanket `192.168.0.0/16` or `10.0.0.0/8` allowance.
DNS resolvers from the container's `resolv.conf` are permitted on port 53.

## Optional rootless Docker

Normal `pi` does not start a Docker daemon. `pi-dind` launches a separate,
read-only daemon container with no host Docker socket. It has only the limited
capabilities and `/dev/net/tun` required to set up RootlessKit and its egress
rules; it is never run with `--privileged`.

RootlessKit creates a user and network namespace for `dockerd`. Inside that
namespace, nested-container root maps to the unprivileged `pi` account and its
configured subordinate UID/GID range (`100000:65536`), rather than root on the
host. `newuidmap` and `newgidmap` are setuid helpers that write those permitted
UID/GID mappings; they are required because an ordinary user cannot map
subordinate IDs directly. `slirp4netns` supplies user-mode networking, and the
nested daemon uses the `vfs` storage driver because unprivileged overlay mounts
are unavailable.

The daemon container uses `seccomp=unconfined`, `apparmor=unconfined`, and
`systempaths=unconfined` because RootlessKit needs user-namespace and proc
operations that Docker's standard profiles prohibit. Those are meaningful
relaxations, which is why this path is opt-in and isolated from normal Pi
sessions. They are not equivalent to `--privileged`: all capabilities are
initially dropped and only the small listed set is added, no host Docker socket
is exposed, and the daemon is rootless.

## Browser MCP

`agent/mcp.json` launches `chrome-devtools-mcp` through Bun and points it at
`/usr/bin/chromium`. Chromium runs headlessly with `--no-sandbox` and
`--disable-dev-shm-usage`; Chromium's own sandbox cannot initialize inside the
already capability-restricted Docker container. The surrounding Docker
boundary, non-root Pi process, capability drop, resource limits, and egress
rules remain the security controls.

Bun is called directly rather than through a mise shim so its stdout remains
clean for the MCP stdio protocol. Its transient package cache is mounted as an
executable tmpfs because `bun x` executes downloaded package entrypoints.

## Resource limits and caveats

Both modes set CPU, memory, PID, and tmpfs size limits. The launcher supplies
writable tmpfs locations only where tools require them (`/tmp`, `/run`, browser
configuration/cache, and npm/Bun caches). The agent itself starts with selected
outer-container capabilities so the entrypoint can install firewall rules, then
`setpriv` drops all capabilities and sets `no_new_privs` before Pi runs.

This is defense in depth, not a guarantee against a compromised container
runtime or kernel. In particular, Pi can intentionally modify every file in the
project directory, can reach public Internet services, and `pi-dind` carries a
larger attack surface than normal `pi`. Review MCP servers and Pi packages
before enabling them, and use ordinary `pi` unless nested Docker is required.
