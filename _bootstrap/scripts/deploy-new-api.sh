#!/usr/bin/env bash
# Silk Road AI — 在 VPS 23.27.113.88 上部署 new-api(B3 路线第 1 步)
# ============================================
# 用法:
#   1. scp 这个脚本到 VPS:
#        scp scripts/deploy-new-api.sh root@23.27.113.88:/tmp/
#   2. ssh 上去跑:
#        ssh root@23.27.113.88
#        bash /tmp/deploy-new-api.sh
#
# 这个脚本做这些事:
#   - 创建 /opt/new-api/ 部署目录
#   - 生成 docker-compose.yml(用现有的 PostgreSQL,共用基础设施)
#   - 写 .env(含安全的随机密码)
#   - 启动 new-api 容器
#   - 配置 Caddy 反代 admin.silkroadai.io
#   - 不动现有服务(Sub2API / LiteLLM / Sub2ApiPay 都保留)
#   - 等你登录 new-api 后台后,你手动配置 sub2api / SiliconFlow 等渠道

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${BLUE}==>${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

NEW_API_DIR="/opt/new-api"
NEW_API_PORT="3000"

# ============================================
# 0. 前置检查
# ============================================
log "前置检查..."
[ "$(id -u)" = "0" ] || fail "需要 root 权限运行"
command -v docker >/dev/null || fail "docker 没装"
docker compose version >/dev/null 2>&1 || fail "docker compose 没装"
[ -f /etc/caddy/Caddyfile ] || fail "找不到 Caddy 配置(/etc/caddy/Caddyfile)"

# 端口冲突检查
if ss -tlnp 2>/dev/null | grep -q ":${NEW_API_PORT} "; then
    fail "端口 ${NEW_API_PORT} 已被占用,请改 NEW_API_PORT 变量"
fi
ok "前置检查通过"

# ============================================
# 1. 准备目录
# ============================================
log "创建部署目录 $NEW_API_DIR"
mkdir -p "$NEW_API_DIR"
cd "$NEW_API_DIR"

# ============================================
# 2. 生成密码
# ============================================
log "生成随机密码..."
SESSION_SECRET=$(openssl rand -hex 32)
DB_PASSWORD=$(openssl rand -hex 16)
INITIAL_ROOT_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)

cat > /tmp/new-api-credentials.txt <<EOF
========================================
new-api 部署凭证(立即存到 1Password)
========================================
时间:$(date)
端口:$NEW_API_PORT
URL :https://admin.silkroadai.io

初始管理员账号:root
初始管理员密码:$INITIAL_ROOT_PASSWORD

数据库密码  :$DB_PASSWORD
Session Key:$SESSION_SECRET
========================================
EOF

ok "凭证已写到 /tmp/new-api-credentials.txt — 请立即复制存档"
echo ""
cat /tmp/new-api-credentials.txt
echo ""
read -p "凭证已复制到密码管理器了吗?(yes 回车继续) " confirm
[ "$confirm" = "yes" ] || fail "请复制凭证后再继续"

# ============================================
# 3. 生成 docker-compose.yml
# ============================================
log "生成 docker-compose.yml..."

cat > "$NEW_API_DIR/docker-compose.yml" <<EOF
services:
  new-api:
    image: calciumion/new-api:latest
    container_name: new-api
    restart: unless-stopped
    ports:
      - "${NEW_API_PORT}:3000"
    environment:
      # 数据库:用独立 Postgres(不和 Sub2API/LiteLLM 共用,避免污染)
      SQL_DSN: "postgres://newapi:${DB_PASSWORD}@new-api-db:5432/newapi?sslmode=disable"
      # Redis 缓存
      REDIS_CONN_STRING: "redis://new-api-redis:6379"
      # 加密 / Session
      SESSION_SECRET: "${SESSION_SECRET}"
      # 时区
      TZ: "Asia/Shanghai"
      # 初始管理员密码
      INITIAL_ROOT_TOKEN: ""
      # 错误信息显示给用户(开发期 true,上线 false)
      ERROR_LOG_ENABLED: "true"
      # 流式响应缓冲(改善体验)
      STREAMING_TIMEOUT: "300"
      # 启动时初始管理员密码
      INITIAL_ROOT_KEY: "${INITIAL_ROOT_PASSWORD}"
    volumes:
      - ./data:/data
      - ./logs:/app/logs
    depends_on:
      new-api-db:
        condition: service_healthy
      new-api-redis:
        condition: service_started
    networks:
      - new-api-net

  new-api-db:
    image: postgres:16-alpine
    container_name: new-api-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: newapi
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: newapi
      TZ: "Asia/Shanghai"
    volumes:
      - ./pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U newapi"]
      interval: 5s
      timeout: 5s
      retries: 10
    networks:
      - new-api-net

  new-api-redis:
    image: redis:8-alpine
    container_name: new-api-redis
    restart: unless-stopped
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - ./redis-data:/data
    networks:
      - new-api-net

