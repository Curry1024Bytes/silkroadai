#!/usr/bin/env bash
# Keep the current Portal image, one explicit rollback image, the newest
# PostgreSQL dump, and the newest production .env backup.
set -euo pipefail
umask 077

ROLLBACK_TAG=${1:-}
CONTAINER=silkroadai-portal
ENV_DIR=/opt/silkroadai-portal
DB_DIR=/opt/backups/silkroadai-portal

if [[ -z "$ROLLBACK_TAG" ]]; then
    echo "usage: $0 silkroadai-portal-portal:rollback-<timestamp>" >&2
    exit 2
fi

CURRENT_REF=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
CURRENT_ID=$(docker inspect -f '{{.Image}}' "$CONTAINER")
ROLLBACK_ID=$(docker image inspect -f '{{.Id}}' "$ROLLBACK_TAG")
[[ -n "$CURRENT_REF" && -n "$CURRENT_ID" && -n "$ROLLBACK_ID" ]]
test "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" = true

prune_oldest() {
    local directory=$1
    local pattern=$2
    local label=$3
    local pruned=0
    while IFS= read -r old_file; do
        [ -n "$old_file" ] || continue
        rm -f -- "$old_file"
        pruned=$((pruned + 1))
    done < <(
        find "$directory" -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' \
            | sort -nr \
            | sed '1d; s/^[^ ]* //'
    )
    echo "pruned $pruned old $label backup(s); retention=1"
}

prune_oldest "$DB_DIR" 'portal-*.sql.gz' 'database'
prune_oldest "$ENV_DIR" '.env.bak*' 'environment'

# Keep exactly the running image reference and the explicitly named rollback.
removed=0
while IFS=$'\t' read -r repository tag image_id; do
    [ -n "$repository" ] || continue
    ref="$repository:$tag"
    case "$repository" in
        silkroadai-portal-*|llmroute-portal*) ;;
        *) continue ;;
    esac
    if [[ "$ref" == "$CURRENT_REF" || "$ref" == "$ROLLBACK_TAG" ]]; then
        continue
    fi
    docker image rm "$ref" >/dev/null
    removed=$((removed + 1))
done < <(docker image ls --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}')

echo "removed $removed old Portal image tag(s); kept current=$CURRENT_REF rollback=$ROLLBACK_TAG"
echo "running image=$CURRENT_ID rollback image=$ROLLBACK_ID"
