# 上游同步报告 · 2026-09-14

## 合并前结论与范围

本报告先于 `main -> dev` 合并生成。operator 本轮要求按约定同步，没有安排本批 VPS 部署。

- 原 main：`8e9b60c0c04e0c122f0df354baa714be7860d24a`（#458）。
- 本批目标：`3f6b4074f22fbc29e247f6f5de98d6d347a051e4`（#464）；fetch 后 `origin/main` 与官方 `upstream/main` 完全相同，本地 main 仅 fast-forward 到该点，没有项目自定义提交。
- 集成前 dev/prod/origin/dev/origin/prod：`b092641b6a9004de373cd2d0ce3230d68857c9a9`。
- 提交差异：dev 独有 144 个提交，main 独有下列 6 个提交。上游增量共 11 个文件、492 行新增、18 行删除。
- 本轮保留已有定价发布核验、每档「改价并发布／历史」、动态拓扑、持久 token、固定图片 SKU 计费与任务恢复逻辑。
- `.env`、`.idea/vcs.xml` 和未跟踪的 `docs/真实上游毛利报表-需求文档.md` 是用户既有改动，已记录文件摘要，禁止纳入本轮提交。

## 逐提交行为（北京时间 UTC+8）

### 2026-09-11 11:26:35 · `a3c4599` · #459

标题：`fix(volc): 轮询遇非2xx但body带status时按任务态终态化,不再永停 queued (#459)`

- 火山/筷子视频轮询：此前 `HTTP 400 + status:failed` 被当作普通上游错误，任务可能一直留在排队状态；现在解析状态后返回 `200 + failed`，交由现有失败落库路径处理。
- 不带状态的 404/限流/服务错误继续走错误分支；2xx 非 JSON 返回可重试 502。
- 失败结果不生成 usage，不走正常完成扣费。影响客户轮询与后台对账；不新增提交任务或重试收费 POST。
- 必须保留上游两项原始回归：非 2xx 失败任务被识别、无状态的 404 继续报错。同时保留 dev 的任务 ID 持久化、恢复句柄、映射读失败重试、映射缺失保护与原因脱敏。
- 审计发现新判断接受任意非空 status，而未知状态默认映射为处理中，可能吞掉 400/429。本轮在 dev 补充已知任务状态判断及回归，保留上游原始失败修复，不修改上游原断言。

### 2026-09-11 17:02:53 · `5c37482` · #460

标题：`fix(image-adapter): we-token 三线上游超时 600s→300s(按 provider 覆盖) (#460)`

- Image 2.0/2.5 provider 增加可选 `upstreamTimeoutMs`；`wetoken`、`wetokenasia`、`wetokenasia25` 设为 300 秒，其他 provider 默认仍为 600 秒，`wetokengated` 不变。
- 超时中止 fetch，适配器返回中性 503，new-api 可按自己的配置尝试后续渠道；不保证本环境存在可用后续渠道。
- 源码中的计时器在 fetch 收到响应头后就清除，所以这是等待响应头的超时，不是整个响应 body、下载或生成流程的总截止时间。
- 保留上游 5 项虚拟时钟回归，验证 299 秒未中止、301 秒已中止和默认 600 秒。
- dev 的 `image-adapter25/__tests__/timeout.test.ts` 仍预期 wetokenasia25 在 600 秒中止，需随新语义改为 300 秒，保留单次 POST、无 usage/data 和 503 断言；这是本项目旧测试适配，不是弱化上游测试。
- 超时不证明供应商任务取消，慢任务可能继续消耗上游资源。未做收费调用或取消保证验收。

### 2026-09-11 21:53:50 · `d59d21d` · #461

标题：`fix(seedance-cn): 客户不传 ratio 时不再硬塞 16:9(首帧/首尾帧任务上游要求跟随输入图) (#461)`

