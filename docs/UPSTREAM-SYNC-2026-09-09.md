# 上游同步报告：2026-09-09（#449–#451）

## 合并前报告

本节在实际 `main -> dev` 合并前完成。operator 本轮指令为「稍等，先不上线，我又同步了上游代码，然后你按照我们的规则执行」。本轮执行上游报告、dev 集成、语义审计和验证，不登录 VPS，不发布服务；完整测试通过才允许按分支约定 fast-forward prod。上轮的部署授权已暂停。

### 范围与分支

- 上一轮上游基线：`1c94f206dd141b108f95f001a20e570948ee9387`（#448）。
- 本轮目标：`fd6b2cde223240b1ad1f434978c4b3fe90dac991`（#451）。已 fetch origin 与 upstream，`main = origin/main = upstream/main`；3 个新增提交均来自官方上游，main 只做 fast-forward，没有项目自定义提交。
- 合并前 dev：`68f6837`（包含上轮 merge `f555455` 及审计记录）；prod / origin/prod：`02cbf26`。
- 上游独有 3 个提交；dev 相对本轮上游独有 122 个历史提交（含历史 merge、品牌、计费、拓扑、发布文档等，完整 SHA/标题附后）。本轮仅新增 3 个上游提交，不重复算上轮 #391–#448 的 58 个提交。
- 用户原有 `.env` 修改与未跟踪的 `docs/真实上游毛利报表-需求文档.md` 保留；本轮不写入或提交这些文件。
- 证据目录：本机 `/tmp/llmroute-sync-20260909/`。上轮测试与 6 条 migration 的验证见 `docs/UPSTREAM-SYNC-2026-09-08.md`。

### 逐提交行为（时间均为北京时间）

