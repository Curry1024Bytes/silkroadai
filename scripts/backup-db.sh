#!/bin/bash
#
# Daily Postgres backup for silkroadai-portal (W5 D4).
#
# Crontab entry on VPS:
#   0 2 * * * /opt/silkroadai-portal/scripts/backup-db.sh \
#             >> /var/log/silkroadai-portal-backup.log 2>&1
#
# Behavior:
#   - pg_dump from inside the silkroadai-portal-db container without a TTY,
#     gzip, validate, and atomically store with mode 0600
#     under /opt/backups/silkroadai-portal/portal-YYYYMMDD-HHMMSS.sql.gz
#   - skip if another backup process already holds the lock
#   - retain only the newest completed backup
#   - log a status line so the cron log is parseable
#
# Restore reference (manual):
#   gunzip < portal-XXX.sql.gz | docker exec -i silkroadai-portal-db \
#       psql -U portal silkroadai_portal_prod
#
# W6 will swap this for an off-host destination (S3 / B2).

set -euo pipefail
umask 077

TS=$(date -u +%Y%m%d-%H%M%S)
BACKUP_DIR=/opt/backups/silkroadai-portal
DB_CONTAINER=silkroadai-portal-db
DB_USER=portal
DB_NAME=silkroadai_portal_prod
LOCK_FILE=/run/lock/silkroadai-portal-backup.lock

mkdir -p "$BACKUP_DIR"

OUT="$BACKUP_DIR/portal-$TS.sql.gz"
TMP="$OUT.tmp"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "[$TS] backup skipped: another backup is already running"
    exit 0
fi

cleanup() {
    rm -f "$TMP"
}
trap cleanup EXIT

# Do not allocate a TTY for dump data; PTYs can transform stream bytes.
# Errors at any stage propagate via pipefail and leave no final backup file.
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" \
    | gzip -9 > "$TMP"
gzip -t "$TMP"
test -s "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$OUT"
trap - EXIT

SIZE=$(du -h "$OUT" | awk '{print $1}')
echo "[$TS] backup complete: $OUT ($SIZE)"

# Keep exactly one completed database backup. The newest file is retained even
# when cron runs more often than expected; older files are removed only after
# the new dump has passed gzip and non-empty checks above.
PRUNED=0
while IFS= read -r old_backup; do
    [ -n "$old_backup" ] || continue
    rm -f -- "$old_backup"
    PRUNED=$((PRUNED + 1))
done < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "portal-*.sql.gz" -printf '%T@ %p\n' \
        | sort -nr \
        | sed '1d; s/^[^ ]* //'
)
if [ "$PRUNED" -gt 0 ]; then
    echo "[$TS] pruned $PRUNED older database backup(s); retention=1"
fi
