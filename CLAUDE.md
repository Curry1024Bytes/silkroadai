# LLmRoute Portal — Claude Code Project Context

> 这份文档由 Claude Code 自动加载,作为项目永久上下文。
> 每次启动 `claude` 时都会读取,不需要重复说项目背景。

---

## 项目身份

- **名字**: LLmRoute Portal (`llmroute-portal`)
- **GitHub Fork(本项目)**: https://github.com/Curry1024Bytes/silkroadai
- **上游仓库**: https://github.com/yexioy/silkroadai
- **角色**: new-api 客户层(Customer Portal)— W2 D3 已切到 B3 路线
- **来源**: Fork 自 [touwaeriol/sub2apipay](https://github.com/touwaeriol/sub2apipay)(已归档)
- **站点域名**: `llmroute.club`
- **客户 API**: `api.llmroute.club`(已上线,只开放 `/v1/*`、`/v1beta/*` 与方舟视频路径)
- **资源域名**: `images.llmroute.club`(平台 R2 待完成)

> 2026-07-24 品牌由 Silk Road AI 迁移为 LLmRoute。历史进度中的旧域名保留作审计记录;
> `X-Silkroadai-*`、`silkroadai` 元数据命名空间与 JWT issuer 暂时保留为兼容契约。

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

## 当前生产环境与发布规则(2026-11-09 核对)— 必读

当前生产操作以 [`deploy/部署与运维手册.md`](deploy/部署与运维手册.md)为唯一权威手册。
`docs/W5-DEPLOY-RUNBOOK.md` 是旧 `23.27.113.88` / `portal.silkroadai.io` / Caddy 环境的历史归档,
不能用于当前服务器。

- `main`:只同步上游,禁止自定义提交、冲突解决和部署。
- `dev`:开发集成、合并 `main`、解决冲突、类型检查和完整测试。
- `prod`:唯一生产发布分支,只接收测试通过的 `dev` fast-forward;VPS 只部署 `prod`。
- 上游同步必须先输出北京时间/SHA/行为/migration/env/基础设施/冲突报告,再执行 `main -> dev`。
- 当前 VPS:`103.240.199.146`(SSH 别名 `llmroute-prod`),CentOS Stream 9,SSH 22,项目 `/opt/silkroadai-portal`。
  `82.29.71.122`(AlmaLinux)是上一台服务器,不要再连。
- 当前入口:Cloudflare Full (strict) → 宿主机 Nginx → Portal `127.0.0.1:3002`。
- new-api:`172.17.0.1:3000`,网络 `new-api_new-api-net`,数据库是 PostgreSQL 15(容器 `postgres`,库 `new-api`);
  Portal 走 `http://host.docker.internal:3000`。
- 已验收:apex/`www`、`api.llmroute.club`(只开 `/v1/*`、`/v1beta/*` 和方舟视频两条路径,见手册 6.3)、
  Google OAuth、GitHub OAuth、zpayz 支付宝充值和余额入账。
- 未完成:SMTP、平台 R2/OSS、Sentry、Tavily、SSH key-only、异机备份与恢复演练。
- `NEWAPI_LOGS_DATABASE_URL` 保持 unset,用量日志走 10,000 行 fallback。
- compose 含 API 副本和 Seedance 服务,当前服务器部署必须显式指定 `portal`,禁止裸 `docker compose up`。
- 2026-08-03 待发布:客服微信 `LLmRoute` 的 forward migration/重建,以及 `main@da510e7` 的 10 个上游提交。
- rc.22 开户兼容:优先使用登录响应 `data.access_token`,仅旧版 `session=` cookie fallback;
  `new_api_refresh` 不是 session。Google/GitHub 真实开户已验证。

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

## 项目沿革(一句话)

W1 走 LiteLLM(15 模型),W2 D3 切 new-api,W3 补齐 Auth 与 OAuth,W4 充值流与客户后台,W5 运维加固,W6 留存冲刺,W7 品牌与落地页,W8 文档与定价,W9 自有 `/v1/*` 代理与生图,之后是 ChatUI、请求捕获、Batch、企业门户、动态售卖规则。**逐天进度不再维护在本文**:查 `git log`,或看下面的深度分析。

---

## 深度分析(2026-11-06,取代原 docs/ 的 93 份一次性记录)

### 一、钱是怎么算出来的

**new-api 扣费 = 模型价格 × 分组系数 × 限时折扣**。三者都按**客户请求里的模型名**查,渠道的 `model_mapping` 发生在计价**之后**,所以改 mapping 不改价。

分组系数取第一个存在的值,**不相乘**:

1. 分组内用户专属倍率 `GroupUserRatio`(fork 自带,Portal 不读不写)
2. `GroupGroupRatio[用户分组][计费分组]`(Portal 的客户专属倍率写这里)
3. `GroupRatio[计费分组]`(档次倍率)

**GroupRatio 是该组的 ¥/$ 汇率直读**(2026-07-20 重锚)。per-model 基准与组无关:chat `ModelRatio = 官方$in ÷ 2`、`CompletionRatio = $out/$in`、`CacheRatio = $cache/$in`;图片视频 `ModelPrice = ¥零售 ÷ 1.2`。实扣 ¥/1M = 2 × MR × GR,quota 标尺 500k = ¥1。**2026-07-20 之前任何文档里的「GR = ¥×5 / ÷1.2」换算全部作废。**

⚠️ **分组倍率双键**:`GroupRatio` 与 `group_ratio_setting.group_ratio` 写进同一张内存表,new-api 每 60 秒按数据库原样重放全部 option 行、无排序,最后应用的那行生效。两行不一致时倍率会来回跳。**改整组 ¥ 率必须两键同写 + 重启**,单改一键必翻车(2026-07-26 default 组误翻倍 2× 多收、az-gpt ¥5,593 两次事故都是这个)。`planGroupRatioWrites` 现在总是用完整目标表写双键。

**四种价格形态**,Portal 都能读写:

| 形态           | new-api option                                                       | Portal 读写                                          |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| 按 token       | `ModelRatio` / `CompletionRatio` / `CacheRatio` / `CreateCacheRatio` | `readBasePrice` → `planModelWrites`                  |
| 按输入长度分档 | `billing_mode=tiered_expr` + `billing_expr`(`len <= N ? tier(...)`)  | `pricing-tiered-expression.ts`                       |
| 按次           | `ModelPrice`                                                         | 同按 token                                           |
| 视频参数矩阵   | `tiered_expr` + `u("resolution")`/`u("video_input")` 8 档            | `pricing-video-token-expression.ts`(2026-11-06 新增) |

**计费表达式的边界**:`billing_expr` 能读 token/媒体用量、`header()`、`param()`、`u()`(任务用量,仅 Task Plugin 渠道)和时间函数,**但没有分组、客户、渠道变量**,结果仍乘分组系数。所以 new-api 原生**做不到**「同一分组内按模型给不同客户不同价」。要做只有四条路:换模型名、Portal 注入请求头、Portal 自己计费、或拆独立计费分组。

**视频任务的坑**:提交时表达式拿到的 token 参数是空的,`p`、`c` 恒为 0;表达式模式还要求渠道上报用量字段,**只有 Task Plugin(65)满足**,其他视频渠道选表达式会每次 400 `model_price_error`。

### 二、Portal 目录的三层

**档次(`channel_groups`)→ 模型(`catalog_models`)→ 每档一价(`catalog_prices`)**

- 档次 = 一组 new-api 渠道 + 一个卖价。`key` 是 Portal 内部标识,`newapi_group` 才是下发到客户 Key 的值,两者解耦。`purchase_rate`(进货率)只存 Portal、只算毛利,**从不参与扣费**。
- 模型的 `upstream_map` 记「哪个档次 → 哪个渠道 → 上游模型名」。同一模型在不同档次可映射不同渠道甚至不同上游名。
- 价格按「模型 × 档次」一行,改价**不覆盖**而是插新行,`effective_from` 区分;现行价取不晚于当下的最新一条。复杂计费存 `billing_details` JSON(四种模式),标量三列只放首档价给旧代码兜底。
- 一个模型要在公开页出现,三个条件同时满足:模型 `enabled`、`upstream_map` 里有**启用档次**的映射、该档有价格行。少一个就不显示。

`ChannelGroupTopology` 强制:每租户恰好一个启用默认档,一个渠道只属于一个启用档(镜像模式例外),new-api 分组与档次一一对应。

### 三、改价的两条路

**定价页 `/admin/pricing`(同步写,首选)**:事务内加定价互斥锁 → 读 new-api 现值与页面打开时比对(乐观锁)→ 只写变化的 key → **回读逐项核对** → 写 `CatalogPrice` 快照 + `AdminAuditLog`。回读不一致就报错且不更新目录。

**签名任务发布链路(V1–V7)**:**2026-11-08 已拆除**(见 `docs/2026-11-08-拆除签名发布链路.md`)。它的持久化核验只接受 `mysql://` 而生产 new-api 是 PostgreSQL,调度器也因 `NEWAPI_PRICING_DATABASE_URL` 未配置而从未启动,三张发布表在生产一直是空的。改价只有定价页这一条路。

### 四、`/v1/*` 代理

客户所有请求的入口是 `src/app/v1/[...path]/route.ts`,Caddy/Nginx 把 `/v1/*` 和 `/v1beta/*` 给 Portal,其余给 new-api。三条分支:

1. **Gemini 生图翻译** — `/v1/chat/completions` 翻成 native `:generateContent`,注入 `imageConfig.imageSize`,再转回 OpenAI 形。入参支持 multimodal `image_url`,出图传客户 OSS 或平台 R2(三级降级)。
2. **Claude clamp** — `max_tokens > 4096` 钳到 4096。
3. **原样透传** — SSE 不缓冲。

⚠️ **翻译/改写 body 时必须同步改 `Content-Type`**。`forwardHeaders` 不剥 CT,原 multipart 的 boundary 带给 JSON body 会让 new-api 读爆缓冲(500 `bufio: buffer full`)。用 `jsonForwardHeaders`。任何「读入一种 body 形态、转发另一种」的地方都要重设出口头。

SSE 两件套在 `src/lib/sse/stream-guard.ts`:上游静默 >15s 注 `: keep-alive` 注释防 CF 掐线(只在行边界注);流中断注格式内合法的错误尾帧再收流。**读错误 body 必须带钟** —— `controller.error()` 会丢弃未读队列。

### 五、发布流程

`dev`(开发集成)→ 快进 `prod`(唯一发布分支)→ 部署。`main` 只镜像上游。

1. 改 `.github/workflows/build-native-amd64.yml` 的 `VERIFIED_SOURCE_SHA` 钉到本次提交,推 `dev` 和 `prod`
2. GitHub 原生 amd64 构建(约 5 分钟)。**禁止在 4GB 生产机上编译**
3. **先打回滚标签**(指向当前运行镜像)再加载新镜像 —— 顺序错了旧镜像会因 `latest` 改指向而不可寻址
4. 备份 `.env` 与数据库,都要 0600 + `gzip -t`
5. 服务器用 GitHub 一次性签名链接取产物,核对 zip digest、`SHA256SUMS`、源码 SHA、image ID 等于归档 manifest、revision label、架构
6. **脱离 SSH**(`nohup setsid`)跑切换脚本:先核 `busy=0`(无在途定价任务/图片任务/Batch/未完成 migration),起 0.5 秒探测,只重启 `portal`
7. 核对:启动日志 migration 数、`Ready in`、restart count、OOMKilled、依赖容器 ID 未变、`probe.log` 实测停机
8. 公网验收 + 删上传归档(目录保留 `release.json`、校验文件、脚本、`evidence/`)

**compose 必须显式写 `portal`**,裸 `docker compose up` 会误启动 API 副本和 Seedance 服务。

`gh` 默认指向上游 `yexioy/silkroadai`,**必须传 `--repo Curry1024Bytes/silkroadai`**。`~/.gitconfig` 钉了 github 代理,7897 和 10808 轮流挂,用前先探活。

### 六、已知缺陷与技术债

| 问题                                | 位置                                   | 影响                                                                                         |
| ----------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| 基础价调整不列受影响客户            | `saveModel`                            | 纳管分组里有折扣的客户会同比例变价,预览不提示,违反规格第 6 节                                |
| 不支持取消纳管                      | `pricing-rules/`                       | 分组一旦纳管只能前进                                                                         |
| 同 new-api 分组被多档共用时拒绝纳管 | 同上                                   | 含跨租户共用                                                                                 |
| `catalog-discounts.ts` 无调用方     | `src/lib/billing/catalog-discounts.ts` | 通用目录折扣逻辑只有测试在用,未接任何扣款入口                                                |
| 成本工作台把视频一律按秒            | `pricing-cost.ts`                      | 2026-11-06 加了 `video_unit: 'million_tokens'` 才支持按 token;成本规则只有修订号没有生效时间 |
| Portal 自有账本只计 in/out token    | `src/lib/billing/`                     | 不含图片、缓存、阶梯、视频;生产未启用,用户均 `billing_mode=newapi`                           |
| 排空钩子曾让发布停机 246 秒         | `src/lib/server/drain.ts`              | 2026-11-06 已修(见下)                                                                        |
| DeepSeek 时间条件公式 Portal 读不了 | `pricing-tiered-expression.ts`         | 两个模型的价格只能在 new-api 维护,同步时会提示                                               |
| 请求捕获默认关                      | `REQUEST_LOGGING`                      | viewer 已上线但列表空,要 operator 配 env                                                     |

**排空缺陷(2026-11-06,已修)**:Next 自己的 SIGTERM 处理只在 **dev** 调 `server.closeAllConnections()`,生产只 `server.close()`,于是等 nginx 的**空闲** keep-alive 连接(`location /` 用 `proxy_http_version 1.1` + `Connection ""`)。排空钩子给响应加 `Connection: close` 碰不到空闲连接 → 进程永不退出 → compose 等满 `stop_grace_period: 630s`,而监听已关,公网 502。**停机时长与切换前的流量成正比**,所以凌晨发布只停 10 秒、下午发布停 246 秒,缺陷藏了很久。现在排空时对每个见过响应的 server 调 `closeIdleConnections()`。

### 七、运维口径

- 生产 new-api 跑 `new-api-custom-full` 的 `main@8c02661`。二进制不含提交号(`.dockerignore` 排除 `.git`,`VERSION` 空),靠**特征字符串**比对认版本:含 `decode image request for model mapping` 则 ≥ `8c02661`,含 `content is not supported; use prompt, images, videos, and audios` 则 ≥ `289febd`。
- 只读查生产库:复用 operator 现有的 `llmroute-prod` ControlMaster,加 `-o ClearAllForwardings=yes -o BatchMode=yes`,`PGOPTIONS` 带 `default_transaction_read_only=on`。**永不 select `channels.key`、`setting.proxy`、`header_override`、`param_override`、`tasks.private_data`**。
- 渠道改动或上游扩容后必须跑 `scripts/rebuild-channel-model-mapping.ts`,否则 W1 时代的短名静默 503。
- `pnpm lint` 在有 worktree 时会崩,用 `--ignore-pattern '.claude/**'`。
- 时间显示一律 `toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })`。容器 `TZ=UTC`,不写 timeZone 会把 UTC 当北京时间显示给客户。

---

## 需求文档约定

`docs/` 只放需求文档,一个需求一份,不再堆一次性记录。

- 命名 `<YYYY-MM-DD>-<需求名>.md`
- 头部必须有状态行:`状态：进行中` 或 `状态：已完结（<YYYY-MM-DD>）`
- 内容:需求、方案、与方案的偏离、验证结果、未决问题
- **完结后不再改动**。再有新需求另起一份,需要引用旧结论就写明文件名
- 本文不再记逐天进度;生产发布记录仍写 `deploy/部署与运维手册.md`
- 2026-11-06 之前的 93 份历史文档已删。本文和部署手册里凡提到 `docs/<文件名>` 的,都可用
  `git show 7458acc6:docs/<文件名>` 取回(含 `docs/superpowers/` 下的路径)
- 现存:`docs/真实上游毛利报表-需求文档.md`(进行中,2026-08-10 梳理,未实现)

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

| 操作                         | 函数                      | new-api 端点                                          |
| ---------------------------- | ------------------------- | ----------------------------------------------------- |
| 注册时建 new-api user(admin) | `createUser`              | `POST /api/user/`                                     |
| 反查 user / 拿登录 cookie    | `loginAsUser`(内部)       | `POST /api/user/login`                                |
| Rotate 出客户 access_token   | (用 cookie 调 call)       | `GET /api/user/token` ⚠️ **是 rotate 不是 read**      |
| 给 user 创建 token           | `createTokenForCustomer`  | `POST /api/token/` (act-as customer)                  |
| 拿 token 真实 key            | `getTokenKey`             | `POST /api/token/{id}/key` (返回 `{key:"sk-..."}`)    |
| 列出客户的 tokens            | `listTokensForCustomer`   | `GET /api/token/?p=&page_size=` (act-as)              |
| 充值入账                     | `addQuota` / `applyTopup` | `POST /api/user/manage` `action=add_quota`            |
| 查用户余额(quota)            | `getUser`                 | `GET /api/user/{id}`                                  |
| 查用量日志                   | `queryLogs`               | `GET /api/log/` (filter by **username** 不是 user_id) |
| 列出可用模型                 | `listAvailableModels`     | `GET /api/channel/models_enabled`                     |
| 高层封装:开通新客户          | `provisionNewCustomer`    | 6 步内部串联(W2 D6 验证)                              |

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
  **W3 runbook 必读**:任何运维操作前先确认是否会触发 rotate。如果 admin token 真的丢了,流程是
  "通过 SSH 隧道进入当前 new-api 后台 UI 重新生成 → 写回服务器 .env → 重启 Portal"(不要从 API 试图重新拿)。
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
  **修复 commit**:运维操作,无 portal commit;在当前 new-api 后台 UI 配置。

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

### 20. server-side `toLocaleString` 必须显式 `timeZone: 'Asia/Shanghai'`

**问题**:`new Date(ts).toLocaleString('zh-CN')` 没指定 timeZone 时,**locale 决定格式语言('zh-CN' 即 yyyy/M/d HH:mm:ss),timeZone 完全独立 — 默认跟随 server 的 `process.env.TZ`**。Docker 容器(includes our portal in `/opt/silkroadai-portal/docker-compose.prod.yml`)默认 `TZ=UTC`,所以 server component(SSR)渲染出的 `2026/5/23 15:52` 其实是 UTC 时间,在北京客户那里实际是 23:52。客户看到 15:52 以为是下午,但 ta 北京时间 15:52 没用过 API,引起投诉。

**正确写法**:`new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })`。把 timeZone 显式写出来,不依赖 server `TZ` 环境变量。`toLocaleDateString` 同理。

**为什么不能改 server TZ env**:

1. 不能保证所有部署环境一致(dev / CI / prod)
2. 副作用太大 — server TZ 会影响 cron 调度、JWT timestamps、DB query 时间窗等所有依赖 `new Date()` 的逻辑;改它要全链路重测
3. **代码层 explicit timeZone 才是 deterministic 写法**

**Client component 是否需要?** 严格不需要(`toLocaleString` 在浏览器端跑,自动用 browser TZ,客户在北京 = Asia/Shanghai = 正确)。但**加上 `{ timeZone: 'Asia/Shanghai' }` 仍然推荐**,因为:(a) 全站统一 = 客户在海外访问也看北京时间 = 跟 operator/支持文档一致;(b) 任何被改写成 SSR 的 client component 自动免疫这个 bug。

**首次发现**:2026-05-23 客户报告 /usage 时间对不上(task #22)。一次性扫全仓修了 9 处:`usage/page.tsx` `balance/page.tsx` `keys/keys-list.tsx` `ImageModal.tsx` (×2) + reseller 3 处 + `UserSubscriptions.tsx` + `admin/subscriptions/page.tsx`。**新增任何时间显示都必须带 `{ timeZone: 'Asia/Shanghai' }`,review 时把这条当硬性 checklist**。

### 21. proxy 翻译/改写 body 时必须同步改 Content-Type(别让 `forwardHeaders` 把原 multipart CT 带给 JSON body)

**症状**:`/v1/images/edits` 用 **multipart/form-data** + 正确 Gemini 模型 → new-api 返 `500 {"message":"multipart: NextPart: bufio: buffer full"}`(数据形态不同也可能是 `NextPart: EOF`,同一 bug 两副面孔)。`x-new-api-version` / `x-oneapi-request-id` 响应头证明错误来自 new-api 不是 portal。

**根因**:`src/app/v1/[...path]/route.ts` 的翻译分支(`handleImagesDalle` / `handleGeminiImage`)命中 Gemini 模型时把 body 换成 `JSON.stringify(generateContent payload)`,但 fetch 用 `headers: forwardHeaders(req)`。`forwardHeaders` **只剥** host/content-length/connection/keep-alive/transfer-encoding,**不剥 `Content-Type`** → 原 multipart 请求的 `Content-Type: multipart/form-data; boundary=----xxx` 被原样带给 JSON body。new-api 信这个头,把 JSON 当 multipart 解析、找不到 boundary 一路读爆缓冲。

**解决**:翻译/改写 body 后 **Content-Type 必须跟 body 的真实形态一致**。本仓用 `jsonForwardHeaders(req)`(= `forwardHeaders` + `h.set('content-type','application/json')`)给两处 generateContent fetch。`Headers.set` 是覆盖(不是追加),原 multipart CT 连 boundary 一起被替掉。

**对比正确的几条**:`forwardToNewApi`(JSON 透传,原请求本就是 JSON,CT 匹配)、`forwardMultipart`(非 Gemini multipart 透传,**显式 `headers.delete('content-type')`** 让 fetch 按重建的 FormData 重生 boundary)—— 这两条本来就对,所以 bug 只在「body 被换成 JSON 但 CT 没改」的翻译分支。

**通用规则**:任何 proxy 层「读入一种 body 形态、转发另一种 body 形态」的地方(JSON↔multipart↔stream),都要把 `Content-Type`(+ 必要时 `Content-Length`)按出口 body 重设,不能无脑透传入口的头。

**首次发现**:2026-06-08 客户 multipart 改图 500(W9 D4 images hotfix-2,`hotfix-multipart-content-type-brief.md`)。修复 commit:见 `fix/proxy-multipart-translate-content-type`。

### 22. gpt-image edits 的 `size=auto` 在按张计费上游上多半是「恒方图」,不是「跟随输入图」

**症状**:客户 `/v1/images/edits` 不传 `size`(或传 `auto`,OpenAI SDK 默认)+ 非方形输入图 → 出 1024×1024 / 2048×2048 方图,客户以为我们改了尺寸。
**真实行为**(2026-09-16 用近 24h 适配器 `[image-adapter] ok` 日志的 `size: 'auto→WxH'` 字段实测):frimodel 家族(ch204 medium / ch207 low)对 `auto` **100% 出方图**(1024² 或 2048²),完全无视输入图比例;ominiapi(ch186 high)跟随输入比例但分辨率由它定,且混有 1254²/1672×941/816² 这类 ChatGPT 网页特征尺寸(号池成员)。OpenAI 官方 edits 的 `auto` 才是跟随输入图。
**解决**:PR #466 起代理层 `resolveGptImageEditsAutoSize` 在 edits 且 `auto`/缺省时按第一张输入图比例补明确 WxH 再发上游(只作用经 portal 的请求)。**排障口诀**:客户报「指定尺寸出方图」先查 new-api `logs.content` 的 `大小 X` —— 那是 new-api 收到的原值,代理对裸 `gpt-image-2` 的显式 WxH 一律透传、只把 `16:9` 这类比例串折成像素、变体名补固定尺寸,不会把 WxH 改成 `auto`;`大小 auto` = 客户端没发(new-api 对 gpt-image 不给空 size 补默认,空 size 时日志根本没有 `大小` 段)。想看 `auto` 实际出了什么尺寸,用 ct 反推(1024² high=7024 / medium=1756 / low=196,2048² high=14272)或查适配器 ok 日志,不要猜。
**prompt 里写比例 ≠ 指定画幅(#468 前)**:按张上游对 `auto` 是「模型自己定画布」,模型有时听 prompt 里的「16:9」有时不听(实测 4/10),客户会把偶然命中当成功能。#468 起代理在 `auto` + edits 时把 prompt 里的明确比例字样当画幅指令补成显式 size,变成确定行为;但正确用法仍是显式 `size`。

**别碰 generations**:generations 的 `auto` 上游出 2048²/1024×1536/1536×1024,一周 73.8 万次、¥25 万,是既有产品行为;任何把 generations `auto` 补成 1024² 的写法都会砍半收入(`gptImageFallbackSize` 对无图请求返回 1024²,不能复用到这里)。

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

## 分支与发布规则 — **必读**

- **`main`**:只用于同步上游变更,保持为 upstream mirror。不要在 `main` 上做本项目业务改动,也不要从 `main` 直接上线。
- **`dev`**:日常开发与集成分支。本项目自研改动、从上游同步来的变更、merge/rebase 冲突解决,都在 `dev` 完成。
- **`prod`**:线上发布分支。只有 `dev` 测试通过后,才把确认要上线的内容同步到 `prod`;VPS 生产部署必须拉 `prod`。
- **发布顺序**:upstream → `main` → 合入 `dev` 并解决冲突 → 测试验证 → 同步到 `prod` → VPS 手动部署。

---

## 编码规范

- 用户可见文案统一通过 `src/lib/i18n/messages/` 提供中英文；保留 LLmRoute 公共配置、协议字段与路由语义。

- **TypeScript strict** — 不允许 `any`,用 `unknown` + zod 校验
- **错误处理** — 自定义 Error 类带 status code,别 throw 字符串
- **API route** — 入口先 zod parse,出口 NextResponse.json
- **数据库** — 所有 mutation 走 Prisma transaction(`$transaction`)
- **commit message** — 用 conventional commits:
    - `feat(auth): add login endpoint`
    - `fix(litellm): handle key not found`
    - `chore: update deps`
- **临时分支** — 需要拆任务时用 `feat/xxx` / `fix/xxx`,最终先合回 `dev`;不要绕过 `dev` 直接进 `prod`

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
# 真实 new-api 烟雾测试需要 SSH 隧道(~/.ssh/config 的 llmroute-prod 已配好 3000/5432 转发与 ControlMaster):
ssh -fN llmroute-prod

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

# 部署到当前 VPS
# ⚠️ CI 不自动部署。发布按本文「五、发布流程」和 deploy/部署与运维手册.md 最近一次发布记录走:
#    钉 VERIFIED_SOURCE_SHA → GitHub 原生 amd64 构建 → 先打回滚标签 → 备份 → 服务器用签名链接取产物并核对
#    → 有 migration 时在备份副本上试跑 → nohup setsid 跑切换脚本(只重启 portal)→ 验收。
#    **禁止在 4GB 生产机上 docker compose build**;也禁止裸 `docker compose up`(会误启 API 副本/Seedance)。
#    上一次发布的脚本在服务器 /opt/llmroute-releases/<sha8>/(backup.sh、fetch.sh、migtrial.sh、switch.sh)。
ssh llmroute-prod
```

上线前配置检查提醒:

- 用户说「上线前检查」「部署前检查」时,必须核对 VPS 真实配置 `/opt/silkroadai-portal/.env`,不要只看仓库模板。
- 新服务器可先 `cp .env.prod.example .env`,但所有 `CHANGE_ME` 必须人工填真实值。
- Google/GitHub 登录必查:`APP_URL` / `NEXT_PUBLIC_APP_URL` / `BRAND_COOKIE_DOMAIN` / `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` / `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` / `GITHUB_OAUTH_REDIRECT_URI`。
- 生产 Google redirect 必须逐字为 `https://llmroute.club/api/auth/oauth/google/callback`,并且 Google Cloud Console OAuth Web Client 里也要填同一个 URI。
- 生产 GitHub callback 必须逐字为 `https://llmroute.club/api/auth/oauth/github/callback`,并且 GitHub OAuth App 的 Authorization callback URL 里也要填同一个 URI。
- OAuth 变量是运行时变量,改完重启 portal 即可;如果同时改了任意 `NEXT_PUBLIC_*`,必须按
  `deploy/部署与运维手册.md` 显式传 `APP_URL=https://llmroute.club` 重新 build,再 `up -d portal`。
- 验证命令:`curl -I https://llmroute.club/api/auth/oauth/google/start`,期望 302 到 `accounts.google.com`;`curl -I https://llmroute.club/api/auth/oauth/github/start`,期望 302 到 `github.com/login/oauth/authorize`。
- 支付上线必查:`PAYMENT_PROVIDERS=easypay` / `ENABLED_PAYMENT_TYPES=alipay,wxpay` / `EASY_PAY_PID=2026072211025295` / `EASY_PAY_PKEY` / `EASY_PAY_API_BASE=https://zpayz.cn` / `EASY_PAY_NOTIFY_URL=https://llmroute.club/api/easy-pay/notify` / `EASY_PAY_RETURN_URL=https://llmroute.club/pay/result`。`EASY_PAY_API_BASE` 不带末尾 `/`;`EASY_PAY_PKEY` 不进 git,只填 VPS `.env`。
- zpayz 易支付对应关系:创建支付走 `POST /mapi.php`(不是 `/submit.php`),notify 是 `GET /api/easy-pay/notify?...` 且必须返回纯 `success`;成功响应的 `payurl` / `qrcode` / `img` 都已兼容。zpayz 文档订单查询示例是 GET 带 `key`,代码当前为避免密钥进 URL 日志用 POST 查询;查询不是入账主路径,上线 smoke 若发现不兼容再调整。

---

## 环境变量速查(`.env`)

最少需要这些才能跑起来:

```bash
DATABASE_URL="postgresql://portal:devpass123@localhost:5433/silkroadai_portal_dev"

# new-api 后端(B3 主链路)— 本地通过 SSH 隧道:
#   ssh -fN llmroute-prod
NEWAPI_BASE_URL="http://localhost:3000"
NEWAPI_ADMIN_TOKEN="<在当前 new-api 后台个人设置生成,密码管理器存档>"
NEWAPI_ADMIN_USER_ID=1                            # root 通常是 1
NEWAPI_QUOTA_PER_USD=500000                       # 1 USD = 500k quota(new-api 默认)
USD_TO_CNY_RATE=7.2

PORTAL_JWT_SECRET="本地随便生成 64 字节 hex"
ADMIN_TOKEN="本地随便生成 32 字节 hex"

# W9 D3:客户自定义 OSS 凭证的 AES-256-GCM 加密 key(64 hex = 32 bytes)。
# ⚠️ 一旦投产且有客户保存过 OSS 配置就【不可更换】(换了已存 secret 全解不开)。
# 生成:openssl rand -hex 32 ;prod 已生成并存 1Password。
PORTAL_OSS_ENC_KEY="本地随便生成 64 hex(openssl rand -hex 32)"

NEXT_PUBLIC_APP_URL="http://localhost:3002"
APP_PORT=3002
```

完整列表见 `.env.example`;生产模板见 `.env.prod.example`,当前生产操作见 `deploy/部署与运维手册.md`。
LiteLLM 时代的 `LITELLM_*` 变量保留作 fallback,W3 D1 关停后可删。

---

## 项目外部依赖说明

- **new-api**: 当前部署在 `103.240.199.146`,容器端口发布到宿主机 `172.17.0.1:3000`,Portal 通过
  `host.docker.internal:3000` 访问;客户经 `api.llmroute.club` 进入 Portal 的 `/v1/*` 代理,不直连 new-api
- ~~**LiteLLM**~~ — Stopped at W3 D1 (2026-05-02), container deprecated, config archived
- **Sub2API**: 部署在 VPS,作为 new-api 的一个 Custom 渠道上游(portal 不直接调)
- **易支付**: zpayz (`https://zpayz.cn`),支付宝充值/callback 已在当前生产验证;PID/KEY 只放生产 `.env`
- **SMTP**: 代码支持腾讯企业邮箱,但当前新服务器账号/密码为空,验证与找回邮件不可用
- **Cloudflare**: apex/`www` 已橙云 + Full (strict);平台 R2、`images` 子域仍待配置
- **筷子 AI 开放平台**(`aiopenapi.kuaizi.cn`,上游 #386): 企业门户「火山」渠道(volc region)的**视频 + 素材库**候选上游;平台级共享 ApiKey(`ENTERPRISE_KUAIZI_KEY`,仅企业实例需配)。⚠️ 素材库按 **ApiKey 账号**归属,无 user 级隔离,当前生产未配置凭据、功能保持 dormant；采用前必须完成隔离和合规审计。

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
- **客户跑过来问业务问题** → 用户自己处理(LLmRoute 微信)

---

**版本**: 2.3
**最后更新**: 2026-09-01(同步上游 #384–#390；仅在 dev 合并，prod 未变)

## 上游同步 2026-09-08

已集成 #391–#448 的代码，详细语义审计见 `docs/UPSTREAM-SYNC-2026-09-08.md`。Batch 默认关闭；MiniMax/Seedream 仅内部适配器，未配置渠道或验收。上游 server1/server2/ch214 的部署记录不属于 LLmRoute；部署仍仅 prod、Nginx、主 Portal 单实例。

## 上游同步 2026-09-09

已按先报告后合并的顺序集成 `main@fd6b2cd`（#449–#451），见 `docs/UPSTREAM-SYNC-2026-09-09.md`。保留固定 SKU 计费与尺寸，接入 Seedance 2.5 费率/480p 默认上游名修正及独立 Image 2.5 适配器。`/image-adapter25/` 已加入仓库 Nginx 公网隔离配置，provider 未配置或真实验收。operator 已暂停上线；完整测试仅本机 new-api 目标返回 HTML 的既有联机 smoke 失败，prod 保持 `02cbf26`，本轮未登录 VPS。

随后完成发布准备：Image 2.5 增加默认关闭开关 `PORTAL_IMAGE_ADAPTER25_ENABLED=false`，Batch 继续关闭；新供应商内部缺陷尚未修复，不能启用。operator 恢复 SSH 隧道后，完整测试含真实只读联机检查全部通过（287 files / 3680 passed / 1 既有 skipped），类型/构建通过、lint 0 error / 93 warnings。prod 仍保持 `02cbf26`，未部署；后续迁移、Nginx 和生产验收要求见 `docs/RELEASE-READINESS-2026-09-09.md`。

operator 随后重新安排上线，`prod@d3c60d3` 已于北京时间 2026-09-09 15:33 在 VPS 发布。76 条 migration 全部完成，50 项源站/公网检查通过，12 个持久用户 token 与真实客户 Key 模型列表鉴权通过，三档图片价格未变；Image 2.5/Batch 显式关闭。切换约 6 秒短暂不可用后恢复，Portal restart count 0，数据库和 new-api 未重建。生产配置备份与回滚镜像均保留，详细结果及现有 Cloudflare Python-urllib 1010 限制见 `docs/DEPLOY-2026-09-09.md`。之后仅文档跟进，不重建运行镜像。

## 上游同步 2026-09-14

本批 #459–#464 在 dev 集成，合并前报告见 `docs/UPSTREAM-SYNC-2026-09-14.md`。接入视频非 2xx 失败状态识别及未指定比例时不注入 16:9；we-token 三个 provider 的等待响应头超时改为 300 秒，其他 provider 默认 600 秒。Image 2.0 的 wetoken/wetokenasia 仅接受 low/medium；Image 2.5 新增两个带 quality 白名单的候选 provider，但入口继续默认关闭，Batch 也继续关闭。上游事故中的客户信息、渠道编号、server2/Caddy 与耗时测量不属于 LLmRoute 生产事实；不采用其部署叙述。本轮无 migration/env/依赖/服务器配置变化，只有 operator 安排本批上线后才部署 VPS。测试及最终分支状态以同步报告为准。

## 2026-10-25 上游集成边界

本轮55提交的逐项行为、配置与风险以 `docs/UPSTREAM-SYNC-2026-10-25.md` 为准。保留LLmRoute当前生产运维、镜像分组、价格、授权、日志及视频缓存语义；上游部署/客户key/收费测试不属于本项目事实。模型广场采用上游组件并适配本项目只读目录和报价。新增有限Key额度、回调、自动补扣及Gemini适配器默认关闭，视频提交默认不重发。

## 2026-10-29 火山方舟原生视频入口

`/api/v3/contents/generations/tasks`（提交）与 `/{id}`（查询）由 `src/lib/seedance/ark-native.ts` 转给 new-api doubao 插件原生路由，已上线（`release-3074a2bd`）。`UPSTREAM_TO_CLIENT_MODEL` 必须与 new-api 渠道的模型重定向逐条互逆，加模型时两处一起改。提交带 `callback_url` 返回 400（#271 同一规则），查询缺 `status` 时由 Portal 补齐。API 子域 Nginx 只开这两条路径；线上 Nginx 文件有仓库模板没有的 ACME 块，改配置时按 diff 打补丁，不要用模板覆盖。已上架为 new-api 渠道 #13（Task Plugin、doubao 插件、分组「SD官转」），价格 = 官方价 ÷ 7.5（两位小数进 1），2026-10-29 首条真实任务验收通过；Cloudflare 规则表达式与带参考视频等验收仍待处理，见 `docs/视频模型兼容1.0.md` 第 6 节与手册文末记录。

## 2026-11-05 动态售卖规则第一阶段

定价页「售卖规则」标签与客户页「售卖折扣」面板已上线（`release-f1ca81eb`，北京时间 22:27），代码在 `src/lib/pricing-rules/`，规格与计划见 `docs/superpowers/`。上线时没有纳管的计费分组，价格未变；首次纳管和旧倍率换算须 operator 确认（计划第 10 节）。生产 new-api 没有 `group_ratio_setting.*` 点号行，定价页保存档次只写经典 `GroupRatio`。Portal 发布现走 GitHub 原生构建、服务器拉取产物、在备份副本上试跑 migration 后再切换，见手册文末记录；手册未记 2026-11-04 至 11-05 凌晨的 `00582268` 与 `f219384f` 两次发布。
