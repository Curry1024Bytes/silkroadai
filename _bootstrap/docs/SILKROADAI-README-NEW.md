# Silk Road AI Portal

> **客户层(Customer Portal)** for Silk Road AI - 一个面向开发者的 AI API 聚合平台
>
> 这个仓库是 [silkroadai.io](https://silkroadai.io) 的 portal 前端 + 业务编排层,
> 后端模型路由 / 用户管理 / 计费由 [new-api](https://github.com/QuantumNous/new-api) 提供。

---

## 项目定位

- **portal.silkroadai.io** — 客户登录、充值、Key 管理、用量查看
- **chat.silkroadai.io** — 内置 Chat UI(基于 fork 的 LibreChat)
- **api.silkroadai.io** — OpenAI-compatible API 端点(由 new-api 提供)
- **admin.silkroadai.io** — new-api admin 后台(内部使用)

本仓库实现 portal.silkroadai.io。

---

## 技术栈

- **Framework**: Next.js 16 (App Router) + React 19 + TypeScript 5
- **Styling**: TailwindCSS 4(深空赛博蓝主题)
- **Database**: PostgreSQL 16 + Prisma 7
- **Auth**: 自建 JWT (`jose`),bcrypt 密码哈希
- **Backend integration**: new-api Admin API
- **Payments**: easypay(易支付)/ 微信 / 支付宝(via easypay)/ Stripe
- **Test**: Vitest

---

## 历史

本仓库 fork 自 [touwaeriol/sub2apipay](https://github.com/touwaeriol/sub2apipay)(已归档)。
- W1 阶段:实验性走 LiteLLM Portal 路线,完成 7 个 commit(commit hash `22c3866` 至 `6fdc9b1`)
- W1 后:经评估改走 B3 路线(new-api 后端 + 自写前端)
- W2 阶段:迁移 LiteLLM client 到 new-api client,数据库 schema 调整

W1 路线的代码作为 git history 保留,但 main 分支演进为 B3 路线。

---

## 部署架构

```
silkroadai.io 客户(完全 Silk Road AI 品牌)
            ↓
   portal.silkroadai.io ← 本仓库
            ↓
   new-api(部署在同一 VPS,通过容器内网调用)
            ↓
   [Sub2API / SiliconFlow / Anthropic / OpenAI / 自建 GPU]
```

---

## 本地开发

```bash
# 1. clone
git clone git@github.com:yexioy/silkroadai.git
cd silkroadai

# 2. 启动本地 PostgreSQL
docker run -d --name silkroad-portal-pg \
  -e POSTGRES_USER=portal \
  -e POSTGRES_PASSWORD=devpass123 \
  -e POSTGRES_DB=silkroadai_portal_dev \
  -p 5433:5432 \
  postgres:16-alpine

# 3. 配 .env(看 .env.example)
cp .env.example .env
# 关键:NEWAPI_BASE_URL + NEWAPI_ADMIN_TOKEN
# - NEWAPI_BASE_URL:VPS 上 new-api 的内网地址(本地通过 SSH 隧道连)
# - NEWAPI_ADMIN_TOKEN:在 new-api admin 后台创建的 admin token

# 4. SSH 隧道连 VPS new-api
ssh -fN -L 3000:localhost:3000 -o ServerAliveInterval=60 root@23.27.113.88

# 5. 安装依赖
pnpm install

# 6. 跑 migration
pnpm prisma migrate dev

# 7. 启动 dev server
pnpm dev
# 打开 http://localhost:3002
```

---

## 关键 API 调用

Portal 调 new-api 的所有调用封装在 `src/lib/newapi/client.ts`。
关键操作:

| 客户操作 | Portal 内部逻辑 | new-api API |
|---|---|---|
| 注册 | 创建 portal user → 调 new-api 创建 user → 创建 token | `POST /api/user/register` + `POST /api/token/` |
| 登录 | 验证 portal user → 签发 JWT cookie | (不调 new-api,本地 auth) |
| 充值 | 易支付通知 → portal 记账 → 调 new-api 加额度 | `POST /api/topup/` |
| 看余额 | 调 new-api 查 user 余额 | `GET /api/user/self` |
| 看用量 | 调 new-api 查 logs | `GET /api/log/` |

---

## 项目状态

参见 [CLAUDE.md](CLAUDE.md) 的「当前进度」区域。

---

## License

MIT
