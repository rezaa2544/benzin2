#!/bin/sh
# Nightly database backup (task G-18).
#
#   ./backup.sh once     # one dump right now (also what the restore drill calls)
#   ./backup.sh loop     # container entrypoint: dump at BACKUP_HOUR every night, forever
#
# A dump is written to a temp name, verified with `pg_restore -l` (a truncated gzip that still
# looks fine is the classic way a backup turns out to be worthless), then moved into place. Old
# copies are pruned after BACKUP_KEEP_DAYS. If BACKUP_RCLONE_REMOTE is set the file is copied to
# that remote too — `rclone copy` is resumable and never deletes on the far side.

set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
HOUR="${BACKUP_HOUR:-3}"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="benzin-${STAMP}.dump"
TMP="${BACKUP_DIR}/.${NAME}.part"

log() { echo "[$(date -Iseconds)] backup: $*"; }

dump_once() {
	mkdir -p "$BACKUP_DIR"
	log "pg_dump -> ${NAME}"
	# -Fc = custom format: compressed, and restorable table-by-table with pg_restore.
	pg_dump --format=custom --compress=9 --no-owner --no-privileges -f "$TMP"
	# Verify the file is a readable archive before it replaces anything.
	if ! pg_restore --list "$TMP" >/dev/null; then
		log "dump is unreadable — keeping the .part file for inspection, not promoting it"
		exit 1
	fi
	mv "$TMP" "${BACKUP_DIR}/${NAME}"
	SIZE="$(du -h "${BACKUP_DIR}/${NAME}" | cut -f1)"
	log "ok ${NAME} (${SIZE})"

	if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
		if command -v rclone >/dev/null 2>&1; then
			log "shipping to ${BACKUP_RCLONE_REMOTE}"
			rclone copy "${BACKUP_DIR}/${NAME}" "${BACKUP_RCLONE_REMOTE}" --config "${RCLONE_CONFIG:-/config/rclone.conf}"
		else
			log "BACKUP_RCLONE_REMOTE is set but rclone is not installed — skipping the offsite copy"
		fi
	fi
}

prune() {
	log "pruning dumps older than ${KEEP_DAYS} days"
	find "$BACKUP_DIR" -name 'benzin-*.dump' -type f -mtime "+${KEEP_DAYS}" -print -delete || true
}

loop() {
	log "starting; nightly at ${HOUR}:00, keeping ${KEEP_DAYS} days"
	while :; do
		NOW_H="$(date +%H)"
		if [ "$NOW_H" = "$(printf '%02d' "$HOUR")" ]; then
			dump_once && prune
			# Sleep past the hour so one night never dumps twice.
			sleep 3600
		else
			sleep 300
		fi
	done
}

case "${1:-loop}" in
once)
	dump_once
	prune
	;;
loop) loop ;;
*)
	echo "usage: $0 [once|loop]" >&2
	exit 64
	;;
esac
