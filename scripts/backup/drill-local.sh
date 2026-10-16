#!/usr/bin/env bash
# Local restore drill (context §7.6): export the dev database's `pay` schema with the backup
# image, encrypt to a throwaway age key, decrypt and restore into a scratch database on the
# same server, and compare row counts table by table. Needs `pnpm db:start` and `db:setup`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DB_CONTAINER=supabase_db_rodiumai-stellar-pay
NET=supabase_network_rodiumai-stellar-pay
SRC_DB=${SRC_DB:-rodium_pay_dev}
DRILL_DB=rodium_pay_drill
SUPERUSER_URL="postgresql://postgres:postgres@${DB_CONTAINER}:5432"

docker build -q -f infra/docker/Dockerfile.backup -t rp-backup:dev . >/dev/null
work=$(mktemp -d)
trap 'rm -rf "$work"; docker exec "$DB_CONTAINER" psql -U postgres -qc "DROP DATABASE IF EXISTS $DRILL_DB" >/dev/null' EXIT
chmod 777 "$work"

run() { docker run --rm --network "$NET" -v "$work:/work" "$@"; }

# Throwaway key pair for the drill only.
run --entrypoint age-keygen rp-backup:dev -o /work/key.txt 2>/dev/null
recipient=$(grep -o 'age1[0-9a-z]*' "$work/key.txt")

start=$(date +%s)
run -e DATABASE_URL="$SUPERUSER_URL/$SRC_DB" -e AGE_RECIPIENTS="$recipient" -e OUT_DIR=/work rp-backup:dev
file=$(cd "$work" && ls pay-*.dump.age)
if docker run --rm -v "$work:/work" --entrypoint sh rp-backup:dev -c "grep -q 'CREATE TABLE' /work/$file"; then
  echo "FAIL: export is not encrypted"; exit 1
fi

docker exec "$DB_CONTAINER" psql -U postgres -qc "DROP DATABASE IF EXISTS $DRILL_DB" -c "CREATE DATABASE $DRILL_DB" >/dev/null
run -e AGE_IDENTITY_FILE=/work/key.txt -e TARGET_DATABASE_URL="$SUPERUSER_URL/$DRILL_DB" \
  --entrypoint /usr/local/bin/restore.sh rp-backup:dev "/work/$file"
took=$(( $(date +%s) - start ))

counts() {
  docker exec "$DB_CONTAINER" psql -U postgres -d "$1" -tAc "
    SELECT string_agg(t || '=' || n, ' ' ORDER BY t) FROM (
      SELECT table_name AS t,
        (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM pay.%I', table_name), false, true, '')))[1]::text AS n
      FROM information_schema.tables WHERE table_schema = 'pay' AND table_type = 'BASE TABLE') c"
}
src=$(counts "$SRC_DB"); dst=$(counts "$DRILL_DB")
echo "source:   $src"
echo "restored: $dst"
[[ "$src" == "$dst" && -n "$src" ]] || { echo "FAIL: row counts differ"; exit 1; }
echo "drill ok: $(wc -c < "$work/$file" | tr -d ' ') bytes encrypted, export+restore ${took}s"
