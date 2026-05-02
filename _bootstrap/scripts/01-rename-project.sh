#!/usr/bin/env bash
# Silk Road AI Portal — 项目重命名 + 初始化脚本
# ============================================
# 用法:
#   1. clone 你的 fork 到本地:
#        git clone git@github.com:yexioy/silkroadai.git
#   2. 把 litellm-portal-bootstrap 整个目录拷到 fork 根目录里
#   3. cd silkroadai && bash scripts/01-rename-project.sh
#
# 这个脚本会:
#   - 把 sub2apipay → silkroadai 所有文本替换
#   - 把 src/lib/sub2api/ 目录改名为 src/lib/litellm/
#   - 重写 .env.example
#   - 删除已归档项目的 README banner
#   - 提示下一步动作

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
# 0. 前置检查
# ============================================
log "前置检查..."
[ -f "package.json" ] || fail "未在 fork 根目录(找不到 package.json),请 cd 到 silkroadai/"
grep -q '"name":\s*"sub2apipay"' package.json || warn "package.json 里没找到 sub2apipay 字样,可能已经重命名过"
ok "前置检查通过"

# ============================================
# 1. 文本替换 sub2apipay → silkroadai
# ============================================
log "替换项目名 sub2apipay → silkroadai-portal..."

# Mac 和 Linux 的 sed 行为不同,用兼容写法
# 兼容 BSD sed (Mac) 和 GNU sed (Linux):用一个 wrapper 函数
# Mac sed -i 必须有备份后缀(用 ''),Linux sed -i 不需要
sed_inplace() {
    if [ "$(uname)" = "Darwin" ]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# package.json
sed_inplace 's/"sub2apipay"/"silkroadai-portal"/g' package.json
sed_inplace 's|github.com/touwaeriol/sub2apipay|github.com/yexioy/silkroadai|g' package.json

# docker-compose 文件
for f in docker-compose.yml docker-compose.hub.yml docker-compose.dev.yml docker-compose.override.yml; do
    [ -f "$f" ] && sed_inplace 's/sub2apipay/silkroadai-portal/g' "$f"
done

# Dockerfile
[ -f Dockerfile ] && sed_inplace 's/sub2apipay/silkroadai-portal/g' Dockerfile

# README 替换标题 + 删除归档 banner
if [ -f README.md ]; then
    sed_inplace 's/Sub2ApiPay/Silk Road AI Portal/g' README.md
    sed_inplace 's/sub2apipay/silkroadai-portal/g' README.md
    # 如果文件最上面有 "ARCHIVED" 横幅,提醒手动删
    if head -10 README.md | grep -qi "archived"; then
        warn "README 里有 ARCHIVED 横幅,请手动删除头部 banner"
    fi
fi

ok "项目名替换完成"

# ============================================
# 2. 改 src/lib/sub2api/ → src/lib/litellm/
# ============================================
if [ -d "src/lib/sub2api" ]; then
    log "重命名目录:src/lib/sub2api → src/lib/litellm"
    git mv src/lib/sub2api src/lib/litellm
    ok "目录重命名完成"
else
    warn "src/lib/sub2api 目录不存在,跳过"
fi

# ============================================
# 3. 改 src/app/api/admin/sub2api → litellm
# ============================================
if [ -d "src/app/api/admin/sub2api" ]; then
    log "重命名目录:src/app/api/admin/sub2api → litellm"
    git mv src/app/api/admin/sub2api src/app/api/admin/litellm
    ok "目录重命名完成"
fi

# ============================================
# 4. 替换所有源码里的 import 路径 + 环境变量名
# ============================================
log "替换源码里的 SUB2API_* 环境变量名 + import 路径..."

# 找所有 ts/tsx/js 文件,替换 SUB2API_BASE_URL 和 SUB2API_ADMIN_API_KEY
find src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' \) | while read -r f; do
    sed_inplace 's/SUB2API_BASE_URL/LITELLM_BASE_URL/g' "$f"
    sed_inplace 's/SUB2API_ADMIN_API_KEY/LITELLM_MASTER_KEY/g' "$f"
    sed_inplace 's|@/lib/sub2api|@/lib/litellm|g' "$f"
    sed_inplace 's|/lib/sub2api|/lib/litellm|g' "$f"
done

ok "源码路径 + 环境变量替换完成"

# ============================================
# 5. 重写 .env.example
# ============================================
log "重写 .env.example..."

cat > .env.example <<'EOF'
# ============================================
# Silk Road AI Portal — 环境变量
# ============================================

# 数据库
DATABASE_URL="postgresql://portal:CHANGE_ME@localhost:5432/silkroadai_portal"

# LiteLLM 后端连接(容器内走 http://litellm:4000)
LITELLM_BASE_URL="http://localhost:4000"
LITELLM_MASTER_KEY="sk-master-CHANGE_ME"

# Portal 自己的认证
PORTAL_JWT_SECRET="CHANGE_ME_$(openssl rand -hex 32)"
PORTAL_JWT_EXPIRES="7d"
ADMIN_TOKEN="CHANGE_ME"      # 管理员后门,bypass JWT

# 公开域名
NEXT_PUBLIC_APP_URL="https://portal.silkroadai.io"

# SMTP 邮件(用于注册验证、找回密码)— 复用之前 QQ 邮箱配置
SMTP_HOST="smtp.qq.com"
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER="your_qq_email@qq.com"
SMTP_PASS="your_qq_app_password"
SMTP_FROM="noreply@silkroadai.io"

# 易支付(复用 Sub2ApiPay 已有配置)
PAYMENT_PROVIDERS=easypay
ENABLED_PAYMENT_TYPES=alipay,wxpay
EASY_PAY_PID="CHANGE_ME"
EASY_PAY_PKEY="CHANGE_ME"
EASY_PAY_API_BASE="https://yourepay.com"
EASY_PAY_NOTIFY_URL="https://portal.silkroadai.io/api/easy-pay/notify"
EASY_PAY_RETURN_URL="https://portal.silkroadai.io/pay/result"

# 充值规则
ORDER_TIMEOUT_MINUTES=15
MIN_RECHARGE_AMOUNT=10
MAX_RECHARGE_AMOUNT=1000
MAX_DAILY_RECHARGE_AMOUNT=5000
PRODUCT_NAME="Silk Road AI 余额充值"

# 默认新用户的 Key 配置
DEFAULT_NEW_USER_MAX_BUDGET=0          # 新用户默认 0 余额
DEFAULT_NEW_USER_MODELS=""             # 空 = 所有模型,或逗号分隔指定: "claude-opus-4-7,deepseek-v4-flash"

# 端口
APP_PORT=3002
EOF

ok ".env.example 重写完成"

# ============================================
# 6. 提示下一步
# ============================================
echo ""
echo "======================================================="
echo "✅ 项目重命名完成"
echo "======================================================="
echo ""
echo "下一步:"
echo ""
echo "  1. 拷贝你的 LiteLLM client 第一版代码:"
echo "     cp scripts/../src/lib/litellm/client.ts src/lib/litellm/client.ts"
echo ""
echo "  2. 拷贝新的 Prisma schema(增量,需要手工合并):"
echo "     diff prisma/schema.prisma scripts/../prisma/schema.diff.prisma"
echo ""
echo "  3. 准备 .env 文件:"
echo "     cp .env.example .env"
echo "     # 编辑 .env 填入真实值"
echo ""
echo "  4. 安装依赖 + 跑 migration:"
echo "     pnpm install"
echo "     pnpm prisma migrate dev --name init_silkroadai_portal"
echo ""
echo "  5. 启动 dev server:"
echo "     pnpm dev"
echo ""
echo "  6. commit + push 第一版:"
echo "     git add -A"
echo "     git commit -m 'rename: sub2apipay → silkroadai-portal'"
echo "     git push origin main"
echo ""
