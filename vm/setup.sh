#!/usr/bin/env bash
set -euo pipefail

# Run as root in a newly-created Arch ARM64 OrbStack machine.
pacman -Syu --noconfirm
pacman -S --noconfirm --needed \
  base-devel bash ca-certificates chromium curl docker docker-buildx fd \
  fuse-overlayfs git iproute2 iptables-nft jq neovim npm ripgrep rootlesskit \
  rsync shadow slirp4netns sudo
printf 'y\ny\n' | pacman -Scc --noconfirm

id pi >/dev/null
printf 'pi:100000:65536\n' >/etc/subuid
printf 'pi:100000:65536\n' >/etc/subgid
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap
install -d -o pi -g pi -m 0700 /home/pi/.local/share/docker /home/pi/.local/state
install -d -o pi -g pi -m 0755 /home/pi/.pi/agent /workspace
install -d -m 0755 /etc/pi-sandbox
: >/etc/pi-sandbox/host-ip
cat >/etc/tmpfiles.d/pi-docker.conf <<'EOF'
d /run/docker 0700 pi pi -
d /run/containerd 0700 pi pi -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/pi-docker.conf

install -m 0755 /home/pi/pi-vm/network-lockdown.sh /usr/local/bin/pi-network-lockdown
install -m 0755 /home/pi/pi-vm/rootless-dockerd.sh /usr/local/bin/pi-rootless-dockerd
install -m 0755 /home/pi/pi-vm/guest-entrypoint.sh /usr/local/bin/pi-guest

cat >/etc/systemd/system/pi-network-lockdown.service <<'EOF'
[Unit]
Description=Pi sandbox egress policy
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/pi-network-lockdown
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl enable pi-network-lockdown.service

install -d -o pi -g pi -m 0755 /home/pi/.config/systemd/user/default.target.wants
cat >/home/pi/.config/systemd/user/pi-docker.service <<'EOF'
[Unit]
Description=Rootless Docker for Pi
After=network.target

[Service]
Environment=HOME=/home/pi
ExecStart=/usr/local/bin/pi-rootless-dockerd
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
EOF
chown -R pi:pi /home/pi/.config
ln -s ../pi-docker.service /home/pi/.config/systemd/user/default.target.wants/pi-docker.service
loginctl enable-linger pi

# OrbStack grants its default user passwordless sudo. Pi deliberately has no
# administrative path; the macOS launcher can still use `orb -u root`.
rm -f /etc/sudoers.d/orbstack
gpasswd -d pi wheel 2>/dev/null || true

# Package installation and pushed provisioning files may create intermediate
# home directories as root; hand the complete home back before user installs.
chown -R pi:pi /home/pi

# Install current language runtimes and Pi as the unprivileged user. Rebuilding
# the template is the explicit update operation; startup performs no tool installs.
runuser -u pi -- env HOME=/home/pi bash -lc '
  set -euo pipefail
  curl --proto "=https" --tlsv1.2 -fsSL https://mise.run | sh
  export PATH="$HOME/.local/bin:$PATH"
  mise use --global node@latest bun@latest rust@latest uv@latest python@latest
  mise use --global npm:@biomejs/biome@latest
  mise exec node@latest -- npm install -g --ignore-scripts \
    @earendil-works/pi-coding-agent chrome-devtools-mcp
'

# The checked-in browser skill expects Chrome's macOS path.
install -d "/Applications/Google Chrome.app/Contents/MacOS"
cat >"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" <<'EOF'
#!/bin/sh
exec /usr/bin/chromium --headless=new --no-sandbox --disable-dev-shm-usage "$@"
EOF
chmod 0755 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

chown -R pi:pi /home/pi
rm -rf /home/pi/pi-vm
