# Silk Road AI — B3 路线项目计划(替代原 LiteLLM Portal 计划)

> 决策日期:2026-05-02
> 决策来源:用户发现 new-api 后,经 Cowork 调研 + Claude Code 评估,确定 B3 路线
> 取代:`litellm-portal-bootstrap/docs/PROJECT-PLAN.md`(归档)

---

## B3 = new-api 后端 + 自写前端 + Chat UI

### 架构

```
              用户访问入口(全部 Silk Road AI 品牌)
                          ↓
        ┌────────────────────────────────────────┐
        │   silkroadai.io      品牌主页(已有)     │
        │   portal.silkroadai.io  客户后台          │← W1 仓库继续用
        │   chat.silkroadai.io   Chat UI(W5 加)  │← fork LibreChat
        │   api.silkroadai.io    OpenAI-compat API │← new-api 暴露的 endpoint
        │   admin.silkroadai.io  内部 admin        │← new-api 自带 UI
        └────────────────────┬───────────────────┘
                             ↓
                    ┌────────────────┐
                    │ new-api(后端)│
                    │ - 100+ 模型路由│
                    │ - 用户/key/积分│
                    │ - 计费/支付    │
                    │ - admin 后台   │
                    └────────┬───────┘
                             ↓
        ┌──────────┬──────────┬─────────┬──────────┐
        ↓          ↓          ↓         ↓          ↓
   sub2api  SiliconFlow  Anthropic  OpenAI    自建 GPU
   (闭源)    (开源)      Direct     Direct    (未来)
```

### 关键设计决策

1. **不修改 new-api 源码**,只用它的 API + Admin GUI 配置 → 不触发 AGPL
2. **silkroadai 仓库继续用**,改造 client.ts 从 LiteLLM 改成 new-api
3. **W1 的代码 70% 可复用**(JWT auth、Prisma user 表概念、易支付集成、订单流程)
4. **Chat UI 选 fork LibreChat**(MIT,清洁度高于 LobeChat)
5. **LiteLLM 暂时保留作 fallback**,W2 D3 验证 new-api 完全可用后才关停

---

## 6 周路线图

### W2:new-api 部署 + portal client 改造(本周开始)

| Day | 任务 | 关键产出 |
|---|---|---|
| **D1** | 部署 new-api 到 VPS,配 admin.silkroadai.io | new-api 跑起来 + admin UI 可访问 |
| **D2** | 在 admin 配置全部上游渠道(sub2api / SiliconFlow / 其他) | 创建一个测试 Token,curl 跑通调用 |
| **D3** | 验证完成,关停 LiteLLM 容器(保留配置 archive) | LiteLLM 容器停 + 配置备份 |
| **D4** | silkroadai 仓库改名 + 调整数据库 schema(LiteLLMKey → NewAPIKey)| migration 通过 |
| **D5** | 重写 src/lib/litellm/client.ts 为 src/lib/newapi/client.ts | 烟雾测试通过 |
| **D6** | 改 register 接口调 new-api 创建 user + key | 端到端注册通 |
| **D7** | tsc 0 错 + 全套 vitest 通过 + push | W2 收尾 commit |

### W3:Auth 完善

| 任务 | 工时 |
|---|---|
| 邮箱验证(注册时发验证邮件,点链接激活)| 1-2 天 |
| 登录接口 / 找回密码 / Reset password | 2 天 |
| Google OAuth(用 new-api 的通用 OIDC 配置)| 0.5 天 |
| GitHub OAuth(用 new-api 原生支持)| 0.5 天 |
| Logout + session refresh | 0.5 天 |

### W4:充值流程 + 客户后台

| 任务 | 工时 |
|---|---|
| 重写 pay/page.tsx → portal-internal 充值页(登录后操作)| 2-3 天 |
| 改 src/lib/order/service.ts paid handler:Sub2API addBalance → new-api topup API | 1-2 天 |
| 充值端到端测试(易支付沙箱 → portal → new-api 余额生效)| 1 天 |
| 客户后台:Key 管理页 / 余额页 / 用量页 | 2 天 |

### W5:Chat UI 集成

