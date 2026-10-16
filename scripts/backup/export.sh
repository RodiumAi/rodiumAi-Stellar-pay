#!/bin/sh
# Encrypted logical export of schema `pay` (context §7.6). The plaintext dump never touches
# disk: pg_dump → age → file (or S3). Requires:
#   DATABASE_URL     read-only role (rp_readonly), sslmode=verify-full in staging/production
#   AGE_RECIPIENTS   one or more age public keys (age1…), comma-separated
#   BACKUP_S3_URI    optional, e.g. s3://rodium-pay-backups/staging/ (else writes to OUT_DIR)
set -eu
: "${DATABASE_URL:?}" "${AGE_RECIPIENTS:?}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="pay-${stamp}.dump.age"
out="${OUT_DIR:-/tmp}/${name}"

recipients=""
for r in $(echo "$AGE_RECIPIENTS" | tr ',' ' '); do
  case "$r" in age1*) recipients="$recipients -r $r" ;; *) echo "bad age recipient" >&2; exit 2 ;; esac
done

# shellcheck disable=SC2086 # word splitting of $recipients is intended
pg_dump --dbname="$DATABASE_URL" --schema=pay --format=custom --no-owner --no-privileges \
  | age $recipients -o "$out"

size=$(wc -c < "$out" | tr -d ' ')
[ "$size" -gt 100 ] || { echo "export suspiciously small ($size bytes)" >&2; exit 1; }
sha=$(sha256sum "$out" | cut -d' ' -f1)

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp --only-show-errors "$out" "${BACKUP_S3_URI%/}/${name}" \
    --metadata "sha256=${sha}"
  rm -f "$out"
  echo "{\"event\":\"backup.exported\",\"object\":\"${BACKUP_S3_URI%/}/${name}\",\"bytes\":${size},\"sha256\":\"${sha}\"}"
else
  echo "{\"event\":\"backup.exported\",\"file\":\"${out}\",\"bytes\":${size},\"sha256\":\"${sha}\"}"
fi
