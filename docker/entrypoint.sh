#!/usr/bin/env bash
set -euo pipefail

/usr/local/bin/pi-network-lockdown
install -d -o pi -g pi -m 0700 /run/user/1000

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
