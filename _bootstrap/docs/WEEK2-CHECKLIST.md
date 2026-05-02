# Week 2 Checklist (B3 路线)

> Day-by-day actionable tasks for Claude Code in the silkroadai repo.
> 总目标:portal 从调 LiteLLM 完全切换到调 new-api,端到端注册接口跑通。

---

## ✅ D1-D2 已完成

- D1:new-api 部署到 VPS,admin.silkroadai.io 可访问
- D2:配置上游渠道(sub2api、SiliconFlow 等),测试 token 调用通过

---

## D3:**先不关 LiteLLM**(改顺序),改在本地 portal 准备 B3 切换

### 任务

```bash
cd ~/Documents/silkroadai

# 1. 拷贝 B3 bootstrap 包(替换之前的 _bootstrap)
mv _bootstrap _bootstrap-w1-archive       # 归档 W1 bootstrap
cp -r ~/Documents/"silk road ai"/b3-bootstrap ./_bootstrap

# 2. 创一个新分支做 B3 切换(隔离风险)
git checkout -b feat/b3-newapi-switch

# 3. 看 B3 路线全貌
cat _bootstrap/README.md
cat _bootstrap/docs/PROJECT-PLAN-B3.md
```

**不要现在就改代码**,先把上下文加载完。

---

## D4:数据库 schema 切换

### 任务

```bash
# 1. 先备份当前本地 dev 数据库
docker exec silkroad-portal-pg pg_dump -U portal silkroadai_portal_dev > /tmp/portal-pre-b3.sql

# 2. 看 schema diff
cat _bootstrap/prisma/schema-b3.diff.prisma

# 3. 按注释手动改 prisma/schema.prisma:
#    A. User model:
#       - 删 litellm_user_id 字段
#       - 加 5 个 newapi_* 字段(见 diff 文件)
#       - keys 关系改 LiteLLMKey[] → NewApiToken[]
#    B. LiteLLMKey model → 改名 NewApiToken,字段全部重组
#    C. RechargeLog model:加 newapi_quota_added 和 newapi_user_id
#    D. Order model:key_id 关系换 LiteLLMKey → NewApiToken

# 4. 跑 migration
pnpm prisma migrate dev --name b3_switch_to_newapi

# 5. 验证三张表的新结构
docker exec silkroad-portal-pg psql -U portal -d silkroadai_portal_dev -c "\d users"
docker exec silkroad-portal-pg psql -U portal -d silkroadai_portal_dev -c "\d newapi_tokens"
docker exec silkroad-portal-pg psql -U portal -d silkroadai_portal_dev -c "\d recharge_logs"

# 6. 重新 generate prisma client
pnpm prisma generate

# 7. commit
git add -A
git commit -m "feat(db): switch schema to new-api integration (B3 W2 D4)

- User: drop litellm_user_id, add newapi_user_id/access_token/username/quota_cache
- LiteLLMKey → NewApiToken: field restructure for new-api token model
- RechargeLog: add newapi_quota_added + newapi_user_id audit fields
- Order: key_id relation now points to NewApiToken
"
```

### 验收

- [ ] users 表里有 5 个 newapi_* 字段
- [ ] newapi_tokens 表存在(原 litellm_keys 表删)
- [ ] tsc 检查会有大量错误(预期 — D5 修)

---

## D5:替换 client.ts

### 任务

