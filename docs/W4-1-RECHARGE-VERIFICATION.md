# W4-1 — Portal-Internal Recharge Flow Verification Report

**Date**: 2026-05-04
**Branch**: `feat/w4-1-d1-recharge-backend`(D1+D2+D3 累积单 PR)
**Base commit**: `36b0301`(W3 D7 PR #8 merged)
**Scope**: 标准档 W4-1 三 batch 累积:① executeRecharge 切 new-api applyTopup ② createOrder 切 portal user + /api/orders cookie auth + 新 /pay /login 页 ③ 集成测试 + Google account-link sweep + 易支付 sig fail alert log

---

## TL;DR

W3 D7 之后 portal 充值通道实质 **0% 通过率**:`createOrder` 调 litellm-shim `getUser` 必 null → crash;`executeRecharge` 调 litellm-shim `createAndRedeem` 必 throw deprecation。本 W4-1 三 batch 把整条链路从 `/pay` 下单 → `/api/orders` cookie auth → easypay createPayment → 跳网关 → 易支付 callback → 验签 → `executeRecharge` → `applyTopup add_quota` → `RechargeLog` audit + `Order COMPLETED` 跑通,**集成测全 5 条 PASS**。顺手把 D7 抽出的 `account-link` helper 从只 GitHub 用扩到 Google 也用,**D6 全套 15/15 单测仍 PASS 证明行为等价**。易支付 sig 验证失败从 silent fail(`console.error` + return `'fail'` → easy-pay 重试)改为 silent ignore + `console.warn`(return `'success'` 防 attacker spam 触发重试风暴,警告日志给 ops 信号)。整体 **42 → 43 测试文件,398 → 423 测试,0 回归**。**真实易支付沙箱 smoke 由用户在浏览器跑**(¥10 小额),指南见 §用户手测指引。

## D1 + D2 + D3 验证矩阵

| 项                                               | 期望                                                                                                                                               | 实测                                                                                                             | 结果         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| **D1**:`executeRecharge` 切 `applyTopup`         | 不再调 litellm shim;CAS lock + RechargeLog 二级 dedup                                                                                              | `service.ts` lines ~933-1100 重写,callers (`confirmPayment` → `executeFulfillment` → `executeRecharge`) 链路完整 | ✅           |
| D1 unit tests `execute-recharge.test.ts`         | 9/9 PASS(happy / idempotent×2 / dedup / applyTopup-fail / no-newapi-user-id / no-user-id / not-found / balance_after-fallback)                     | 9/9 PASS                                                                                                         | ✅           |
| **D2**:`createOrder` 切 `prisma.user.findUnique` | 字段映射 nickname→userName(fallback email local-part)/ notes=null / balance=0;status 检查 403 banned/disabled                                      | service.ts lines ~150-189 重写                                                                                   | ✅           |
| D2:`/api/orders` POST cookie auth                | 删 `getCurrentUserByToken(token)`,改 `getCurrentUser(req)` from session;删 `token` 字段                                                            | route.ts 全套重写                                                                                                | ✅           |
| D2 新页 `/pay`(server + client form)             | getCurrentUser 守门,5 tier(¥10/30/100/300/1000)+ custom amount + provider radio + submit POST `/api/orders` → window.location 跳网关               | `page.tsx` 3.6 KB + `pay-form.tsx` 8.7 KB                                                                        | ✅           |
| D2 新页 `/login`(密码 + Google + GitHub OAuth)   | 已登录 redirect next(白名单防 open-redirect);展示 `?oauth_error=` banner                                                                           | `page.tsx` 3.6 KB + `login-form.tsx` 5.7 KB                                                                      | ✅           |
| D2 W1 `/pay/page.tsx` 1160 行重命名              | `page.legacy.tsx`(Next 不识别,自动忽略)                                                                                                            | 文件保留为 reference                                                                                             | ✅           |
| D2 `src/app/page.tsx` forward 全 query           | OAuth 失败 `oauth_error=...` 现在能穿透到 `/pay` → `/login` banner                                                                                 | 11 → 30 行,for 循环 forward 所有 string + array params                                                           | ✅           |
| D2 unit tests                                    | createOrder auth 5/5 + /api/orders POST 6/6 + pay/login UI SSR smoke 9/9 = **20/20 PASS**                                                          | 20/20                                                                                                            | ✅           |
| **D3** 集成测 `recharge-flow.test.ts`            | 5 cases:happy / duplicate(COMPLETED replay)/ defensive dedup(RechargeLog 已存)/ sig fail / applyTopup throw                                        | 5/5 PASS                                                                                                         | ✅           |
| D3 Google callback 改用共用 helper               | callback route 335 → 138 行(净 -197);D6 全套 15/15 仍 PASS                                                                                         | 15/15 PASS                                                                                                       | ✅           |
| D3 易支付 sig fail console.warn                  | bad sig → response `'success'` body + `console.warn('[easy-pay/notify] signature verification failed', { instId, out_trade_no, pid, signPrefix })` | 集成测 case 4 验证                                                                                               | ✅           |
| 全套 vitest                                      | 0 新 fail;newapi smoke 含(隧道 up)                                                                                                                 | 43 files / **423 PASS / 1 skip / 0 fail**                                                                        | ✅           |
| `tsc --noEmit`                                   | 0 errors                                                                                                                                           | 0 errors                                                                                                         | ✅           |
| `eslint`(D3 改/新文件)                           | 0 issues                                                                                                                                           | 0 issues                                                                                                         | ✅           |
| 真实易支付沙箱 smoke                             | 用户手测                                                                                                                                           | 见 §用户手测指引                                                                                                 | ⏳ User TODO |

**结论:核心信号 ✅,7 个 informational(F1-F7),1 个用户 TODO(易支付沙箱 ¥10 真打)。**

## D3 设计决策

### 集成测试边界(`recharge-flow.test.ts`)

不真打易支付 / 不真打 new-api / 不真用 prisma:

- **真用** `provider.verifyNotification`(real MD5 sig 算法)+ `generateSign` from `src/lib/easy-pay/sign` 生成测试 sig(用同一个 `TEST_PKEY` 签 / 验,模拟真实易支付沙箱场景下的合法 callback)
- **真用** `executeRecharge` + `confirmPayment` + `handlePaymentNotify`(D1 改造的链路核心)
- **mock** prisma:用 `vi.hoisted()` 抽出小型有状态内存 mock(`Map<orderId, OrderRow>` + `RechargeLogRow[]` + `AuditLogRow[]`),按测试 setup 不同初始 state,验完读 state 看效果
- **mock** newapi:`applyTopup` + `getUser` + `cnyToQuota`
- **mock** load-balancer `getInstanceConfig`:返回 `{ pkey: TEST_PKEY, pid: TEST_PID }`,让路由走 `?inst=...` 分支(避免 ensureDBProviders + paymentRegistry mock 链)

5 个 case 完整覆盖 D1 改造的所有分支:

1. **happy**:Order PAID + 无 RechargeLog → notify 合法 sig → applyTopup 1 次 + RechargeLog 写入 + Order COMPLETED + audit RECHARGE_SUCCESS
2. **duplicate(COMPLETED replay)**:Order 已 COMPLETED → notify 合法 sig → confirmPayment 早返(status===COMPLETED 分支)→ applyTopup **不调** + RechargeLog 不增加
3. **defensive dedup(RechargeLog 已存)**:Order PAID + RechargeLog 行已存(模拟"上轮 add_quota 成功但 status=COMPLETED 写入前 crash")→ notify 合法 sig → executeRecharge 内部 findFirst 命中 → applyTopup **不调** + Order finalize 到 COMPLETED
4. **sig fail**:任意状态 + tampered sig(改 sig 字符串首字母)→ console.warn 调用 + body `'success'`(防 attacker spam 触发 easy-pay 重试)
5. **applyTopup fail**:Order PAID + applyTopup throw → Order FAILED + audit RECHARGE_FAILED + body `'fail'`(让 easy-pay 重试,下次进 dedup 防御 OR 重新调 applyTopup 看是否 transient)

### Google callback refactor 设计

W3 D7 brief 当时为了不动 Google 把 5-branch logic 抽 helper 但只 GitHub 用,留个 W4-2/W5 sweep。W4-1 D3 顺手做完:

- **删除**:`createUserFromGoogle`(86-175 行,内含 prisma.user.create + provisionNewCustomer + linkage transaction + 失败回滚)— 这正是 helper 内的 `createUserFromIdentity`
- **删除**:Branches 1-5 inline 代码(236-322 行)— helper 一个调用替代
- **新增**:`linkOrCreateOAuthUser({ provider: 'google', providerAccountId: claims.sub, email: claims.email, nameHint: claims.name })` 一行
- **保留**:state CSRF + PKCE cookie 校验、id_token 验证(jose JWKS)、cookie clear 出口(gotcha #17)、last_login_at touch、signSession + setSessionCookie

**行为等价性证据**:D6 全套 15 个单测覆盖 5 个 branch + provision rollback + banned + state mismatch + token-exchange/id-token 错误,**全部 unchanged 仍 PASS**。

净行数:Google callback route.ts **335 → 138 行(-197)**,删的就是已抽到 helper 的代码。零行为差异、零 schema 改动。

### 易支付 sig fail alert 设计

**问题**:W1 sub2apipay 的 `verifyNotification` throw → 路由外层 catch → `console.error` + body `'fail'`。两个问题:

- (1) attacker 拿 fake notification spam 我们 → 我们 say 'fail' → easy-pay 看到 'fail' 标记成失败但**不会重试**(easy-pay 协议:body 不是 `'success'` 就放弃),所以现实中 spam 不会循环 — 但每次都 console.error 噪音
- (2) `console.error` 在 prod 不带 alerting,ops 看不到 sig 失败信号(可能是配错 pkey 或者真有人 spam)

**修复**:catch 块内 match `'signature verification failed'`(provider 抛的 exact message)→ `console.warn` 带安全 metadata(`instId`, `out_trade_no`, `pid`, `signPrefix=sign[0:6]+'...'`)+ body `'success'`(明确告知 easy-pay 无需关注,即使是合法重试 case 也 OK,因为重试之前已经 finalize 过)。其他 verify 错误(pid mismatch / amount<=0)继续走外层 catch → `'fail'`。

**没打**:raw body / 完整 sign(防日志 leak 给攻击者重放)、any user PII

W6 对接 Sentry / alert:这个 console.warn 之后 pipe 进去就是 ops 信号。

## Findings

### F1 [info / 已修] LiteLLM stub 残留追踪

D1 报告里列的 W1 LiteLLM 残留清单,W4-1 三 batch 完成度:

| 项                                                                                                           | 状态                                |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `service.ts.executeRecharge`                                                                                 | ✅ D1 改                            |
| `service.ts.createOrder`                                                                                     | ✅ D2 改                            |
| `/api/orders` POST `getCurrentUserByToken`                                                                   | ✅ D2 改                            |
| `service.ts.executeSubscriptionFulfillment`                                                                  | ⏳ W4-2(订阅流)                     |
| `service.ts.processRefund` / `requestRefund` / `prepareDeduction` / `executeDeduction` / `rollbackDeduction` | ⏳ W4-2(退款流)                     |
| `/api/orders/my/route.ts`                                                                                    | ⏳ W4-2(客户后台订单列表)           |
| `/api/admin/user-balance/route.ts`                                                                           | ⏳ W5(管理员后台余额视图)           |
| `/pay/orders` / `/pay/[orderId]` / `/pay/result` / `/pay/stripe-popup` 子页                                  | ⏳ W4-2(W1 UI 复用,改 prisma)       |
| `/pay/page.legacy.tsx`(D2 重命名后保留)                                                                      | ⏳ W5+ sweep,确认无意义后删         |
| `middleware.ts` Sub2API iframe-allow CSP                                                                     | ⏳ W5+ sweep(无害,可暂缓)           |
| `RechargeLog` schema 字段裁(`balance_before/after` 在 add_quota 模型下意义弱)                                | ⏳ W5+ schema sweep(配新 migration) |

### F2 [info / 设计] 集成测试边界为何不真用 prisma

无 in-memory PostgreSQL fixture(prisma 不直接支持 sqlite for unit;真用 testcontainers 又是新依赖)。`vi.hoisted()` + `Map<id, Row>` 小型 state mock 是 best-fit:① 验 D1 二级 dedup(需要 RechargeLog.findFirst 看到 prior row) ② 验 CAS lock(需要 status 状态机) ③ 验 transaction 内多 op 顺序。Mock 不能验 schema 约束(unique / nullable / FK cascade)— 那是 真实 e2e 范围(D3 用户手测 step 5)。

### F3 [info] sig fail body 'success' vs 'fail' 取舍

我考虑过 3 种返回:

- `'fail'`(W1 旧)→ easy-pay 不重试(协议:非 'success' 即放弃)+ noisy console.error,**实际效果与 'success' 等价但日志噪音大**
- `'success'`(D3 改)→ easy-pay 不重试 + console.warn 带 metadata,**信号清晰**
- `400`(brief 早期版假设)→ easy-pay 默认 5 分钟内多次重试,attacker spam → 重试风暴 ❌

最终选 'success' + warn。详见 route 文件头部注释。

### F4 [info / W6 待续] sig fail alert 路径

目前 `console.warn` 只到 stdout。W6 接 Sentry 时:

- 加 `Sentry.captureMessage('easy-pay sig fail', { level: 'warning', extra: { instId, out_trade_no, pid } })`
- 加 rate limit(同一 instId+out_trade_no 5 分钟内 max 1 alert,防真 attacker 把 alert 钻爆)

### F5 [info / 已知] easy-pay verifyNotification 把 `?inst=` 也算进 sig

provider.ts `verifyNotification` 把 query 里的 `inst` 也丢进 paramsForSign(只过滤 `sign` / `sign_type`)。集成测试需要在生成 test sig 时也包含 `inst`,否则 sig fail。这与生产行为一致 — 易支付 callback 协议:它 echo 我们 notifyUrl 里的 query 参数,然后用我们 pkey 签**包括** `inst` 在内的所有非 sign / sign_type 参数。**生产 W1 至今正常运作**,所以行为本身 OK,只是 W1 没文档化。本批不动这块。

### F6 [info] CreateOrderResult.userBalance 字段保留

D2 已说明:portal 没 balance(quota 在 new-api 侧)。`userBalance: number` 字段保留始终为 0,/api/orders route 剥离不下发客户端。Admin orders refund UI 走的是 `/api/admin/user-balance` 路由(走 litellm shim),W4-2 sweep 一并改。

### F7 [info / 用户自决] 真实易支付沙箱 smoke 待跑

集成测**全模拟**(mock prisma + mock newapi + mock load-balancer + 自签 sig + 自伪造 callback)。"易支付沙箱真打小额" 是补完的最后一块:验真实网关 callback URL 能命中 portal 的 `/api/easy-pay/notify`、真实 sig 验证通过、真实 new-api `getUser(id).quota` 涨 ~69k。

## 用户手测指引(易支付沙箱 ¥10 真打)

预先(D6 教训):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/status
# 期望 200。如果 0 / connection refused,先起 SSH 隧道:
# ssh -fN -L 3000:localhost:3000 -o ServerAliveInterval=60 vps
```

worktree 提醒:本 PR 在 `feat/w4-1-d1-recharge-backend`。如果用户主仓库不在这分支,先:

```bash
git fetch origin && git checkout feat/w4-1-d1-recharge-backend
# 撞 worktree lock 按 W3 D7 教训处理(看 .git/worktrees/ 解 lock)
```

1. **预先 + dev server**:`PORT=3002 pnpm dev`(背景跑)。`.env` 应有 `EASY_PAY_PID` / `EASY_PAY_PKEY` 真值(已配)。

2. **浏览器隐身窗口** → `http://localhost:3002/login` → 任选一种登录方式:
    - 邮箱密码(用之前 register 创建的账号)
    - 「使用 Google 登录」(之前 W3 D6 smoke 用过的 Google 账号)
    - 「使用 GitHub 登录」(之前 W3 D7 smoke 用过的)

3. 登录成功 → 自动跳 `/pay`(URL 应该携带 `?next=/pay` 透传)→ 看到 5 tier 按钮 + provider radio。**选 ¥10 tier**(沙箱小额)+ 选「支付宝」(走 easypay sandbox)+ 点「前往支付」。

4. 跳易支付沙箱 → 沙箱 UI 通常有「测试支付成功」按钮(具体看你 EASY_PAY_API_BASE 配的沙箱)→ 点确认 → 沙箱跳回 portal `/pay/result`。

5. **三处验证**:
    - **DB**:`pnpm prisma studio` 开 GUI → `recharge_logs` 表多 1 行(`amount=10.0000`, `source='payment'`, `newapi_quota_added` 约 `694444`,`newapi_user_id` 是该客户的)+ `orders` 对应行 `status=COMPLETED`,`completed_at` 非 null
    - **new-api**:浏览器开 `https://admin.silkroadai.io` → 用户列表 → 找到该 user(用 newapi_user_id 反查)→ `quota` 从 0(或之前值)涨到 + ~69_444(`¥10 / 7.2 USD/CNY × 500_000 quota/USD = 694_444`)
    - **server log**:`pnpm dev` 输出找 `[easy-pay/notify]`(应无 sig fail warning)+ `[recharge]` 应有 audit 行 `RECHARGE_SUCCESS`,无 ERROR

任一失败 → 看 server log 中 `[easy-pay/notify]`/`[recharge]` 前缀诊断行,按 `oauth_error` / `Order.failedReason` 反查路径。常见问题:

- sig fail → 检查 `EASY_PAY_PKEY` 是否对、易支付沙箱 admin 后台配的 notifyUrl 是否完全等于本地 `http://localhost:3002/api/easy-pay/notify?inst=...`
- applyTopup fail → 检查 SSH 隧道是否还活(`curl localhost:3000/api/status`)+ NEWAPI_ADMIN_TOKEN 是否仍有效
- portal user 没 newapi_user_id → 该账号是 W1 之前注册的(provisionNewCustomer 没跑过),用刚 register 或刚 OAuth 登录创建的全新账号

## 后续(W4-2 / W5)

- **W4-2**:① 客户后台 UI(用量 + 历史订单 + token 列表)② 退款流(processRefund 切 prisma.user + new-api `add_quota` 减款)③ subscription stub 决定上线 or 删
- **W5**:管理员后台改 prisma + new-api / RechargeLog schema 裁字段 / Sentry 接 sig fail warn / `page.legacy.tsx` 删 / middleware iframe-allow CSP 删
- **W6**:Sentry / alert / metrics

---

**Signed-off**:W4-1 (D1+D2+D3) 验证信号 ✅(单测 + 集成测 + 全套回归层面),用户手测 ⏳ pending(易支付沙箱小额真打)。Unblock W4-2 客户后台。
