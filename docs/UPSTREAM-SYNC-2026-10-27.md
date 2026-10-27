# 上游同步合并前报告：2026-10-27

**本轮范围已确认：2026-10-27 operator 明确选择「先只出报告，暂不合并」。本轮到报告为止，不执行 main → dev、迁移或部署；后续合并须等 operator 重新安排。下文集成建议不是执行授权。**

## 核对范围与当前状态

本报告在实际 `main → dev` 合并前输出。已通过 Git 直接 fetch 核对：

- fork `origin/main` 与官方 `upstream/main` 均为 `5778304ed21fb0afde9e03e89d2ded36ee0ab297`。
- 上次已集成上游为 `48f914ba6b6bf2dbce3ca9f446d3a0fb5bc56e48`，本批新增 **4 个提交**。
- 本地 `main` 已从该基线 fast-forward 到 `5778304e`；旧 main 是官方上游祖先，没有混入本项目自定义提交。
- 本轮开始时 `dev`、`prod`、`origin/dev`、`origin/prod` 均为 `86c982d8`，工作区干净。
- 合并前独有提交数：`dev / main = 243 / 4`。新增上游改动 30 个文件，增加 1,990 行、删除 100 行。
- `git merge-tree --write-tree dev main` 预演发现 **8 个文本冲突文件**，没有修改工作区、索引或 dev。
- 首次 fetch 被已有 Git URL 专用代理 `127.0.0.1:10808` 拒绝；仅本次命令覆盖代理后成功，没有修改用户 Git 或系统代理配置。

截至本报告形成时，尚未合并 dev、执行数据库 migration、修改生产配置或登录 VPS。本轮尚未运行完整测试。下文列出的集成措施是建议，不能当作已经实施或验收。

## 逐提交行为（北京时间，提交时间）