| 北京时间            | SHA       | 原始标题                                                                                             |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| 2026-09-09 01:01:52 | `6efa7c9` | fix(seedance): 国内版/火山 seedance 2.5 1080p 调价 90/54 → 77/46 (#449)                              |
| 2026-09-09 12:15:48 | `3413443` | fix(seedance): cn 2.5 480p 换稳定上游名 artsdance→doubao-seedance-2-5-260628 (#450)                  |
| 2026-09-09 13:54:58 | `fd6b2cd` | feat(image-adapter25): gpt-image-2.5 flare/sunburst 独立适配器(5 档 quality + 官方输入图口径) (#451) |

#### #449 — `6efa7c9`

- `src/lib/seedance/cn-billing.ts` 的 `2.5 / 1080p` 基准由无视频输入 ¥90、含视频输入 ¥54，改为 ¥77 / ¥46，单位均为每百万 token。480p/720p 仍为 ¥70 / ¥42；global/proMax 的独立费率不变。
- `officialCostCny` 是国内版和 Enterprise cn/volc 的共享基准，网页价目表随函数推导更新。seedance-cn 标准零售仍只乘一次 0.85；Enterprise 仍只乘客户 discount，不能叠两次折扣。
- 原 `official-price-parity.test.ts` 中 1080p 的期望值随费率更新，其余场景未删减。
- 这是实际计费行为变化，不只是文案。任务在完成结算时读取当前代码费率；没有价格快照 migration，也不重算已有 `billed=true` 账单。未来发布跨越时尚未结算的 2.5/1080p 任务会采用新基准，必须验证延迟完成和重复结算语义。
- 本轮不修改 new-api 后台价格、渠道、客户折扣或历史账本。上游提交中的「operator 核对」属于上游项目记录，不等于 LLmRoute 线上已验收。

#### #450 — `3413443`

- 国内 `seedance2.5-480p` 与 `seedance2.5-480p-ref` 的默认上游名从 `artsdance-2-5-260628` 改为 `doubao-seedance-2-5-260628`。
- 720p/1080p 继续使用 `artsdance-2-5-pro-260801`；对客模型名、480p 档位、费率、提交/轮询协议不变。`SEEDANCE_XHK_MODEL_25_480P` 环境覆盖仍优先；已显式配置旧名的环境不会仅因更新代码自动换名。
- `cn-adapter.test.ts` 保留原本的 480p/参考图档映射断言，更新其目标名。
- 上游报告旧名 12 次请求中 6 次拒绝 480p、新名 28/28 成功；这是上游实测声明，本轮只验证代码映射及请求边界，不把该统计记作本项目生产 smoke。
- 没有新增环境变量、migration、依赖或基础设施文件。

#### #451 — `fd6b2cd`

- 新增独立 `src/lib/image-adapter25/{adapter,providers}.ts` 和内部 `/image-adapter25/[provider]/v1/images/{generations,edits}` 两个 POST 路由。保留旧 `src/lib/image-adapter` 原样；新 provider 注册名为 `wetokenasia25`。
- 一个 provider 接受 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` 两个精确白名单名；按请求的模型透传。模型不匹配返回中性 503，无 Authorization 返回 401。凭据来自 new-api 渠道传入的 Authorization，适配器不保存 key。
- quality 支持 low/medium/high/xhigh/max，auto/未知归一 low。输出 usage 采用五档网格，输入参考图采用 32px patch、上限 1536 的公式；prompt token 仍是估算。上游附有采样值回归测试，但本项目未使用真实 provider key 复核其官方计费声明。
- 原生透传 n，不做 n 次扇出；最多钳为 10，以实际返回张数合成 usage。只输出 Images 的 input/output/total 和 details 字段，不再加 Chat 别名。
- 向上游过滤 response_format；上游 URL 图片拉回为 b64；PNG/JPEG 按返回首图尺寸计算 usage；透明请求过滤已识别的无 alpha 图片。jpeg 未兑现时由 Jimp 回退转码；按实际格式回显；复用既有按内容清理 Adobe 元数据的工具。
- 安全拒绝和明确输入错误返回终态 400；网络失败、5xx、渠道错误和无图返回 503。单次请求不在适配器内重 POST，new-api 仍可能执行渠道 failover。
- `src/middleware.ts` 单独排除 `/image-adapter25/`，避免大图 edits 被 middleware 的 10MB body 缓冲截断；旧 `/image-adapter/` 的字面匹配覆盖不到新名字。
- `src/app/v1/[...path]/route.ts` 增加 `isGptImage25Model` 和 `ImageEchoFields.tier5`，仅在 2.5 模型的 JSON/multipart 响应中回显 xhigh/max；2.0 与固定价 SKU 沿用既有行为。新增适配器测试和 7 个 echo 枚举测试默认原样保留。
- 本轮没有渠道配置操作，也不会自动让机器模型目录出现这两个新模型。

### 数据库、环境、服务器与安全兼容性

| 类别              | 本轮影响与处理                                                                                                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据库            | 3 个提交均无 schema/migration。上轮尚未发布的 6 条新增 migration 仍保留在 dev；未来部署仍需从生产 70 条升级到 76 条，本轮不执行生产迁移。                                                                                                                                          |
| 环境变量          | 无新增变量；#450 修改现有 `SEEDANCE_XHK_MODEL_25_480P` 的代码默认值。实际 `.env` 不改。Batch 保持默认关闭，`PORTAL_BATCH_ENABLED=false` 的既有门控保留。                                                                                                                           |
| 依赖/构建         | package.json、pnpm-lock、Dockerfile、Compose 均无上游改动；沿用 Next/Prisma/Jimp。仍需执行类型、lint、测试和生产构建。                                                                                                                                                             |
| Nginx             | 上游没有 Nginx 补丁，但新增内部入口只判断 Authorization 是否存在，不能作为公网客户接口。当前 `llmroute-web.conf` 必须新增 `/image-adapter25/` JSON 404；API-only host 既有 `/v1/`、`/v1beta/` 白名单已默认拒绝此路径。本轮仅修改仓库配置并本机验证，待下次发布前先安装并校验配置。 |
| Cloudflare/服务器 | 无需本轮更改 DNS、缓存规则、证书、Docker 网络或启动 profile。继续采用 LLmRoute Nginx 单 Portal 实例；不照搬新 provider 注释中的上游 `172.20.0.1:3010`/Caddy 部署地址。LLmRoute 内部地址应为 `http://silkroadai-portal:3002/image-adapter25/wetokenasia25`。                        |
| 旧业务            | 固定图片 SKU 原始模型名、尺寸、计费、最多 4 路扇出和禁流守门保留；动态拓扑、持久客户 token、充值回调不在本轮上游修改范围。                                                                                                                                                         |
| 新渠道启用        | 新适配器暂不配置渠道或宣称可用。其供应商、价格、实际格式与收费失败恢复需另行验收，不能以函数测试替代真实链路。                                                                                                                                                                     |

新适配器代码审阅发现的启用前限制：目前多张图片共用首张尺寸计费，WebP 尺寸/alpha 不能完整判定；URL 下载缺少私网/重定向约束且 50MB 检查发生在全量读取之后；上游 POST 的 600s 定时器在收到响应头后即清除，不包含后续 body 读取；edits 的 mask 字段未透传。这些是新增上游实现本身的限制，不能表述为已完整支持的能力。本轮保留独立模块并做公网隔离，不启用渠道；不借上游同步扩展成供应商接入或收费真机测试。

### dev 差异与冲突预判

`git merge-tree --write-tree 68f6837 fd6b2cd` 的预演仅写 Git 对象，不更改分支、index 或工作树；结果为 1 个文本冲突。

| 文件                                            | 合并前 dev 语义                                                                                          | 本轮上游语义                             | 预判与计划                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/v1/[...path]/route.ts`                 | 固定价 SKU 原名进入 new-api，注入/强校验固定尺寸，最多 4 路 n 扇出，禁 stream；LLmRoute 图床、Batch gate | 加 2.5 quality echo 门控，不触碰固定 SKU | 文本冲突位于模型判断函数与固定 SKU 定义相邻区。新增 2.5 helper，同时保留 dev 固定价类型/函数和所有守门；逐个检查两条 echo 构造与 reshape 调用。 |
| `src/lib/seedance/cn-adapter.ts`                | 主要相对 main 为资源域名说明与格式差异                                                                   | 480p 默认目标名修正                      | 自动合并；检查 480p 实际出站请求采用新名、720p+ 不受影响，保留环境覆盖。                                                                        |
| `src/lib/seedance/__tests__/cn-adapter.test.ts` | LLmRoute 域名测试值                                                                                      | 更新原 480p 上游名断言                   | 自动合并；不改上游测试名称、调用次数或断言方向，只保留既有品牌差异。                                                                            |

新适配器、其测试、price parity 测试、billing 常量、middleware、echo 单元测试均无项目侧同区修改，计划接收上游。Nginx 公网隔离为必要的 LLmRoute 部署适配，单列记录。

### 验证计划与现有阻塞

- 先保存并输出本报告，再实际 merge main 到 dev；记录最终 SHA 和逐文件三方语义取舍。
- 上游新增测试原样保留；对 JSON/multipart 2.5 echo 与旧固定 SKU 的实际 handler 行为、480p 的实际出站模型名、1080p 延迟完成/重复结算、适配器失败不自重发进行定向验证。
- 执行完整 `pnpm test`、typecheck、lint、Prisma validate、生产构建；完整测试中联机 smoke 需真实 new-api，上一轮本机 3000 返回 HTML，本轮会核对当前目标并如实记录，不更改测试来制造通过。
- schema/migrations 与合并前相同时沿用上一轮 PostgreSQL 16 的升级预演证据；不对生产或用户开发库执行迁移。
- 本机隔离 Nginx 验证新路径在 apex/www/API host 的响应；不登录 VPS。
- 合并后对 #449、#450 分别执行 `git diff <fix>..<merge-result> -- <affected-files>`；#451 虽是 feat 也审计其触及的公共代理，确认没有覆盖本项目固定 SKU 语义。
- 全套测试未通过则不推进 prod；本轮无论测试结果如何都不部署。最终结果追加在本报告末尾。

## 附录：本轮上游文件变化

```text
A	src/app/image-adapter25/[provider]/v1/images/edits/route.ts
A	src/app/image-adapter25/[provider]/v1/images/generations/route.ts
M	src/app/v1/[...path]/route.ts
M	src/app/v1/__tests__/image-echo-conformance.test.ts
A	src/lib/image-adapter25/__tests__/adapter25.test.ts
A	src/lib/image-adapter25/adapter.ts
A	src/lib/image-adapter25/providers.ts
M	src/lib/seedance/__tests__/cn-adapter.test.ts
M	src/lib/seedance/__tests__/official-price-parity.test.ts
M	src/lib/seedance/cn-adapter.ts
M	src/lib/seedance/cn-billing.ts
M	src/middleware.ts
```

## 附录：合并前 dev 独有提交

```text
68f6837 docs: record upstream merge verification and release blockers
f555455 merge(upstream): sync main #391-#448 into dev
ce23083 docs: record production model smoke results
02cbf26 docs: record topology production rollout
c91afcc fix(pricing): enforce dynamic tier topology
2206da4 docs: mark upstream sync branches as pushed
d4721e4 docs: record 2026-09-02 production deployment
3b3dd1b docs: normalize project memory formatting
6f68ef6 docs: record local new-api port 3000
8d59ce4 docs: clarify preserved workspace state
3aa029d docs: record upstream sync #384-#390
5a8ed8e merge(upstream): sync main #384-#390 into dev
88af847 fix(image): fan out fixed SKU multi-image requests
1576c95 fix(image): enforce fixed SKU output dimensions
45ea775 fix(billing): audit complete model mapping chains
26932a7 feat(billing): add fixed-price GPT image SKUs
348d12b docs: prepare modified new-api release
637787b fix(deploy): 加固 Prisma migration 文件权限
8a9181f fix(auth): 同步新用户默认计费档次到 new-api
cd473d1 fix(billing): 校准 Portal 技术计费单位换算
6650970 Revert "feat(admin): add upstream cost evidence ledger"
b62a7b6 feat(admin): add upstream cost evidence ledger
ac96e47 feat(admin): migrate customer keys to dedicated tier
ce38b5f fix(admin): harden portal user dedicated multiplier sync
266fc75 feat(admin): sync portal user dedicated multipliers
73e4e1f feat(admin): show new-api customer identity
249d8bc merge: sync upstream main into dev
c917253 merge: sync upstream main into dev
782e487 feat(admin): add official price lookup to calculator
a5c0f86 merge: sync upstream main into dev
63bae4a merge: sync upstream main into dev
5f21c9d merge: sync upstream main into dev
5f6cc82 fix(seedance): align local upstream model override
7d1cabf fix(portal): hide internal balance units from customers
808f37a merge: sync upstream main into dev
4cf2cbe refactor(admin): simplify pricing calculator UI
4eab6e5 fix(admin): make pricing calculator reset observable
b6a04df feat(admin): add pricing calculator
b2147de merge: sync upstream main into dev
2c2ee9f docs(memory): record new-api token merge incident
6da611d fix(newapi): persist durable customer access tokens
fe0f5ca fix(keys): keep tier dropdown above card bounds
2221299 Merge branch 'main' into dev
bfd0a47 chore(enterprise): remove unused media metadata variable
690e841 Merge branch 'main' into dev
45653d8 docs(ops): record 2026-08-06 production deployment
53d30a3 docs(workflow): record upstream asset storage sync
c5a5a55 Merge branch 'main' into dev
5a1246d docs(workflow): record upstream responses failover sync
d5cd281 Merge branch 'main' into dev
bf5f427 docs(workflow): record upstream enterprise 480p sync
cb5c01f Merge branch 'main' into dev
6665a98 docs(ops): record 2026-08-05 production deployment
b480b09 docs(workflow): record upstream image fanout sync
2f0e3f9 Merge branch 'main' into dev
52dd294 fix(admin): preserve hidden legacy consoles
4540b12 fix(admin): retire legacy Sub2API consoles
fef22b1 docs(ops): record BBR tunnel recovery
d87301d Merge branch 'main' into dev
095ce0d docs(ops): record first offsite backup
2bc75db docs(ops): record isolated restore drill
94abc9f docs(ops): record verified backup cron
149d9c4 fix(ops): harden database backup output
6ea3a6c docs(ops): record SSH key-only hardening
db6a754 docs(ops): record 2026-08-04 production deployment
a166b28 fix(deploy): keep image adapter internal
6f8d1c9 Merge branch 'main' into dev
36e9cc3 fix(deploy): align nginx virtual hosts
44397af feat(deploy): isolate public API hostname
e9b672e fix(ci): restore lint and format gates
b2fead2 fix(deploy): harden production build configuration
3ca2451 docs(ops): record current production deployment
2feea6b docs(workflow): record upstream sync and release policy
29f2371 merge(main): sync upstream changes
11ca367 fix(brand): update customer WeChat contact
59410da fix(new-api): use login access token on current releases
c8550f2 fix(new-api): accept refresh cookie during provisioning
9afd16e test(proxy): align image URL expectation with llmroute domain
7430cbe Merge remote-tracking branch 'origin/main' into dev
c33add5 docs(deploy): record production rollout configuration
5e881ef Merge branch 'main' into dev
f923a7e Merge branch 'main' into dev
b91fb40 Merge branch 'main' into dev
5131e72 add
e049cb3 Merge branch 'main' into dev
f2be5bc chore(dev): sync development environment
d0dc481 feat(portal): redesign customer dashboard
325975c Merge remote-tracking branch 'origin/main' into dev
66e0bbf chore: track development env
2c845d6 Merge remote-tracking branch 'origin/main' into dev
3529bc0 Merge branch 'main' into dev
515b8a7 Merge branch 'yexioy:main' into main
4aa2d9d Merge branch 'yexioy:main' into main
2f536d8 Merge branch 'yexioy:main' into main
fc3fe1a Merge branch 'yexioy:main' into main
ae85994 Merge branch 'yexioy:main' into main
3797ac8 Merge branch 'yexioy:main' into main
9e0b5af Merge branch 'yexioy:main' into main
beb521e Merge branch 'yexioy:main' into main
48160dd Merge branch 'yexioy:main' into main
e0a3ada Merge branch 'yexioy:main' into main
d24a167 Merge branch 'yexioy:main' into main
a795749 Merge branch 'yexioy:main' into main
9ff27ed Merge branch 'yexioy:main' into main
a0e1bd0 add
b41a429 （docs）部署运维手册优化
90ca066 chore(deploy): expose portal-postgres on host loopback for SSH-tunnel admin access
14090f8 Merge branch 'yexioy:main' into main
c311d15 Merge branch 'yexioy:main' into main
afa6d41 Merge branch 'yexioy:main' into main
7303d2d Merge branch 'yexioy:main' into main
29e0732 chore: upgrade stripe-node submodule to official latest version
5818c20 docs:去除.env文件版本控制
2be1bcf Merge branch 'yexioy:main' into main
4a0c42e docs(deploy): 新增 llmroute.club 环境部署与运维手册
ceac34c fix(deploy): portal 端口只绑 127.0.0.1,不暴露公网
39a0d6c chore(deploy): 修复 pnpm 构建警告 + 新增本地/线上 env 模板
bbe8887 feat：新增了本地Google测试兼容
9d3accb Merge branch 'yexioy:main' into main
d1e838f add
03d28ef Merge branch 'yexioy:main' into main
067f73e add
```

## 合并后语义审计与验证

### 唯一冲突文件的三方取舍

`src/app/v1/[...path]/route.ts` 的冲突只发生在 `isGptImageModel` 后、`gptImageVariant` 前的相邻代码区。

- 合并前 dev `68f6837`：固定 SKU 是独立计费模型；`gptImageVariant` 返回 alias/size/width/height，`resolveGptImageVariantSize` 校验固定尺寸。请求必须带原 SKU 进入 new-api，固定 SKU 的 stream、n 上限、扇出和返回尺寸处理已具备专门保护。
- 上游 `fd6b2cd`：新增独立的 `isGptImage25Model`；周边历史实现仍把 `gpt-image-2-{1,2,4}k` 当普通可降级别名，返回 base/size 并去掉 SKU 后缀。
- 最终：接收上游新增的 2.5 helper、tier5 字段、quality 两个新值及 JSON/multipart/reshape 三条连接；保留 dev 的完整固定 SKU 类型和实现。放弃上游旧 SKU 降级语义（不是放弃 #451 的新增修复），避免 new-api 在计费前丢失 SKU。
- 已用独立脚本构造「合并前 dev 文件 + 上游本次七处 echo 修改」，与最终文件逐字比较完全相同。因此该冲突没有额外替换 dev 中的固定尺寸、四路扇出、禁流、JPEG compression、LLmRoute 图床或 Batch gate。
- 三方快照存于本机证据目录 `proxy-{base,dev-before,upstream,merged}.ts`；合并前/上游 Git SHA 足以从仓库复现。

### 自动合并与上游测试保留

- `cn-adapter.ts` 采用上游新的 480p 默认值和原有环境覆盖；与 main 的差异仍只有之前的资源域名说明和 TypeScript 格式。480p 文生/参考图、720p、1080p 的实际出站 POST 均在新增测试中校验模型名、分辨率、audio=false 和一次提交。
- `cn-adapter.test.ts` 的上游原场景、名称、调用次数和断言方向均保留；已有的 LLmRoute 品牌 URL 差异保留，额外添加 4 个请求边界案例。
- 新增适配器的 `adapter25.test.ts`、`image-echo-conformance.test.ts`、#449 的 `official-price-parity.test.ts` 最终与 main 逐字一致。本轮未改写或删除任何上游新增回归断言。
- 新适配器实现/provider 注册表、cn-billing 和 middleware 最终与 main 逐字一致；原 2.0 图片适配器与合并前 dev 逐字一致。
- 其他新增测试：公共 proxy JSON 4 项（含 2.0/固定 SKU 对照）、multipart 2 项；延迟结算与失败 7 项；适配器 600s 超时 1 项；middleware 新路径 2 项。合计新增本项目回归 20 项。

### 高风险场景与原故障对照

- 1080p 在任务尚无 usage 时不抢占、不扣款；两分钟后 usage 到达再按新费率结算。零售为 ¥65.45 / ¥39.1，Enterprise 在客户折扣 0.9 时为 ¥69.3 / ¥41.4（每百万 token，分别无视频/含视频），cn 和 volc 一致且只乘一层折扣。
- 延迟的 ledger 写入仍在途时发起第二次结算，以及一小时后的再轮询，都不产生第二次扣款。ledger 等待 30 秒后报错时保留原 claim，之后轮询不重扣。测试使用真实异步 Promise 和可控时钟，Prisma/ledger/new-api 边界为 mock，不宣称做了生产账本写入。
- 负向对照：把这 7 个新结算案例指向 `68f6837` 的旧 `cn-billing.ts` 快照（只重定位 import，未修改工作区源代码），7 项均因旧价格失败：零售 ¥76.5/¥45.9、企业 0.9 折 ¥81/¥48.6；合并后 7 项通过。证据 `premerge-control.log`。这证明测试可发现 #449 的原错误，而非只验证永远成功的 mock。
- 新适配器收到响应头前卡住时，599999ms 保持一次 POST 在途，600000ms abort 并返回中性 503，无 data/usage，不自动重 POST。此测试不证明超时后的外部服务已取消收费，且不覆盖上游代码已记录的响应 body 超时缺口；新渠道继续未启用。
- schema/migrations、持久 token 客户端、认证、支付/充值、动态拓扑、Batch scheduler、Docker/Compose 均与合并前无差异。未访问生产数据库或修改渠道；生产不变量需在未来部署时重新核查，不能把本地单测当作线上验收。

### 本地验证结果

环境：Node `24.19.0`（与项目 `.node-version` 的 24 一致）、pnpm `10.30.3`（项目固定版本）、Vitest `4.1.10`。

| 检查                               | 结果                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 10 个受影响定向测试文件            | 574 passed                                                                                                                                    |
| 完整 `pnpm test`                   | 285 files：284 passed / 1 failed；3656 passed / 1 skipped / 1 failed                                                                          |
| 完整测试中的非 smoke 部分          | 284 files / 3654 passed / 1 skipped（由完整测试结果排除既有联机文件的 3 个测试计算；未另行重复跑 test:ci）                                    |
| `pnpm typecheck`                   | 通过；新增测试初稿的 BigInt 字面量与项目 TS target 不符，改为现有代码同款 `BigInt(...)` 后通过；无业务代码修复                                |
| `pnpm lint`                        | 0 error / 93 warnings，与上轮基线相同                                                                                                         |
| `pnpm exec prisma validate`        | 通过；本轮零 migration 变更，沿用上轮 PG16 合法拓扑升级 70 → 76 的验证证据                                                                    |
| `PORTAL_SCHEDULERS=off pnpm build` | 通过，2 个新增 adapter25 路由进入生产构建。静态 pricing 因本机 DB 不可达记录 ECONNREFUSED 降级，不能当作价格数据已验收                        |
| Nginx 1.28-alpine 隔离验证         | `nginx -t` 通过。apex / www / API 三个 host × 4 类内部适配器均 POST 404；另外 3 条普通页面/API 路径仍到达本地 stub（200），证明未扩大拦截范围 |

完整测试的唯一失败仍是 `src/lib/newapi/__tests__/client.smoke.test.ts` 的模型列表断言：expected Array, received null。独立无凭据检查 `http://127.0.0.1:3000/api/status` 和 `/api/channel/models_enabled` 均为 HTTP 200 text/html，非 new-api JSON。health 的 200 不能当作真实链路成功。没有改 smoke、没有修改用户 `.env`、没有建立 VPS SSH 会话，也没有制造假的接口响应来放行发布门。

格式检查覆盖 1186 个 tracked/本轮新增文件（不包含用户未跟踪内容），初次仅上轮同步报告的裸 `<Link>` 被 Prettier 反复改变缩进。已将它标为行内代码，业务含义不变；最终文档修改后再检查相关文件。

### 分支与发布结论

本轮完成 dev 集成；完整联机 smoke 未通过，prod 不 fast-forward，仍为 `02cbf26`。operator 已暂停部署，本轮没有生产发布。main 保持官方上游 `fd6b2cd`，不承载本项目 Nginx 或测试改动。最终 merge SHA、修复提交 diff 审计和推送状态在提交后追加。

### 提交后的 fix SHA 审计

实际合并提交：`634808f4425a0c39cbabdd3ff0554a29de04e5cf`，父提交依次为 `68f6837eed1ec1acd71463396e1eaf35d2318c1d`、`fd6b2cde223240b1ad1f434978c4b3fe90dac991`。后续审计记录只修改本文档。

已逐项实际执行 `git diff <upstream-commit>..634808f -- <该提交涉及的文件>`；完整输出保存在 `/tmp/llmroute-sync-20260909/audit-*.diff`。

| 上游提交       | 审计结果                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `6efa7c9` #449 | diff 为空；费率源与上游价格回归测试原样进入 merge，¥77/¥46 未被覆盖。                                                                                                                                                           |
| `3413443` #450 | 剩余差异只含此前 cn-adapter 的品牌说明/格式、cn-adapter 测试的 LLmRoute URL 和新增 4 个真实出站请求断言；480p 新默认模型名和原上游断言保留。                                                                                    |
| `fd6b2cd` #451 | 仅公共图片代理有 715 行既有定制差异；独立适配器、注册表、两个路由、middleware、上游新增测试均与该提交一致。公共代理已逐字证明等于合并前 dev 加本次七处上游 echo 修改，固定 SKU、图床、JPEG compression、Batch gate 语义未丢失。 |

最终相关文档和新增测试的 Prettier 检查通过；此前 1186 文件检查发现的唯一格式问题已修正。用户 `.env` 与原未跟踪需求文档的 SHA-256 与开工前相同；未提交用户内容。prod / origin/prod 仍为 `02cbf26`，不会因本轮合并自动发布。
