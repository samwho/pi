#!/usr/bin/env bash
set -euo pipefail

# The outer container starts with the narrow capabilities required to install
# egress rules and create a user namespace. Re-exec as pi before dockerd runs.
if [[ "${1:-}" != "--as-pi" ]]; then
	/usr/local/bin/pi-network-lockdown
	install -d -o pi -g pi -m 0700 /run/containerd /run/docker /run/user/1000
	exec setpriv \
		--reuid=pi \
		--regid=pi \
		--init-groups \
		--inh-caps=-all \
		--ambient-caps=-all \
		--bounding-set=-net_admin \
		"$0" --as-pi
fi

export HOME=/home/pi
export USER=pi
export LOGNAME=pi
export XDG_RUNTIME_DIR=/run/user/1000
export DOCKER_HOST="unix:///run/pi-docker/docker.sock"
# slirp4netns supplies user-mode networking, so nested containers do not gain
# access to the outer container's network namespace.
export DOCKERD_ROOTLESS_ROOTLESSKIT_NET="${DOCKERD_ROOTLESS_ROOTLESSKIT_NET:-slirp4netns}"

# A stale socket or runtime directory would make a restarted daemon unusable.
rm -f /run/pi-docker/docker.sock
rm -rf "$XDG_RUNTIME_DIR/dockerd" "$XDG_RUNTIME_DIR/containerd"

# RootlessKit maps container-root to pi's subordinate IDs and starts dockerd in
# a separate user/network namespace. This avoids a privileged nested daemon.
# slirp4netns owns networking, so dockerd must not alter outer firewall rules.
# Overlay mounts are unavailable to this unprivileged nested daemon; use vfs.
exec rootlesskit \
	--net="$DOCKERD_ROOTLESS_ROOTLESSKIT_NET" \
	--mtu=1500 \
	--disable-host-loopback \
	--port-driver=builtin \
	--copy-up=/etc \
	dockerd \
		--data-root=/home/pi/.local/share/docker \
		--exec-root="$XDG_RUNTIME_DIR/dockerd" \
		--host="$DOCKER_HOST" \
		--iptables=false \
		--ip6tables=false \
		--storage-driver=vfs
