# LLmRoute Portal — Codex Project Context

> 这份文档由 Codex 自动加载,作为项目永久上下文。
> 每次启动 `Codex` 时都会读取,不需要重复说项目背景。

---

## 项目身份

- **名字**: LLmRoute Portal (`llmroute-portal`)
- **GitHub Fork(本项目)**: https://github.com/Curry1024Bytes/silkroadai
- **上游仓库**: https://github.com/yexioy/silkroadai
- **角色**: new-api 客户层(Customer Portal)— W2 D3 已切到 B3 路线
- **来源**: Fork 自 [touwaeriol/sub2apipay](https://github.com/touwaeriol/sub2apipay)(已归档)
- **站点域名**: `llmroute.club`
- **客户 API**: `api.llmroute.club`
- **资源域名**: `images.llmroute.club`

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

## Git 分支与发布流程 — 必须遵守

- `main`：仅用于同步上游 Fork 变更。禁止在此分支提交项目自定义改动、解决项目冲突或部署线上。
- `dev`：开发集成分支。将本项目开发提交与 `main` 的上游变更在这里合并；所有冲突在这里解决，并完成类型检查和测试。
- `prod`：唯一的线上发布分支。仅当 `dev` 测试通过后，才以 fast-forward 方式同步到 `prod`；VPS 只允许拉取和部署 `prod`。

### 每次上游同步的固定顺序

1. 仅同步上游到 `main`，确认 `main` 没有本项目自定义提交。
2. **在合并到 `dev` 前，必须先输出上游变更报告**，报告必须包含：
    - 每个上游提交的北京时间、短 SHA 和标题。
    - 每个提交的具体行为变化列表，而不只罗列提交标题。
    - 数据库 migration、环境变量、服务器/Nginx/Cloudflare 配置、安全性及线上兼容性影响。
    - 与当前 `dev` 的提交差异和预判冲突文件。
3. 报告输出后，执行 `main -> dev` 合并；在 `dev` 解决冲突、运行 `typecheck` 和完整测试。
4. 测试通过后，fast-forward `dev -> prod`，但只有在 operator 明确安排部署时才登录 VPS 发布。

---

## 当前生产环境快照(2026-08-04)— 必读

当前环境与 2026-05/06 的旧 VPS 不同。今后的生产操作以
[`deploy/部署与运维手册.md`](deploy/部署与运维手册.md)为唯一权威手册;
`docs/W5-DEPLOY-RUNBOOK.md` 是旧 `portal.silkroadai.io` / Caddy 环境的历史归档,不能照它操作当前服务器。

- 服务器:`82.29.71.122`,AlmaLinux 9.7,SSH `root:22` key-only,项目目录 `/opt/silkroadai-portal`。
- 入口:Cloudflare 橙云 + Full (strict) → 宿主机 Nginx → Portal `127.0.0.1:3002`。
- TLS:Cloudflare Origin Certificate 在 `/etc/nginx/ssl/llmroute.club.{pem,key}`,私钥权限 600。
- Portal:容器 `silkroadai-portal`;PostgreSQL 16 容器 `silkroadai-portal-db`,仅回环 `127.0.0.1:5432`。
- new-api:容器 `new-api`,宿主机绑定 `172.17.0.1:3000`,网络 `new-api_new-api-net`,数据目录 `/opt/new-api/data`;
  MySQL 8 容器为 `new-api-mysql`。Portal 用 `http://host.docker.internal:3000` 访问。
- VPS Git 工作区和 Portal 运行镜像均为 `prod@b480b09`,Portal 回滚代码 SHA 为 `149d9c4`。
  2026-08-05 发布前已生成 0600 的 `.env.bak.20260805-114701` 和 Portal PostgreSQL 备份
  `/opt/backups/silkroadai-portal/portal-20260805-034701.sql.gz`,后者 `gzip -t` 通过。
- 当前公网已验收:`llmroute.club` / `www.llmroute.club`、Google OAuth、GitHub OAuth、zpayz 支付宝充值及
  幂等入账。`api.llmroute.club` 已使用显式 API-only Nginx virtual host,只放行 `/v1/*`、`/v1beta/*`;
  假 Key 为 401,两类 CORS 预检为 204,`/login` / `/admin/login` 和主站 `/image-adapter/*` 均为 404。
- 当前未完成:SMTP、平台 R2/OSS、Sentry、Tavily、自动异机备份/跨主机恢复演练。new-api 尚未
  配置正式渠道/模型,所以真实客户 Key 模型调用验收明确为 pending,不能误报已经完成。
- 2026-08-04 SSH 已完成 key-only 加固:`PermitRootLogin prohibit-password`、`PasswordAuthentication no`、
  `KbdInteractiveAuthentication no`,原生 OpenSSH 与 Xterminal 新会话均验证成功。`fail2ban` 的 `sshd`
  jail 已启用(10 分钟 5 次失败先封 1 小时,重复触发递增到 24 小时),启动后已实际捕获并封禁攻击 IP。
- 2026-08-04 new-api SSH 隧道卡死根因已定位为 VPS -> operator 中国电信网络的高下行丢包:
  服务端 `ss -ti` 观察到约 17%-28% 重传,CUBIC `cwnd` 塌至 2-4,MSS/PMTU 正常;纯 SSH 和 HTTP/80
  对照均复现,排除浏览器、new-api、Docker、forwarding 与 MTU。VPS 已持久化 `tcp_bbr` + `fq`;
  同一 5 MB SSH 下行由 5 分 32 秒降至 8.29 秒,3.42 MB new-api 主脚本 3.91 秒完成,Chrome 整页无错误。
  配置与 Mac 隧道命令见 `deploy/部署与运维手册.md` 7.3/9 节;切换拥塞算法后必须重建旧 SSH 连接。
- 2026-08-04 Portal PostgreSQL 本机备份 cron 已启用:每日北京时间 02:00 执行
  `scripts/backup-db.sh`,保留 7 天;脚本使用无 TTY dump、0600 临时文件、`gzip -t`、原子重命名和
  `flock`。已在 cron 最小环境中手工执行成功并验证 0600;最新备份已恢复到临时隔离数据库,40 张表、
  60 条 migration 与生产一致且 5 个用户可读,测试库随后删除。首份手工异机副本已通过 SSH 保存到
  operator Mac 的 `~/Backups/LLmRoute/portal/`,权限 0600、gzip 完整且 FileVault 开启;自动异机备份与
  跨主机恢复演练仍未完成。
- 支付收款主体由 zpayz 商户/渠道决定;当前个人支付宝收款不是 Portal 代码问题,企业主体仍需渠道侧办理。
- 当前 new-api 使用 MySQL;上游 `NEWAPI_LOGS_DATABASE_URL` 直连全量导出仅支持 PostgreSQL,所以保持未设置并使用
  10,000 行 API fallback,不能填一个 PostgreSQL 伪连接串。
- `docker-compose.prod.yml` 还含上游 API 副本和 Seedance 服务,分别受 `api-replicas` / `seedance` profile
  隔离;默认只启动 Portal + PostgreSQL。标准发布仍显式指定 `portal`,当前服务器不要启用可选 profile。
- 2026-08-04 已部署构建加固:Dockerfile 默认公开域名改为 LLmRoute,Compose 从服务器 `.env`
  传入全部公开 build args;生产 `.env` 已补齐 `NEXT_PUBLIC_API_URL`、`NEXT_PUBLIC_IMAGE_URL`、
  `NEXT_PUBLIC_SUPPORT_WECHAT` 和 `NEWAPI_CUSTOMER_BASE_URL`。
- 2026-08-03 lint 基线:项目未启用 React Compiler,其 compiler-only 诊断保留为 warning;`.codex/**`
  是独立技能工具,不纳入应用 ESLint。`pnpm lint` 必须保持 0 error,并继续作为 CI/发布门。
- 2026-08-04 已部署 API 入口加固:`deploy/nginx/llmroute-api.conf` 只放行 `/v1/*` 和 `/v1beta/*`
  到 Portal `127.0.0.1:3002`,其余路径 JSON 404;SSE 禁用 buffering/cache,650s timeout,access log 只记
  `$uri`。VPS `nginx -t`、源站和 Cloudflare 公网 smoke、Gemini query-string 日志脱敏均已通过。
- 2026-08-04 已部署 `deploy/nginx/llmroute-web.conf`:apex/`www` 显式纳入同一主站 virtual host,不再依赖
  default 443 偶然匹配;主站 access log 只记 `$uri`。Cloudflare 已启用规则 `Bypass LLmRoute API`,条件
  `http.host eq "api.llmroute.club"`,动作为 Bypass cache。
- 2026-08-04 发布批次:客服微信、构建/Nginx 加固及 `main@eb1258a` 的 7 个上游提交已 clean merge 到
  `dev`(`6f8d1c9`),验证为 245 files / 2681 passed / 1 skipped 且生产构建通过;随后 fast-forward 到
  `prod@a166b28` 并完成 VPS 重建。两个 forward migration 均成功,`enterprise_ak_sk.secret_key_hash`
  缺失计数为 0,无需 backfill。
- `main@eb1258a` 新增 `/image-adapter/{provider}/*` 内部上游适配器。公网主站 Nginx 已验证返回 404,
  Docker 内部访问无 Authorization 时返回预期 401。未来 new-api 渠道应通过共享网络 Base URL
  `http://silkroadai-portal:3002/image-adapter/ominiapi` 调用,不能绕 Cloudflare。该渠道未配置时功能 dormant。
- 2026-08-04 上游 `main@b5d3f5e` 的 1 个提交已 clean merge 到 `dev`(`d87301d`):图片适配器合成
  `usage` 只保留 OpenAI Images 官方 5 个字段,删除 `prompt_tokens` / `completion_tokens` Chat 别名,
  避免中继客户把两套字段相加造成 token 统计翻倍。无 migration/env/依赖/Nginx 变化;验证为
  245 files / 2681 passed / 1 skipped、typecheck/format/lint 0 error 且生产构建通过;已随
  `prod@b480b09` 于 2026-08-05 部署。图片适配器渠道未配置时功能继续 dormant。
- 2026-08-05 上游 `main@27ef9c8` 的 1 个提交已 clean merge 到 `dev`(`2f0e3f9`):图片适配器对
  ominiapi 的 `n > 1` 请求改为最多 10 路并发单图扇出,每次重建 JSON/FormData,合并成功图片并按
  实际张数合成 usage;部分失败返回已有图片,全失败才 503 failover。无 migration/env/依赖/Nginx
  变化;验证为 245 files / 2687 passed / 1 skipped、适配器 32/32、typecheck/format/lint 0 error 且
  生产构建通过;已随 `prod@b480b09` 于 2026-08-05 部署。主要运行风险是单请求最多放大为 10 个
  上游并发及 4K 图片内存占用;该渠道未配置时功能继续 dormant。
- 2026-08-05 已部署后台降噪:仅隐藏已停用的 Sub2API/LiteLLM `渠道管理`、`订阅管理`
  导航入口;两个页面的完整实现和 `/admin/channels`、`/admin/subscriptions` 直达地址继续保留,
  旧 API、数据库表及历史订单读取也不删除。需要排查或恢复入口时无需从 Git 历史找回代码。
- 2026-08-05 `prod@b480b09` 发布验收:Portal/PostgreSQL healthy、Portal restart count 0、60 条
  migration 无 pending;Portal -> new-api 200;apex/`www` 登录页 200、API 假 Key 401、主站
  `/image-adapter/*` 404、Google/GitHub OAuth start 302。生产 `BILLING_SOURCE` 未设置(默认
  `newapi`),数据库 5 个用户全部 `billing_mode=newapi`;Portal 计费未启用。new-api 仍未上货,
  所以真实客户 Key 推理验收继续 pending。
- 2026-08-06 上游 `main@cbc00af` 的 3 个提交已 clean merge 到 `dev`(`cb5c01f`):客户日志展示、
  `/api/portal/logs` 与 CSV 导出无条件隐藏 image-adapter 专用 `upstream_unavailable` 503 中间态;
  Enterprise 国内版/proMax/火山新增 480p(每 token 与 720p 同费率),global 因 intl 上游真机不支持而
  保持 720p/1080p[/4k],请求 480p 时 Portal 直接返回带替代指引的 400。无 migration/env/依赖/
  Docker/Nginx/Cloudflare 变化;定向 125/125、CI 245 files / 2693 passed / 1 skipped、typecheck/
  format/lint 0 error 且生产构建通过。完整测试另有 2 个联机 smoke 因本机未开 `127.0.0.1:13000`
  VPS 隧道而 `ECONNREFUSED`,不属于代码回归。该批次尚未部署,VPS 镜像仍为 `prod@b480b09`。
- 2026-08-06 同步期间上游又前进到 `main@35036ed`,新增 2 个提交并 clean merge 到 `dev`
  (`d5cd281`):`/v1/responses` 遇上游 5xx 时同请求体最多重 POST 一次并回传 failover 状态头(4xx、
  `/chat/completions`、`/messages` 不重试);Enterprise `/api/v3` 查询响应补齐火山/BytePlus 官方字段,
  proMax 接受并回显 `byteplus/seedance-2.0*` 别名。新增 migration
  `20260806040000_add_seedance_task_submit_params`,向 `seedance_video_tasks` 加 3 个可空回显字段,
  无 backfill;部署新镜像前必须执行 migration。无 env/依赖/Docker/Nginx/Cloudflare 变化;Prisma
  validate、定向 381/381、CI 245 files / 2700 passed / 1 skipped、typecheck/format/lint 0 error 且
  生产构建通过。完整测试为 2701 passed / 1 skipped / 2 个上述联机 smoke 失败。该批次尚未部署,
  VPS 镜像仍为 `prod@b480b09`。
- 2026-08-06 上游 `main@ccae480` 的 3 个提交已 clean merge 到 `dev`(`c5a5a55`):Enterprise
  素材库经两轮分流修正后最终统一为平台 R2 托管,AIGC 与 `LivenessFace` 真人素材四渠道通用,
  727 provider 素材 Action 路由下线;素材组新增 `GroupType` 白名单与官方缺省筛选语义,火山生成
  继续以 lenient 模式解析平台素材引用。新增 migration `20260806120000_add_asset_group_type`,给
  `enterprise_asset_groups` 增加非空、默认 `AIGC` 的 `group_type`,无数据删除。无新 env/依赖/
  Docker/Nginx/Cloudflare 变化,但部署前必须确认现有 `R2_*` 凭据、bucket、公开域名及真人素材
  访问/保留/删除策略;当前生产快照的平台 R2/OSS 仍未完成,不能跳过该前置条件。Prisma validate、
  定向 88/88、CI 245 files / 2708 passed / 1 skipped、typecheck/format/lint 0 error 且生产构建通过;
  完整测试为 2709 passed / 1 skipped / 2 个上述联机 smoke 失败。该批次尚未部署,VPS 镜像仍为
  `prod@b480b09`。
- new-api rc.22 登录兼容决策:优先直接使用登录响应的 `data.access_token`;仅旧版本 `session=` cookie 走 fallback。
  该路径已通过 Google/GitHub 真实开户验证,不要把 `new_api_refresh` 当 session。

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
└── _bootstrap/                  ← Codex 别动这个目录,这是辅助资源
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
- [x] D3 — \_bootstrap 切到 B3 包 + 新分支 `feat/b3-newapi-switch` ✅
- [x] D4 — Prisma schema 切到 new-api 集成 ✅ (LiteLLMKey → NewApiToken)
- [x] D5 — `src/lib/newapi/client.ts` + 烟雾测试通过(117 模型) ✅
- [x] D6 — 注册接口切 new-api,端到端跑通(deepseek-v4-flash 真实调用) ✅
- [x] D7 — README + AGENTS.md 更新 + push + PR ✅
- [x] **W2 PR #1 merged at `6c4b422`(2026-05-02)** 🎉

### W3(Auth 完善 + LiteLLM 关停)

- [x] D1 — VPS 收尾(2026-05-02):LiteLLM 容器停 + Caddy `api.silkroadai.io` 切到 new-api `:3000` + 3 个渠道配齐(SiliconFlow OpenAI / sub2api-Codex Anthropic / sub2api-openai OpenAI)+ 117 模型可调 ✅
- [x] D2 — portal e2e 验证 ✅(2026-05-03,见 `docs/W3-D2-VERIFICATION.md`)— 注册 → sk-xxx → 三格式真实模型调用 → 用量回查全链路 200
- [x] D2.5 — SiliconFlow 短名 model_mapping 修复 ✅(2026-05-03,见 `scripts/rebuild-channel-model-mapping.ts` + gotcha #15 修复段)
- [x] D3 — login 端点上线 ✅(2026-05-03,见 `docs/W3-D3-LOGIN-VERIFICATION.md`)— `POST /api/auth/login` cookie session(JWT httpOnly SameSite=Lax 7d)+ apiKey 在 response,timing 防御 + banned 拒绝;6/6 单测 + 4 e2e 状态码全对 + cookie 反解 + apiKey 真打 ai.silkroadai.io 200
- [x] D4 — forgot password + reset password ✅(2026-05-03,见 `docs/W3-D4-FORGOT-PASSWORD-VERIFICATION.md`)— `POST /api/auth/{forgot,reset}-password` + 独立 `PasswordResetToken` 表 + 邮件基础设施 `src/lib/email/*` + JWT `session_token_version` 踢登机制 + `/reset-password` UI 页;14 单测 + 6 jwt 单测 + 7 真实 e2e PASS;SMTP 凭据 F1 已修(SMTP_HOST 配错成个人 QQ 邮箱,改成 `smtp.exmail.qq.com` + verify=true + 真实送达 1226627765@qq.com 收到)
- [x] D5 — register 邮箱验证(soft-block)✅(2026-05-03,见 `docs/W3-D5-EMAIL-VERIFICATION-VERIFICATION.md`)— `POST /api/auth/{verify-email,resend-verification}` + 独立 `EmailVerificationToken` 表 + register 注册时异步发邮件 + `/verify-email?token=` UI 页(自动 POST + StrictMode 防双消)+ User 加 `email_verified_at` 时间戳;同 migration 一并 drop W1 sub2apipay 4 个 stale 字段 + backfill 已有 user 视为已验证;21 新单测 + 6 真实 e2e 步骤 PASS;login 未改,**敏感操作 enforcement 留 W4 客户后台**
- [x] D6 — Google OAuth(OIDC)✅(2026-05-02,见 `docs/W3-D6-GOOGLE-OAUTH-VERIFICATION.md`)— `GET /api/auth/oauth/google/{start,callback}` + 新表 `oauth_accounts(provider, provider_account_id)` unique + `User.password_hash` 改 nullable;DIY with `jose`(零新依赖,不引 `openid-client`);state CSRF + S256 PKCE 双 cookie;5-branch email 冲突策略(login / link-verified / bootstrap-unverified / fresh-signup-with-provision-rollback / sub-conflict);15 单测 PASS,348 全套 PASS;**2026-08-03 新生产环境真实浏览器登录与 new-api 开户已通过**
- [x] D7 — GitHub OAuth(原生 OAuth2)✅(2026-05-02,见 `docs/W3-D7-GITHUB-OAUTH-VERIFICATION.md`)— `GET /api/auth/oauth/github/{start,callback}` 复用 D6 的 `oauth_accounts` 表(`provider='github'`);**纯 fetch 实现,零新依赖**(没 id_token / 没 PKCE);state CSRF cookie 单守门;email 走 `/user/emails` 挑 `primary && verified`,无则拒;5-branch 冲突逻辑抽出共用 helper `src/lib/auth/oauth/account-link.ts`,GitHub callback 调用之,**Google callback 暂未改造**(D7 brief 不动 google,F1 sweep 留 W4-W5);39 新单测 + 全套 389/390 PASS / **0 fail**;**2026-08-03 新生产环境真实浏览器登录与 new-api 开户已通过**

### W4-1(充值流改造 — portal-internal /pay + new-api add_quota)

- [x] D1 — `executeRecharge` 切 new-api `applyTopup` ✅(2026-05-03)— 删 W1 LiteLLM `createAndRedeem` stub(W3 D6 起会 throw deprecation,导致每个支付成功的 order 都 PAID→FAILED);CAS lock(PAID/FAILED → RECHARGING → COMPLETED)做主 idempotency,RechargeLog `findFirst` by `(order_id, source='payment')` 做二级 dedup(防"上轮 add_quota 成功但 status flip 前 crash");balance_before/after 用 `getUser(newapi_user_id).quota` 读,失败 fallback before+delta;9 新 `execute-recharge.test.ts` PASS
- [x] D2 — `createOrder` + `/api/orders` cookie auth + portal `/pay` `/login` 页 ✅(2026-05-03)— `createOrder` 切 `prisma.user.findUnique`(替 litellm shim getUser);新错误码 `AUTH_REQUIRED` 401 / `USER_NOT_FOUND` 404 / `USER_INACTIVE` 403(banned/disabled);`/api/orders` POST 改 cookie session(`getCurrentUser(req)`)删 `token` 字段;新 `/pay/page.tsx` server component 守门 + `/pay/pay-form.tsx` 5-tier(¥10/30/100/300/1000)+ custom amount + provider radio + window.location 跳网关;新 `/login/page.tsx` + `/login/login-form.tsx` 邮箱密码 + Google + GitHub 三选一(白名单 next 防 open-redirect);W1 1160 行 `/pay/page.tsx` 重命名 `page.legacy.tsx`(Next 自动忽略,留 reference);`src/app/page.tsx` forward 全 query(原仅 lang,影响 OAuth `?oauth_error=` 穿透);20 新单测(create-order auth 5 + /api/orders POST 6 + pay/login UI SSR smoke 9)
- [x] D3 — 集成测 + Google sweep + 易支付 sig alert ✅(2026-05-04,见 `docs/W4-1-RECHARGE-VERIFICATION.md`)— 5 集成测 `recharge-flow.test.ts`(happy / duplicate / defensive dedup / sig fail / applyTopup throw),用 `vi.hoisted()` + 内存 prisma mock + 真签名验证(`generateSign` 测试 pkey);Google callback refactored 改用共用 `linkOrCreateOAuthUser` helper(335→138 行,删 createUserFromGoogle + inline 5-branch),与 GitHub callback 走同一 code path,**D6 全套 15/15 仍 PASS 证明行为等价**;易支付 `verifyNotification` 失败现 `console.warn('[easy-pay/notify] signature verification failed', { instId, out_trade_no, pid, signPrefix })` + body `'success'`(silent ignore + ops 信号,W6 接 Sentry);全套 vitest **43 files / 423 PASS / 1 skip / 0 fail**;**2026-08-03 新生产环境 zpayz 支付宝真实充值、notify 与余额入账已通过**

### W4-2(客户后台 MVP — `(authenticated)` route group + Keys / Balance / Usage)

- [x] D4 — layout + Sidebar + Header + UnverifiedBanner + `/api/auth/logout` ✅(2026-05-04)— `src/app/(authenticated)/` route group 单点 auth 守门(layout 顶层 `getCurrentUser` null → `redirect /login?next=` 透传 path),共享 Header(logo + email + 退出)+ Sidebar(4 nav 高亮 + 充值 CTA)+ 主区(soft-block yellow banner 当 `email_verified=false`);`/dashboard /keys /balance /usage` 4 占位页(D5-D7 替换为实页);`POST /api/auth/logout` 单设备登出(清 cookie 不动 `session_token_version`,gotcha #16);15 新单测;W1 `/portal/*` 不存在,fresh build
- [x] D5 — `/keys` API key 管理页 + 3 endpoints ✅(2026-05-04)— `/api/portal/keys/{,[id],[id]/key}` 三 REST 端点(cookie auth + IDOR 401 防 enum);列表 / 创建(限 5)/ 撤销 / reveal-with-mask(10s auto-mask);创建走 3 步 new-api 流(createTokenForCustomer → list 反查 id → getTokenKey)+ Prisma create 双向回滚;撤销走 new-api delete + Prisma `status='disabled'` 软删(Order/RechargeLog FK refs 默认 RESTRICT 不能 hard delete);reveal **不调** new-api(Prisma 直读,gotcha #11+#13 警觉);token 永远 `unlimited_quota=true`(gotcha #12);27 新单测
- [x] D6 — `/balance` 页 + `getQuotaWithCache` 4 路径 + `executeRecharge` cache bust ✅(2026-05-04)— `src/lib/newapi/quota-cache.ts` helper:hit(60s 内)/ miss(refetch + write-back)/ live / fallback(new-api 短暂不可用 + 有 stale cache → 返 stale + `console.warn '[quota-cache] new-api unreachable'`)/ hard fail;`executeRecharge` 事务内加 4th op `prisma.user.update({...nullify newapi_quota_cache 三字段...})`,充值成功原子性 cache bust;UI 两张大卡(可用余额 / 累计消费)CNY 主显 + USD/raw quota 副 + `+ 充值` CTA + 充值流水表(zh-CN 本地化 + 友好类型 label + 8 字符 order id 截断)+ fallback yellow banner + error 红 alert(隐藏卡片);**Cache 字段实际命名**:`User.newapi_quota_cache` / `newapi_used_quota_cache` / `newapi_cached_at`(W2 D4 与其他 newapi\_ 列对齐,brief 假设的 NewApiToken 风格 `cached_remain_quota` 等不准);24 新单测
- [x] D7 — `/usage` 页 + `getCurrentUser` cache() dedup + `/reset-password` fired guard ✅(2026-05-04,见 `docs/W4-2-DASHBOARD-VERIFICATION.md`)— `/usage` 页 `?period=7d|30d|all` 默认 30d(parsePeriod 白名单防注入)+ 服务端聚合 by-model top 5 + 最近 50 条表格 + 空状态指 `/keys` CTA;`queryLogs` 加 `user_id?: number` 参数(修 W3 D2 F2 username filter 0-result bug),portal 业务路径全部用 user_id;`getCurrentUser` 包 React `cache()` 内层 `_resolveUserFromCookie(cookieValue)` keyed by 字符串,layout + nested page + 内层 helper 共享同 cookie → 1 verify + 1 DB read per request(structural test + 5 behavioral test);`/reset-password` form 加 `useRef(false)` fired 同步 guard(防 React 19 + 双击 race,镜像 W3 D5 verify-email-runner pattern);全套 vitest **54 files / 494 PASS / 1 skip / 0 fail**;**真实浏览器 5 步 smoke 待用户跑**

### W5(Ops Hardening + Legal + 易支付 QR)— 见对应 verification doc 系列

- [x] D1-D6 — Sentry / last_login_ip / DB backup cron / 法律页 / 易支付 QR display 等(旧环境记录见 `docs/W5-DEPLOY-RUNBOOK.md` + 各 PR;当前生产运维只看 `deploy/部署与运维手册.md`)

### W6(Client Polish + Retention Sprint — 5-day stack)

- [x] D1 — 首充 20% bonus ✅(2026-05-05,PR #17)— `executeRecharge` 加 interactive `prisma.$transaction` 包 CAS-claim + applyTopup + finalize:`tx.user.updateMany WHERE first_recharge_bonus_granted=false` 拿到 row lock + flip true,`applyTopup` 加 `extraBonusQuota` 参数(raw quota,不经汇率);失败回滚整个 tx,bonus claim 也回滚;`/pay` 加 yellow banner(仅 `granted=false` 时渲染);schema `User.first_recharge_bonus_granted Boolean default false` + `RechargeLog.bonus_quota_added BigInt? default 0`;20 新单测
- [x] D2 — 余额低提醒 + 阈值配置 ✅(2026-05-05,PR #18,见 `docs/W6-CLIENT-POLISH-VERIFICATION.md`)— `BalanceAlertScheduler`(1h 镜像 W4-2 Order timeout 模式)+ `sendBalanceAlertEmail` 复用 W3 D4 SMTP + W5 D4 Sentry + 5-state form on `/balance` + `POST /api/portal/balance-alert-threshold`(zod 0-1000 整数 + IDOR-safe);CAS-claim `WHERE last_sent IS NULL OR last_sent < now-24h` 防多实例双发;`executeRecharge` 事务尾加一行 `balance_alert_last_sent_at: null` 让充值后立即可重发提醒;26 新单测;**首次部署即触发 3 现有用户邮件**(spec 行为,F2)
- [x] D3 — 公开 /models 双级分组 ✅(2026-05-05,PR #19,见 verification doc)— `categorize.ts`(type × vendor 规则 + filter helpers,纯函数)+ `/models` server page(`revalidate=60` ISR)+ `ModelsBrowser` client(200ms debounce + useMemo)+ Footer/Sidebar 模型清单链接;OpenAI 厂商规则比 brief 略宽(F3)— 加上 dall-e/sora/whisper/tts/text-embedding;**正则 `(^|[\/-])` 字符类边界匹配 dall-e-3 失败**(F4)→ 重写 `startsWith`/`includes` 链;40 新单测;公网 200 + 379 模型 9 厂商
- [x] D4 — 多 key + 每 key 用量 ✅(2026-05-05,PR #20,见 verification doc)— `MAX_TOKENS_PER_USER 5→10` + `token-usage.ts` 60s row cache 镜像 W4-2 D6 4 路径;`queryLogs` 加 `token_id?` query param 转发(F5 best-effort,client 侧 post-filter 兜底);`/keys` server 并行 `Promise.all` per-token usage fetch + per-row try/catch;UI subline `累计 ¥X.XX · 最近调用 N 天前`(grey 11px,不抢主信息);alias 命名建议 placeholder `prod-openai / test-Codex / dev-mobile` + `env-purpose` 小提示;migration 含手工 `UPDATE ... SET 0 WHERE NULL` 后 `SET NOT NULL`;16 新单测
- [x] D5 — usage server-side aggregator + dashboard 真内容 + W6 收尾 ✅(2026-05-05,PR #21,见 `docs/W6-CLIENT-POLISH-VERIFICATION.md`)— `usage-aggregate.ts`(5min cache 4 路径 + paging 1-50 页 × 1000 行 = 50k hard-cap;F6/F7 已知)替代 W4-2 D7 客户端 200-cap aggregate(W3 D2 F3 长尾失真);新表 `usage_aggregate_cache(user_id, period)` PK 复合;period 支持 `7d / 30d / all / last_month`(自然月 UTC,Date.UTC(y,-1,1) 跨年 OK);`periodToTimeRange` 4 case 单测全 PASS;/dashboard 4 张真卡(当前余额 / 上月消费 / 累计调用 / Top 3 模型)+ 4 quick links 替代 W4-2 D5 占位;`Promise.allSettled` 4 并行 fetch + 单卡降级独立;tx 内 `applyTopup` HTTP 持有 DB 连接 ~10s 已知(F1);**W6 全周累积 = 67 files / 642 PASS / 1 skip / 0 fail**

### W7(Brand + Landing + Pricing + GPU + Launch Polish — 见各 PR)

- [x] PR-A..PR-O — brand identity / 落地页 / pricing / promo / SF 旗舰 / logo / 促销日期 等(PR #22..#43)
- [x] PR-P — 公开 /gpu 算力租赁页(2026-05-07,PR #44)— H100 / H200 / B300 三 SKU + 4 步流程 + 客户类型 + 询价 CTA
- [x] PR-Q — GPU 入口位置调整 + nav 简化(2026-05-07,PR #45)— GPU 租赁 outline 钮上 landing header,/gpu 页 nav 收敛单 CTA
- [x] PR-R — 4 项 launch 前 UX 改进(2026-05-09,PR #46)— (A)landing header 删 `登录` / (B)landing 删 in-page Trust prose row 由 global Footer 单点担纲 / (C)`/keys` 拆掉 PR-G 的 per-row `KeyHowtoPanel`,改成底部统一 `KeysSnippetsPanel`(`YOUR_API_KEY` placeholder + curl/Python/Node SDK tabs + 复制按钮 + base URL chips)/ (D)`/models` `/docs` `/gpu` 公开页 hero 上方加 `← 返回首页`;**deploy 实测发现 AGENTS.md 写的 `CI 触发自动部署` 不准 — 实际无 deploy step,必须手动 SSH 上 VPS**(本次顺手修)

### W8(launch 后第 2 周 — 维护 + 客户支援)

- [x] D1 — `/docs` 加 OpenAI Codex 集成教程上线 ✅(2026-05-21,PR #63 merge `4d2afc0` + PR #64 merge `178abbc`)— 客户场景:用 Codex(CLI / VS Code / Cursor / Windsurf / JetBrains IDE 插件 / 桌面 app `codex app`)连 ai.silkroadai.io。三客户端共享 `~/.codex/config.toml`,核心是**自定义 `wire_api = "chat"` 的 provider** 旁路 Codex 内置 `openai` provider 默认 `wire_api = "responses"` 撞上 sub2api passthrough 非空 instructions 校验的问题(详见 gotcha #18 + 同日 task #8 / #11 完整诊断);IDE 插件强调**点 "Use API Key" 不点 "Sign in with ChatGPT"**(后者走 OpenAI OAuth 与 portal sk-xxx 不通)+ `~/.codex/auth.json` 凭据清理提示;单文件 `src/app/docs/page.tsx`,无 DB / 无 deps;VPS `/opt/silkroadai-portal` 手动 `git pull + docker compose --build portal` 部署;公网 `silkroadai.io/docs#codex-cli` 后验证 200,9 章节关键字 + 编号 01-09 + `wire_api` × 10 全到位
- [x] D1.5 — 新定价永久替换 ✅(2026-05-21,PR #XX merge `<填>`)— 替换 W7 D2 `PROMO_DISCOUNT = 0.5` 这个 50% 促销,改为 **ChatGPT 系 ¥0.5 / 官方 $1**(mr × 0.5/7 = 0.0714,e.g. gpt-5.5 mr=0.357)+ **Codex 系 ¥1.5 / 官方 $1**(mr × 1.5/7 = 0.2143,e.g. opus-4-7 mr=3.214);per-channel `model_ratio` + `completion_ratio` PUT 到 new-api channel id=2(Anthropic 6 SKU)+ id=3(OpenAI 14 SKU),不动 global ModelRatio;`completion_ratio = retail_out / retail_in` 沿用官方比例(opus 5/sonnet 5/haiku 5,gpt-5.4 4/gpt-5.5 5);scripts/apply-new-pricing-2026-05-21.mjs dry-run + --apply + verify 20/20 entries 全 match;portal `src/app/page.tsx` `PRICING_ROWS` 同步:Codex/GPT 行切 `cnyIn/cnyOut` ¥ 格式(¥22.5/¥112.5 for opus-4-7 等)+ `promoActive` 硬编码 false 替代 `isPromoActive()`(promo 机器代码留着待后 PR 清理,Gemini 行保留 $ 因 channel 未动);`_bootstrap/apply-w7-pricing.ts` + `exit-w7-promo.ts` 标 OBSOLETE(永久价后不存在 6/9 退场动作);landing-page.test.tsx 删 promo-ACTIVE describe 块 + INACTIVE 块更新价格断言;**operator 拿货价 ~1/10 of new retail,毛利 ~90%**;SiliconFlow 渠道(118 模型)+ Gemini 渠道不动

### W9(Portal Proxy Layer — 自有 /v1/\* 代理)

- [x] D1 — portal `/v1/*` catch-all 代理上线 + Caddy 按路径分流 ✅(2026-06-05,PR #73 [#44 land WIP] merge `a9c92e8` + PR #74 [PR-A proxy] merge `71ef053`,详见 `docs/W9-D1-PORTAL-PROXY-DEPLOY.md`)— 新文件 `src/app/v1/[...path]/route.ts`:Branch 1 Gemini image(2.5-flash 1K / 3.1-flash 2K / 3-pro 4K)把 `/v1/chat/completions` 翻译成 new-api native `/v1beta/...:generateContent` 注入 `imageConfig.imageSize` 再转回 OpenAI 形(头 `X-Silkroadai-Translated`)→ **OpenAI SDK 客户端也能拿真 2K/4K**;Branch 2 `Codex-*` 且 `max_tokens>4096` 钳到 4096(头 `X-Silkroadai-Clamped`);Branch 3 + 其余路径原样透传(SSE 不缓冲)。Caddy `ai.silkroadai.io` 加 `@portalv1 path /v1/*` → portal :3002,其余(含 `/v1beta` native Gemini)留 new-api :3000(备份 `/etc/caddy/Caddyfile.bak-w9d1`)。#73 顺带把长期红的 main CI 修绿。Gate 1/2/3 + smoke 5/5 全过(Gemini 2K→2048²、Codex clamp 头、GPT streaming、`/v1beta` 200、`/balance` 307)。**Phase 2(multimodal `image_url` 入参 + 图片 R2 上传)未开始,待 operator 绿灯。**
- [x] D2 — proxy `image_url` 入参 + 自动 R2 上传返 URL ✅(2026-06-05,PR #75 merge `4a0bb85`,详见 `docs/W9-D2-PROXY-IMAGE-URL-R2.md`)— proxy Branch 1 加两件:(1) **入参** 支持 OpenAI multimodal `content` array 的 `image_url`(data URL 直解 / 外部 http(s) URL portal fetch→base64,SSRF 基础守门 = 协议白名单 + 私网 IP 字面量拒,15s 超时 + 20MB 上限,fetch 失败 → 400 invalid_request_error)翻译成 Gemini `inlineData`;(2) **出图** 改传 R2(`gen/{uuid}.{ext}`,复用 `src/lib/r2/client.ts` uploadImage),`content` 返公网 `https://images.silkroadai.io/gen/...` URL(不再内联 base64),R2 故障降级回 data URL + 头 `X-Silkroadai-R2-Fallback`。smoke 5/5:image_url(data URL + picsum 外部)→ R2 **2048²**、text-only → R2、坏 URL → 400、Codex clamp / GPT 透传无回归;R2 无降级。**已知**:`gen/` 不在 image-cleanup cron 管辖(operator 建议 R2 配 lifecycle rule);wikimedia 等对 VPS datacenter IP 回 400/403(proxy 正确 400,非 bug)。**Phase 3(自定义 OSS)待 operator 绿灯,未开始。**
- [x] D3 — 客户自定义 OSS 配置上线 ✅(2026-06-05,PR #76 merge `89545c5`,详见 `docs/W9-D3-CUSTOMER-OSS-CONFIG.md`)— 客户可在 `/settings/storage` 配自己的 S3 兼容存储(R2 / 阿里 OSS / 腾讯 COS / AWS S3 / 自建),proxy 生图按 user OSS 配置传客户 bucket、返客户公网前缀 URL;无配置 / 任何故障 → 三级降级回平台 R2(客户请求不失败)。新表 `user_oss_configs`(`user_id` unique,secret 用 AES-256-GCM 加密存,key = `PORTAL_OSS_ENC_KEY` env,**投产后不可换**);新 API `GET/PUT/DELETE /api/portal/oss`(GET 永不回显 secret)+ `POST /api/portal/oss/test-connection`;新页 `/settings/storage`。**W9 首个 DB migration** `20260605140000_add_user_oss_configs` —— prod `migrate deploy` 已 apply、表已建。Step 0a 本地用 throwaway temp DB 验证 migration 干净 apply + 表 schema 与模型一致(Prisma AI-guard 挡了破坏性 `migrate reset`,改用非破坏性 temp-DB 验证);Step 0b 发现 prod .env 遗留占位符 `PORTAL_OSS_ENC_KEY=<64字符>` 与新生成真 key 重复,**停下报告 → operator 拍板留真 key 删占位符**(已备份 `.env.bak-w9d3`)。smoke 1-4 过(无 OSS 配置 → 平台 R2 回归、OSS API 未登录 401、`/settings/storage` 307、Codex clamp / GPT 透传回归);**smoke 5 真实 R2 e2e + /docs 自定义 OSS 客户章节待 operator 验证后补。**
- [x] D4 — DALL·E 兼容 `/v1/images/{edits,generations}`(代码完成,待 operator 部署)✅(2026-06-08,分支 `feat/b3-images-dalle-compat`,详见 `W9-D4-images-dalle-brief.md`)— proxy `handleRequest` 新增拦截这两条路径:model 命中 `GEMINI_IMAGE_MODELS`(`gemini-2.5-flash-image` 1K / `gemini-3.1-flash-image-preview` 2K / `gemini-3-pro-image-preview` 4K)→ 翻译到 native `generateContent` 注入 `imageConfig.imageSize` + `aspectRatio`,响应包成 DALL·E 形 `{ created, data:[{url|b64_json}] }`;**multipart/form-data**(对标 gpt-best「Nano-banana Edits」)与 **JSON** 两种 body 都收,多参考图 `form.getAll('image')` / JSON 数组按序转 inlineData。`aspect_ratio` 按 Gemini 官方全集分档白名单校验(pro 档独有 `1:4`/`1:8`/`8:1`),空串默认 `1:1`,非法 → 400 不打上游。非 Gemini model(`gpt-image-2` 等)→ 透传(multipart 走 `forwardMultipart` 重建 FormData + 删 content-type 让 fetch 重生 boundary;JSON 走 `forwardToNewApi`)。图床三级降级(客户 OSS → 平台 R2 → data URL)抽出共享 `storeGeneratedImage`,chat + images 两路复用(现有 chat 测试全过证抽取等价)。`response_format=b64_json` 直返 base64 不走图床;上游无图 → 502。已知取舍写进代码注释:`n>1` 忽略(Gemini 单次 1 图)、`size` 忽略(分辨率由档位定、比例由 `aspect_ratio` 定)。**唯一改动文件** `src/app/v1/[...path]/route.ts`(+ `__tests__/proxy.test.ts`),无 DB / 无 deps;`tsc` + `lint` 0 error,`vitest src/app/v1` 34/34(11 新)+ 全套 1523 PASS / 1 skip。**已 merge #92 + 手动部署 2026-06-08(VPS HEAD `383629c`;smoke:bad-ratio→400 `invalid_request_error` / good-ratio→401 `new_api_error` 证新码生效)。`/docs` DALL·E 接入章节另起 PR。**
- [x] D4-hotfix — `aspect_ratio="auto"`/空 误判 400 修复 ✅(2026-06-08,分支 `fix/images-aspect-ratio-auto`,详见 `hotfix-aspect-ratio-auto-brief.md`)— 客户 Java 工作流 `ApiWorkflowExecutorServiceImpl` 调 `/v1/images/edits` 带 `aspect_ratio=auto`(业界客户端常用默认,对标 OpenAI gpt-image `size:"auto"`)被 #92 的白名单校验逐字 400。改正语义:`""` / `auto`(大小写不限)= **"不指定"** → 不往 Gemini 注入 `aspectRatio`,让模型自动(edits 跟随输入图,不再被硬塞 `1:1` 裁成方图);显式非法值(`7:3`)仍 400(白名单保留)。§2 一并把 chat `handleGeminiImage` 硬编码 `aspectRatio:'1:1'` 去掉(同模型走 `/chat/completions` 与 `/images/*` 行为一致);删 unused `DEFAULT_ASPECT_RATIO`。+2 测试(auto / 大小写 AUTO 均不注入)+ 改 2 旧断言(空串/缺省 → 不注入),`vitest src/app/v1` 36/36 + 全套 1525 PASS。**merge #93 + 部署 2026-06-08(VPS HEAD `66c8aaf`;smoke:auto→401 `new_api_error` 穿过校验 / 7:3→400 回归)。**
- [x] D4-hotfix-2 — multipart 输入翻译后 Content-Type 串台修复 ✅(2026-06-08,分支 `fix/proxy-multipart-translate-content-type`,详见 `hotfix-multipart-content-type-brief.md`)— `/v1/images/edits` 用 **multipart** + 正确 Gemini 模型 → new-api 返 `500 multipart: NextPart: bufio: buffer full`。根因:`handleImagesDalle`/`handleGeminiImage` 翻译到 `:generateContent` 时 body 换成 `JSON.stringify(...)` 但 `headers: forwardHeaders(req)` **不剥 `Content-Type`**,原 multipart CT(`multipart/form-data; boundary=...`)被带给 JSON body → new-api 拿 JSON 当 multipart 解析找不到 boundary 读爆缓冲。修复:新增 `jsonForwardHeaders(req)`(= forwardHeaders + 强制 `content-type: application/json`),两处翻译 fetch 改用之;透传 `forwardToNewApi`(JSON 原样)+ `forwardMultipart`(已 delete CT 重生 boundary)不动。chat 路径同写法(只因输入恒 JSON 没暴露)一并修,防 Phase 2 multimodal 复发。见 gotcha #21。+2 测试(multipart→generateContent CT=`application/json` 核心守护 + chat 路径同断言),`vitest src/app/v1` 38/38 + 全套 1527 PASS。**W9 D4 images 任务线闭环 = #92 + #93(auto)+ 本 hotfix(multipart CT)。**

### ChatUI(无状态客户对话 — 2026-06-08 上线)

- [x] v1 — `/chat` 无状态流式对话 ✅(2026-06-08,PR #97 merge `fbd761a`,brief `chatui-v1-deploy-brief.md`)— 客户选**我们自接的模型**(复用 `/models` catalog 管线,过滤 `chat`+`vision` 两 bucket,按 vendor 分组)→ 发消息 → SSE **逐 token 流式** → **不存历史 / 零 schema / 零新依赖**。唯一服务端件 `POST /api/portal/chat/stream`:cookie auth(`getCurrentUser`)→ 限流(scope `chat_stream` 20/min)→ zod 校验 `{model,messages,temperature?}` → `getOrCreateSystemToken(user.id)` → 转发 `ai.silkroadai.io/v1/chat/completions` `stream:true` 原样 pipe SSE 回(**sk-… 不进浏览器**,镜像生图 `POST /api/portal/image/generate` pattern;quota 由 user 单点扣,gotcha #12)。client island(`chat-console.tsx`):vendor 分组下拉 + in-memory transcript(每轮整发,`MAX_MESSAGES=100`/`MAX_CONTENT_CHARS=32000`)+ 停止 AbortController + 新对话清 state + Enter 发送/Shift+Enter 换行;**零依赖** markdown 渲染(`markdown.tsx`,代码块+语言标签+复制,未闭合围栏流式安全)。sidebar 加「AI 对话」(概览之后)。tsc/lint/prettier clean,全套 **1546 pass / 1 skip / 0 fail**(16 新测:`chat-models` 4 + `stream-route` 12 覆盖 401/429/400×3/503/500/SSE 透传/Bearer 头/502/402)。部署后线上验证:`/chat` unauth→`/login` 307(路由+守门上线)、`/api/portal/chat/stream` unauth→401。**真实浏览器 happy-path 逐 token 流式 smoke 待有余额账号验证**(本地 DB provisioned 用户在线上 new-api 已 record-not-found,operator 选 ship-on-tests);无 migration,Caddy 不动(`/chat`+`/api/portal/chat/stream` 皆 portal :3002,代理 server 端 fetch 出去)。**对话历史持久化留后续单独协调 migration。**

- [x] v2 — assistant-ui + 图片上传 + 联网搜索 ✅(2026-06-08,PR #99 merge `c89e9a1`,brief `chatui-v2-assistant-ui-brief.md`)— `/chat` 升级到 **assistant-ui**(`useLocalRuntime` + `ChatModelAdapter` 包住同一个 `/api/portal/chat/stream`,复用 v1 `drainSse`;后端契约 / 计费 / 无状态 / 零 schema 全不变)。**真 markdown + Prism 代码高亮**(`@assistant-ui/react-markdown` + `react-syntax-highlighter`,`assistant-markdown.tsx`)替代 v1 手写 `markdown.tsx`(已删)。保留 vendor 分组模型选择器(加 `视觉` 标记);**新对话 = remount 全新 runtime**。**图片上传**:`SimpleImageAttachmentAdapter` → data URL → OpenAI 多模态 content,上传按钮按新增 `ChatModel.vision` 仅对视觉模型开放。**联网搜索**:`src/lib/chat/web-search.ts`(inject-results MVP,Tavily,model-agnostic,never throws)+ 工具条「联网」toggle → `web_search` flag;route 把检索结果拼成 system message 前插(`extractLatestUserText` + `runWebSearch`)。**dark 上线**:未配 `TAVILY_API_KEY` 时 `getWebSearchProvider()` 返 null、联网开关 no-op(纯对话照常),operator 在 VPS `.env` 配 key 再开。route §3:`MessageSchema` 收 `string | 多模态 parts`;adapter 把上游错误渲染成可见 `⚠️` 气泡(不白屏),abort 仍透传给停止键。tsc/lint/prettier clean,全套 **1577 pass / 1 skip / 0 fail**(新增 `chat-websearch` 7 + 多模态透传 / `web_search` 注入 / vision-flag 测试)。**真机浏览器 smoke(本地 dev)**:assistant-ui 在 Next 16 编译挂载无 console 错、picker + 视觉徽章、视觉门控上传(`gpt-5.4` 隐藏 / `Codex-opus-4-8` 显示)、联网 toggle、send→友好错误气泡 全过;**happy-path 逐 token 流式 / 视觉识别 / 联网结果待有余额账号验证**(本地 DB 用户线上 new-api record-not-found,同 v1)。部署后线上:`/chat` unauth→307、`stream` unauth→401。新依赖 `@assistant-ui/*` + `react-syntax-highlighter` + `remark-gfm`(operator 同意解除 v1 零依赖约束);无 migration,Caddy 不动。**已知**:`categorize.ts` 把个别 image/video 模型(`gpt-image-2` / `seedance-2.0`)漏进 chat picker(v1 同款,本 PR 不动)。

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

**症状**:同一上游(比如 sub2api)既能调 Codex 又能调 GPT,只配一个 Anthropic Codex 渠道时,GPT 调用 → `404 server_error`(模型不存在/上游路径不对)。
**真实行为**:new-api 的"渠道类型"决定它对该上游用哪种请求格式:

- `Anthropic Codex` type → `POST /v1/messages`(Codex 原生格式)
- `OpenAI` type → `POST /v1/chat/completions`(OpenAI 兼容格式)
  一个渠道只能一种类型,所以同上游有多种格式的 endpoint 时必须建多个渠道。
  **解决**:同 base URL + 同 key 配两个渠道,types 不同,每个渠道的 model list 各列对应模型。
  **实例**(W3 D1 落地):
- `sub2api`(Anthropic Codex type)— `Codex-opus-4-7` / `Codex-sonnet-4-6` / etc
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
# 真实 new-api 烟雾测试需要 SSH 隧道:
ssh -4 -fN -L 3000:127.0.0.1:3000 -o ServerAliveInterval=60 root@82.29.71.122

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

# 部署到当前 VPS(上线后)
# ⚠️ CI 实际**不**自动部署 — `.github/workflows/ci.yml` 只跑 typecheck/lint/test;
#    `release.yml` 仅在 `v*` tag 触发 Docker 镜像 push 到 dockerhub。
#    prod 更新后必须手动 deploy(W7 D4 PR-R 实测确认 — 2026-05-09):
ssh -4 root@82.29.71.122
# 登录后按 deploy/部署与运维手册.md 执行备份,再显式 build/up portal:
cd /opt/silkroadai-portal
git switch prod && git pull --ff-only origin prod
docker compose -f docker-compose.prod.yml build portal
docker compose -f docker-compose.prod.yml up -d portal
# 注:实际 VPS 路径是 /opt/silkroadai-portal(不是 silkroad-portal),
#     实际 compose 文件是 docker-compose.prod.yml,服务名 portal。线上不从 main 发布。
#     API 副本/Seedance 已由 profile 隔离;标准发布仍显式写 portal,不要启用可选 profile。
```

上线前配置检查提醒:

- 用户说「上线前检查」「部署前检查」时,必须核对 VPS 真实配置 `/opt/silkroadai-portal/.env`,不要只看仓库模板。
- 新服务器可先 `cp .env.prod.example .env`,但所有 `CHANGE_ME` 必须人工填真实值。
- Google/GitHub 登录必查:`APP_URL` / `NEXT_PUBLIC_APP_URL` / `BRAND_COOKIE_DOMAIN` / `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` / `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` / `GITHUB_OAUTH_REDIRECT_URI`。
- 生产 Google redirect 必须逐字为 `https://llmroute.club/api/auth/oauth/google/callback`,并且 Google Cloud Console OAuth Web Client 里也要填同一个 URI。
- 生产 GitHub callback 必须逐字为 `https://llmroute.club/api/auth/oauth/github/callback`,并且 GitHub OAuth App 的 Authorization callback URL 里也要填同一个 URI。
- OAuth 变量是运行时变量,改完重启 portal 即可;如果同时改了任意 `NEXT_PUBLIC_*`,必须按
  `deploy/部署与运维手册.md` 重新 `build portal`,再 `up -d portal`。Compose 会从 `.env` 传公开 build args。
- 验证命令:`curl -I https://llmroute.club/api/auth/oauth/google/start`,期望 302 到 `accounts.google.com`;`curl -I https://llmroute.club/api/auth/oauth/github/start`,期望 302 到 `github.com/login/oauth/authorize`。
- 支付上线必查:`PAYMENT_PROVIDERS=easypay` / `ENABLED_PAYMENT_TYPES=alipay,wxpay` / `EASY_PAY_PID=2026072211025295` / `EASY_PAY_PKEY` / `EASY_PAY_API_BASE=https://zpayz.cn` / `EASY_PAY_NOTIFY_URL=https://llmroute.club/api/easy-pay/notify` / `EASY_PAY_RETURN_URL=https://llmroute.club/pay/result`。`EASY_PAY_API_BASE` 不带末尾 `/`;`EASY_PAY_PKEY` 不进 git,只填 VPS `.env`。
- zpayz 易支付对应关系:创建支付走 `POST /mapi.php`(不是 `/submit.php`),notify 是 `GET /api/easy-pay/notify?...` 且必须返回纯 `success`;成功响应的 `payurl` / `qrcode` / `img` 都已兼容。zpayz 文档订单查询示例是 GET 带 `key`,代码当前为避免密钥进 URL 日志用 POST 查询;查询不是入账主路径,上线 smoke 若发现不兼容再调整。

---

## 环境变量速查(`.env`)

最少需要这些才能跑起来:

```bash
DATABASE_URL="postgresql://portal:devpass123@localhost:5433/silkroadai_portal_dev"

# new-api 后端(B3 主链路)— 本地通过 SSH 隧道:
#   ssh -4 -fN -L 3000:127.0.0.1:3000 -o ServerAliveInterval=60 root@82.29.71.122
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

- **new-api**: 当前部署在 `82.29.71.122`,容器端口发布到宿主机 `172.17.0.1:3000`,Portal 通过
  `host.docker.internal:3000` 访问;公网 `api.llmroute.club` 已启用 API-only Nginx virtual host 和
  Cloudflare cache bypass。正式渠道/模型尚未上货,真实模型调用待配置后验收
- ~~**LiteLLM**~~ — Stopped at W3 D1 (2026-05-02), container deprecated, config archived
- **Sub2API**: 部署在 VPS,作为 new-api 的一个 Custom 渠道上游(portal 不直接调)
- **易支付**: zpayz (`https://zpayz.cn`),支付宝充值/callback 已在当前生产验证;PID/KEY 只放生产 `.env`
- **SMTP**: 代码支持腾讯企业邮箱,但当前新服务器账号/密码为空,验证与找回邮件不可用
- **Cloudflare**: apex/`www`/`api` 均为显式 A 记录、橙云 + Full (strict);`api` 已启用 Cache Rule
  `Bypass LLmRoute API`;平台 R2、`images` 子域仍待配置

---

## 推荐的工作循环

```
1. 看 _bootstrap/docs/WEEK1-CHECKLIST.md 知道今天做什么
2. 起一个 feat/xxx 分支
3. Codex 写代码 → 写测试 → 跑测试
4. commit + push
5. 更新本文件「当前进度」区域
6. 下一个任务
```

---

## 遇到事情该问谁

- **战略决策、架构变更、跨服务排查、外部调研** → 用 Cowork(silkroadai-project-memory.md 那个对话)
- **项目内部具体编码、debug、重构、git 操作、跑命令** → 用 Codex(就是你)
- **客户跑过来问业务问题** → 用户自己处理(LLmRoute 微信)

---

**版本**: 2.3
**最后更新**: 2026-08-03
