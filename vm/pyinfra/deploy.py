from io import StringIO
from pathlib import Path

from pyinfra.context import host
from pyinfra.facts.server import Users
from pyinfra.operations import files, pacman, server, systemd
from pyinfra.operations.util import any_changed

from operations import mise_npm_packages, mise_tools, user_without_groups

VM_DIR = Path(__file__).resolve().parent.parent
MISE_VERSION = "2026.8.4"
MISE_SHA256 = "9cb1227dd27a11c0895374b8ea4e07fb9ff73c32451267d07f2ae84db07bda0e"

packages = [
    "autoconf",
    "automake",
    "bash",
    "binutils",
    "bison",
    "ca-certificates",
    "chromium",
    "composer",
    "curl",
    "docker",
    "docker-buildx",
    "debugedit",
    "fakeroot",
    "fd",
    "file",
    "findutils",
    "firefox",
    "flex",
    "fuse-overlayfs",
    "gawk",
    "gcc",
    "gettext",
    "git",
    "github-cli",
    "grep",
    "groff",
    "gzip",
    "iproute2",
    "iptables-nft",
    "jq",
    "libtool",
    "m4",
    "make",
    "neovim",
    "patch",
    "php",
    "php-apcu",
    "php-fpm",
    "php-gd",
    "php-imagick",
    "php-pgsql",
    "php-redis",
    "php-sqlite",
    "php-xsl",
    "pkgconf",
    "ripgrep",
    "rootlesskit",
    "rsync",
    "sed",
    "shadow",
    "slirp4netns",
    "texinfo",
    "unzip",
    "which",
    "zip",
]

pacman.packages(
    name="Upgrade Arch and install system tools",
    packages=packages,
    update=True,
    upgrade=True,
)

files.put(
    name="Enable Laravel PHP extensions",
    src=StringIO(
        "; PHP extensions commonly required by Laravel applications.\n"
        "extension=apcu.so\n"
        "apc.enable_cli=1\n"
        "extension=bcmath.so\n"
        "extension=exif.so\n"
        "extension=gd.so\n"
        "extension=igbinary.so\n"
        "extension=imagick.so\n"
        "extension=iconv.so\n"
        "extension=intl.so\n"
        "extension=mysqli.so\n"
        "extension=pdo_mysql.so\n"
        "extension=pdo_pgsql.so\n"
        "extension=pdo_sqlite.so\n"
        "extension=pgsql.so\n"
        "extension=redis.so\n"
        "extension=soap.so\n"
        "extension=sqlite3.so\n"
        "extension=xsl.so\n"
    ),
    dest="/etc/php/conf.d/laravel.ini",
    user="root",
    group="root",
    mode="0644",
)

server.shell(
    name="Install Laravel Cloud CLI",
    commands=[
        "install -d -o pi -g pi -m 0755 /home/pi/.local/bin",
        "if [ ! -x /home/pi/.config/composer/vendor/bin/cloud ]; then "
        "runuser -u pi -- env HOME=/home/pi "
        "COMPOSER_HOME=/home/pi/.config/composer "
        "/usr/bin/composer global require --no-interaction --no-progress "
        "laravel/cloud-cli:^0.5.0; "
        "fi",
        "ln -sfn /home/pi/.config/composer/vendor/bin/cloud /home/pi/.local/bin/cloud",
        "chown -h pi:pi /home/pi/.local/bin/cloud",
    ],
)