- cn/global/promax 共用的提交适配器不再给省略或空字符串 ratio 的请求强加 16:9，让上游按首帧或任务类型决定比例。
- 显式合法比例/adaptive 原样保留，非法显式值仍宽松纠正为 16:9；`aspect_ratio` 别名继续支持。
- 不改变模型费率、任务提交次数和 480p 模型映射。保留上游新增「未传／空串」回归及本地 480p/提交一次回归。
- 边界：此修复仅针对提交适配器。Ark 严格入口仍拒绝空字符串；现有落库/轮询回显仍可能默认显示 16:9，不能宣称比例全链路已同步。

### 2026-09-13 22:08:31 · `06040f8` · #462

标题：`feat(image-adapter25): 接入 llmway25 上游 + per-provider quality 档位白名单(只放 low/medium/high) (#462)`

- Image 2.5 注册 `llmway25`，固定目标 `https://llmway.ai`，支持现有 flare/sunburst 两模型。
- provider 新增可选 quality 白名单；在 quality 归一后、供应商 fetch 前检查，只接受 low/medium/high。
- xhigh/max 返回中性 503 且零供应商调用；auto/空值归一为 low 可通过；非法字符串 quality 仍先返回 400。
- 沿用默认 600 秒超时，增加供应商品牌脱敏；没有新增环境变量或 Portal 凭据存储。保留上游新增 5 项测试。

### 2026-09-13 22:59:19 · `0ce6b2f` · #463

标题：`feat(image-adapter25): 接入 ominiapi25 上游,只放 xhigh/max 两档(补齐 llmway25 缺的高两档) (#463)`

- 注册 `ominiapi25`，固定目标 `https://www.ominiapi.com`，支持同样两个模型，只接受 xhigh/max。
- low/medium/high、auto/空值均在供应商调用前返回中性 503；归一、错误处理复用 #462。
- 沿用 600 秒超时并增加品牌脱敏，保留上游新增 4 项测试。未配置白名单的 wetokenasia25 仍接受五档。
- 两个新增 provider 只是候选代码；本项目 Image 2.5 继续默认关闭，不能视作已接入生产渠道或通过真实质量验收。

### 2026-09-13 23:58:00 · `3f6b407` · #464

标题：`feat(image-adapter): we-token 两线(ch176/177)守门改 onlyQualities=[low,medium],high 503 让路 (#464)`

- Image 2.0 的 wetoken/wetokenasia 从放开全部档位改为只接受 low/medium，high（含大小写归一及 size=auto）在 fetch 前返回 503。
- low/medium 支持原有尺寸及 auto；省略 quality 按 low 处理。按返回实际尺寸计算 usage、透明背景处理与 300 秒超时保留，wetokengated 不变。
- 是否切到其他渠道取决于 new-api 配置，本轮不改路由或渠道。
- 上游自身调整了 #460 超时 fixture 的 high→medium、4K usage fixture 的 high→medium，以及 high 回显 fixture 的 provider；本轮保留最终 main 的测试原文和新增拒绝/允许断言，不将这些上游调整冒充本项目修改。

## 环境、数据、安全与兼容性

| 项目                    | 本批影响                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 数据库                  | 无 schema/migration/backfill；现有 77 条 migration 文件保持不变。#459 使用已有任务失败落库路径，需验证失败不扣费与后续查询。  |
| 环境变量/依赖           | 无增删；不修改用户或生产 `.env`。新增 provider 沿用渠道 Authorization。                                                       |
| Docker/Nginx/Cloudflare | 无文件变更；继续单 Portal、Nginx，内部适配器公网 404。上游 server2/Caddy/渠道编号不是本项目生产配置。                         |
| 功能开关                | Image 2.5 与 Batch 默认关闭，新增 provider 不自动启用；不得仅因代码存在就配置供应商。                                         |
| 计费/定价               | 不修改 new-api 计费权威、Portal 价格发布核验、价格历史、图片固定 SKU 或费率公式。白名单拒绝无 usage；超时不保证上游停止计费。 |
| 安全                    | 保留客户任务归属、供应商错误脱敏、私网适配器边界和持久 token。上游文档的客户身份/测量/部署记录不复制为本项目事实。            |
| 生产操作                | 本轮仅集成与验收；通过后按约定 fast-forward prod，未获本批部署安排前不登录 VPS 发布。                                         |

