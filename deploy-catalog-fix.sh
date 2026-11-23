#!/bin/bash
set -e

echo "=== Catalog Loading Fix Deployment ==="
echo "Target: 103.240.199.146 (llmroute-prod)"
echo "Commit: a86fd337 (fix non-tiered_token mode parsing)"
echo ""

cd /opt/silkroadai-portal

echo "Step 1: Pull latest code..."
git fetch origin
git reset --hard origin/prod
echo "✓ Code updated to $(git log --oneline -1)"
echo ""

echo "Step 2: Build Portal container (cached layers, ~3 min)..."
docker compose -f docker-compose.prod.yml build portal
echo "✓ Build completed"
echo ""

echo "Step 3: Restart Portal service..."
docker compose -f docker-compose.prod.yml up -d portal
echo "✓ Container restarted"
echo ""

echo "Step 4: Wait for startup..."
sleep 5
docker compose -f docker-compose.prod.yml logs --tail=30 portal | grep -E "Ready in|loadBrowserCatalog|Invalid tiered" || true
echo ""

echo "Step 5: Verify catalog loads..."
curl -s https://llmroute.club/models | grep -q "模型清单" && echo "✓ Catalog page loads" || echo "⚠ Catalog page check failed"
echo ""

echo "=== Deployment Complete ==="
echo "Next: Visit https://llmroute.club/models to verify model list displays"