```bash
# 1. 拷贝 b3-bootstrap 里的 newapi/client.ts 到项目里
mkdir -p src/lib/newapi
cp _bootstrap/src/lib/newapi/client.ts src/lib/newapi/client.ts

# 2. 把老的 src/lib/litellm/ 整个目录归档(不删,留作参考)
git mv src/lib/litellm src/lib/litellm.archive
# 注意:src/lib/litellm/__tests__ 里的测试文件先 .bak 掉,W2 D6 写新测试
find src/lib/litellm.archive -name "*.test.ts" -exec mv {} {}.bak \;

# 3. 更新 .env.example + .env
cat >> .env.example <<EOF

# --- new-api(B3 路线后端)---
NEWAPI_BASE_URL="http://localhost:3000"
NEWAPI_ADMIN_TOKEN="<在 admin.silkroadai.io 后台 → 个人设置 → 系统访问令牌 生成>"
NEWAPI_ADMIN_USER_ID="<admin user 的 int id,通常是 1>"
NEWAPI_QUOTA_PER_USD="500000"
USD_TO_CNY_RATE="7.2"
EOF

# 同样改 .env(本地用 SSH 隧道连 VPS new-api)
# 你需要先在 admin.silkroadai.io 后台:
#   1. 登录(用 deploy 脚本生成的 root 密码)
#   2. 个人设置 → 系统访问令牌 → 生成令牌
#   3. 复制令牌 + 你的 user.id(通常是 1)
#   4. 填到 .env

# 4. 写新的烟雾测试
mkdir -p src/lib/newapi/__tests__
cat > src/lib/newapi/__tests__/client.smoke.test.ts <<'EOF'
import { describe, it, expect } from 'vitest';
import { listAvailableModels, checkNewApiHealth, quotaToUsd, cnyToQuota } from '../client';

describe('new-api client smoke test', () => {
    it('responds to health check', async () => {
        const ok = await checkNewApiHealth();
        expect(ok).toBe(true);
    });

    it('lists available models from VPS new-api', async () => {
        const models = await listAvailableModels();
        expect(models).toBeInstanceOf(Array);
        expect(models.length).toBeGreaterThan(0);
        console.log(`Found ${models.length} models:`, models.slice(0, 10).join(', '));
    });

    it('quota conversion is reversible', () => {
        // 100 RMB → quota → 回算 → 应该 ≈ 100 RMB
        const quota = cnyToQuota(100);
        const usd = quotaToUsd(quota);
        const cny = usd * 7.2;
        expect(Math.abs(cny - 100)).toBeLessThan(0.01);
    });
});
EOF

# 5. 跑烟雾测试(需要 SSH 隧道连 new-api)
# 隧道:ssh -fN -L 3000:localhost:3000 root@23.27.113.88
pnpm vitest run src/lib/newapi/__tests__/client.smoke.test.ts

# 6. commit
git add -A
git commit -m "feat(newapi): add new-api client (W2 D5)

- src/lib/newapi/client.ts: full TypeScript wrapper around new-api admin API
- two-header auth (Authorization + New-Api-User)
- per-customer access_token strategy for token operations
- provisionNewCustomer high-level helper (atomic 6-step flow)
- applyTopup helper using /api/user/manage with action=add_quota
- archive old src/lib/litellm/ directory (kept for reference)
"
```

### 验收

- [ ] 烟雾测试通过(能调通 VPS new-api)
- [ ] 控制台打印能看到 admin 配的渠道里的模型列表

---

## D6:重写注册接口

### 任务

```bash
# 1. 修改 src/app/api/auth/register/route.ts
#    - 从 import { provisionNewCustomer } from '@/lib/litellm/client';
#    - 改成 import { provisionNewCustomer } from '@/lib/newapi/client';
#    - response shape 调整(返回 newapi_user_id 而不是 litellm_user_id)
#    - 数据库写入字段:user.newapi_user_id / newapi_username / newapi_access_token
#                    + NewApiToken { newapi_token_id, newapi_token_value }

# 2. 改单元测试 src/app/api/auth/register/__tests__/route.test.ts
#    - mock @/lib/newapi/client 的 provisionNewCustomer
#    - 期望返回 { newapi_user_id, newapi_token_value }
#    - rollback 路径:provision 失败时,同时:
#      * 删 portal user
#      * 调 deleteUser(newapi_user_id) 清理 new-api 那边的孤儿(如果 user 已创建)

# 3. 跑测试
pnpm vitest run src/app/api/auth/register

# 4. tsc 全局检查
pnpm tsc --noEmit
# 期望:0 errors(可能还有 1-2 个孤立文件 — 那些是订阅相关的 R3 stub,如果还报错,
# 把对应文件里的 import 改成 newapi/client 的 stub 或直接 .bak)

# 5. dev server 端到端测试
pnpm dev &
sleep 5

# 6. curl 注册测试
RESP=$(curl -sX POST http://localhost:3002/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"d6-b3-test@silkroadai.io","password":"test12345","nickname":"D6 B3 Test"}')
echo "$RESP" | python3 -m json.tool

# 7. 验证 portal DB
docker exec silkroad-portal-pg psql -U portal -d silkroadai_portal_dev -c \
  "SELECT id, email, newapi_user_id, newapi_username FROM users WHERE email='d6-b3-test@silkroadai.io';"
docker exec silkroad-portal-pg psql -U portal -d silkroadai_portal_dev -c \
  "SELECT id, key_alias, newapi_token_id, LEFT(newapi_token_value, 15) FROM newapi_tokens;"

# 8. 验证 new-api DB(通过 admin API)
NEWAPI_USER_ID=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['newapi_user_id'])")
source .env
curl -s "http://localhost:3000/api/user/$NEWAPI_USER_ID" \
  -H "Authorization: $NEWAPI_ADMIN_TOKEN" \
  -H "New-Api-User: $NEWAPI_ADMIN_USER_ID" | python3 -m json.tool

# 9. 用拿到的 token 实际调用一次模型(端到端!!)
TOKEN=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['newapi_token_value'])")
curl -sX POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}' \
  | python3 -m json.tool
# 注意:这次大概率会因为 quota=0 被拒(429)— 那就先充点 quota 再测:
# curl -sX POST http://localhost:3000/api/user/manage \
#   -H "Authorization: $NEWAPI_ADMIN_TOKEN" -H "New-Api-User: $NEWAPI_ADMIN_USER_ID" \
#   -H "Content-Type: application/json" \
#   -d "{\"id\":$NEWAPI_USER_ID,\"action\":\"add_quota\",\"mode\":\"add\",\"value\":500000}"
# 加 1 USD 后再 curl 调用应该 200 OK
```