既有未解决限制：Image 2.5 的尺寸没有入口严格 400 校验，现有测试依赖供应商拒绝；多图尺寸计费、WebP、远程下载、body 超时、mask 等旧待办仍未完成，继续关闭。视频失败落库当前缺少与完成状态竞争时的条件更新，迟到失败可能覆盖已完成记录；本批不宣称终态并发安全已保证，将核对受影响失败路径并在最终验收中明确范围。

## 与 dev 的差异与冲突预判

`git merge-tree --write-tree dev main` 只预判 `CLAUDE.md` 文本冲突；`cn-adapter.ts`、`kuaizi-adapter.ts` 及 cn 回归测试自动合并，但必须做语义审计。

- `CLAUDE.md`：dev 保留 LLmRoute 的部署约束、默认关闭与本地发布记录；main 新增上游超时事故和部署叙述，并改末尾更新时间。最终采用 dev 生产事实，另以本项目语境记录 provider 超时行为；不恢复「Batch 已可正式使用」或上游 server2 部署声明。
- Image 2.0 三个变更文件、Image 2.5 adapter/providers/adapter25 测试在原 main 与 dev 完全一致，采用目标 main 的新增实现及回归；本地 Image 2.5 入口开关和附加测试保留。
- Seedance：采用上游状态解析和比例省略修复，叠加保留 dev 的任务恢复句柄、映射读失败重试、映射缺失保护、480p/品牌兼容与提交一次约束；禁止整文件覆盖。
- 价格发布与分档历史 UI 等文件均不在上游增量中，合并后对集成前 dev 做文件差异检查，确认本轮没有覆盖此前修复。

## 验证计划与进度

合并前已确认本机 `http://127.0.0.1:3000/api/status` 为真实 new-api 状态 JSON；尚需完整测试中的管理鉴权模型列表检查。只执行只读接口，不做收费模型调用。

待执行：三方冲突最终审计；新增失败/未知状态与比例序列化回归；用旧实现复现上游原始故障；Image 2.5 300 秒测试适配；Prisma 校验、typecheck、lint、完整测试（含只读联机 smoke）、生产构建及相关文件格式检查。完成后在本报告追加实际结果和分支状态。

## 合并后追加审计

合并前报告已先提交为 `3ec550f`，随后执行 `main -> dev`，实际 merge 为 `8a4c378`。报告中的合并前计划与风险保留作为当时记录，后续结果以下文为准。

### 实际三方冲突取舍

唯一冲突文件是 `CLAUDE.md`。对比了共同基线 `8e9b60c`、dev 合并前 `b092641`（实际第一父 `3ec550f` 的该文件相同）、main `3f6b407` 与 merge `8a4c378`：

- main 在旧 Batch 说明附近增加上游超时事故，并将末尾更新时间换成其事故修复日期；dev 已移除不适用的 Batch 正式开放声明，并保留 LLmRoute 历次同步/部署记录。
- 最终以 dev 全文为基础，追加本批技术行为和默认关闭限制；原有本地部署记录全部保留。
- 放弃上游环境的客户身份、server2/Caddy/多副本上线叙述、渠道编号与生产测量，不将其作为本项目验收证据；采用其 provider 超时和质量限制的实际代码语义。

非文本冲突文件仍执行 fix-to-merge 审计：

- `git diff a3c4599..8a4c378 -- src/lib/seedance/kuaizi-adapter.ts src/lib/seedance/__tests__/kuaizi-adapter.test.ts`：上游两项回归逐字保留；差异为 dev 原有任务映射持久化失败恢复、查询读库失败重试、随机任务号无映射 404 保护，以及原有格式差异。未覆盖本次 failed 解析修复。
- `git diff d59d21d..8a4c378 -- src/lib/seedance/cn-adapter.ts src/lib/seedance/__tests__/cn-adapter.test.ts`：上游 ratio 新逻辑和新增回归保留；差异只有原有 LLmRoute 测试域名/资源域名注释、480p/单次提交回归与格式。
- Image 2.0 与 Image 2.5 的 adapter、providers、上游主测试共六个文件在 merge 结果与目标 main 完全一致；额外质量、超时、开关回归放在本地附加测试文件。
- 定价发布、每档价格历史 UI、拓扑、持久 token、固定 SKU 代理、迁移、依赖、Docker、Nginx、Image 2.5 入口与 Batch 共 17 组保护路径的差异检查均为空。仅这点不能替代渠道运行时兼容性检查。