server.user(
    name="Configure the unprivileged Pi user",
    user="pi",
    home="/home/pi",
    shell="/bin/bash",
    ensure_home=True,
)
user_without_groups(
    name="Remove Pi from administrative groups",
    user="pi",
    groups=["wheel", "adm"],
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
files.file(
    name="Configure newuidmap permissions",
    path="/usr/bin/newuidmap",
    mode="4755",
)
files.file(
    name="Configure newgidmap permissions",
    path="/usr/bin/newgidmap",
    mode="4755",
)
files.file(
    name="Remove OrbStack passwordless sudo policy",
    path="/etc/sudoers.d/orbstack",
    present=False,
)
pacman.packages(
    name="Remove the base-devel metapackage and sudo",
    packages=["base-devel", "sudo"],
    present=False,
)

for path, owner, mode in host.loop(
    [
        ("/home/pi/.local", "pi", "0700"),
        ("/home/pi/.local/share", "pi", "0700"),
        ("/home/pi/.local/bin", "pi", "0755"),
        # Mise and its Sigstore verifier create state below these directories as pi.
        ("/home/pi/.config/mise", "pi", "0700"),
        ("/home/pi/.local/share/mise", "pi", "0700"),
        ("/home/pi/.cache/mise", "pi", "0700"),
        ("/home/pi/.cache/sigstore-rust", "pi", "0700"),
        # Rootless dockerd adds group execute while running.
        ("/home/pi/.local/share/docker", "pi", "0710"),
        ("/home/pi/.local/state", "pi", "0700"),
        ("/home/pi/.cache", "pi", "0700"),
        ("/home/pi/.cache/pnpm", "pi", "0700"),
        ("/home/pi/.pi/agent", "pi", "0700"),
        ("/home/pi/.pi/agent/npm", "pi", "0700"),
        ("/home/pi/.pi/agent/sessions", "pi", "0700"),
        ("/mnt/pi-deps", "pi", "0700"),
        ("/mnt/pi-host", "root", "0700"),
        ("/mnt/pi-launch", "root", "0700"),
        ("/run/containerd", "pi", "0700"),
        ("/run/docker", "pi", "0700"),
        ("/var/lib/systemd/linger", "root", "0755"),
        ("/workspace", "root", "0755"),
    ],
):
    files.directory(
        name=f"Configure {path}",
        path=path,
        user=owner,
        group=owner,
        mode=mode,
    )

managed_scripts = {
    "network-lockdown.sh": "/usr/local/bin/pi-network-lockdown",
    "prepare-runtime.sh": "/usr/local/bin/pi-prepare-runtime",
    "pi-agent-dependencies.sh": "/usr/local/bin/pi-agent-dependencies",
    "prefetch-mcp.sh": "/usr/local/bin/pi-prefetch-mcp",
    "project-dependencies.sh": "/usr/local/bin/pi-project-dependencies",
    "guest-entrypoint.sh": "/usr/local/bin/pi-guest",
}
for source, destination in host.loop(managed_scripts.items()):
    files.put(
        name=f"Install {Path(destination).name}",
        src=str(VM_DIR / source),
        dest=destination,
        user="root",
        group="root",
        mode="0755",
    )

files.put(
    name="Install the VM MCP configuration",
    src=str(VM_DIR.parent / "agent" / "mcp-linux.json"),
    dest="/home/pi/.pi/agent/mcp.json",
    user="pi",
    group="pi",
    mode="0644",
)

files.put(
    name="Install the VM-specific Pi system prompt",
    src=str(VM_DIR / "SYSTEM.md"),
    dest="/home/pi/.pi/agent/SYSTEM.md",
    user="pi",
    group="pi",
    mode="0644",
)

files.put(
    name="Install the headless Chromium compatibility launcher",
    src=StringIO(
        "#!/bin/sh\n"
        "exec /usr/bin/chromium --headless=new --no-sandbox "
        '--disable-dev-shm-usage "$@"\n'
    ),
    dest="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    user="root",
    group="root",
    mode="0755",
)
prepare_unit = files.put(
    name="Install runtime sandbox preparation service",
    src=str(VM_DIR / "pi-sandbox-prepare.service"),
    dest="/etc/systemd/system/pi-sandbox-prepare.service",
    user="root",
    group="root",
    mode="0644",
)
docker_unit = files.put(
    name="Install rootless Docker user service",
    src=str(VM_DIR / "pi-rootless-docker.service"),
    dest="/home/pi/.config/systemd/user/pi-rootless-docker.service",
    user="pi",
    group="pi",
    mode="0644",
)

files.put(
    name="Configure rootless Docker runtime directories",
    src=StringIO("d /run/docker 0700 pi pi -\nd /run/containerd 0700 pi pi -\n"),
    dest="/etc/tmpfiles.d/pi-docker.conf",
    mode="0644",
)
files.put(
    name="Enable the Pi user manager at boot",
    src=StringIO(""),
    dest="/var/lib/systemd/linger/pi",
    mode="0644",
)

systemd.daemon_reload(
    name="Reload changed system units",
    _if=any_changed(prepare_unit),
)
systemd.service(
    name="Enable runtime sandbox preparation",
    service="pi-sandbox-prepare.service",
    running=False,
    enabled=True,
)

pi_uid = host.get_fact(Users)["pi"]["uid"]
systemd.service(
    name="Start the Pi user manager",
    service=f"user@{pi_uid}.service",
    running=True,
)
systemd.daemon_reload(
    name="Reload changed Pi user units",
    user_mode=True,
    machine="pi@",
    _if=any_changed(docker_unit),
)
systemd.service(
    name="Enable and start rootless Docker",
    service="pi-rootless-docker.service",
    running=True,
    enabled=True,
    user_mode=True,
    machine="pi@",
)
systemd.service(
    name="Restart rootless Docker after unit changes",
    service="pi-rootless-docker.service",
    restarted=True,
    user_mode=True,
    machine="pi@",
    _if=any_changed(docker_unit),
)

# Mise has no built-in pyinfra operation. Install its pinned, checksummed binary,
# then use local fact-driven operations to converge tools and npm packages.
files.download(
    name="Install mise",
    src=f"https://github.com/jdx/mise/releases/download/v{MISE_VERSION}/mise-v{MISE_VERSION}-linux-arm64",
    dest="/home/pi/.local/bin/mise",
    user="pi",
    group="pi",
    mode="0755",
    sha256sum=MISE_SHA256,
)
mise_tools(
    name="Install or update mise-managed tools",
    tools=[
        "node@latest",
        "bun@latest",
        "rust@latest",
        "uv@latest",
        "python@latest",
        "npm:pnpm@latest",
        "npm:@biomejs/biome@latest",
    ],
)
mise_npm_packages(
    name="Install or update Pi and Chrome DevTools MCP",
    packages=[
        "@earendil-works/pi-coding-agent@latest",
        "chrome-devtools-mcp@latest",
    ],
)
server.shell(
    name="Remove Firefox DevTools MCP",
    commands=[
        "runuser -u pi -- env HOME=/home/pi "
        "PATH=/home/pi/.local/share/mise/installs/node/latest/bin:/usr/bin "
        "/home/pi/.local/share/mise/installs/node/latest/bin/npm uninstall --global "
        "@mozilla/firefox-devtools-mcp",
    ],
)
