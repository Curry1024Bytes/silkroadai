#!/bin/bash
set -euo pipefail

REPO="Curry1024Bytes/silkroadai"
EXPECTED_SHA="4854d970857be43976e190b104f01afdb95675f6"

echo "=== Deploying debug version to production ==="
echo "Expected commit: $EXPECTED_SHA"
echo

# 1. Find the workflow run for this commit
echo "Searching for workflow run..."
RUN_ID=$(gh run list --repo "$REPO" --commit "$EXPECTED_SHA" --limit 1 --json databaseId --jq '.[0].databaseId')
if [ -z "$RUN_ID" ]; then
    echo "ERROR: No workflow run found for commit $EXPECTED_SHA"
    exit 1
fi
echo "Found run ID: $RUN_ID"

# 2. Download artifact
echo
echo "Downloading artifact..."
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"
gh run download "$RUN_ID" --repo "$REPO" --name llmroute-portal-linux-amd64

# 3. Verify checksums
echo
echo "Verifying checksums..."
shasum -c SHA256SUMS || { echo "ERROR: Checksum verification failed"; exit 1; }
echo "✓ Checksums verified"

# 4. Verify source SHA
ACTUAL_SHA=$(cat SOURCE_SHA.txt)
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "ERROR: Source SHA mismatch. Expected $EXPECTED_SHA, got $ACTUAL_SHA"
    exit 1
fi
echo "✓ Source SHA verified: $ACTUAL_SHA"

# 5. Upload to VPS
echo
echo "Uploading to VPS..."
scp llmroute-portal-linux-amd64.tar llmroute-prod:/tmp/
scp SHA256SUMS SOURCE_SHA.txt IMAGE_ID.txt llmroute-prod:/tmp/

# 6. Deploy on VPS
echo
echo "Deploying on VPS..."
ssh llmroute-prod 'bash -s' << 'REMOTE_SCRIPT'
set -euo pipefail
cd /opt/silkroadai-portal

# Tag current image for rollback
CURRENT_IMAGE=$(docker compose -f docker-compose.prod.yml images -q portal)
if [ -n "$CURRENT_IMAGE" ]; then
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    docker tag "$CURRENT_IMAGE" "llmroute-portal:rollback_$TIMESTAMP"
    echo "✓ Tagged rollback image: llmroute-portal:rollback_$TIMESTAMP"
fi

# Load new image
echo "Loading new image..."
docker load -i /tmp/llmroute-portal-linux-amd64.tar

# Restart portal service
echo "Restarting portal..."
docker compose -f docker-compose.prod.yml up -d portal

# Wait for startup
echo "Waiting for portal to start..."
sleep 5

# Check health
echo "Checking container status..."
docker compose -f docker-compose.prod.yml ps portal

echo "✓ Deployment completed"
REMOTE_SCRIPT

# 7. Monitor logs for the validation error
echo
echo "=== Monitoring logs for validation errors ==="
echo "Waiting 10 seconds for startup..."
sleep 10
echo "Fetching recent logs..."
ssh llmroute-prod 'docker logs --tail 100 silkroadai-portal 2>&1 | grep -A 10 "parseTieredPricingDetails\|Invalid tiered pricing" || echo "(No validation errors found yet)"'

echo
echo "=== Deployment complete ==="
echo "Now trigger the error by visiting:"
echo "  https://llmroute.club/portal/models"
echo
echo "Then check logs with:"
echo "  ssh llmroute-prod 'docker logs silkroadai-portal 2>&1 | grep -A 20 parseTieredPricingDetails'"
