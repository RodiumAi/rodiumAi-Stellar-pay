#!/usr/bin/env bash
# Hardening checks for a service image (context §16.3): runs as non-root, has no shell,
# starts on a read-only root filesystem (it must reach config validation, which proves
# the module graph loads), and has no package manager.
set -euo pipefail
image="$1"

user=$(docker inspect --format '{{.Config.User}}' "$image")
[[ "$user" == "65532" || "$user" == "nonroot" || "$user" == "65532:65532" ]] \
  || { echo "FAIL: image user is '$user', expected nonroot"; exit 1; }
echo "ok: runs as $user"

uid=$(docker run --rm --read-only --cap-drop ALL --entrypoint /nodejs/bin/node "$image" \
  -e 'process.stdout.write(String(process.getuid()))')
[[ "$uid" == "65532" ]] || { echo "FAIL: uid is $uid"; exit 1; }
echo "ok: uid 65532"

for sh in /bin/sh /bin/bash /bin/ash /busybox/sh; do
  if docker run --rm --entrypoint "$sh" "$image" -c true >/dev/null 2>&1; then
    echo "FAIL: shell present at $sh"; exit 1
  fi
done
echo "ok: no shell"

for pm in /usr/bin/apt /usr/bin/apt-get /usr/bin/dpkg /sbin/apk /usr/local/bin/npm /usr/local/bin/pnpm; do
  if docker run --rm --entrypoint /nodejs/bin/node "$image" \
    -e "process.exit(require('node:fs').existsSync('$pm') ? 0 : 1)" 2>/dev/null; then
    echo "FAIL: $pm present"; exit 1
  fi
done
echo "ok: no package manager"

# With no configuration the service must exit 1 with a config error, not a crash.
set +e
out=$(docker run --rm --read-only --cap-drop ALL --network none "$image" 2>&1)
code=$?
set -e
# "cannot read" means the image itself is broken (e.g. a file outside --allow-fs-read).
if [[ $code -ne 1 || "$out" != *"Invalid configuration"* || "$out" == *"cannot read"* ]]; then
  echo "FAIL: expected a config error on a read-only FS (exit $code):"; echo "$out" | head -20; exit 1
fi
echo "ok: starts read-only and fails closed without configuration"
