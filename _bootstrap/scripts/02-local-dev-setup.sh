#!/usr/bin/env bash
# Silk Road AI Portal — Mac 本地开发环境一键 setup
# ============================================
#
# 用法:在 fork 根目录(silkroadai/)下执行:
#   bash _bootstrap/scripts/02-local-dev-setup.sh
#
# 这个脚本会:
#   - 检查 Node / pnpm / docker 安装
#   - 启动本地 PostgreSQL (端口 5433,不和系统 PG 冲突)
#   - 准备 .env(从 .env.example 复制 + 填本地默认值)
#   - 提示如何开 SSH 隧道连 VPS LiteLLM

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

# ============================================
# 1. 工具链检查
# ============================================
log "检查 Node.js..."
if ! command -v node &> /dev/null; then
    fail "Node.js 没装,推荐用 nvm 装:curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && nvm install 20"
fi
NODE_VERSION=$(node --version)
ok "Node.js $NODE_VERSION"

log "检查 pnpm..."
if ! command -v pnpm &> /dev/null; then
    log "  pnpm 没装,自动安装..."
    npm install -g pnpm
fi
ok "pnpm $(pnpm --version)"

log "检查 Docker..."
if ! command -v docker &> /dev/null; then
    fail "Docker 没装,去 https://docs.docker.com/desktop/install/mac-install/ 装 Docker Desktop"
fi
docker info > /dev/null 2>&1 || fail "Docker 没运行,请打开 Docker Desktop"
ok "Docker 运行中"

# ============================================
# 2. 启动本地 PostgreSQL(独立容器,不和生产冲突)
# ============================================
log "启动本地 PostgreSQL(端口 5433)..."

if docker ps -a --format '{{.Names}}' | grep -q '^silkroad-portal-pg$'; then
    if docker ps --format '{{.Names}}' | grep -q '^silkroad-portal-pg$'; then
        ok "  容器已运行"
    else
        log "  容器存在但未运行,启动中..."
        docker start silkroad-portal-pg
    fi
else
    docker run -d --name silkroad-portal-pg \
        -e POSTGRES_USER=portal \
        -e POSTGRES_PASSWORD=devpass123 \
        -e POSTGRES_DB=silkroadai_portal_dev \
        -p 5433:5432 \
        postgres:16-alpine
    ok "  容器创建并启动"
fi

# 等 PostgreSQL ready
for i in {1..15}; do
    if docker exec silkroad-portal-pg pg_isready -U portal > /dev/null 2>&1; then
        ok "  PostgreSQL ready"
        break
    fi
    [ $i -eq 15 ] && fail "PostgreSQL 启动超时"
    sleep 1
done

# ============================================
# 3. 准备 .env
# ============================================
sed_inplace() {
    if [ "$(uname)" = "Darwin" ]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

if [ ! -f .env ]; then
    if [ ! -f .env.example ]; then
        fail "找不到 .env.example,先跑 01-rename-project.sh"
    fi
    cp .env.example .env

    sed_inplace 's|DATABASE_URL=.*|DATABASE_URL="postgresql://portal:devpass123@localhost:5433/silkroadai_portal_dev"|' .env
    sed_inplace 's|LITELLM_BASE_URL=.*|LITELLM_BASE_URL="http://localhost:4000"|' .env

    JWT_SECRET=$(openssl rand -hex 32)
    ADMIN_TOK=$(openssl rand -hex 16)
    sed_inplace "s|PORTAL_JWT_SECRET=.*|PORTAL_JWT_SECRET=\"$JWT_SECRET\"|" .env
    sed_inplace "s|ADMIN_TOKEN=.*|ADMIN_TOKEN=\"$ADMIN_TOK\"|" .env

    ok ".env 已创建,本地 PG / JWT / ADMIN_TOKEN 已自动填写"
    warn "你还需要手动填入:LITELLM_MASTER_KEY、SMTP_*、EASY_PAY_*"
else
    ok ".env 已存在,跳过"
fi

# ============================================
# 4. 安装依赖
# ============================================
log "安装 pnpm 依赖..."
pnpm install

# ============================================
# 5. 跑 Prisma migration
# ============================================
log "应用 Prisma migration..."
pnpm prisma generate
if [ -d prisma/migrations ] && [ -n "$(ls prisma/migrations 2>/dev/null)" ]; then
    pnpm prisma migrate deploy
    ok "已应用现有 migration"
else
    warn "还没有 migration 文件 — 等你按 WEEK1 D2 改完 schema 后跑:"
    echo "  pnpm prisma migrate dev --name init_silkroadai_portal"
fi

# ============================================
# 6. 提示
# ============================================
echo ""
echo "======================================================="
echo "✅ 本地开发环境 setup 完成"
echo "======================================================="
echo ""
echo "下一步:"
echo ""
echo "  1. 开 SSH 隧道连接 VPS LiteLLM(新开一个 terminal,保持运行):"
echo "       ssh -L 4000:localhost:4000 -N root@23.27.113.88"
echo ""
echo "  2. 把真实 LITELLM_MASTER_KEY 填进 .env"
echo ""
echo "  3. 启动 dev server:"
echo "       pnpm dev"
echo "       open http://localhost:3002"
echo ""
echo "  4. 数据库 GUI(可选):"
echo "       pnpm prisma studio"
echo ""
echo "  5. 启动 Claude Code:"
echo "       claude"
echo "       # Claude Code 会自动读 CLAUDE.md 加载项目上下文"
echo ""
echo "------------------------------------------------------"
echo "本地资源占用:"
echo "  - PostgreSQL 容器:silkroad-portal-pg (端口 5433)"
echo "  - Next.js dev server:端口 3002"
echo "  - 停止数据库:docker stop silkroad-portal-pg"
echo "  - 完全删除数据库(清数据):docker rm -f silkroad-portal-pg"
echo "------------------------------------------------------"
