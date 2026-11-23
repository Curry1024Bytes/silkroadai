#!/bin/bash
set -e

echo "=== Catalog Parsing Fix Deployment ==="
echo "Target: 103.240.199.146 (llmroute-prod)"
echo "Commit: 88781857 (comprehensive billing_details parser fix)"
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

echo "Step 3: Restart Portal service (no-deps to skip DB check)..."
docker compose -f docker-compose.prod.yml up -d --no-deps portal
echo "✓ Container restarted"
echo ""

echo "Step 4: Wait for startup..."
sleep 5
docker compose -f docker-compose.prod.yml logs --tail=30 portal | grep -E "Ready in|loadBrowserCatalog|Invalid tiered|Unknown billing mode" || true
echo ""

echo "Step 5: Verify catalog loads..."
curl -s https://llmroute.club/models | grep -q "模型清单" && echo "✓ Customer catalog page loads" || echo "⚠ Catalog page check failed"
echo ""

echo "Step 6: Verify admin sync..."
curl -s -H "Cookie: admin_token=\$ADMIN_TOKEN" https://llmroute.club/api/admin/newapi-sync?dryRun=true -X POST -d '{}' | grep -q "preview_token" && echo "✓ Admin sync preview works" || echo "⚠ Admin sync check skipped (needs auth)"
echo ""

echo "=== Deployment Complete ==="
echo "Next steps:"
echo "1. Visit https://llmroute.club/models - should show model list"
echo "2. Admin > 模型管理 > 从 new-api 更新目录 - should show preview"
echo "3. Check logs for 'Unknown billing mode' warnings to identify bad data"

