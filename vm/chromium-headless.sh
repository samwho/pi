#!/bin/sh
exec /usr/bin/chromium --headless=new --no-sandbox --disable-dev-shm-usage "$@"
