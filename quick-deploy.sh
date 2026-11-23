#!/bin/bash
# Quick fix: just restart portal with new image, skip DB
set -e

cd /opt/silkroadai-portal

echo "✓ Code already at 88781857"
echo "✓ Image already built"
echo ""

echo "Restarting Portal (--no-deps)..."
docker compose -f docker-compose.prod.yml up -d --no-deps portal

echo ""
echo "Waiting 5 seconds..."
sleep 5

echo ""
echo "Recent logs:"
docker compose -f docker-compose.prod.yml logs --tail=20 portal

echo ""
echo "Done! Check https://llmroute.club/models"
