#!/usr/bin/env bash
set -euo pipefail

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
export DOCKERD_ROOTLESS_ROOTLESSKIT_NET="${DOCKERD_ROOTLESS_ROOTLESSKIT_NET:-slirp4netns}"

rm -f /run/pi-docker/docker.sock
rm -rf "$XDG_RUNTIME_DIR/dockerd" "$XDG_RUNTIME_DIR/containerd"

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
