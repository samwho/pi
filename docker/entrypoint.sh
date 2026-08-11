#!/usr/bin/env bash
set -euo pipefail

# Firewall rules must be installed while the outer container retains NET_ADMIN.
# Pi itself is then deliberately stripped of every capability.
/usr/local/bin/pi-network-lockdown
# Rootless clients (and Chromium) expect an XDG runtime directory owned by pi.
install -d -o pi -g pi -m 0700 /run/user/1000

# Do not rely on Docker's image USER alone: explicitly drop identity and all
# capability sets before starting the agent process.
exec setpriv \
	--reuid=pi \
	--regid=pi \
	--init-groups \
	--inh-caps=-all \
	--ambient-caps=-all \
	--bounding-set=-all \
	--no-new-privs \
	env HOME=/home/pi USER=pi LOGNAME=pi XDG_RUNTIME_DIR=/run/user/1000 \
	/home/pi/.local/share/mise/installs/node/latest/bin/pi "$@"
