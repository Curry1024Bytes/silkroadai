# W6 — Client Polish & Retention Week Verification Report

**Date**: 2026-05-05
**Branches**: `feat/w6-d{1..5}-*` (5 stacked PRs, #17 → #18 → #19 → #20 → #21)
**Base**: `main` at `56cd860` (W5 D6 merged, W6 starts here)
**Scope**: 5-day client-polish & retention sprint:
① first-recharge 20% bonus(D1)
② balance-low email alert + threshold config(D2)
③ public /models page with type × vendor grouping(D3)
④ key-limit 5→10 + per-key usage cache(D4)
⑤ server-side usage aggregator + dashboard real cards + W6 收尾(D5)

---

## TL;DR

W3 上 portal auth, W4-1 接 new-api 充值, W4-2 客户后台落地, W5 ops 加固 + 易支付 QR + 法律页. W6 是 **客户体验冲刺** — 5 天密集补完 retention + polish:

1. **首充 bonus** 提升首次转化(¥10 → +20% bonus = ¥12 quota,新用户 onboarding 更甜)。
2. **余额低提醒** 防客户静默断 API(retention 第一杀手)。
3. **公开模型清单** marketing + customer reference 双重作用(379 模型 / 9 厂商)。
4. **多 key + 每 key 用量** 让 prod / test / experiment 用户能看到哪个 key 在烧 quota。
5. **真 dashboard + 全量 usage aggregate** 替代 W4-2 D7 的 200 条客户端 cap(F3 长尾失真),5min 缓存 5 路径(hit / miss / fallback / hard-fail)。

**核心新增**:

- 3 张新缓存表:**首充 flag**(User.first_recharge_bonus_granted) + **每 key 用量**(NewApiToken.cached_used_quota/cached_used_at) + **聚合 cache**(UsageAggregateCache(user_id, period)) + 2 阈值字段(User.balance_alert_threshold_cny, balance_alert_last_sent_at)
- 1 新 portal scheduler:`BalanceAlertScheduler` 1h 扫,镜像 W4-2 Order timeout 模式,Sentry 接驳
- 4 新 API 路径:`POST /api/portal/balance-alert-threshold`(D2)、隐式扩展 `GET /api/portal/keys`(+ usage 字段,D4)、`/models` 公开页(D3)、`/dashboard` 真数据(D5)
- 1 新 lib 子目录:`src/lib/scheduler/`(W6 D2)+ `src/lib/models/`(W6 D3) + `src/lib/newapi/{token-usage,usage-aggregate}.ts`(W6 D4/D5)

整体 **W3+W4+W5 全套累计 + W6 5 天累积 = 67 files / 642 PASS / 1 skip / 0 fail**(smoke 测排除,需 SSH 隧道)。**所有 5 PR 已部署到 prod 验证**(每个 PR 都过了真实容器 rebuild + 公网 smoke / DB schema 校验);**真实浏览器 5 步全套 smoke 由用户跑**(覆盖首充 bonus → 余额提醒 → /models / /keys 用量 → dashboard 真数据)。

---

## W6 验证矩阵

| Day         | Brief                        | 交付                                                                                                                               | 单测                                                     | PR                                                  | VPS 部署                                                             | Migration                                       |
| ----------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| **D1**      | 首充 20% bonus               | `executeRecharge` 加 CAS-claim + interactive tx,`applyTopup` 扩 `extraBonusQuota`,`/pay` 加 banner                                 | 13 unit + 6 integration + 1 banner SSR = 20              | [#17](https://github.com/yexioy/silkroadai/pull/17) | ✅ migrate + container Up + 3 用户 eligible 状态                     | `add_first_recharge_bonus`                      |
| **D2**      | 余额低提醒 + 阈值配置        | `BalanceAlertScheduler`(1h)+ `sendBalanceAlertEmail` + `/balance` 配置 form + `POST /api/portal/balance-alert-threshold`           | 8 scheduler + 3 template + 10 endpoint + 5 form SSR = 26 | [#18](https://github.com/yexioy/silkroadai/pull/18) | ✅ scheduler started + 3 用户 last_sent_at 由首次扫描填入            | `add_balance_alert`                             |
| **D3**      | 公开 /models 双级分组        | `categorize.ts`(type × vendor 规则 + filter helpers)+ `/models` server page(ISR 60s)+ `ModelsBrowser` client + Footer/Sidebar 入口 | 32 categorize + 8 SSR = 40                               | [#19](https://github.com/yexioy/silkroadai/pull/19) | ✅ 公网 200 + 379 模型 9 厂商验证                                    | (no schema)                                     |
| **D4**      | 多 key + 每 key 用量         | `MAX_TOKENS_PER_USER 5→10` + `token-usage.ts`(60s row cache 4 路径)+ `/keys` 并行 fetch + alias 命名建议                           | 10 cache + 6 endpoint/UI = 16                            | [#20](https://github.com/yexioy/silkroadai/pull/20) | ✅ 5 现有 token cached_used_at NULL 状态 + container Up              | `add_token_usage_cache`(含手工 backfill UPDATE) |
| **D5**      | usage aggregator + dashboard | `usage-aggregate.ts`(5min cache + 1-50 页 paging)+ /dashboard 4 真卡 + quick links + /usage 数据源换 aggregator                    | 17 aggregator + 6 dashboard SSR + 9 /usage(更新)= 32     | (本 PR)                                             | ✅ migrate + 两 scheduler started + dashboard/usage 307 (auth-gated) | `add_usage_aggregate_cache`                     |
| **W6 累计** |                              | 9 schema migrations + 3 caches 一次设计完成                                                                                        | **134 新测,无回归**                                      | 5 PR 串(#17-21)                                     | 5 次 prod 部署成功                                                   | 4 schema migrations                             |

---

## W6 设计决策(3 项,已锁)

### 1. 首充 bonus 用「事务内 CAS-claim」而非外部 lock

**问题**: 同一 user 两个不同 order 同时充值,如果两次都拿首充 bonus 就 2× 漏。
**选项**:
(a) Redis lock — 多一个外部依赖,部署复杂度上升
(b) 应用层 in-memory lock — 多实例部署后失效
(c) **DB 行锁 + interactive transaction(选)**

**实装**: `prisma.$transaction(async tx => { tx.user.updateMany WHERE granted=false; applyTopup; ... })`。Postgres READ COMMITTED:第一个 tx 拿到 row lock + 把 granted=true,第二个 tx 阻塞,等第一个 commit 后 re-read,predicate 不符,count=0,bonus=0。applyTopup 在 tx 内,失败即回滚整个 tx,bonus claim 也回滚 — 用户保持 eligible。

**Trade-off**: tx 持有 DB 连接 ~10s(applyTopup HTTP),timeout 设 15s。在 W6 内部用户量级下零问题;真灰度后看 connection pool 指标决定是否抽外部 lock。

### 2. 余额提醒 scheduler 不写 cron,跑在 portal 内部

**问题**: 1h 周期任务 — cron / k8s job / portal 内部 setInterval。
**选项**:
(a) 系统 cron + curl 一个 trigger endpoint — 多一个失败点,需要鉴权
(b) **portal `setInterval` + instrumentation hook(选)** — 镜像 W4-2 已落地的 Order timeout scheduler

**Trade-off**: 单实例部署假设。多实例时多个 portal 容器都会扫 → CAS-claim WHERE last_sent_at < now-24h 防重复发(已实装),所以即使 future 多实例也安全。多实例下唯一缺点是浪费 N×新-api 调用;能接受。

### 3. /usage server-side 50 页 cap + 5min 缓存

**问题**: W4-2 D7 一次 queryLogs page_size=200 客户端聚合,W3 D2 F3 长尾失真(power user > 200 logs/window 数据被截断)。
**选项**:
(a) 移除 cap,real-time 拉全部 — 慢(2-5s),频繁渲染会打爆 new-api
(b) **5min cache + 50 页(50k 条)hard-cap(选)**

**Trade-off**:

- 5min staleness: 客户看 "上月消费 ¥X" 几分钟前的数据 — 完全可接受。
- 50k 条 hard-cap: 重度用户单 month 调用 > 50k 次会被截断。当前 W6 客户没这个量级;真有了再改 streaming aggregate 或 batch job。
- dashboard 4 卡 = 4 次 aggregator 调用,各自 cache(period, user_id)独立 — 第一次冷启 ~10s,第二次 < 100ms。

---

## W6 Findings(累积 informational,不阻塞)

> Severity scheme: 🔴 hard fail / 🟡 informational / 🟢 已修复 / ✅ 已知不修

### F1 (W6 D1 🟡) executeRecharge tx 内 applyTopup HTTP — DB 连接持有约 10s

新增的 interactive transaction 把 `applyTopup` 放进了 callback。new-api HTTP 默认 timeout 10s,加上 prisma 写入 ~100ms = tx 持有连接 ~10s 上限。当前 prod connection pool 默认 10 连接,W6 用户量级 RTS < 1/min,无瓶颈。**未来真灰度 100+ 并发 user 充值时**重新评估 — 可能需要把 applyTopup 移到 tx 外、用 application-layer compensation(brief 接受过这个简化)。

### F2 (W6 D2 🟡) BalanceAlertScheduler 部署后立即触发 — 3 现有用户被发邮件

按 spec 行为:`balance_alert_last_sent_at IS NULL` 视为「从未发过」,首次扫描余额低 → 发提醒。3 现有 prod 测试账户(`1226627765@qq.com`、`bookeryyh@gmail.com`、`arisyem8@gmail.com`)在 W6 D2 部署当下都收到了真实邮件。**这是 spec 行为**(brief 明示 retention 触发条件)。如果想让 future 部署「不打扰存量用户」,migration 可以加 `UPDATE users SET balance_alert_last_sent_at = NOW()` backfill — 不在本批做。

### F3 (W6 D3 🟡) OpenAI vendor 规则比 brief 略宽

Brief 仅列 `gpt-/o1/o3/o4/chatgpt`,但 SiliconFlow 渠道的 `dall-e-*`、`sora-*`、`whisper-*`、`tts-*`、`text-embedding-*` 都是 OpenAI 出品,不归类成 OpenAI 会落到 "Other" — UI 体验不好。我把这些前缀也归到 OpenAI。**严格 brief 行为是更窄**,如果产品决策要 strictly 限定 chat-vendor 才算 OpenAI,这一行可以收回。

### F4 (W6 D3 🟢) 正则 `(^|[\/-])` 字符类边界匹配 `dall-e-3` 失败

首版 `categorizeByVendor` 用单个 regex `/(^|[\/-])(gpt-|...|dall-e|...)/`,看似该匹配 `dall-e-3` 但实测 false。重写成显式 `startsWith` / `includes` 链 — 可读性和正确性双赢。**已修**,详见 D3 commit body。

### F5 (W6 D4 🟡) `queryLogs` `token_id` filter 是 best-effort

新-api 较老 build 可能不识别 `token_id` query 参数,helper 在 client 侧 post-filter 兜底。结果一致(只是多拉了几页其他 token 的 log 然后过滤掉)。**重度用户(高频调用同 user 的多个 token)** 单次 refresh 会多拉数据,但 60s row cache 缓解。无 prod 影响。

### F6 (W6 D5 🟡) 50 页 / 50k 条 aggregate hard-cap

单 user 单 period 超过 50k 次调用时 totalCalls / totalUsedQuota 会少计。pagesFetched 字段暴露给 ops 监控,达到 50 时记录 `[usage-aggregate]` log。当前 W6 用户量级远不到。

### F7 (W6 D5 🟡) `usage_aggregate_cache.payload` 是 JSONB,无 schema 校验

缓存表用 Json 存 payload,反序列化时用 `readPayload(payload)` 做防御性 narrowing(默认 0 / [] 处理 missing field)。**未来 payload 结构升级**(比如加 `byHour` 数组)时,旧 cache 行不会报错,只会返回新 schema 缺省值,直到 5min TTL 过期被覆盖。

---

## 累积技术债更新

### W6 完成的(本批解决):

- ✅ W3 D2 F3 / W4-2 D7 客户端 200-cap aggregate 长尾失真 → W6 D5 server-side 50 页 paging
- ✅ W4-2 D5 dashboard 4 张占位卡(D5/D6/D7 上线 placeholder) → W6 D5 真数据 4 卡
- ✅ W4-2 D5 `MAX_TOKENS_PER_USER = 5` 多环境用户的 headroom 不足 → W6 D4 升 10
- ✅ W4-2 D5 没有 per-key 用量显示(W4-2 brief outscope) → W6 D4 实装
- ✅ retention 缺口(余额低无主动提醒,客户静默断 API) → W6 D2 解决
- ✅ /pay 缺乏 onboarding incentive → W6 D1 首充 bonus
- ✅ marketing 缺乏「379 模型」可验证落地页 → W6 D3 /models 公开页

### 排队 W7+(本批未做,brief 明示 outscope 或新发现):

- ❌ Free / Paid 分层动态 token limit(W6 D4 "❌ 不分阶层")— 未来产品决策
- ❌ 模型 pricing 显示(W6 D3 "❌ 不实装定价")— 等 new-api 暴露 pricing API
- ❌ Admin 模型管理 UI(W6 D3 "❌ 不写 admin")— 仍 admin.silkroadai.io 走运维
- ❌ 后续充值优惠(W6 D1 "❌ 不改后续充值规则")— W6 业务决策已锁:仅首充
- ❌ 余额提醒 SMS / IM 通道(W6 D2 outscope)— 邮件优先,后续看渠道偏好
- ❌ /usage > 50k 条流式 / batch aggregate(F6)— 真有用户跑到再做
- ❌ /balance 实时余额刷新按钮(W6 内部讨论延后) — 60s cache 已够
- ❌ executeRecharge tx 内 HTTP 的 connection-pool 优化(F1)— 真灰度有信号再调

### 历史 W7+ 仍排队(W6 未触碰):

- ❌ Sentry 改 self-hosted(W5 D4 用 sentry.io free tier,免费额度足够)
- ❌ 多 portal 实例水平扩展(W6 单实例假设;Caddy 反代 + StateLess JWT 已支持 sticky session)
- ❌ admin 后台改密 / banned 流(W4-2 outscope)
- ❌ Refund 流程(继承自 sub2apipay,稳定但缺 portal UI)

---

## 测试 fixtures 状态(prod 现 3 user 在 W6 结尾)

| portal user_id | email                 | first_recharge_bonus | balance_alert_threshold | last_sent_at                  | active keys      | last_used_at | newapi_quota  |
| -------------- | --------------------- | -------------------- | ----------------------- | ----------------------------- | ---------------- | ------------ | ------------- |
| `4da0c8e6-...` | `1226627765@qq.com`   | `false`(未充过)      | ¥10.00                  | 2026-05-05 11:47(D2 首扫触发) | 0–N(各 dev 自创) | 多数 NULL    | 由各 dev 自测 |
| `507f33cf-...` | `bookeryyh@gmail.com` | `false`              | ¥10.00                  | 2026-05-05 11:47              | 0–N              | 多数 NULL    | 由各 dev 自测 |
| `96d93d6c-...` | `arisyem8@gmail.com`  | `false`              | ¥10.00                  | 2026-05-05 11:47              | 0–N              | 多数 NULL    | 由各 dev 自测 |

> **5 现有 NewApiToken** 全部 `cached_used_quota=0, cached_used_at=NULL`(D4 backfilled);首次任一 dev 打开 /keys 触发 W6 D4 helper 写入。

> **0 行 UsageAggregateCache**(D5 新表);首次任一 dev 打开 /dashboard 或 /usage 触发 W6 D5 helper 写入。

---

## VPS 部署历史(W6 5 次 rebuild)

| Day   | 部署时间          | Migration                              | 启动日志关键行                                                                             |
| ----- | ----------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| W6 D1 | 2026-05-05 ~11:30 | `add_first_recharge_bonus`             | `Order timeout scheduler started`                                                          |
| W6 D2 | 2026-05-05 ~11:47 | `add_balance_alert`                    | + `Balance alert scheduler started` + `[balance-alert] scan complete: candidates=3 sent=3` |
| W6 D3 | 2026-05-05 ~12:30 | (无 schema)                            | 公网 `/models` 200 / 379 模型验证                                                          |
| W6 D4 | 2026-05-05 ~12:50 | `add_token_usage_cache`(手工 backfill) | container Up + 5 token cached_used_quota=0 验证                                            |
| W6 D5 | 2026-05-05 ~13:?? | `add_usage_aggregate_cache`            | container Up + 两 scheduler 启动 + /dashboard /usage 307 (auth-gated)                      |

---

## 用户手测指引(W6 整周 5 步浏览器 smoke)

1. **首充 bonus(D1)** — 用未充值过的用户在 /pay 选 ¥10、支付宝、扫付。等 60s 看 /balance 应到 ¥12 等价 quota(¥10 主 + ¥2 bonus)。再次访问 /pay 看 banner 应消失。
2. **余额提醒(D2)** — 在 /balance 把阈值改成大于当前余额的值,等 1h 内的下一次 scheduler 扫描(或重启容器立即触发)。注册邮箱应收到中文模板邮件 + 立即充值 link 指 /pay。
3. **公开 /models(D3)** — 不登录访问 https://portal.silkroadai.io/models,看 379 模型 9 厂商分组渲染 + 顶部搜索 "deepseek" 应只剩 DeepSeek 卡 + 复制按钮 toggle "已复制 ✓"。
4. **多 key 用量(D4)** — 在 /keys 创建 6+ key(确认 5 上限解除)+ 任一 key 复制 sk- 真实调一次 /v1/chat/completions → 60s 后回 /keys 看该 key 累计 / 最近调用更新。
5. **dashboard 真数据(D5)** — 任一存在用量的用户访问 /dashboard,看 4 卡渲染:当前余额(CNY+USD)/ 上月消费 / 累计调用次数 / Top 3 模型;quick links 4 个全可点。

---

**版本**: 1.0
**最后更新**: 2026-05-05
