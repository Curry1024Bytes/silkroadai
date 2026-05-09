# W4-2 — Client Dashboard MVP Verification Report

**Date**: 2026-05-04
**Branch**: `feat/w4-2-d4-portal-layout`(D4+D5+D6+D7 累积单 PR;stack 在 W4-1 PR #9 之上)
**Base commit**: `53c76c8`(W4-1 D3,PR #9 仍 OPEN)
**Scope**: 标准档 W4-2 四 batch 累积:① layout 底座 + 4 受保护页 + logout(D4)② Keys 页 + 5-key 限额 + reveal/revoke(D5)③ Balance 页 + 60s row cache + executeRecharge cache bust(D6)④ Usage 页 + period filter + by-model top-5 + getCurrentUser cache() dedup + reset-password fired guard(D7)

---

## TL;DR

W3 之后 portal 完全没有客户后台 UI(W1 sub2apipay 时代靠 iframe `/pay`,无 `/portal/*`)。W4-2 fresh build 4 张页:`/dashboard` 落地 + `/keys` API key 管理 + `/balance` 余额与流水 + `/usage` 调用统计。共享 `(authenticated)` route group layout 单点鉴权 + sidebar nav + `email_verified=false` soft-block banner。新增 `/api/portal/keys/*` 3 endpoints + `/api/auth/logout`(单设备登出,不动 session_token_version,gotcha #16)。

**核心新增**:

- `getQuotaWithCache`(D6)4 路径:hit / miss / live / fallback,`executeRecharge` 事务内 cache bust 让充值后下次 `/balance` 必走 live(W3 D3 期间发现的 W4 必修债,本批落地)。
- `getCurrentUser` 包 React.cache()(D7)按 cookie value memo,layout + nested page 两次调用 collapse 到 1 次 jose verify + 1 次 DB read。
- `queryLogs` 加 `user_id` filter(D7),修 W3 D2 F2 发现的 username filter 0-result bug。
- `reset-password` form 加 firedRef(D7),与 W3 D5 verify-email-runner 防 React 19 StrictMode 双消模式一致。

整体 **W3 全套(389 测)+ W4-1 全套(全集成)+ W4-2 全套(86 新测)= 54 files / 494 PASS / 1 skip / 0 fail**。**真实浏览器 5 步 smoke 由用户跑**(易支付沙箱 ¥10 真打验证 D5/D6 cache bust 链路完整),指南见 §用户手测指引。

## D4 + D5 + D6 + D7 验证矩阵

| 项                                                  | 期望                                                                                            | 实测                                                                                                                                                                                                              | 结果                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **D4** layout `(authenticated)/layout.tsx`          | server auth 守门 + Header(logo/email/退出)+ Sidebar(4 nav + 充值)+ unverified banner soft-block | 4.0 KB · `getCurrentUser` null → `redirect /login?next=` 透传 path · 4 client 子组件                                                                                                                              | ✅                                  |
| D4 `POST /api/auth/logout`                          | 清 cookie 不动 tv,gotcha #16                                                                    | `clearSessionCookie(res)` 直返 200,httpOnly+SameSite=Lax+Path=/ + Max-Age=0                                                                                                                                       | ✅                                  |
| D4 单测                                             | 15/15(layout auth × 4 + 4 component SSR + 3 logout)                                             | 15/15(D7 sweep 后 placeholder 块清空,因为 4 页都已实装)                                                                                                                                                           | ✅                                  |
| **D5** `/keys` 页 + 3 endpoints                     | 列表 / 创建(限 5)/ 撤销 / reveal-with-mask + 10s auto-mask + IDOR 防御                          | page 2.5 KB + KeysList 17.9 KB + 3 endpoints 12.7 KB · 创建走 3 步 new-api 流(create/list-find/getKey)+ Prisma create 双向回滚 · 撤销走 new-api delete + Prisma `status='disabled'` 软删(保 Order/RechargeLog FK) | ✅                                  |
| D5 单测                                             | GET/POST/DELETE/GET-key + UI smoke                                                              | 27/27(11 list-create + 11 delete-reveal + 5 UI)                                                                                                                                                                   | ✅                                  |
| **D6** `/balance` 页 + cache helper + recharge bust | 4 路径 cache(hit/miss/live/fallback)+ 充值事务内 nullify 三字段                                 | helper 5.1 KB · page 10.4 KB · executeRecharge 事务加 4th op `prisma.user.update({...nullify...})`                                                                                                                | ✅                                  |
| D6 单测                                             | helper × 9 + page SSR × 5 + recharge regression × 9                                             | 24/24                                                                                                                                                                                                             | ✅                                  |
| **D7** `/usage` 页                                  | period filter `?period=7d\|30d\|all` + 服务端聚合 by-model top-5 + 最近 50 + 空状态指 /keys     | page 13.2 KB + period-tabs 1.7 KB + period helper 1.1 KB · `queryLogs({user_id, type:2})` 替代 username · 防 querystring 注入(parsePeriod 白名单)                                                                 | ✅                                  |
| D7 Sweep 1:`getCurrentUser` cache                   | 同请求多次调用 1 次 DB read                                                                     | `cache()` from `react` 包内层 by-cookie-value;函数签名不变                                                                                                                                                        | ✅(structural 测 + behavioral 5 测) |
| D7 Sweep 2:reset-password fired guard               | useRef + 同步 short-circuit                                                                     | `useRef(false)` + `if (fired.current) return` 在 await 之前 + 失败/异常路径 reset 允许重试                                                                                                                        | ✅                                  |
| D7 单测                                             | usage page × 9 + cache structural+behavioral × 6 + reset-password × 2                           | 17/17                                                                                                                                                                                                             | ✅                                  |
| 全套 vitest                                         | 0 新 fail,W3 + W4-1 + W4-2 全绿                                                                 | **54 files / 494 PASS / 1 skip / 0 fail**                                                                                                                                                                         | ✅                                  |
| `tsc --noEmit`                                      | 0 errors                                                                                        | 0 errors                                                                                                                                                                                                          | ✅                                  |
| `eslint`(D4-D7 改/新文件)                           | 0 issues                                                                                        | 0 issues                                                                                                                                                                                                          | ✅                                  |
| 真实浏览器 5 步 smoke                               | 用户手测                                                                                        | 见 §用户手测指引                                                                                                                                                                                                  | ⏳ User TODO                        |

**结论:核心信号 ✅,7 个 Findings(F1-F7),1 个用户 TODO。**

## D7 设计取舍

### React.cache() dedup 策略

`cache()` from React 19 仅在 server-component render context 内 memoize;vitest 外是 no-op pass-through。这意味着:

- **生产**:layout 调 `getCurrentUser` → cache miss → verify+lookup,nested page 调 `getCurrentUser`(同 cookie 值)→ cache hit → 直返同一 user。**1 verify + 1 DB read per request**。
- **vitest**:`cache()` 是 pass-through,每次调用都执行底层。所以 dedup 测试不能用"调 2 次断言 1 次 mock 调用"风格 — 改用 source-grep 结构断言(`cache(` 实际包了内层 + 用 `cookieValue` 做 key)+ 5 条 behavioral 断言(返回值在各 corner case 仍正确)。

### queryLogs `user_id` 加参,not 改 default

W3 D2 F2 发现 `username` filter 在 new-api 上返 0(疑似 upstream bug 或某种 bug-by-design)。本批不改 default(`username` 还在,因为可能其他 admin/debug 路径用)— 加 `user_id` 参数,**portal 业务路径全部改用 user_id**。`/usage` 页 + 测试明确不传 username。

### usage 页空状态指 /keys

新用户没有 token → 没法调上游 → 没有 logs。空状态 CTA 链 `/keys` 比链 `/pay` 更对路 — "你需要先有 key 才能调用"。/keys 页本身又有 + 创建 CTA。

### 撤销 key 设 `status='disabled'` 不真删

`NewApiToken` 没 `deleted_at`。Order / RechargeLog 都有 nullable FK 指向 NewApiToken,默认 onDelete=RESTRICT。真删会破历史订单可追溯。软删(status flip)+ List 过滤 active = 用户可见即"已删",DB 完整保留审计。

### Reveal 不调 `/api/token/{id}/key`(gotcha #11 + #13 警觉)

new-api `POST /api/token/{id}/key` 在某些版本有 rotate 语义(类似 gotcha #13 的 GET /api/user/token)。reveal 是高频客户操作 — 走 Prisma `newapi_token_value` 直接读够安全,**完全不调 new-api**。

### Balance 页 fallback 行为细节

- `source='cache'`:60s 内的命中,无 banner,无打扰
- `source='live'`:miss / stale 后 refetch + write-back 成功,无 banner
- `source='fallback'`:new-api 短暂不可用但有 stale cache,**显示 yellow banner 「数据暂时不可更新,显示的是稍早数据」** — 客户能看到数字 + 知道可能不最新
- 完全失败(无 cache + 无 live):红 alert「当前无法获取余额」+ **隐藏卡片**(避免显 ¥0.00 误导)

### Cache bust 在事务内 vs 分两步

D6 把 `prisma.user.update` 加进 `executeRecharge` 的 `$transaction` 内(4th op,与 RechargeLog.create / order.updateMany / auditLog.create 同事务)。如果分两步(先 commit 事务再 bust),网络抖动可能让 bust 丢失,客户在 60s 内看到旧 cache 余额。事务内保证「充值成功 = cache 必 bust」原子性。

## Findings

### F1 [info / 已修] N+1 getCurrentUser 已修(D7)

D4 引入时 layout + nested page 各调 1 次 getCurrentUser = 2 次 DB read per request。D6 加 `getQuotaWithCache` 时也独立查 user(在 helper 内)。**D7 sweep**:`cache()` 包内层后 — layout + page + helper 三处共享同一 cookie value → 1 次 verify + 1 次 user lookup。`getQuotaWithCache` 内部仍要 select 不同字段,所以总 DB read = 2 而非 3(getCurrentUser 1 次 + helper 1 次,但都只 1 次)。

### F2 [info / W3 D2 F2 修] queryLogs filter 改 user_id

W3 D2 F2 发现 username filter 0-result;现在 portal 业务路径都改用 user_id。`/usage` 页测试断言 `expect(callArgs.username).toBeUndefined()` 钉住此约定。username 参数还在,因为可能 admin / debug 路径需要(用户名直观 grep 易)。

### F3 [info] queryLogs page_size=200 是临时上限

`/usage` 页一次拉 200 条,前 50 入表 + 全 200 算 by-model top-5。如果客户调用量爆炸(>200 / 30 天),top-5 会基于尾巴 200 条而非全量。W6 加分页或 server-side aggregate endpoint 时修。本批 acceptable trade-off。

### F4 [info] React.cache() vitest 内是 no-op

不能用纯 vitest 验 dedup。结构性 source-grep 测 + 5 条 behavioral 测组合。**生产层面**:Next dev server 能在 console 看 prisma query 数从 2 → 1。

### F5 [info / 已防御] IDOR 防御统一返 401 不返 404

`/api/portal/keys/[id]` DELETE / GET-key 在「token 存在但属另一 user」时返 401(`invalid_credentials`),不返 403/404。原因:404 vs 401 的区别会让攻击者用 brute-force 枚举 token UUID(404=不存在,401=存在但不是你的)。统一 401 + 不区分错误码。同款防御已用在所有 W3 auth 端点。

### F6 [info / 用户自决] 真实易支付沙箱 ¥10 smoke 待跑

集成测 + 单元测全模拟。"易支付沙箱真打小额" 是补完的最后一块 — 验证 D5 创建 key + D6 充值 cache bust + D7 用量统计 端到端可见。指南见 §用户手测指引。

### F7 [info / 排队 W6+] 客户后台还差什么

W4-2 是 MVP。W6+ 待加:① 客户后台密码改 endpoint(目前只能走 reset-password 流) ② 已绑 OAuth 列表 + 解绑(W3 D6 doc F4) ③ /usage 客户端 dynamic 化 + 分页 ④ 余额低提醒邮件 ⑤ 移动端响应式审视(目前 desktop-first)

## 用户手测 5 步指南(请用户在浏览器跑)

预先(D6 教训):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/status
# 期望 200。否则:ssh -fN -L 3000:localhost:3000 -o ServerAliveInterval=60 vps
```

worktree 提醒:本 PR 在 `feat/w4-2-d4-portal-layout`,**stack 在 W4-1 PR #9 之上**(还没 merge)。如果你的主仓库不在这分支,先:

```bash
git fetch origin && git checkout feat/w4-2-d4-portal-layout
# 撞 worktree lock 按 W3 D7 教训处理
```

1. **起本地 dev**:`PORT=3002 pnpm dev`(背景跑)。`.env` 应有真 `EASY_PAY_PID/PKEY/...` + `GOOGLE/GITHUB_OAUTH_*`。

2. **隐身窗口** → `http://localhost:3002/login` → 任选一种登录(密码 / Google / GitHub)→ 跳 `/dashboard`。验证:看到欢迎语 + 3 卡片(Keys / 余额 / 用量)+ 顶部 header(email + 退出)+ sidebar(4 nav 高亮 / 充值 CTA 在底部)+(可能)yellow banner「邮箱未验证」。

3. **`/keys` 页**:点「+ 创建新 Key」→ alias 任意填(如 `test-key`)→ 创建后看到完整 sk-xxx,**复制保存**;返回列表看到 mask key + 创建时间;点「显示」reveal(10s 后自动 mask 验);点「撤销」一个 key 看是否消失。如果已有 5 个 key,验「+ 创建」按钮 disable + tooltip「已达上限 (5)」。

4. **`/balance` + `/pay`(测 cache bust)**:
    - 先访问 `/balance`,看到当前余额(可能 ¥0.00 如果 fixture 用户没充过钱)+ 累计消费 + 充值历史(可能空)
    - 点右上「+ 充值」→ 跳 `/pay` → 选 ¥10 + 支付宝 → 提交 → 跳易支付沙箱
    - 沙箱「测试支付成功」→ 跳回 portal `/pay/result`
    - **回到 `/balance`** → 余额数字应增加 ¥10(cache bust 生效;否则会显示充值前的旧值最多 60s)
    - 充值历史表格多 1 行(`amount=¥10.00`, `source=在线支付`, order_id 前 8 字符)

5. **`/usage` 页**:fixture A(W3 D2 时打过 claude/gpt/deepseek 各几条调用)应看到 3-4 条记录;新 user 看空状态 + 「前往 /keys 创建 key」CTA。**切「近 7 天 / 近 30 天 / 全部」窗口** → URL 变 `?period=7d` 等 + 数字 / by-model 块刷新。

任一失败 → server log 找 `[oauth/...]` / `[recharge]` / `[quota-cache]` / `[portal/keys ...]` 前缀,按 error code 反查路径。常见问题:

- 登录后 redirect 不到 dashboard → 看 layout `getRequestedPath` 是否拿到 path header(看 `[oauth/google/callback]` 后续日志)
- /balance 显示「当前无法获取余额」→ SSH 隧道挂了或 NEWAPI_ADMIN_TOKEN 失效
- /usage 显示「该时间段内无 API 调用记录」但你确实调过 → 你账号的 newapi_user_id 可能没设 / 调用是更早周期的(切「全部」试试)
- /keys 创建后看不到完整 sk-xxx → 网络问题或 createTokenForCustomer 失败,看 server log

---

## 后续(W5+)

- **W5**:① 客户改密 endpoint(走 session 不经 reset-password 邮件) ② OAuth 解绑 / 加绑 endpoint ③ admin 后台改 prisma + new-api ④ /pay/page.legacy.tsx 删 ⑤ middleware iframe-allow CSP 决断
- **W6**:① /usage 客户端 dynamic + 分页 ② Sentry 接 [easy-pay/notify] sig fail warn + [quota-cache] fallback warn ③ 移动端响应式 sweep ④ 充值低余额邮件提醒
- **W4-2 LiteLLM 残留(W4-2 D1 报告 + 本批确认)**:W4-2 三 batch 完成 5 项核心端点 + 4 张 UI;**仍排队**:`/api/orders/my/route.ts` 客户后台订单列表(litellm.getCurrentUserByToken)、`/api/admin/user-balance/route.ts`(W5 admin)、`/pay/{orders,[orderId],result,stripe-popup}` 子页(可能也 broken)、`page.legacy.tsx`(W5 sweep 决断删 vs 保留)、`middleware.ts iframe-allow CSP`(W5+)

---

**Signed-off**:W4-2 (D4+D5+D6+D7) 验证信号 ✅(单测 + 集成测 + 全套回归层面),用户手测 ⏳ pending。Stack 在 W4-1 PR #9 之上,merge order = PR #9 先 → 本 W4-2 PR 跟上。