### 本轮额外防回归修复

1. **非 2xx 状态边界**：`mapStatus` 对已知任务状态进行显式匹配，未知状态保留原 HTTP 错误；2xx 未知状态仍沿用原进行中回退。没有删除上游状态修复或反向修改测试。
2. **迟到失败覆盖完成**：合并后追踪确认原 Enterprise 客户轮询、后台对账的失败写入只按 id；本批 #459 扩大触发面，因此追加 pending（queued/in_progress）且 billed=false 的条件更新。未成功写入时不宣称已失败；读回已失败任务的保存原因，其他状态竞争或数据库错误返回可重试 503。过期对账也采用相同保护，只在实际改动时写终态日志。成功计费实现与 schema 不改。
3. 此保护只针对失败/过期覆盖完成或已扣费记录；不宣称所有完成/失败顺序都已实现全局单向终态，也没有补齐供应商受理后到独立任务记录落库之间的既有崩溃窗口。

### 原故障复现与行为验证

所有供应商响应均来自本地 mock/可控延迟 fixture，超时使用虚拟时钟；未调用真实供应商或收费接口。

| 场景                     | 修复前负对照                                                                                                                         | 最终逻辑正对照                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| #459 原始失败任务        | 在 b092641 运行上游原回归，400+failed 仍返回 400；无状态 404 对照通过                                                                | 替换当前 adapter 后，上游原两项回归 2/2 通过                                                                                           |
| #461 原始比例错误        | 在 b092641 运行上游原回归，省略 ratio 仍序列化 16:9                                                                                  | 替换当前 adapter 后，该原回归通过；另加三地区×8个实际 JSON 序列化边界                                                                  |
| 非 2xx 未知状态          | 在刚合并的 8a4c378，unknown/constructor/throttled/unavailable 四类分别吞掉 400/429/503                                               | 显式状态集合后对应筛选 6/6 通过                                                                                                        |
| #460/#464 Image 2.0      | 旧 adapter/providers 配上最终 main 原测试：两 provider 的 high 错误放行，两项 300 秒时钟未中止，共 4 项预期失败；默认 600 秒对照通过 | 最终 main 的同一原测试文件完整 143/143 通过                                                                                            |
| #460/#462/#463 Image 2.5 | 旧 adapter 配当前 registry：300 秒未中止、6项名单外 quality 仍调用 mock 上游后返回 200，共 7 项预期失败                              | Image 2.5 定向 5 files / 97 passed，包含新增 26 项入口关闭与 multipart 边界                                                            |
| 失败落库贯通             | 延迟供应商响应到达前保持 queued，尚未落失败或扣费                                                                                    | 实际 adapter→客户轮询／对账→条件写入两条路径：400+failed 落库、无 usage/供应商号、零扣费，再次查询直接读已保存失败原因且总共仅一次 GET |

负对照均在 `/tmp` 隔离目录运行，没有把共享工作区切回旧实现。证据包括 `/tmp/llmroute-upstream-regressions-20260914/reproduction.json`、`/tmp/llmroute-upstream-20260914/image2-control-summary.json` 与 Image 2.5 正反对照日志。

### 当前渠道兼容性只读检查

2026-09-14 北京时间 09:45，经 operator 已建立的 `127.0.0.1:3000` SSH 隧道，只读列出 new-api 全部 7 条渠道，分页总数核对完整；未发现 Base URL 路径使用本批变化的 wetoken/wetokenasia/wetokenasia25/llmway25/ominiapi25 适配器。检查输出只保存渠道总数与匹配结果，不保存渠道密钥。没有修改渠道/价格或登录 VPS 部署。

此结果不证明 Enterprise 客户独立 key 全部缺失，也不代替新增供应商真实质量/扣费验收。未来若配置上述 we-token 路径，必须先接受 high→503 与 300 秒等待响应头限制，并确认 new-api 存在可用后续渠道。

