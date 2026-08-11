from io import StringIO
from pathlib import Path

from pyinfra import host
from pyinfra.operations import files, pacman, server, systemd

VM_DIR = Path(__file__).resolve().parent.parent

packages = [
    "base-devel",
    "bash",
    "ca-certificates",
    "chromium",
    "curl",
    "docker",
    "docker-buildx",
    "fd",
    "fuse-overlayfs",
    "git",
    "iproute2",
    "iptables-nft",
    "jq",
    "neovim",
    "npm",
    "ripgrep",
    "rootlesskit",
    "rsync",
    "shadow",
    "slirp4netns",
    "sudo",
]

pacman.packages(
    name="Upgrade Arch and install system tools",
    packages=packages,
    update=True,
    upgrade=True,
)

server.user(
    name="Ensure the Pi user has the expected home and shell",
    user="pi",
    home="/home/pi",
    shell="/bin/bash",
    ensure_home=True,
)

files.put(
    name="Configure subordinate user IDs",
    src=StringIO("pi:100000:65536\n"),
    dest="/etc/subuid",
    mode="0644",
)
files.put(
    name="Configure subordinate group IDs",
    src=StringIO("pi:100000:65536\n"),
    dest="/etc/subgid",
    mode="0644",
)
files.file(path="/usr/bin/newuidmap", mode="4755")
files.file(path="/usr/bin/newgidmap", mode="4755")
files.file(
    name="Remove OrbStack passwordless sudo policy",
    path="/etc/sudoers.d/orbstack",
    present=False,
)
server.shell(
    name="Remove Pi from the administrative wheel group",
    commands="if id -nG pi | tr ' ' '\\n' | grep -qx wheel; then gpasswd -d pi wheel; fi",
)

for path, mode in host.loop(
    [
        ("/etc/pi-sandbox", "0755"),
        ("/home/pi/.local/share/docker", "0700"),
        ("/home/pi/.local/state", "0700"),
        ("/home/pi/.pi/agent", "0700"),
        ("/home/pi/.pi/agent/sessions", "0700"),
        ("/home/pi/.config/systemd/user/default.target.wants", "0755"),
        ("/mnt/pi-host", "0700"),
        ("/mnt/pi-launch", "0700"),
        ("/workspace", "0755"),
    ],
):
    files.directory(path=path, user="pi" if path.startswith("/home/pi") else "root", group="pi" if path.startswith("/home/pi") else "root", mode=mode)

# Remove configuration copied by the previous image-style provisioner. Runtime
# clones project selected live host entries here before Pi starts.
for path in host.loop(
    [
        "/home/pi/.pi/agent/bin",
        "/home/pi/.pi/agent/extensions",
        "/home/pi/.pi/agent/git",
        "/home/pi/.pi/agent/npm",
        "/home/pi/.pi/agent/skills",
        "/home/pi/.pi/agent/prompts",
        "/home/pi/.pi/agent/themes",
    ],
):
    files.directory(path=path, present=False)
for name in host.loop(
    [
        "AGENTS.md",
        "APPEND_SYSTEM.md",
        "SYSTEM.md",
        "auth.json",
        "keybindings.json",
        "mcp-cache.json",
        "mcp-npx-cache.json",
        "mcp.json",
        "models-store.json",
        "models.json",
        "oauth.json",
        "settings.json",
        "trust.json",
    ],
):
    files.file(path=f"/home/pi/.pi/agent/{name}", present=False)

managed_files = {
    "network-lockdown.sh": "/usr/local/bin/pi-network-lockdown",
    "prepare-runtime.sh": "/usr/local/bin/pi-prepare-runtime",
    "rootless-dockerd.sh": "/usr/local/bin/pi-rootless-dockerd",
    "guest-entrypoint.sh": "/usr/local/bin/pi-guest",
    "chromium-headless.sh": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "pi-sandbox-prepare.service": "/etc/systemd/system/pi-sandbox-prepare.service",
    "pi-docker.service": "/home/pi/.config/systemd/user/pi-docker.service",
}
for source, destination in host.loop(managed_files.items()):
    is_user_file = destination.startswith("/home/pi")
    files.put(
        src=str(VM_DIR / source),
        dest=destination,
        user="pi" if is_user_file else "root",
        group="pi" if is_user_file else "root",
        mode="0644" if source.endswith(".service") else "0755",
    )

files.put(
    name="Configure rootless Docker runtime directories",
    src=StringIO("d /run/docker 0700 pi pi -\nd /run/containerd 0700 pi pi -\n"),
    dest="/etc/tmpfiles.d/pi-docker.conf",
    mode="0644",
)
server.shell(
    name="Create rootless Docker runtime directories",
    commands="systemd-tmpfiles --create /etc/tmpfiles.d/pi-docker.conf",
)

# Retire the old standalone service; runtime preparation now installs the host
# exception and firewall atomically before Pi is allowed to start.
systemd.service(
    name="Disable the superseded firewall service",
    service="pi-network-lockdown.service",
    running=False,
    enabled=False,
)
files.file(path="/etc/systemd/system/pi-network-lockdown.service", present=False)

systemd.service(
    name="Enable runtime sandbox preparation",
    service="pi-sandbox-prepare.service",
    running=False,
    enabled=True,
    daemon_reload=True,
)

files.link(
    name="Enable the rootless Docker user service",
    path="/home/pi/.config/systemd/user/default.target.wants/pi-docker.service",
    target="../pi-docker.service",
    user="pi",
    group="pi",
)
server.shell(
    name="Enable the Pi user manager at boot",
    commands="loginctl enable-linger pi",
)

# This is the explicit update operation. The persistent template retains all
# package-manager caches, so unchanged tools are not downloaded again.
server.shell(
    name="Install or update mise-managed tools and Pi",
    commands=r"""
set -euo pipefail
runuser -u pi -- env HOME=/home/pi bash -lc '
  set -euo pipefail
  if [[ ! -x "$HOME/.local/bin/mise" ]]; then
    curl --proto "=https" --tlsv1.2 -fsSL https://mise.run | sh
  fi
  export PATH="$HOME/.local/bin:$PATH"
  mise use --global node@latest bun@latest rust@latest uv@latest python@latest
  mise use --global npm:@biomejs/biome@latest
  mise exec node@latest -- npm install -g --ignore-scripts \
    @earendil-works/pi-coding-agent@latest chrome-devtools-mcp@latest
'
""",
)

server.shell(
    name="Reload and start the rootless Docker user service",
    commands="systemctl --user --machine=pi@ daemon-reload && systemctl --user --machine=pi@ restart pi-docker.service",
)