networks:
  new-api-net:
    driver: bridge
EOF

ok "docker-compose.yml 已生成"

# ============================================
# 4. 启动容器
# ============================================
log "拉取镜像 + 启动容器..."
docker compose pull
docker compose up -d
log "等待 new-api 启动(约 30 秒)..."
sleep 20

# 检查容器状态
for i in 1 2 3 4 5; do
    if docker exec new-api wget -q -O - http://localhost:3000/api/status >/dev/null 2>&1; then
        ok "new-api 已启动并健康"
        break
    fi
    [ $i -eq 5 ] && warn "new-api 启动慢,请稍后用 docker logs new-api 检查"
    sleep 5
done

# ============================================
# 5. 配置 Caddy(admin.silkroadai.io)
# ============================================
log "配置 Caddy admin.silkroadai.io..."

# 检查是否已经有 admin.silkroadai.io
if grep -q "admin.silkroadai.io" /etc/caddy/Caddyfile; then
    warn "Caddyfile 已有 admin.silkroadai.io,跳过(请手动检查配置)"
else
    cat >> /etc/caddy/Caddyfile <<EOF

# new-api 管理后台 — 内部使用,不对客户暴露
admin.silkroadai.io {
    reverse_proxy localhost:${NEW_API_PORT} {
        flush_interval -1
        transport http {
            read_timeout 600s
            write_timeout 600s
        }
    }
    request_body {
        max_size 50MB
    }
    encode gzip
}
EOF

    if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
        systemctl reload caddy
        ok "Caddy 已 reload"
    else
        warn "Caddyfile 验证失败,请手动检查"
        caddy validate --config /etc/caddy/Caddyfile
    fi
fi

# ============================================
# 6. DNS 提醒
# ============================================
echo ""
echo "==========================================="
echo "✅ new-api 部署完成"
echo "==========================================="
echo ""
echo "🔧 你需要手动做的事:"
echo ""
echo "  1. ⚠️ 在 Namecheap 加 DNS A 记录:"
echo "       Type: A"
echo "       Host: admin"
echo "       Value: 23.27.113.88"
echo ""
echo "     等 5-15 分钟 DNS 生效后,Caddy 会自动申请 HTTPS 证书"
echo ""
echo "  2. 浏览器打开 https://admin.silkroadai.io"
echo "       账号:root"
echo "       密码:见 /tmp/new-api-credentials.txt"
echo ""
echo "  3. 登录后立即:"
echo "       - 修改 root 密码(账户设置 → 修改密码)"
echo "       - 系统设置 → 通用设置 → 改系统名为 'Silk Road AI'"
echo "       - 系统设置 → 通用设置 → 上传 logo"
echo ""
echo "  4. 配置渠道(渠道管理 → 添加新的渠道):"
echo "       a. SiliconFlow:类型 = OpenAI,Base URL = https://api.siliconflow.cn,Key = 你的 SF Key"
echo "       b. Sub2API   :类型 = Custom(自定义),Base URL = https://api.silkroadai.io,Key = 你的 Sub2API admin key"
echo "       c. 其他上游(Anthropic / OpenAI / Gemini 等)按需添加"
echo ""
echo "  5. 创建一个测试 Token,curl 测试:"
echo "       curl https://admin.silkroadai.io/v1/chat/completions \\"
echo "         -H 'Authorization: Bearer sk-xxx' \\"
echo "         -H 'Content-Type: application/json' \\"
echo "         -d '{\"model\":\"deepseek-v4-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
echo ""
echo "📂 部署目录:$NEW_API_DIR"
echo "📋 数据目录:$NEW_API_DIR/data, $NEW_API_DIR/pg-data, $NEW_API_DIR/redis-data"
echo "📜 日志查看:docker logs -f new-api"
echo "🔄 重启服务:cd $NEW_API_DIR && docker compose restart"
echo "🛑 完整停止:cd $NEW_API_DIR && docker compose down"
echo ""
echo "💾 备份命令:"
echo "       cd $NEW_API_DIR && tar czf /root/new-api-backup-\$(date +%Y%m%d).tar.gz data pg-data"
echo ""
echo "❌ 完整卸载(删数据):"
echo "       cd $NEW_API_DIR && docker compose down -v && rm -rf $NEW_API_DIR"
echo ""
echo "==========================================="
echo "🚨 安全提醒"
echo "==========================================="
echo ""
echo "  - /tmp/new-api-credentials.txt 包含初始密码,**立即** 存 1Password 后删除"
echo "    rm /tmp/new-api-credentials.txt"
echo ""
echo "  - LiteLLM 还在跑(端口 4000),后续 W2 D3 确认 new-api 完全可用后再关停"
echo "    现在不要动它,留作 fallback"
echo ""