| 北京时间            | 短 SHA     | 上游标题                                                                                                             |
| ------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| 2026-10-25 21:35:54 | `c60017e2` | fix(pricing): 专属倍率读路径换源 /api/pricing(act-as)— 客户 PAT 无 profile:read 导致 self/groups 403 回落全局 (#569) |
| 2026-10-26 10:58:37 | `c6543ade` | fix(image-adapter): ztyunjuan 改要 url 直拉 Firefly S3,绕开上游 b64 回送慢段 (#571)                                  |
| 2026-10-26 18:18:56 | `94bda16a` | feat(admin): 客户专属倍率写路径 — 后台面板 + GroupGroupRatio 两键同写 + 留痕 + 每小时对账 (#570)                     |
| 2026-10-26 20:00:59 | `5778304e` | feat(seedream): 售价下调到官方 5 折 + 支持火山方舟原生路径 /api/v3/images/generations (#573)                         |

### #569：客户 PAT 的倍率读取兼容

- 新增 `getPricingGroupRatiosForCustomer`，以客户 access token 和 `New-Api-User` 请求 `/api/pricing`，读取响应信封顶层的 `group_ratio`，不从 `data` 内取值。
- `getEffectiveGroupRatios` 从 `/api/user/self/groups` 改为此数据源，避免上游记录的客户 PAT 缺少 `profile:read` 时 403。上游公共函数仍有 60 秒缓存，以及失败时采用旧缓存或公共价的行为。
- 新增请求头、顶层字段、403、缺字段测试，并调整有效倍率测试的 mock。
- 本项目 Key 页面实际还使用自定义 `getVerifiedEffectiveGroupRatios`，它仍读取 `/self/groups`。只接受上游那一处替换，不能修复本项目这条严格读取路径。
- 集成需保留严格分支的客户身份、零倍率、不增加客户响应之外的分组、无报价缓存，以及失败时不回退公共价。上游 helper 接受缺少 `success:true`、缺少 `group_ratio` 时返回空对象，并未拒绝负倍率；不能直接替换后降低当前校验。
- 无 migration、环境变量、依赖、部署配置变化，不写 new-api 配置或轮换 token。

### #571：ztyunjuan 改为下载上游图片 URL

- provider 新增 `upstreamUrlResponse`，仅为 `ztyunjuan` 启用。
- 同步 JSON 生图和 multipart 改图请求不再强制 `response_format=b64_json`，让该 provider 返回默认图片 URL；适配器复用现有 `fetchImageAsB64` 下载并转换。
- 对客户仍返回原来的 base64 或平台图床结果，不把上游 URL 直接作为客户交付地址；其他 provider 保留原请求方式。
- 新增两种请求格式及最终转码结果的回归。上游记录的加速时间属于其环境，不能当作 LLmRoute 性能验收。
- 不改变模型路由、价格、计量、数据库、环境变量或服务器配置；没有自动创建渠道。下载安全、超时和失败处理仍依赖原有公共下载实现。

### #570：另一套客户专属倍率管理

- 客户详情新增专属倍率面板和 superadmin GET/PUT 接口，按客户整体替换倍率列表。
- 保存顺序为：校验全局分组与倍率 → 固定客户空分组 Key → 写 `GroupGroupRatio` 与 `group_ratio_setting.group_group_ratio` 两个配置键 → 将客户移到 `vip-<username>` → 事务写 Portal 留痕及用户组镜像 → 清缓存 → 客户身份回读。
- 修改用户组时先读用户，保留 `display_name` 和 `remark`；空倍率列表意图取消专属价并回到 `default`。
- 新增 `CustomerRatioOverride` 表和 `User.newapi_user_group`，并增加日志记录。
- 新增定时任务：启动两分钟后首次运行，此后每小时读取留痕、矩阵和用户组并报警。**这是只读对账，不是自动改价或修复**；代码最多读取 500 个客户，且不覆盖本项目已有 `UserTierMultiplier` 管理记录。
- 上游广场过滤客户自己的内部用户组；本项目广场已通过 Portal 目录生成可见分组，不能为接入此过滤而恢复原始上游 pricing 透传。

发现的确定集成阻断：

1. `setCustomerRatios` 在空输入时把 `targetGroup` 设为 `default`，随后 `delete matrix[targetGroup]`。若共享 `GroupGroupRatio.default` 存在，取消一个客户的专属价会删除该共享行。
2. 本项目广场读取 `UserTierMultiplier`，新入口只写 `CustomerRatioOverride`；直接开放两套入口会造成扣费与目录报价的事实来源分裂。
3. 新写入不使用本项目定价协调锁，整个矩阵的读改写可能与原专属倍率入口、全局改价或另一客户保存互相覆盖。
4. Key 修改、两个 option PUT、用户迁组与本地事务不是同一事务。第二次 PUT 或后续步骤失败时，前面的状态已经改变，新实现没有相应持久恢复/补偿流程；回读失败仍可能返回 `ok:true`。
5. 取消固定回 `default`，丢失本项目精确恢复 `original_newapi_user_group` 的语义。坏矩阵会被宽松解析为空或跳过部分项后再覆盖，弱于当前严格拒绝策略。
6. 可选档次未按租户过滤，PUT 仅确认全局 GroupRatio 存在；空 Key 使用 `vip* → default` 猜测，且最多遍历 50 页而未证明到达完整末页。

建议本轮保持既有倍率入口与 `UserTierMultiplier` 为唯一在用流程。若保留上游候选代码，新的 UI、写入口和定时任务须明确隔离，不能仅隐藏按钮；后续整合须解决上述问题并验证失败恢复，不能将“入口关闭”写成“新功能已验收”。

### #573：Seedream 改价与 Ark 原生入口

- `SEEDREAM_PRICING.sellDiscount` 从 `0.55` 改为 `0.5`，直接改变适配器合成 usage/quota，**属于实际计费代码变化，不只是价格文案**。
- Flash 单张 quota 从 33,660 改为 30,600；Pro 普通低/高档从 84,150/168,300 改为 76,500/153,000；额外参考图从 5,610 改为 5,100。图层单价同步下降。
- setup 脚本提示、文档价格和原测试金额随之修改。持续同步授权不包含擅自改价，本项目建议保留 `0.55`，也保留已有默认 2,360,000 像素阈值与显式配置机制。
- 主站新开放 `POST /api/v3/images/generations`：将 Seedream Pro/Flash 官方模型别名转换为现有客户模型名，内部复用 `/v1/images/generations`；成功响应回显客户原模型名，拒绝 `stream=true`，其他主站 `/api/v3` 路径仍 404。Enterprise 分支保留原处理。
- 新入口 `await res.json()` 会消费完整 `/v1` 响应再返回，阻断既有 keepalive 的首字节/涓流传递。隔离内存模拟已复现该差异；不是生产超时或收费验收。
- 普通对象别名表未检查 own property，`__proto__`、`constructor` 等能绕过应有白名单；成功响应 JSON 解析失败后返回的原 Response 已被消费。
- 新路由没有完整 OPTIONS/CORS 支持。现行 API 子域 Nginx 只放行 `/v1/*`、`/v1beta/*`，因此该 API 域路径仍会 404；主站 catch-all 能到新路由，但原有 Cloudflare API 规则、超时策略不能自动覆盖它。
- 建议原生入口作为待修复兼容能力保留并关闭；若本轮选择开放，需同时修复流式保活、别名白名单、响应消费和 CORS，并单独审查精确路径 Nginx/Cloudflare 变更，不可直接宣传 SDK 链路已验收。

## 数据库、配置与上线影响

| 项目               | 上游实际变化与集成要求                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| migration          | 新增 `20261025120000_customer_ratio_overrides`：users 新增 nullable TEXT 列；新增倍率表、用户外键、复合唯一索引及用户索引。没有 backfill 或历史删除。若最终保留该 schema，须在新应用读取字段前迁移并完成隔离恢复验证。 |
| 现有 schema        | Seedance 大段变化主要是格式调整；必须保留本项目已经移除的 `pool` 默认值及其他本地字段，不得整块选上游。                                                                                                                |
| 环境变量与依赖     | 四提交没有新增环境变量或依赖，package/lock 未变。若集成增加隔离开关，应在最终报告单列，属于本项目适配。                                                                                                                |
| scheduler          | 上游新增默认启动的只读倍率对账，不是自动改价；不应把它当作现有客户倍率的完整对账。                                                                                                                                     |
| Nginx / Cloudflare | 上游没有配置改动。原生 Ark 路径与当前 API-only 白名单不一致，需要显式决策，不能顺带放宽整个 `/api/*`。                                                                                                                 |
| 安全与权限         | 保持原会话、PAT、租户、Key 归属、动态拓扑、定价锁和错误时拒绝报价。不得轮换管理员凭据或把短效 JWT 持久化。                                                                                                             |
| 实际经营行为       | 不执行 setup 脚本、不创建渠道、不改价、不发收费推理或充值、不启用既有关闭功能。                                                                                                                                        |
| 发布环境           | 最新已记录应用为 `04f0bdf1`，现役主机为 `103.240.199.146`；88 条已应用迁移和一条旧 rolled-back 历史需保留。本报告未现场复核生产状态。                                                                                  |
| 构建与回退         | 现役 4GB VPS 禁止重型编译；独立原生 amd64 构建、校验后仅 load 与 no-build 发布。应用回退保留新增可空列，不用整库恢复覆盖新交易。                                                                                       |

## 与 dev 的差异和冲突预判

本项目对上游基线有 243 个独有提交，不能以整文件采用上游方式处理。预演的 8 个文本冲突如下；这不是最终三方语义审计，实际合并后仍需逐项补记结果。

| 冲突文件                                          | 预判与建议保留语义                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                                       | 保留 LLmRoute 现役环境、品牌和项目状态，新增本轮说明；上游部署、价格、客户与性能记录不冒充本项目事实。                           |
| `prisma/schema.prisma`                            | 新候选倍率表与本地字段/格式相撞；保留 UserTierMultiplier、价格发布协调、动态拓扑和视频字段，新增 schema 是否接入按最终范围处理。 |
| `src/app/admin/(console)/customers/[id]/page.tsx` | 本地已有 RateOverridesPanel；不能挂两个独立改价面板。                                                                            |
| `src/app/api/portal/models/[...path]/route.ts`    | 保留 Portal 目录/完整人民币报价、private no-store、身份失败关闭和性能过滤；不能恢复上游原始报价透传。                            |
| `src/app/docs/page.tsx`                           | 保留 LLmRoute 共享 docs-content 入口；兼容说明应写到真实正文，不能带入旧域名或未经授权的五折价格。                               |
| `src/lib/newapi/client.ts`                        | 合并新读取函数和 token group 类型时保留现有 PAT/legacy 鉴权、安全校验及 token 更新能力。                                         |
| `src/lib/newapi/effective-group-ratios.ts`        | 接入新读取源时同时覆盖严格分支，保留无缓存、零倍率和失败关闭；候选新写入的缓存失效不能覆盖严格策略。                             |
| `src/lib/seedream/adapter.ts`                     | 保留现有 0.55 计费及可配置像素阈值，不以消除冲突为由继承上游经营调价。                                                           |

自动合并也需要语义审查：`instrumentation.ts` 会接入新的默认定时任务；`/api/v3` 会开放新生成入口；上游测试可能与本项目报价代理实现不相容。自动合并无冲突不代表可以直接上线。

## 建议实施与验证边界

1. 完整接入 #569 的 PAT 读取修复和 #571 的图片 URL 下载优化，保留回归。
2. 保留现有专属倍率管理和 Seedream 价格；#570 新流程及 #573 原生入口先隔离，不自动启用。另一种范围是本轮完整重构这些功能，但那是明显更大的定价/权限工作。
3. 上游测试默认原样保留；若因当前 Portal 报价事实来源、0.55 价格或关闭入口改变断言，逐项记录原因，保留原始测试用于独立对照，不得反向改测试掩盖故障。
4. #569 覆盖真实失败时序的模拟：客户 PAT 在旧端点 403、新端点有效；缺字段/坏值、零倍率、客户 A/B/凭据切换、成功后失败均不得串价或回公共价。
5. #571 验证 JSON/multipart 发出形态、原图片返回、URL 下载失败、非目标 provider 行为保持；不发收费模型请求。
6. 若保留候选入口，验证默认不可达且没有配置写入/任务启动；若选择完整开放，必须先解决上述实际阻断并做故障与并发验证。
7. 实际合并后对每个冲突补 `dev@86c982d8`、`main@5778304e`、最终结果的三方语义审计，并对修复文件执行 upstream-fix 到 merge-result 的差异核对。
8. 通过 typecheck、lint 零 error、完整测试、格式、Prisma 校验、生产构建后，才进入 prod/发布阶段。新 migration 若保留，须做 PostgreSQL 16 隔离迁移和旧数据不变验证；真实只读 smoke 与收费供应商验收分别记录。

## 合并后语义审计与验证结果

operator 随后授权按建议开始实施。最终合并提交为 `968e5099`，父提交为本地开发基线
`58d760dc` 和上游 `5778304e`。逐文件三方取舍如下：

| 冲突文件                                          | 最终采用的语义                                                                                                         | 放弃/隔离的上游内容                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `CLAUDE.md`                                       | 保留 LLmRoute 当前生产、品牌和历史事实；本报告单独记录本批范围。                                                       | 上游维护线的客户倍率写入、五折经营记录和旧域名文案未写入项目事实。                |
| `prisma/schema.prisma`                            | 保留 dev 的定价发布协调、`UserTierMultiplier`、视频字段和已移除 `pool` 默认值。                                        | #570 的 `CustomerRatioOverride` 与 `User.newapi_user_group` 未接入。              |
| `src/app/admin/(console)/customers/[id]/page.tsx` | 保留现有 `RateOverridesPanel` 和当前客户倍率入口。                                                                     | #570 的第二个专属倍率面板未挂载。                                                 |
| `src/app/api/portal/models/[...path]/route.ts`    | 保留 Portal 目录生成、客户身份失败关闭、`private/no-store` 和性能数据过滤。                                            | 未采用上游内部 `hideOwnUserGroup` 透传改写，避免改变现有目录事实来源。            |
| `src/app/docs/page.tsx`                           | 保留 LLmRoute 的共享 docs-content 入口和当前域名/价格语义。                                                            | 未套用上游旧域名、五折 Seedream 文案或独立 Ark 使用说明。                         |
| `src/lib/newapi/client.ts`                        | 保留 dev 的 PAT/legacy、token 生命周期和严格管理接口；新增 #569 的客户 `/api/pricing` 读取 helper。                    | #570 仅为写入口服务的 token group 扩展及 `customer-ratio.ts` 依赖未进入最终代码。 |
| `src/lib/newapi/effective-group-ratios.ts`        | 普通有效倍率读取改用 `/api/pricing`；严格 Key 页面也改用同一客户响应，同时保留身份校验、零倍率、缺价拒绝和不补全分组。 | 没有采用普通 helper 的宽松结果作为严格路径，也没有恢复公共价静默替代。            |
| `src/lib/seedream/adapter.ts`                     | 保留 dev 的 `0.55` 售价折扣、2,360,000 默认阈值和显式配置保护。                                                        | #573 的五折计费和 2,610,000 自动阈值未采用。                                      |

自动合并部分也按范围复核：保留 #571 的三个适配器文件及对应回归；删除 #570 的 migration、后台面板、API、留痕模块、scheduler 和测试；删除 #573 的 Ark 路由、实现、测试及五折测试金额。最终提交相对 `86c982d8` 只包含 8 个兼容性文件和本报告，没有数据库 migration、环境变量、依赖、Nginx 或 Cloudflare 改动。

修复类差异复核已完成：#569 的最终代码在 `client.ts` 中只新增 `/api/pricing` 客户读取，并在两个倍率读取入口共用；#571 的最终代码只增加 provider URL 响应模式，不改变其他 provider 的 body、usage 或计费。上游新增的 #569/#571 回归场景保留；对本项目严格读取测试的 mock 按新数据源更新，未反向删除失败关闭断言。

验证结果：

- 定向倍率和图片适配测试：4 个文件，330 passed。
- 完整非 smoke 测试：389 个文件，6,263 passed，1 skipped。
- `pnpm typecheck`：通过。
- `pnpm lint`：0 errors，100 个既有 warnings。
- 本次变更文件 `prettier --check`：通过。
- `pnpm exec prisma validate --schema prisma/schema.prisma`：通过。
- `pnpm build`：通过，Next.js 生产构建生成 116 个静态页面/路由结果。
- 全仓 `pnpm format:check` 仍会命中仓库已有的 outputs/需求文档格式差异；本轮没有格式化或改动这些无关文件。

当前本地 `dev` 为 `968e5099`，`prod` 仍为 `86c982d8`；截至本报告更新时尚未执行生产数据库迁移或 VPS 部署。后续发布只能使用本次已验证的兼容性范围，不能因为上游 `main` 已包含 #570/#573 就把它们带入 `prod`。
