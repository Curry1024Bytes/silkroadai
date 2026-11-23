#!/bin/bash
set -e

echo "=== Phase 2 Agent Pricing Deployment Script ==="
echo "Target: 103.240.199.146 (llmroute-prod)"
echo "Commit: 31056663 (remove debug test file)"
echo ""

cd /opt/silkroadai-portal

echo "Step 1: Pull latest code from prod..."
git fetch origin
git reset --hard origin/prod
echo "✓ Code updated to $(git log --oneline -1)"
echo ""

echo "Step 2: Build Portal container..."
docker compose -f docker-compose.prod.yml build portal
echo "✓ Build completed"
echo ""

echo "Step 3: Restart Portal service..."
docker compose -f docker-compose.prod.yml up -d portal
echo "✓ Container restarted"
echo ""

echo "Step 4: Wait for startup and check logs..."
sleep 5
docker compose -f docker-compose.prod.yml logs --tail=50 portal
echo ""

echo "Step 5: Verify service health..."
curl -I http://127.0.0.1:3002/ || echo "Warning: Health check failed"
echo ""

echo "=== Deployment Complete ==="
echo "Next steps:"
echo "1. Check logs: docker compose -f docker-compose.prod.yml logs -f portal"
echo "2. Verify public access: curl -I https://llmroute.club/admin/pricing"
echo "3. Test Phase 2 UI at: https://llmroute.club/admin/pricing"
