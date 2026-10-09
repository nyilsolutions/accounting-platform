#!/bin/sh
# The clamd sidecar (ADR 0030). The signature volume starts empty on each task: fill it from the
# signatures in the image, keep them current with freshclam (restarted if it ever stops), and
# run clamd, which reloads them itself (SelfCheck in clamd.conf).
set -eu

db=/var/lib/clamav
if ! ls "$db"/main.c?d >/dev/null 2>&1; then
  cp /usr/local/share/clamav/seed/* "$db/"
fi

(
  while :; do
    freshclam --daemon --foreground --stdout || true
    echo "freshclam stopped; restarting in 60 seconds"
    sleep 60
  done
) &

exec clamd --foreground
