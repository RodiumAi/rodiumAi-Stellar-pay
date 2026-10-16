#!/bin/sh
# Restores an age-encrypted export into a database (docs/runbooks/database-restore.md).
#   restore.sh <file.dump.age> — needs AGE_IDENTITY_FILE (private key) and TARGET_DATABASE_URL.
# The target must have the roles from infra/supabase/bootstrap-roles.sql and no `pay`
# schema yet; grants are re-applied from packages/db/migrations/0002_grants.sql afterwards.
set -eu
file="${1:?usage: restore.sh <file.dump.age>}"
: "${AGE_IDENTITY_FILE:?}" "${TARGET_DATABASE_URL:?}"
age -d -i "$AGE_IDENTITY_FILE" "$file" \
  | pg_restore --dbname="$TARGET_DATABASE_URL" --no-owner --no-privileges --exit-on-error
echo "{\"event\":\"backup.restored\",\"file\":\"${file}\"}"
