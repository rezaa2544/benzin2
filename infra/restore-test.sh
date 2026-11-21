#!/bin/sh
# Restore drill (task G-18). Answers the only question that matters about a backup:
# *does it come back?*
#
#   docker compose -f infra/docker-compose.prod.yml exec postgres \
#     sh /drills/restore-test.sh /backups/benzin-20260101-030000.dump
#
# It restores the dump into a throwaway database (never into the live one), counts the rows of the
# tables the product cannot lose, and drops the scratch database afterwards. Exit code 0 = a real
# restore was possible, and the numbers are printed so they can go in the runbook.

set -eu

DUMP="${1:-$(ls -t /backups/benzin-*.dump 2>/dev/null | head -1)}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
	echo "usage: $0 <path-to-.dump> (no dump found in /backups)" >&2
	exit 64
fi

SCRATCH="restore_drill_$(date +%s)"
# The dump was taken with --no-owner, so the restoring role has to exist and own the objects.
SUPERUSER="${PGUSER:-benzin}"
PSQL="psql -v ON_ERROR_STOP=1 -U ${SUPERUSER} -d postgres"

echo "==> dump: ${DUMP} ($(du -h "$DUMP" | cut -f1))"
echo "==> scratch database: ${SCRATCH}"

cleanup() { $PSQL -q -c "DROP DATABASE IF EXISTS ${SCRATCH}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

$PSQL -q -c "CREATE DATABASE ${SCRATCH}"
# PostGIS lives in the template databases of this image, but an explicit create keeps the drill
# honest on a plain postgres image too.
psql -v ON_ERROR_STOP=1 -U "$SUPERUSER" -d "$SCRATCH" -q -c 'CREATE EXTENSION IF NOT EXISTS postgis' || true

pg_restore --no-owner --no-privileges --exit-on-error -U "$SUPERUSER" -d "$SCRATCH" "$DUMP"
echo "==> pg_restore finished without errors"

echo "==> row counts (live objects the product cannot lose)"
psql -U "$SUPERUSER" -d "$SCRATCH" -At -F ' ' -c "
	SELECT 'users', count(*) FROM users
	UNION ALL SELECT 'orders', count(*) FROM orders
	UNION ALL SELECT 'reservations', count(*) FROM reservations
	UNION ALL SELECT 'payments', count(*) FROM payments
	UNION ALL SELECT 'plans', count(*) FROM plans
	UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
	ORDER BY 1;"

MIGRATIONS=$(psql -U "$SUPERUSER" -d "$SCRATCH" -At -c "SELECT count(*) FROM drizzle.__drizzle_migrations" 2>/dev/null || echo 0)
echo "==> applied migrations in the dump: ${MIGRATIONS}"

if [ "${MIGRATIONS:-0}" = "0" ]; then
	echo "!! no migration rows — the dump may be from an empty database; check before trusting it" >&2
fi

echo "==> restore drill PASSED (scratch database will be dropped)"
