# Silk Road AI Portal — Claude Code Project Context

> 这份文档由 Claude Code 自动加载,作为项目永久上下文。
> 每次启动 `claude` 时都会读取,不需要重复说项目背景。

---

## 项目身份

- **名字**: Silk Road AI Portal (silkroadai-portal)
- **GitHub**: https://github.com/yexioy/silkroadai
- **角色**: new-api 客户层(Customer Portal)— W2 D3 已切到 B3 路线
- **来源**: Fork 自 [touwaeriol/sub2apipay](https://github.com/touwaeriol/sub2apipay)(已归档)
- **目标域名**: portal.silkroadai.io

---

## 项目核心定位 — **必读**

这是一个**给 new-api 套客户层**的项目。new-api 本身**一个字不改**(AGPL),我们只在前面套一层:
- 客户在 portal 注册 / 登录 / 充值 / 拿 API Key / 看用量
- portal 在背后调 new-api Admin API:创建 user → login as user → rotate access_token → create token → 拿 sk-xxx
- 充值 = 调 `POST /api/user/manage` `add_quota` 给 user(**user.quota 是单点预算门**,token 永远 unlimited_quota)
- new-api 是模型路由后端(117 个模型,跨 SiliconFlow / Anthropic / OpenAI / Sub2API 等),客户感知不到它的存在

**历史**:W1 走 LiteLLM 路线(15 个模型)。W2 D3 用户决定切到 B3:new-api 后端 + 自写前端 + Chat UI。LiteLLM 客户端代码现在保留在 `src/lib/litellm.archive/` 作 W1 参考,`src/lib/litellm/client.ts` 是 thin shim 让老 routes 编译。详见 `_bootstrap/docs/PROJECT-PLAN-B3.md`。

**禁止做的事**:
- ❌ 不要建议 fork 或修改 new-api 源码(AGPL,改了就要开源全部)
- ❌ 不要在 portal 里实现"模型路由"逻辑(new-api 已经做了)
- ❌ 不要尝试调 SiliconFlow / Anthropic / OpenAI 上游(走 new-api)
- ❌ 不要再调 LiteLLM(W3 D1 在 VPS 关停)— 任何 `@/lib/litellm/client` import 都是 R3 stub,不是真后端

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

⚠️ **每次 commit 时,如果完成了 WEEK1-CHECKLIST 或 WEEK2-CHECKLIST 里的某天,请更新这个区域**

### W1(LiteLLM 路线,已归档)
- [x] D1 — 项目重命名 + dev server 跑起来 ✅
- [x] D2 — Prisma schema 完成(User / LiteLLMKey / RechargeLog 三张新表)✅
- [x] D3 — LiteLLM client 烟雾测试通过 ✅
- [x] D4-5 — 替换 admin-auth + user/route 的 Sub2API 老调用 ✅ (R3 决策:订阅 stub,UI 留壳)
- [x] D6-7 — 注册接口端到端跑通 ✅ (W1 完成 🎉)

### W2(B3 路线 — new-api 切换,已合并)
- [x] D1-D2 — VPS 部署 new-api + 配置上游渠道 ✅ (在 VPS 上完成)
- [x] D3 — _bootstrap 切到 B3 包 + 新分支 `feat/b3-newapi-switch` ✅
- [x] D4 — Prisma schema 切到 new-api 集成 ✅ (LiteLLMKey → NewApiToken)
- [x] D5 — `src/lib/newapi/client.ts` + 烟雾测试通过(117 模型) ✅
- [x] D6 — 注册接口切 new-api,端到端跑通(deepseek-v4-flash 真实调用) ✅
- [x] D7 — README + CLAUDE.md 更新 + push + PR ✅
- [x] **W2 PR #1 merged at `6c4b422`(2026-05-02)** 🎉

### W3(Auth 完善 + LiteLLM 关停)
- [x] D1 — VPS 收尾(2026-05-02):LiteLLM 容器停 + Caddy `api.silkroadai.io` 切到 new-api `:3000` + 3 个渠道配齐(SiliconFlow OpenAI / sub2api-claude Anthropic / sub2api-openai OpenAI)+ 117 模型可调 ✅
- [x] D2 — portal e2e 验证 ✅(2026-05-03,见 `docs/W3-D2-VERIFICATION.md`)— 注册 → sk-xxx → 三格式真实模型调用 → 用量回查全链路 200
- [x] D2.5 — SiliconFlow 短名 model_mapping 修复 ✅(2026-05-03,见 `scripts/rebuild-channel-model-mapping.ts` + gotcha #15 修复段)
- [x] D3 — login 端点上线 ✅(2026-05-03,见 `docs/W3-D3-LOGIN-VERIFICATION.md`)— `POST /api/auth/login` cookie session(JWT httpOnly SameSite=Lax 7d)+ apiKey 在 response,timing 防御 + banned 拒绝;6/6 单测 + 4 e2e 状态码全对 + cookie 反解 + apiKey 真打 ai.silkroadai.io 200
- [x] D4 — forgot password + reset password ✅(2026-05-03,见 `docs/W3-D4-FORGOT-PASSWORD-VERIFICATION.md`)— `POST /api/auth/{forgot,reset}-password` + 独立 `PasswordResetToken` 表 + 邮件基础设施 `src/lib/email/*` + JWT `session_token_version` 踢登机制 + `/reset-password` UI 页;14 单测 + 6 jwt 单测 + 7 真实 e2e PASS;SMTP 凭据 F1 已修(SMTP_HOST 配错成个人 QQ 邮箱,改成 `smtp.exmail.qq.com` + verify=true + 真实送达 1226627765@qq.com 收到)
- [x] D5 — register 邮箱验证(soft-block)✅(2026-05-03,见 `docs/W3-D5-EMAIL-VERIFICATION-VERIFICATION.md`)— `POST /api/auth/{verify-email,resend-verification}` + 独立 `EmailVerificationToken` 表 + register 注册时异步发邮件 + `/verify-email?token=` UI 页(自动 POST + StrictMode 防双消)+ User 加 `email_verified_at` 时间戳;同 migration 一并 drop W1 sub2apipay 4 个 stale 字段 + backfill 已有 user 视为已验证;21 新单测 + 6 真实 e2e 步骤 PASS;login 未改,**敏感操作 enforcement 留 W4 客户后台**
- [x] D6 — Google OAuth(OIDC)✅(2026-05-02,见 `docs/W3-D6-GOOGLE-OAUTH-VERIFICATION.md`)— `GET /api/auth/oauth/google/{start,callback}` + 新表 `oauth_accounts(provider, provider_account_id)` unique + `User.password_hash` 改 nullable;DIY with `jose`(零新依赖,不引 `openid-client`);state CSRF + S256 PKCE 双 cookie;5-branch email 冲突策略(login / link-verified / bootstrap-unverified / fresh-signup-with-provision-rollback / sub-conflict);15 单测 PASS,348 全套 PASS,**真实浏览器 smoke 待用户跑**(F4)
- [x] D7 — GitHub OAuth(原生 OAuth2)✅(2026-05-02,见 `docs/W3-D7-GITHUB-OAUTH-VERIFICATION.md`)— `GET /api/auth/oauth/github/{start,callback}` 复用 D6 的 `oauth_accounts` 表(`provider='github'`);**纯 fetch 实现,零新依赖**(没 id_token / 没 PKCE);state CSRF cookie 单守门;email 走 `/user/emails` 挑 `primary && verified`,无则拒;5-branch 冲突逻辑抽出共用 helper `src/lib/auth/oauth/account-link.ts`,GitHub callback 调用之,**Google callback 暂未改造**(D7 brief 不动 google,F1 sweep 留 W4-W5);39 新单测 + 全套 389/390 PASS / **0 fail**;**真实浏览器 smoke 待用户跑**

### W4-1(充值流改造 — portal-internal /pay + new-api add_quota)
- [x] D1 — `executeRecharge` 切 new-api `applyTopup` ✅(2026-05-03)— 删 W1 LiteLLM `createAndRedeem` stub(W3 D6 起会 throw deprecation,导致每个支付成功的 order 都 PAID→FAILED);CAS lock(PAID/FAILED → RECHARGING → COMPLETED)做主 idempotency,RechargeLog `findFirst` by `(order_id, source='payment')` 做二级 dedup(防"上轮 add_quota 成功但 status flip 前 crash");balance_before/after 用 `getUser(newapi_user_id).quota` 读,失败 fallback before+delta;9 新 `execute-recharge.test.ts` PASS
- [x] D2 — `createOrder` + `/api/orders` cookie auth + portal `/pay` `/login` 页 ✅(2026-05-03)— `createOrder` 切 `prisma.user.findUnique`(替 litellm shim getUser);新错误码 `AUTH_REQUIRED` 401 / `USER_NOT_FOUND` 404 / `USER_INACTIVE` 403(banned/disabled);`/api/orders` POST 改 cookie session(`getCurrentUser(req)`)删 `token` 字段;新 `/pay/page.tsx` server component 守门 + `/pay/pay-form.tsx` 5-tier(¥10/30/100/300/1000)+ custom amount + provider radio + window.location 跳网关;新 `/login/page.tsx` + `/login/login-form.tsx` 邮箱密码 + Google + GitHub 三选一(白名单 next 防 open-redirect);W1 1160 行 `/pay/page.tsx` 重命名 `page.legacy.tsx`(Next 自动忽略,留 reference);`src/app/page.tsx` forward 全 query(原仅 lang,影响 OAuth `?oauth_error=` 穿透);20 新单测(create-order auth 5 + /api/orders POST 6 + pay/login UI SSR smoke 9)
- [x] D3 — 集成测 + Google sweep + 易支付 sig alert ✅(2026-05-04,见 `docs/W4-1-RECHARGE-VERIFICATION.md`)— 5 集成测 `recharge-flow.test.ts`(happy / duplicate / defensive dedup / sig fail / applyTopup throw),用 `vi.hoisted()` + 内存 prisma mock + 真签名验证(`generateSign` 测试 pkey);Google callback refactored 改用共用 `linkOrCreateOAuthUser` helper(335→138 行,删 createUserFromGoogle + inline 5-branch),与 GitHub callback 走同一 code path,**D6 全套 15/15 仍 PASS 证明行为等价**;易支付 `verifyNotification` 失败现 `console.warn('[easy-pay/notify] signature verification failed', { instId, out_trade_no, pid, signPrefix })` + body `'success'`(silent ignore + ops 信号,W6 接 Sentry);全套 vitest **43 files / 423 PASS / 1 skip / 0 fail**;**真实易支付沙箱 ¥10 smoke 待用户跑**

---

## 关键架构决策(决策已定,不要重新讨论)

1. **不 fork LiteLLM** — 套层架构(已分析 fork 维护成本太高)
2. **每客户一 user + 一 key**(模式 X)— 后续可加多 key
3. **portal 维护 User 表 + LiteLLM 维护 user(双向 ID 映射)** — portal 是单一事实源(SSO 这边),LiteLLM 只是计费引擎
4. **充值流 = `max_budget = SUM(recharges)`** — 每次充值后 PUT 累计总值(不是 increment)
5. **使用 PostgreSQL UUID 作为主键** — 不用自增 int
6. **Decimal(12,4) 存余额** — 4 位小数精度,不要用 float

---

## 核心 API 调用(new-api Admin API)

| 操作 | 函数 | new-api 端点 |
|---|---|---|
| 注册时建 new-api user(admin) | `createUser` | `POST /api/user/` |
| 反查 user / 拿登录 cookie | `loginAsUser`(内部) | `POST /api/user/login` |
| Rotate 出客户 access_token | (用 cookie 调 call) | `GET /api/user/token` ⚠️ **是 rotate 不是 read** |
| 给 user 创建 token | `createTokenForCustomer` | `POST /api/token/` (act-as customer) |
| 拿 token 真实 key | `getTokenKey` | `POST /api/token/{id}/key` (返回 `{key:"sk-..."}`) |
| 列出客户的 tokens | `listTokensForCustomer` | `GET /api/token/?p=&page_size=` (act-as) |
| 充值入账 | `addQuota` / `applyTopup` | `POST /api/user/manage` `action=add_quota` |
| 查用户余额(quota) | `getUser` | `GET /api/user/{id}` |
| 查用量日志 | `queryLogs` | `GET /api/log/` (filter by **username** 不是 user_id) |
| 列出可用模型 | `listAvailableModels` | `GET /api/channel/models_enabled` |
| 高层封装:开通新客户 | `provisionNewCustomer` | 6 步内部串联(W2 D6 验证) |

封装在 `src/lib/newapi/client.ts`。看那里就是 source of truth。

**双 header 认证**(每个请求都要):
- `Authorization: <access_token>`(不带 `Bearer` 前缀,**新代码不要再用 admin token 调 per-user endpoint**)
- `New-Api-User: <int_user_id>`(必填,缺了一律 401)

`provisionNewCustomer` 的 6 步流程见 `src/lib/newapi/client.ts` 头部注释 + gotcha #10。

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

> ⚠️ 上面 #1-#6 是 W1 LiteLLM 时代的遗留(已停用,W2 D3 切到 new-api)。
> 现在 portal 调 new-api,看下面 #9-#13(B3 W2 D6 实测踩到的坑)。

### 9. new-api `display_name` 20 字符上限(不是 50)
**症状**:`POST /api/user/` 返回 `422 Field validation for 'DisplayName' failed on the 'max' tag`。
**真实行为**:`display_name` max **20**(bootstrap 文档说 max 50,错的);`email` 字段才是 max 50。
**解决**:`display_name` 用 username(`c-{8字符}` 必然 ≤20),邮箱仍走 `email` 字段。
**修复 commit**:`ad401af` (W2 D6) — `_bootstrap/src/lib/newapi/client.ts` 文档不准。

### 10. `PUT /api/user/` 不能给客户改 `access_token`
**症状**:PUT 返回 `{success:true}` 看似成功,但立刻 `GET /api/user/{id}` 拿回 `access_token: null`。任何用这个 access_token 的后续操作 → 401 Unauthorized。
**真实行为**:`PUT /api/user/` **静默丢弃** `access_token` 字段,doc 没说。其他字段(group/role/quota)是真改的,所以错觉很强。
**解决**:不能 admin 改,要让客户自己 rotate:
1. `POST /api/user/login` 用 portal 持有的 username+password → 拿 session cookie + user.id
2. `GET /api/user/token` 带 cookie + `New-Api-User: <user.id>` → 返回新生成的 access_token
3. portal 把这个 access_token 存 DB,以后 act-as 该客户用
**修复 commit**:`ad401af` (W2 D6) — 见 `provisionNewCustomer` 重写后的 6 步流程。

### 11. `POST /api/token/{id}/key` 返回 `{key: "sk-..."}` 不是裸字符串
**症状**:把返回值当 string 存进 `newapi_token_value String @unique` → Prisma 写入抛 type error,或者存进去后所有后续 `.slice` 调用炸。
**真实行为**:envelope 里 `data: { key: "sk-..." }`,需要 `.key` 解包。
**解决**:`getTokenKey` 在 client 层 unwrap,返回内层字符串。
**修复 commit**:`ad401af` (W2 D6) — `client.ts:getTokenKey` 改 `Promise<{key:string}>` 后 `return result.key`。

### 12. `unlimited_quota=false + remain_quota=0` 的 token 直接拒绝调用
**症状**:刚创建的 token 调 `/v1/chat/completions` → `Invalid token`(误导,看起来像 auth 错)。
**真实行为**:new-api 把 `remain_quota=0` 视为"已耗尽",**在 token 验证阶段就拒**,根本没到上游模型。
**解决**:portal 创建的 token 永远设 `unlimited_quota: true`。预算关由 `user.quota` 单点控制(W4 充值流入账走 `add_quota` 加给 user)。Token 不再做第二道独立预算门。
**架构影响**:**充值 = `add_quota` 给 user,token 不动**。这条要在 W4 充值改造时记牢。
**修复 commit**:`ad401af` (W2 D6) — `provisionNewCustomer` 默认 `unlimited_quota: true`。

### 13. ⚠️⚠️⚠️ `GET /api/user/token` 是 **rotate** 不是 read
**最危险的一条**。这个端点不是"拿当前 token",是"重新生成并使旧的失效"。
**症状**:你以为是无副作用的 GET,顺手调一下 → portal 用的 admin token 立即失效 → 整套 portal 调不通 new-api → 全线 502。
**真实行为**:每次 GET 都 rotate,旧值作废。doc 没明说。
**解决**:
- 永远不调 `GET /api/user/token`,除非你**主动**想 rotate。
- portal `.env` 里的 `NEWAPI_ADMIN_TOKEN` **完全人工管理**:在 1Password,不要从 API 拿。
- 客户的 access_token 我们也只在 `provisionNewCustomer` 里 rotate **一次**(注册时),之后存 DB,后续 act-as 都用 DB 里的值,不再调这个端点。
**W3 runbook 必读**:任何运维操作前先确认是否会触发 rotate。如果 admin token 真的丢了,流程是"在 admin.silkroadai.io UI 重新生成 → 写回 .env → 重启 dev/prod"(不要从 API 试图重新拿)。
**修复 commit**:`ad401af` (W2 D6) — 在 `_bootstrap/src/lib/newapi/client.ts` 的注释里也标了。

### 14. 一个上游多种 API 格式 → 必须配多个渠道
**症状**:同一上游(比如 sub2api)既能调 Claude 又能调 GPT,只配一个 Anthropic Claude 渠道时,GPT 调用 → `404 server_error`(模型不存在/上游路径不对)。
**真实行为**:new-api 的"渠道类型"决定它对该上游用哪种请求格式:
- `Anthropic Claude` type → `POST /v1/messages`(Claude 原生格式)
- `OpenAI` type → `POST /v1/chat/completions`(OpenAI 兼容格式)
一个渠道只能一种类型,所以同上游有多种格式的 endpoint 时必须建多个渠道。
**解决**:同 base URL + 同 key 配两个渠道,types 不同,每个渠道的 model list 各列对应模型。
**实例**(W3 D1 落地):
- `sub2api`(Anthropic Claude type)— `claude-opus-4-7` / `claude-sonnet-4-6` / etc
- `sub2api-openai`(OpenAI type)— `gpt-5.4` / `gpt-5.4-pro` / `codex` / `gpt-image-2`
- `SiliconFlow`(OpenAI type)— 余下的开源模型(deepseek/qwen/glm/kimi/...)
**修复 commit**:运维操作,无 portal commit;在 admin.silkroadai.io UI 配置。

### 15. 渠道 model_mapping 短名在渠道编辑/扩容后可能失效
**症状**:从 ai.silkroadai.io 调用 `deepseek-v4-flash`(W1 时代用过的短名)→ `503 no available channel for model X under group default`。canonical 名 `deepseek-ai/DeepSeek-V4-Flash` 同样的 sk-xxx 通。
**真实行为**:new-api 渠道的 `model_mapping` 字段是个 JSON,把客户传来的 model name 在路由前 transform 成 canonical。这个字段在 channel 编辑、PUT 不带它时,**可能被静默清掉**;也可能在 SiliconFlow 上游模型清单大幅扩容(W3 D1 后 117 → 291)时被覆盖。
**影响**:任何 W1 时代公开过的短名,客户/前端/SDK/文档示例还在用 → 静默 503,看不到投诉但流量在掉。
**解决**:
- 任何渠道改动后,跑全 W1 短名清单(`deepseek-v4-flash` 等)的回归 e2e
- `model_mapping` 字段在 admin UI 编辑 channel 时必须确认还在
- 长期:portal 后台测试覆盖加入「短名清单回归」step
**首次发现**:W3 D2 Batch B(2026-05-03),`docs/W3-D2-VERIFICATION.md` F1。
**修复**:W3 D2.5 Batch D(2026-05-03)用 `scripts/rebuild-channel-model-mapping.ts` 重建 SiliconFlow 渠道 model_mapping。该脚本可复用 — 任何渠道编辑或上游扩容后跑一次 `pnpm tsx scripts/rebuild-channel-model-mapping.ts <channel_id> --apply` 即可。
**额外发现(W3 D2.5 实测,gotcha #15 的延伸)**:`model_mapping` 仅做"上游 forward 时的名字翻译",**不影响路由匹配**。要让 portal 客户能用短名调用,**短名必须同时出现在 `channel.models` 字段里**(路由器按字面查找),否则 503 `no available channel`。脚本已经把短名 append 到 `models`。
**Tier 优先级**(SiliconFlow 多变体的同短名冲突):`Pro/X` > `vendor/X` > `LoRA/X`。Pro 默认胜出(客户充的是真金白银,free tier 限速会变成 cryptic 错误)。

### 16. 改密 / token version 机制 — verifySession 每次多 1 DB read
**现状**:为支持"改密即时踢登所有设备",jwt payload 带 `tv` 字段(= `User.session_token_version` 当时快照),`getCurrentUser` 内每次多查一次 User 表读 `session_token_version` 比对,不等返回 `null`。`signSession(userId)` 也内部读一次 User 表把当前 tv 写进 payload。
**触发 tv++ 的事件**:reset-password endpoint(W3 D4)、未来主动 logout-all-devices endpoint。
**影响**:Auth 热路径每请求 +1 DB read(getCurrentUser 本来就要查 user,等于 select 多一字段,几乎零额外成本;signSession 是写路径不在热路径)。目前无 cache。
**缓解(W4-W5)**:redis 缓存 `User.session_token_version`,失效策略 = bcrypt rehash(reset password)/ 主动 logout 时主动 bust。
**首次发现**:W3 D4 引入(本特性),`docs/W3-D4-FORGOT-PASSWORD-VERIFICATION.md` F4。

### 17. OAuth `state` / `pkce` cookie 必须在 callback 出口清掉(成功 + 失败两条路都清)
**现状**:`/api/auth/oauth/google/start` 写两个短命 httpOnly cookie:`oauth_google_state`(CSRF 校验)+ `oauth_google_pkce`(PKCE code_verifier),maxAge=600s。`/api/auth/oauth/google/callback` 在 **每条**返回路径(success / state mismatch / google_denied / id_token 错误 / provision 失败)都通过 `buildResponse() → clearOAuthCookies()` 把两个 cookie 设回 maxAge=0。
**为什么重要**:这两个值是单次使用的安全凭据。如果失败路径忘清,攻击者诱导受害者再次访问 callback URL 时还能拿到旧 verifier,放大 CSRF / replay 窗口。
**正确写法**:任何新 OAuth provider 的 callback 都走"集中出口函数"模式 — 成功失败都 return 同一个 helper 构造的 response,helper 内 unconditionally 清 cookie。**不要**只在 happy path 末尾清。
**首次发现**:W3 D6 引入(本特性),`docs/W3-D6-GOOGLE-OAUTH-VERIFICATION.md` F3。

---

## 不要做的事(避免误改)

- ❌ 不要改 `src/lib/easy-pay/`、`src/lib/wxpay/`、`src/lib/alipay/`、`src/lib/stripe/` — 支付层是从 Sub2ApiPay 继承的,稳定可靠,改了就要重测全部支付链路
- ❌ 不要改 `src/lib/order/{fee,status,timeout,code-gen,limits}.ts` — 订单工具函数,继承,不动
- ❌ 不要改 `src/app/api/easy-pay/notify/route.ts` 的 webhook 框架 — 只改它内部 `handlePaymentNotify` 调用的下游函数
- ❌ 不要把 `NEWAPI_ADMIN_TOKEN` 或 `PORTAL_JWT_SECRET` hardcode 进任何代码,只能在 .env 里
- ❌ 不要在测试里调真实的 new-api(除了 `src/lib/newapi/__tests__/client.smoke.test.ts`),用 mock
- ❌ 不要直接写 SQL,所有数据库操作走 Prisma
- ❌ 不要建议改 new-api 源码(AGPL)
- ❌ 不要从 API rotate `NEWAPI_ADMIN_TOKEN`(`GET /api/user/token` 是 rotate,会让 .env 当前值失效)— 见 gotcha #13
- ❌ 不要尝试 admin 直接给客户改 access_token(PUT 静默丢)— 见 gotcha #10

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
pnpm vitest run src/lib/newapi                  # 跑某目录(B3 之后)
# 真实 new-api 烟雾测试需要 SSH 隧道:
ssh -fN -L 3000:localhost:3000 -o ServerAliveInterval=60 vps

# 渠道 model_mapping 重建(防 gotcha #15 回归)
pnpm tsx scripts/rebuild-channel-model-mapping.ts <channel_id>           # dry-run 看 diff
pnpm tsx scripts/rebuild-channel-model-mapping.ts <channel_id> --apply   # 实际 PUT
# 任何渠道编辑(admin UI 改 models / key / config)或上游扩容后必须跑一次,
# 否则 W1 时代客户用过的短名(deepseek-v4-flash 等)会静默 503

# 邮件 e2e debug 模式(W3 D4 forgot-password / W3 D5 邮箱验证用)
EMAIL_DEBUG_LOG=/tmp/mail-debug.log pnpm dev
# 然后 forgot-password 调用后,resetUrl(含裸 token)会 append 到 /tmp/mail-debug.log
# 让 e2e 脚本能拿到 token(DB 只存 sha256 hash,不可恢复)。prod 永远不要 set 这个 env

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

# new-api 后端(B3 主链路)— 本地通过 SSH 隧道:
#   ssh -fN -L 3000:localhost:3000 -o ServerAliveInterval=60 vps
NEWAPI_BASE_URL="http://localhost:3000"
NEWAPI_ADMIN_TOKEN="<在 admin.silkroadai.io 个人设置生成,1Password 存档>"
NEWAPI_ADMIN_USER_ID=1                            # root 通常是 1
NEWAPI_QUOTA_PER_USD=500000                       # 1 USD = 500k quota(new-api 默认)
USD_TO_CNY_RATE=7.2

PORTAL_JWT_SECRET="本地随便生成 64 字节 hex"
ADMIN_TOKEN="本地随便生成 32 字节 hex"

NEXT_PUBLIC_APP_URL="http://localhost:3002"
APP_PORT=3002
```

完整列表见 `.env.example`。LiteLLM 时代的 `LITELLM_*` 变量保留作 fallback,W3 D1 关停后可删。

---

## 项目外部依赖说明

- **new-api**: 部署在 VPS 23.27.113.88:3000(admin.silkroadai.io),本地通过 SSH 隧道访问
- ~~**LiteLLM**~~ — Stopped at W3 D1 (2026-05-02), container deprecated, config archived
- **Sub2API**: 部署在 VPS,作为 new-api 的一个 Custom 渠道上游(portal 不直接调)
- **易支付**: 公开网关,需要 PID/KEY,callback 必须公网可达
- **QQ SMTP**: 邮件验证用(W3 启用)

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

**版本**: 1.7
**最后更新**: 2026-05-04