### 验收

- [ ] curl 注册成功 + 返回 newapi_user_id + newapi_token_value
- [ ] portal DB 和 new-api DB 双向一致
- [ ] 拿到的 token 加 quota 后能真实调用 deepseek-v4-flash
- [ ] 单测全部 pass
- [ ] tsc 0 errors

---

## D7:收尾 + push + 计划 W3

### 任务

```bash
# 1. 删测试用户(避免污染 dev DB)
docker exec silkroad-portal-pg psql -U portal -d silkroadai_portal_dev -c \
  "DELETE FROM users WHERE email='d6-b3-test@silkroadai.io';"
# new-api 那边的 user 也删
source .env
NEWAPI_USER_ID=<从前面记录拿>
curl -sX DELETE "http://localhost:3000/api/user/$NEWAPI_USER_ID" \
  -H "Authorization: $NEWAPI_ADMIN_TOKEN" -H "New-Api-User: $NEWAPI_ADMIN_USER_ID"

# 2. 用新的 README 替换 silkroadai 的 README.md
cp _bootstrap/docs/SILKROADAI-README-NEW.md README.md

# 3. 更新 CLAUDE.md
# 在「项目身份」加一句:"现已切换到 B3 路线,后端 = new-api"
# 在「不要做的事」改:"不要尝试调 LiteLLM"
# 在「核心 API 调用」表里换成 new-api 接口
# 在「常用命令」里替换 LITELLM_BASE_URL → NEWAPI_BASE_URL

# 4. 全套测试 + tsc
pnpm vitest run
pnpm tsc --noEmit

# 5. commit + push
git add -A
git commit -m "feat: complete B3 switch (W2 D7) — all auth + register on new-api

- README + CLAUDE.md updated for B3 architecture
- end-to-end: portal register → new-api user/token → real model call
- ready to merge feat/b3-newapi-switch to main
"
git push -u origin feat/b3-newapi-switch

# 6. 在 GitHub 上开一个 PR(可以让 Claude Code 帮你写 PR description)
gh pr create --title "B3 routing: switch portal backend from LiteLLM to new-api" \
  --body "完整改造 W2 D3-D7,详见 _bootstrap/docs/PROJECT-PLAN-B3.md"

# 7. 等用户 review,merge 到 main
```

---

## D7+ 之后(W3 D1)— 关停 LiteLLM(在 VPS 做)

```bash
# 在 VPS:
ssh root@23.27.113.88

# 1. 把 LiteLLM 容器停掉(配置保留)
cd /opt/litellm && docker compose stop

# 2. Caddy 改 api.silkroadai.io 指向 new-api(:3000)
# 编辑 /etc/caddy/Caddyfile,把:
#   api.silkroadai.io {
#       reverse_proxy localhost:8080  ← Sub2API 旧端口
#   }
# 改成:
#   api.silkroadai.io {
#       reverse_proxy localhost:3000  ← new-api 端口
#       request_body { max_size 50MB }
#       encode gzip
#   }
# Sub2API 的入口可以重定向或者下线
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy

# 3. 验证 api.silkroadai.io 现在是 new-api 提供的服务
curl https://api.silkroadai.io/v1/models -H "Authorization: Bearer <你的客户 sk-xxx>"
```

---

## W2 收尾后,你应该有

- ✅ silkroadai repo 里 main 分支已经合并 B3 切换
- ✅ portal 完全用 new-api 后端
- ✅ LiteLLM 已停(配置保留作 archive)
- ✅ api.silkroadai.io 指向 new-api
- ✅ 注册接口端到端跑通,客户能拿到可用的 sk-xxx
- ✅ Sub2API 还在(作为 new-api 的一个 Custom 渠道)

---

## 几个会让你头大的坑(预先警告)

1. **new-api 双 header 认证** — 忘了 New-Api-User 会 401。看 client.ts 里已经处理。
2. **CreateUser 不返回 ID** — 必须 search 反查。`provisionNewCustomer` 已封装。
3. **/api/token/* 是 per-user** — admin 不能给别人创建 token。`provisionNewCustomer` 通过给客户分配独立 access_token 解决。
4. **充值是 add_quota,不是 /topup** — 看 `applyTopup` 实现。
5. **quota 单位是 raw int,不是 USD** — 用 `cnyToQuota` / `quotaToUsd` 转换。
6. **W1 dev DB 里的测试数据会丢** — schema 重构后 LiteLLMKey 表删掉,数据没了。这是 dev 数据,无影响。

---

**版本**: 1.0 (B3 W2)
**生成时间**: 2026-05-02
