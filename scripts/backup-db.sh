#!/bin/bash
#
# Daily Postgres backup for silkroadai-portal (W5 D4).
#
# Crontab entry on VPS:
#   0 2 * * * /opt/silkroadai-portal/scripts/backup-db.sh \
#             >> /var/log/silkroadai-portal-backup.log 2>&1
#
# Behavior:
#   - pg_dump from inside the silkroadai-portal-db container, gzip, store
#     under /opt/backups/silkroadai-portal/portal-YYYYMMDD-HHMMSS.sql.gz
#   - prune backups older than 7 days
#   - log a status line so the cron log is parseable
#
# Restore reference (manual):
#   gunzip < portal-XXX.sql.gz | docker exec -i silkroadai-portal-db \
#       psql -U portal silkroadai_portal_prod
#
# W6 will swap this for an off-host destination (S3 / B2).

set -euo pipefail

TS=$(date -u +%Y%m%d-%H%M%S)
BACKUP_DIR=/opt/backups/silkroadai-portal
RETENTION_DAYS=7
DB_CONTAINER=silkroadai-portal-db
DB_USER=portal
DB_NAME=silkroadai_portal_prod

mkdir -p "$BACKUP_DIR"

OUT="$BACKUP_DIR/portal-$TS.sql.gz"

# pg_dump → gzip pipeline. Errors at any stage propagate via pipefail.
docker exec -t "$DB_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" \
    | gzip -9 > "$OUT"

SIZE=$(du -h "$OUT" | awk '{print $1}')
echo "[$TS] backup complete: $OUT ($SIZE)"

# Prune anything older than $RETENTION_DAYS days. -mtime +7 = strictly older.
PRUNED=$(find "$BACKUP_DIR" -name "portal-*.sql.gz" -mtime "+$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
if [ "$PRUNED" -gt 0 ]; then
    echo "[$TS] pruned $PRUNED file(s) older than ${RETENTION_DAYS}d"
fi
