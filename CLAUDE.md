# Silk Road AI Portal — Claude Code Project Context

> 这份文档由 Claude Code 自动加载,作为项目永久上下文。
> 每次启动 `claude` 时都会读取,不需要重复说项目背景。

---

## 项目身份

- **名字**: Silk Road AI Portal (silkroadai-portal)
- **GitHub**: https://github.com/yexioy/silkroadai
- **角色**: LiteLLM 客户层(Customer Portal)
- **来源**: Fork 自 [touwaeriol/sub2apipay](https://github.com/touwaeriol/sub2apipay)(已归档)
- **目标域名**: portal.silkroadai.io

---

## 项目核心定位 — **必读**

这是一个**给 LiteLLM 套客户层**的项目。LiteLLM 本身**一个字不改**,我们只在前面套一层:
- 客户在 portal 注册 / 登录 / 充值 / 拿 API Key / 看用量
- portal 在背后调 LiteLLM Admin API 创建 Virtual Key + 设 max_budget + 拉 spend
- LiteLLM 是模型路由后端,客户感知不到它的存在

**禁止做的事**:
- ❌ 不要建议 fork 或修改 LiteLLM 源码
- ❌ 不要在 portal 里实现"模型路由"逻辑(LiteLLM 已经做了)
- ❌ 不要尝试调 SiliconFlow / Anthropic / OpenAI 上游(走 LiteLLM)

---

## 技术栈

- **Frontend / Backend**: Next.js 16 (App Router) + React 19 + TypeScript 5
- **Styling**: TailwindCSS 4
- **Database**: PostgreSQL 16 + Prisma 7 ORM
- **Auth**: 自建 JWT(`jose` 库),bcrypt 密码哈希
- **Payments**: easypay(易支付,主)/ Alipay / WeChat Pay / Stripe
- **Validation**: Zod
- **Test**: Vitest
- **Package manager**: pnpm
- **Container**: Docker + docker-compose

---

## 目录结构

```
silkroadai/
├── prisma/
│   ├── schema.prisma            ← 数据库 schema(本项目最重要的文件之一)
│   └── migrations/              ← 自动生成的 SQL migration
├── src/
│   ├── app/
│   │   ├── api/                 ← API route handlers
│   │   │   ├── auth/            ← 注册/登录/找回密码(W2)
│   │   │   ├── user/            ← 客户用户信息
│   │   │   ├── orders/          ← 充值订单(从 Sub2ApiPay 继承,几乎不动)
│   │   │   ├── easy-pay/notify/ ← 易支付 callback(几乎不动)
│   │   │   └── admin/           ← 管理员后台 API
│   │   ├── pay/                 ← 支付页面 UI(继承,几乎不动)
│   │   ├── portal/              ← 客户后台 UI(W3 新增)
│   │   └── (auth)/              ← 登录/注册页面 UI(W2 新增)
│   ├── lib/
│   │   ├── litellm/             ← ⭐ LiteLLM client(原 sub2api/)
│   │   │   ├── client.ts        ← 12 个 Admin API 函数封装
│   │   │   └── types.ts
│   │   ├── auth/                ← JWT + session(W1 D4-5 新增)
│   │   ├── easy-pay/            ← 易支付 SDK(继承,不动)
│   │   ├── payment/             ← 支付提供方注册器(继承,不动)
│   │   ├── order/
│   │   │   └── service.ts       ← ⭐ 订单状态机(W2 大改:把 Sub2API 充值改成 LiteLLM update_budget)
│   │   ├── admin-auth.ts        ← 管理员鉴权(W1 D4 改)
│   │   └── prisma.ts            ← Prisma client singleton
│   └── components/              ← React 组件
├── docker-compose.yml           ← 生产部署(VPS 上跑)
├── docker-compose.dev.yml       ← 本地开发
├── .env.example                 ← 环境变量模板
└── _bootstrap/                  ← Claude Code 别动这个目录,这是辅助资源
```

---

## 当前进度(实时更新)

⚠️ **每次 commit 时,如果完成了 WEEK1-CHECKLIST 里的某天,请更新这个区域**

- [x] D1 — 项目重命名 + dev server 跑起来 ✅
- [x] D2 — Prisma schema 完成(User / LiteLLMKey / RechargeLog 三张新表)✅
- [x] D3 — LiteLLM client 烟雾测试通过 ✅
- [ ] D4-5 — 替换 admin-auth + user/route 的 Sub2API 老调用
- [ ] D6-7 — 注册接口端到端跑通

---

## 关键架构决策(决策已定,不要重新讨论)

1. **不 fork LiteLLM** — 套层架构(已分析 fork 维护成本太高)
2. **每客户一 user + 一 key**(模式 X)— 后续可加多 key
3. **portal 维护 User 表 + LiteLLM 维护 user(双向 ID 映射)** — portal 是单一事实源(SSO 这边),LiteLLM 只是计费引擎
4. **充值流 = `max_budget = SUM(recharges)`** — 每次充值后 PUT 累计总值(不是 increment)
5. **使用 PostgreSQL UUID 作为主键** — 不用自增 int
6. **Decimal(12,4) 存余额** — 4 位小数精度,不要用 float

---

## 核心 API 调用(LiteLLM Admin API,全部免费版可用)

| 操作 | 函数 | LiteLLM 端点 |
|---|---|---|
| 注册时建 LiteLLM user | `createUser` | `POST /user/new` |
| 给 user 发 Key | `generateKey` | `POST /key/generate` |
| 充值后调 max_budget | `updateKeyBudget` | `POST /key/update` |
| 查 Key 详情(余额) | `getKeyInfo` | `GET /key/info` |
| 列出 user 的 Key | `listKeys` | `GET /key/list` |
| 删 Key | `deleteKeys` | `POST /key/delete` |
| 退款 reset spend | `resetKeySpend` | `POST /key/{key}/reset_spend` |
| 查用量日志 | `getSpendLogs` | `GET /spend/logs/v2` |

封装在 `src/lib/litellm/client.ts`。看那里就是 source of truth。

---

## 必知技术 gotcha(开发时遇到 90% 是这几个)

### 1. `/key/update` 是替换不是增加
**错**:充值时把 `+=amount` 当成增量发给 LiteLLM。
**对**:Portal 维护 `recharge_logs`,先算 `newMax = SUM(amount)`,然后 PUT 这个总值。

### 2. LiteLLM 缓存 60 秒
充值后 max_budget 不会立刻生效。`updateKeyBudget` 内部已经调了 `getKeyInfo` 强制刷新。如果你写新代码绕过这个封装,记得自己也加。

### 3. 流式请求会小额超支
spend 是 post-flight 记录的,流式请求结束时一次性写入。可能出现 `spend > max_budget` 几个 cents。**UI 显示余额必须 `Math.max(0, max_budget - spend)`**,不要显示负数。

### 4. 退款让 max_budget < spend
退款 → max_budget 减少 → 可能瞬间 max < spend → key 被锁。
**政策**:退款时同时调 `resetKeySpend`,然后把 max_budget 重算。

### 5. 时区全部 UTC
LiteLLM 所有时间字段都是 UTC。客户端展示时再转用户时区,不要把本地时间直接传给 `getSpendLogs`。

### 6. 别用 `user.max_budget`
LiteLLM 同时支持 user-level 和 key-level 预算。我们只用 key-level(更灵活,客户后续可能多 key)。**`user.max_budget` 永远 null**。

---

## 不要做的事(避免误改)

- ❌ 不要改 `src/lib/easy-pay/`、`src/lib/wxpay/`、`src/lib/alipay/`、`src/lib/stripe/` — 支付层是从 Sub2ApiPay 继承的,稳定可靠,改了就要重测全部支付链路
- ❌ 不要改 `src/lib/order/{fee,status,timeout,code-gen,limits}.ts` — 订单工具函数,继承,不动
- ❌ 不要改 `src/app/api/easy-pay/notify/route.ts` 的 webhook 框架 — 只改它内部 `handlePaymentNotify` 调用的下游函数
- ❌ 不要把 LITELLM_MASTER_KEY hardcode 进任何代码,只能在 .env 里
- ❌ 不要在测试里调真实的 LiteLLM API(除了 smoke test),用 mock
- ❌ 不要直接写 SQL,所有数据库操作走 Prisma
- ❌ 不要建议改 LiteLLM 源码

---

## 编码规范

- **TypeScript strict** — 不允许 `any`,用 `unknown` + zod 校验
- **错误处理** — 自定义 Error 类带 status code,别 throw 字符串
- **API route** — 入口先 zod parse,出口 NextResponse.json
- **数据库** — 所有 mutation 走 Prisma transaction(`$transaction`)
- **commit message** — 用 conventional commits:
  - `feat(auth): add login endpoint`
  - `fix(litellm): handle key not found`
  - `chore: update deps`
- **分支** — 主分支 `main`,功能分支 `feat/xxx`

---

## 常用命令

```bash
# 开发
pnpm install
pnpm dev                  # localhost:3002

# 数据库
docker compose -f docker-compose.dev.yml up -d  # 启动本地 postgres
pnpm prisma migrate dev --name <change_desc>    # 新 migration
pnpm prisma studio                              # 开 GUI 查数据
pnpm prisma migrate reset                       # ⚠️ 危险:清库重建

# 测试
pnpm vitest                                     # watch 模式
pnpm vitest run                                 # 单次
pnpm vitest run src/lib/litellm                 # 跑某目录

# Lint + 类型检查
pnpm tsc --noEmit
pnpm lint

# 部署到 VPS(上线后)
git push origin main                            # CI 触发自动部署
# 或手动:
ssh root@23.27.113.88 "cd /opt/silkroad-portal && git pull && docker compose up -d --build"
```

---

## 环境变量速查(`.env`)

最少需要这些才能跑起来:

```bash
DATABASE_URL="postgresql://portal:devpass123@localhost:5433/silkroadai_portal_dev"

LITELLM_BASE_URL="http://localhost:4000"          # 本地用 SSH 隧道转发
LITELLM_MASTER_KEY="sk-master-真实-key"           # 找 .ssh/silkroadai-secrets

PORTAL_JWT_SECRET="本地随便生成 64 字节 hex"
ADMIN_TOKEN="本地随便生成 32 字节 hex"

NEXT_PUBLIC_APP_URL="http://localhost:3002"
APP_PORT=3002
```

完整列表见 `.env.example`。

---

## 项目外部依赖说明

- **LiteLLM**: 部署在 VPS 23.27.113.88:4000,本地通过 SSH 隧道访问
- **Sub2API**: 部署在 VPS,LiteLLM 内部用它转发闭源模型(portal 不直接调)
- **易支付**: 公开网关,需要 PID/KEY,callback 必须公网可达
- **QQ SMTP**: 邮件验证用

---

## 推荐的工作循环

```
1. 看 _bootstrap/docs/WEEK1-CHECKLIST.md 知道今天做什么
2. 起一个 feat/xxx 分支
3. Claude Code 写代码 → 写测试 → 跑测试
4. commit + push
5. 更新本文件「当前进度」区域
6. 下一个任务
```

---

## 遇到事情该问谁

- **战略决策、架构变更、跨服务排查、外部调研** → 用 Cowork(silkroadai-project-memory.md 那个对话)
- **项目内部具体编码、debug、重构、git 操作、跑命令** → 用 Claude Code(就是你)
- **客户跑过来问业务问题** → 用户自己处理(Globe_Ads 微信)

---

**版本**: 1.0
**最后更新**: 2026-05-01