| 任务 | 工时 |
|---|---|
| Fork [LibreChat](https://github.com/danny-avila/LibreChat) → silkroadai-chat repo | 0.5 天 |
| 改 LibreChat 配置:后端 endpoint 指向 api.silkroadai.io | 0.5 天 |
| 主题 fork(深空赛博蓝)| 1-2 天 |
| 改 logo / 系统名 / 文案 | 0.5 天 |
| 配 chat.silkroadai.io DNS + Caddy | 0.5 天 |
| 接入 portal 单点登录(用 portal 颁发的 Key 直接登录 chat)| 1-2 天 |

### W6:部署 + 灰度

| 任务 | 工时 |
|---|---|
| 服务条款 / 隐私政策 / 退款政策(模板化生成 + 法律审阅)| 1 天 |
| Sub2API 老站点下线 / 重定向(pay.silkroadai.io → portal.silkroadai.io)| 0.5 天 |
| 错误监控(Sentry 或自建)| 0.5 天 |
| 数据库每日备份 cron | 0.5 天 |
| 第一批 5-10 个种子客户灰度 | 持续 |

---

## 数据库 schema 调整(W2 D4)

### 调整方向:Portal 数据库变薄,大部分余额/spend 信息走 new-api

#### users 表(基本不变)
- 保留 `litellm_user_id` 字段,改名为 **`newapi_user_id`**
- 加字段:`newapi_balance_cache`(从 new-api 拉的余额缓存)
- 加字段:`newapi_balance_cached_at`(缓存时间)

#### litellm_keys 表 → newapi_keys 表
- 重命名表
- 字段调整:
  - `litellm_key` → `newapi_token`(new-api 叫 token)
  - 删除 `max_budget` 字段(在 new-api 那边管,不要双向同步)
  - 删除 `cached_spend`(实时调 new-api 拿)
  - 保留 `key_alias`(client-side label)

#### recharge_logs 表(完全保留)
- 不变,这是 portal 独立的财务审计表
- 加字段:`newapi_quota_added`(new-api 那边对应增加的额度,作冗余审计)

---

## new-api API 调用对照(替代原 LiteLLM client.ts)

| 操作 | LiteLLM API | new-api API |
|---|---|---|
| 创建 user | `POST /user/new` | `POST /api/user/register` |
| 给 user 发 key | `POST /key/generate` | `POST /api/token/` |
| 调高余额 | `POST /key/update` (max_budget) | `POST /api/topup/` (admin 加额度) |
| 查 user 信息 | `GET /user/info` | `GET /api/user/self` |
| 查 token 详情 | `GET /key/info` | `GET /api/token/{id}` |
| 列出 token | `GET /key/list` | `GET /api/token/?p=1` |
| 删 token | `POST /key/delete` | `DELETE /api/token/{id}` |
| 查 spend 日志 | `GET /spend/logs/v2` | `GET /api/log/?p=1&...` |

详细接口在 D5 写 client 时参考 [new-api docs](https://docs.newapi.pro/en/docs)

---

## W1 工作的处理(已完成,不浪费)

| W1 产出 | B3 中的角色 |
|---|---|
| ✅ Next.js 项目骨架 | 继续用作 portal 前端 |
| ✅ Prisma User 表 | 字段微调,继续用 |
| ✅ JWT auth(jwt.ts / session.ts) | 100% 保留 |
| ✅ admin-auth.ts | 100% 保留 |
| ✅ /api/auth/register | 改 client 调用,核心逻辑保留 |
| ✅ Prisma RechargeLog 表 | 100% 保留(财务审计) |
| ✅ 易支付 / wxpay / alipay 集成 | 100% 保留 |
| ⚠️ LiteLLMKey 表 | 改名 + 字段调整(W2 D4) |
| ⚠️ src/lib/litellm/client.ts | 重写为 newapi/client.ts(W2 D5) |
| ❌ src/lib/litellm/__tests__/client.smoke.test.ts | 删,写新的 newapi 烟雾测试 |
| ❌ R3 stub functions | 删(new-api 自己处理订阅) |

70% 可复用,30% 重写。

---

## 部署架构(VPS 23.27.113.88)

```
/opt/
├── new-api/                  ← 新加 ⭐
│   ├── docker-compose.yml
│   ├── data/                  (new-api 配置)
│   ├── pg-data/               (PostgreSQL 数据)
│   └── redis-data/
├── litellm/                   ← W2 D3 后停掉(保留配置作 archive)
├── sub2api/                   ← 保留,作为 new-api 的一个 Custom 渠道上游
├── sub2apipay/                ← W4 后下线
└── silkroad-portal/           ← W5 部署(silkroadai 仓库改造后的产物)

DNS / Caddy:
  silkroadai.io        → /var/www/silkroadai/(主页)
  portal.silkroadai.io → :3002 (silkroad-portal)
  chat.silkroadai.io   → :3003 (LibreChat fork) [W5]
  api.silkroadai.io    → :3000 (new-api OpenAI-compat 端口)
  admin.silkroadai.io  → :3000 (new-api admin UI,内部用)
```

注:`api.silkroadai.io` 现在指向 Sub2API,W2 D2 后**改指向 new-api**(因为 new-api 替代了 Sub2API 对外的角色,Sub2API 退到内部)。

---

## 风险和应对

| 风险 | 应对 |
|---|---|
| new-api 升级破坏兼容 | 锁版本到 stable tag,每月只 review 一次升级 |
| AGPL 被律师质疑 | 不改 new-api 源码 = 不触发,法律最稳 |
| Chat UI 流量大,LibreChat 性能问题 | 监控,必要时缓存或扩容 |
| Sub2API 余额管理复杂 | 设大额度 + 监控 cron(W4 任务)|
| Portal 自己维护成本 | 前端 90% 是配置和样式,改动频率低 |

---

## 上线检查清单(W6 前完成)

```
□ new-api admin 密码已 rotate
□ Sub2API admin key 已 rotate
□ Portal JWT secret 已生产化(64 字节强随机)
□ 所有上游渠道在 new-api 配置完成
□ 充值端到端(易支付沙箱)通过
□ 注册 / 登录 / 找回密码全部可用
□ Chat UI 可用 + 模型可调用
□ 客户后台可用(Key / 余额 / 用量 / 充值历史)
□ 服务条款 / 隐私政策 / 退款政策上线
□ 数据库每日备份 cron 在跑
□ Caddy HTTPS 全部正常
□ portal / chat / api / admin 4 个域名都通
□ 错误监控配好(Sentry 或类似)
□ 客服渠道:微信 Globe_Ads
□ 第一批种子客户名单(5-10 人)
```

---

**版本**: 1.0 (B3 路线)
**日期**: 2026-05-02
**取代**: litellm-portal-bootstrap/docs/PROJECT-PLAN.md