## 最终验收与分支结果

本轮应用修复提交为 `e54cd75`，后续仅追加验收文档。生产运行版本没有切换，本批没有登录 VPS、执行 migration、修改配置、渠道或价格。

| 检查                                                       | 结果                                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 完整测试 `NEWAPI_BASE_URL=http://127.0.0.1:3000 pnpm test` | 309 files / 4177 passed / 1 既有 skipped；未排除 smoke，包含真实 new-api 状态及管理鉴权模型列表 GET |
| `pnpm typecheck`                                           | 通过；新增测试曾使用不兼容当前 TS target 的 bigint 字面量，已改为 `BigInt(...)` 后重新完整通过      |
| `pnpm lint`                                                | 0 error / 93 个既有 warning                                                                         |
| 两套 Prisma schema validate                                | 均通过，无 migration 变更                                                                           |
| `pnpm build`                                               | 通过，完整编译/类型生成/111 个页面生成成功                                                          |
| 相关变更文件 Prettier / `git diff --check`                 | 最终通过；仅格式化报告，未重写上游原测试                                                            |
| 失败/完成时序独立对照                                      | 相同测试原文：8a4c378 的旧 proxy/reconcile 为 15 failed / 1 passed，当前实现 16/16 passed           |
| 用户既有文件                                               | `.env`、`.idea/vcs.xml`、未跟踪需求文档的 SHA-256 与本轮开始完全一致，未纳入提交                    |

构建限制已核对：本地 Portal PostgreSQL `127.0.0.1:5433` 未连接，公开价格页预生成出现一次 `ECONNREFUSED` 并进入已有错误横幅降级；该页面和 schema 与合并前相同。构建退出码为 0，但本地构建不等于真实 Portal 数据库页面验收；本轮没有执行生产数据库并发验收。发布时仍须在生产 Compose 环境重新构建并检查价格页，不能直接把本机 `.next` 当作线上发布产物。

### 测试调整的逐项理由

- `image-adapter25/__tests__/timeout.test.ts`：测试名 `600s` 改为 `wetokenasia25 300s`，时钟边界 599999→299999；abort 断言移到等待响应前，便于旧实现负对照立即指出未 abort。调用次数仍恰好一次，503、错误码、无 usage/data 断言全部保留。旧实现负对照已实际失败，未用调整断言掩盖错误。
- `enterprise/__tests__/proxy.test.ts`：「失败 → 标 failed 不计费」从无条件 `update` 改断言条件 `updateMany`，明确检查 pending+billed=false；「TaskTypeConstraint…客户据此停止轮询」的 where 同样增加条件。原失败响应和不扣费要求保留；公共 mock 返回实际 API 形态 `{count:1}`。
- `enterprise/__tests__/reconcile.test.ts`：「上游 failed → 落 fail_reason,不扣费」「仍在跑但未超保留期…」「volc 任务被上游判废…」的 where 增加状态与计费条件，保留原状态、原因、不扣费与分流断言。
- `enterprise/__tests__/ark-v3.test.ts`：仅增加 `updateMany` mock 和 count，原测试名称与断言完全不改。
- 上述 Enterprise 的旧实现通过新的可控延迟对照实际复现已完成/已扣费被覆盖、写入异常仍假报 HTTP 200，以及零行过期更新仍写迁移日志；当前 16 项全部通过。未把「必须落失败」改成「一概不落失败」，pending 任务真实失败仍正常落库，只有状态已变化或未能持久化才拒绝伪报终态。
- 本批上游新增回归原样保留；cn 主测试原有 LLmRoute 域名与 480p 测试是集成前已有差异。本轮新回归均独立添加，没有删除、跳过或反向改写上游修复测试。

### 发布边界

验收通过后将 dev fast-forward 到 prod，并推送 origin/dev、origin/prod；main 保持上游提交，不纳入自定义修复。本批仍是**待部署**版本：必须由 operator 明确安排本次 VPS 发布。Image 2.5/Batch 继续默认关闭，没有真实收费请求、支付或新增供应商验收。
