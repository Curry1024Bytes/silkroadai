# 上游同步报告 · 2026-09-08

## 合并前报告

范围：`557681d..1c94f20`，58 个上游提交（#391–#448）；目标为 `dev@ce23083`。本地 main 已仅 fast-forward 到 origin/main，未添加项目提交。当前 prod 为 `02cbf26`。报告先于 main → dev 合并输出。

工作区用户已有 `.env` 修改与未跟踪需求文档不纳入同步。Git 单次绕过不可用的 localhost:10808 代理完成 fetch，未修改全局配置。不登录 VPS、不执行渠道配置脚本、不发收费请求。

### 数据库、配置与上线影响

- 6 条新增 migration：`20260819230000_volc_id_map`（原生/上游 ID 映射）；`20260829120000_add_batch_api`（files/batches/results 三表）；`20260831130000_volc_group_meta`（组名所有权）；`20260903090000_enterprise_request_logs`（请求日志）；`20260904040000_reqlog_asset_actions`（日志 action/resource_id 可空列）；`20260904060000_enterprise_admins_audit`（管理员与审计表）。均增量，不删除历史数据；与本项目同时间戳但不同名称的 topology migration 并存，须先迁移再启新镜像。
- 新模板配置：ENTERPRISE_VOLC_ALLOW_LOW_TIERS、ENTERPRISE_VOLC_REQUIRE_ARK、ENTERPRISE_VOLC_VENDOR_WAIT_MS、ENTERPRISE_REALPERSON_PROVIDER、ENTERPRISE_POLL_CACHE_MS、MINIMAX_XHK_BASE_URL、MINIMAX_XHK_KEY、BATCH_MAX_REQUESTS、BATCH_MAX_INPUT_BYTES、BATCH_LINE_CONCURRENCY、BATCH_SELF_BASE_URL。代码另增加 ENTERPRISE_REQLOG_POLL_ALL、ENTERPRISE_REQLOG_RETENTION_DAYS、SEEDANCE_GLOBAL_MODEL_25、SEEDANCE_XHK_MODEL_25_480P 等可选开关，须按实际使用功能核对，不能把上游账号/渠道信息当成本项目配置。
- package.json/lockfile 没有上游变更。Compose 新加 172.21.0.0/16 固定网段，源于上游 Caddy/多机环境；本项目保留现有网络定义，不接受该网段迁移。api-replicas/seedance profile 继续隔离。
- 新 MiniMax/Seedream 适配器只能由 new-api 内部调用；主站当前只屏蔽 image-adapter，须给新增路径加同样 404 隔离。API 域名的 /v1 与 /v1beta 白名单继续保留，Cloudflare 无需改动。600s 上游超时与主站 300s timeout 存在差异，收费慢请求以 API 域名为准，不能将 Cloudflare 或客户端超时视为取消。
- Batch 持久化 auth_header 为明文；结果落库幂等不能保证收费调用幂等：HTTP 发出后进程崩溃/落库失败会重放，进程内 running 也不是跨实例锁。因此本项目合并时应默认关闭新增 Batch 入口及 worker，待凭据存储和崩溃恢复完成后再启用，现有同步调用不受影响。
- Enterprise 请求日志含请求正文、上游原文、IP/UA；应仅监督权限可读，正文脱媒/截断不等于全面敏感信息清除。新次级管理员拥有企业日常写权限，监督面仍 super-only；不改全局 UserRole。审计异步落库，失败会 warn，不能宣称强一致审计。
- volc 配客户 kz- key 才获得上游账号隔离；占位符回落共享 env key 仍然共享素材，不能误报隔离已完成。视频等待原生 ID 超时后上游仍可能继续执行；失败终态、429/5xx 瞬时降级须分别验证。新渠道、新模型、480p 与默认价格仅是代码支持，未在 LLmRoute 配置或验收。
- 图片按实际尺寸合成 usage 必须与 LLmRoute 固定 SKU 尺寸和固定价格共存；持久 token 换取、动态档次 fail-closed、历史价不复活档次均须保留。Seedream 配置脚本不执行，不能用其固定组或三键镜像覆盖本项目拓扑。

### dev 差异与预判冲突

当前 dev 独有客户 UI/LLmRoute 域名、固定图片 SKU/扇出、计费换算和映射审计、动态档次拓扑、持久 token 修复及 Nginx/Compose 加固。完整独有提交清单见文末。

merge-tree 预演 7 个冲突文件：`src/__tests__/app/dashboard-page.test.tsx`、`src/__tests__/instrumentation.test.ts`、`src/app/(authenticated)/dashboard/page.tsx`、`src/app/(authenticated)/dashboard/period-tabs.tsx`、`src/app/docs/page.tsx`、`src/app/v1/[...path]/route.ts`、`src/lib/seedance/kuaizi-adapter.ts`。

处理策略：逐文件三方比较；保留 dev 业务语义与品牌、接入上游真实修复。docs 新章节适配到 docs-content；dashboard 保留本项目布局并接入异步区块与反馈；代理保留固定 SKU 与 CORS 约束；测试保留上游新增回归案例，任何断言适配单列理由。自动合并文件也检查拓扑、价格、迁移和生产配置语义。

### 逐提交行为与影响

以下各节时间均为北京时间。行为依据为提交说明和代码差异；上游说明里的线上账号、验收、价格及部署状态仅属于上游，不代表 LLmRoute。各提交的 migration/env/config 变更文件同时列出，整体安全与兼容性影响见上文。

#### 40f521e · 2026-08-18 23:25:51 · fix(enterprise): 上游 4xx 任务级失败终态化 —— 止住无限轮询 (#391)

2026-08-18 实测:weirdo 的一条 seedance-2.5 任务被模型判成「视频延长」
(ratio 必须 adaptive),上游对每次轮询都回 HTTP 400
InvalidParameter.TaskTypeConstraint。我们把它当「轮询瞬时失败」透传,任务
永远停在 queued → 客户脚本无限重试:**8925 次 / 22 小时**,单条任务约
7 次/分钟,还顺带把上游打到 429(当天 2671 次轮询失败里绝大多数是它)。

根因:上游用 HTTP 4xx 表达「任务已废」,而我们对所有非 2xx 一视同仁 ——
既不落库、也不终态化。对账器同样只在超 48h 保留期才终态化,所以卡满两天。

- upstream-error:新增 category `task_type_constraint`(TaskTypeConstraint 的
  「视频编辑」变体文案含 duration 字样,分支必须【早于】duration,否则被截胡;
  有守护用例)。分类信号加入上游 error.code —— TaskTypeConstraint 只出现在
  code 字段,不在 message 里。
  新增 isTerminalTaskFailure(category, status):
  · 终态 = 4xx 且非 429 + 「请求本身不合法」类(task_type_constraint /
  content_safety / copyright / invalid_parameter / resolution / duration /
  media_fetch)—— 这些等多久都不会变好;
  · 瞬时 = 5xx / 429 / upstream_account —— 任务多半还活着,绝不误杀;
  · task_gone 刻意【不】终态化:它描述上游状态而非请求本身,一次查询抖动
  就杀任务风险太大,交给对账器 48h 过期兜底。
- 两个 adapter 的错误体加 `error.category`(机器可读),供调用方判定。
- enterprise proxy handlePoll:终态 → 落库 status=failed + fail_reason,并返回
  **HTTP 200 + status:failed**(不是把 4xx 抛给客户 —— 那正是被当异常然后
  无限重试的原因)。下次轮询走既有「已 failed 短路」,连上游都不打。
- reconcile:同一判据,不再只有超 48h 才终态化。

失败任务不计费,本改动不影响任何计费路径。

11 新测(终态/瞬时切分 + 分支顺序守护 + proxy 端到端 5 例:TaskTypeConstraint
与内容审核终态化落库、502/429 不落库不误杀、已 failed 短路不打上游)。
全套 257 files / 3017 pass / 0 fail。

变更文件：`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/enterprise/reconcile.ts`、`src/lib/seedance/__tests__/upstream-error.test.ts`、`src/lib/seedance/cn-adapter.ts`、`src/lib/seedance/kuaizi-adapter.ts`、`src/lib/seedance/upstream-error.ts`。

#### 3a3b652 · 2026-08-18 23:44:42 · fix(enterprise): 对账器按 region 分流 —— volc 任务改走 kuaizi 端点 (#392)

#391 部署后验证时发现:那条卡了 22 小时的 volc 僵尸任务,对账器跑完仍没被
终态化。根因是 #391 之前就有的老 bug —— reconcile 对所有 region 一律走
pollVideoWithKey(cn-adapter),而 baseForRegion('volc') 回落国内 base,
等于拿筷子的 task id 去 token.xinhankr 查,永远查不到。

后果:volc 任务在对账器这条路上【从来没能被终态化】,只能靠客户轮询自愈
(handlePoll 的分流是对的)。客户一旦放弃轮询,任务就永久卡在 queued,
连 48h 过期兜底都走不到(那条分支在 !res.ok 之后)。

修:region==='volc' → pollVolcVideo(task.id),与 enterprise/proxy 的
handlePoll 保持同一套分流。volc 用平台共享 env key,不再去查客户的
per-region 上游 key(查了也没用)。

4 新测:volc 走 kuaizi 端点且不取客户 key、volc 4xx 终态化落库、
volc 5xx 不落库、volc 与 cn 混批时各走各的上游。
全套 257 files / 3021 pass / 0 fail。

变更文件：`src/lib/enterprise/__tests__/reconcile.test.ts`、`src/lib/enterprise/reconcile.ts`。

#### acbb827 · 2026-08-19 00:16:18 · fix(enterprise): 轮询遇上游瞬时故障降级 —— 不再把 429/5xx 抛给客户 (#393)

轮询失败 ≠ 任务失败。上游限流(429)或抖动(5xx)时任务多半还在跑,但我们把
上游错误原样透传给客户,脚本往往直接当异常中断整条流水线 —— 2026-08-18
客户就是这么报障的(「上游返回 HTTP 429」「502 Bad Gateway」),而当时那些
任务其实都活着(实测 cgt-20260818055654-6zhtb 报 502 时仍 in_progress)。

改:handlePoll 遇 429 / 5xx → 返回 HTTP 200 + 库里最后已知状态
(queued / in_progress,火山形走官方词表 queued/running),带响应头
`X-Silkroadai-Poll-Degraded: 1` 供我们排查区分。客户照常轮询,任务真出片
时自然拿到结果。

刻意的边界:只认 429 与 5xx 这两类【明确瞬时】信号。4xx 的 unknown /
task_gone 仍原样透传 —— 对它们降级会造出新的无限轮询(客户永远拿到
in_progress 却永远等不到完成),那正是 #391 刚修掉的病。终态类(#391)
继续终态化,不受影响。

5 新测 + 2 条旧测改预期:429/502 降级且不落库、503 时回显 in_progress 而非
queued、火山形降级吐 running(不泄露内部词)、4xx unknown 仍透传且无降级头。
全套 257 files / 3024 pass / 0 fail。

变更文件：`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`。

#### ecbb2ec · 2026-08-19 00:49:26 · feat(enterprise): 轮询短 TTL 缓存 + 并发合流 —— 从源头降上游 QPS (#394)

#393 解决的是「429 发生后不伤客户」,这条解决「少让 429 发生」。

客户的轮询频率原本 1:1 传导到上游:实测 liyan2 曾同时 29 个任务在途,
按每 5 秒轮一次 ≈ 350 次/分钟打到上游,直接触发 nginx 限流(2026-08-18
峰值 129 次 429/分钟)。而视频出片要几分钟 —— 秒级轮询拿到的答案跟 8 秒前
一模一样,纯属自我限流。

新 src/lib/enterprise/poll-cache.ts,两件事:

- 短 TTL 缓存:同一 task 在 TTL 内只打一次上游(缺省 8s,
  ENTERPRISE_POLL_CACHE_MS 可调,置 0 关闭);已完成结果缓存 60s ——
  结果不会再变,而客户完成后常重复拉取成片 URL
- 并发合流(single-flight):同 task 的并发轮询共用一次在途请求,避免
  「TTL 刚过 + 客户并发」瞬间打出一堆重复请求

缓存的是原始 (HTTP 状态码, 响应体文本),不是 Response —— 调用方拿到后照常跑
完整下游逻辑(落 tokens / 幂等扣费 / 客户 OSS 转存 / 序列化),**所有副作用
一个不少**,对客语义完全透明。扣费本身 CAS + (kind,ref) 双幂等,重复执行零风险。
终态化落库后主动 invalidate,免得 TTL 内还返旧的排队态。

上游报错也进短 TTL 缓存 —— 限流时继续猛打只会更糟。

已知取舍:进程内缓存,企业实例 3 副本各存各的 → 上游 QPS 上限是
3 × (1/TTL) per task,不是 1 ×。要再降只能上共享缓存(目前无 Redis)。
对账器不走缓存(要权威状态)。

10 新测(TTL 命中/过期/并发合流 10→1/任务间不串/完成态长 TTL/报错也缓存/
开关与调参/invalidate/上游抛错不落缓存)。
⚠️ 顺带给 proxy 与 ark-v3 两个测试套加 __resetPollCache() —— 缓存是进程级的,
用例复用同一 task id 会互相串台(生产不受影响:task id 唯一 + 归属校验在缓存之前)。

全套 258 files / 3034 pass / 0 fail。

变更文件：`.env.example`、`src/lib/enterprise/__tests__/ark-v3.test.ts`、`src/lib/enterprise/__tests__/poll-cache.test.ts`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/poll-cache.ts`、`src/lib/enterprise/proxy.ts`。

#### f1a2989 · 2026-08-19 02:36:02 · feat(enterprise): 火山渠道透传 vendor_task_id + 2.5 放开 1080p (#395)

上游筷子文档 v1.1 → v1.3 两处变化,实测逐条确认后落地。

【v1.3】查询响应新增 vendor_task_id(渠道侧原始任务 id),running 阶段即返回
(此前实测只在 succeeded 才有 —— 上游按我们需求提前改了)。全量透传给下游:

- v1 形 → body 加 vendor_task_id + 响应头 X-Silkroadai-Vendor-Task-Id
- 火山形(ark)→ **只走响应头**,body 一个多余键都不加:火山官方响应里没有
  这个字段,#326 起 cn/volc 面只出官方声明字段(客户按严格白名单校验,多一
  个键就拒)。头对 schema 校验零风险。

⚠️ 已知取舍(operator 知悉后拍板仍要透传):它【不总是】火山原生 id。文档原话
「字节方舟渠道为方舟原始任务 ID(形如 cgt-...);其它三方渠道为对应渠道平台的
任务 ID」。实测同一 model(mini)/同一分辨率(480p),08-17 是
`cgt-20260817125256-tfv79`、08-19 是 `tsk-ghubt0mgm8impt83`。tsk- 形拿去跟
火山对账查不到,形态上也暴露没走官方直连。留逃生阀
`ENTERPRISE_VENDOR_TASK_ID_ARK_ONLY=1` → 只透 cgt- 形(改 env 即可,不用发版)。

【v1.2】doubao-seedance-2.5 放开 1080p(仍无 4k)。我们档位表停在 480p/720p,
等于在误拒客户合法请求。零成本实测确认(用非法 duration 探分辨率校验,
不建任务):1080p 过校验、4k 报 allowed: 480p, 720p, 1080p。
同步客户文档 /enterprise/docs 矩阵 —— 防漂移守护测试正是这么抓到的。

顺带纠正注释里的产品名张冠李戴:筷子这条返回的是火山【TOS 对象存储】
(ark-acg-cn-beijing.tos-cn-beijing.volces.com + X-Tos-Signature,文档 v1.1
响应示例即为此域名);而 cn 渠道(xinhankr)返回的才是【VOD 点播】
(实测 …vod.cn-north-1.volcvideo.com)。两条渠道给客户的域名本就不同,
都属火山自有域名,不影响「隐藏中间商」的口径。cn-adapter 与主站 /docs 的
VOD 说法经实测确认无误,保持不动。

7 新测(cgt- 透传 / tsk- 默认也透传 / 逃生阀只挡非 cgt- 形 / 上游未给不崩 /
v1 头+body / ark 只给头且 body 无多余键 / 2.5 档位表)+ 3 条旧测更新。
全套 258 files / 3043 pass / 0 fail。

变更文件：`.env.example`、`src/__tests__/app/enterprise-docs-page.test.tsx`、`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/seedance/__tests__/kuaizi-adapter.test.ts`、`src/lib/seedance/kuaizi-adapter.ts`。

#### cd1c971 · 2026-08-19 09:31:03 · feat(enterprise): 素材 vendor 字段补齐 + 真人活体检测并到筷子 (#396)

- feat(enterprise): 素材 vendor 字段补齐 + 真人活体检测并到筷子

对照上游最新文档逐条实测(不是读代码猜的),三组 vendor 字段的适配情况:

- 视频 vendor_task_id → 已适配(#395)
- GetAssetGroup / ListAssetGroups 的 VendorGroupId → 已透传(我们原样转发 Result)
- GetAsset / ListAssets 的 VendorAssetId / VendorAssetUrl → 已透传
- **CreateAssetGroup 的 VendorGroupId → 被丢了**(写死只挑 Id),本 PR 补上
  三项能力上游都已为我们账号开通(建真实组+素材验证,用完已删)。

⚠️ 顺带发现 id 形态撞车:筷子的 vendor id 与我们平台库【同前缀】——
我们平台库 asset-{14位时间戳}-{6位十六进制} (newAssetId: randomBytes(3))
筷子 vendor asset-{14位时间戳}-{5位字母数字} (实测 asset-20260819085202-247l9)
筷子平台 Id 纯十进制
而 shouldUseKuaiziAssets 的 isPlatformAssetId 只看前缀 → 客户若把 VendorAssetId
当句柄传回来会被误路由到平台库 → 404 且报错指错方向。改成按【完整形态】匹配
(^(asset|group)-\d{14}-[0-9a-f]{6}$)。生产库实测 31 素材 + 29 组【100% 匹配】,
零例外,收紧安全。

【真人活体检测并到筷子】此前走 727 provider,那是条**断链** —— 认证产出的 GroupId
挂在 727 账号里,而 volc 生成早已换成筷子,拿 727 的 group id 去 asset:// 引用筷子
根本不认。并过来后与视频面/素材面同一个筷子账号自洽。
逃生阀 ENTERPRISE_REALPERSON_PROVIDER=727 切回旧 provider。

筷子契约为实测所得(文档只列了 Action 名、无字段定义):
CreateVisualValidateSession ← { CallbackURL }(**必填**;上游报错文案写的是
「URL is required」,有误导性,我按 URL/Url/ImageUrl… 试了一圈才试出来)
→ { BytedToken, H5Link, CallbackURL };H5Link 仍指向 ark.volcengine.com 官方页
GetVisualValidateResult ← { BytedToken }
⚠️ 活体未完成时上游返 **HTTP 500 + rpc 内部串**(不是干净的未完成语义)→
我们统一映射成 404「真人认证尚未完成」,不外泄 rpc 细节
route 层把客户传的 CallbackURL 透下去(客户不传则用门户域名兜底)。

⚠️ **成功路径未经真人实测** —— 需要真人在手机上做完活体才能验证 Result 形态。
故防御性实现:裸字符串 / {GroupId} / {Id} 三种形态都认,认不出报 502 而不是崩。

客户文档 /enterprise/docs/assets 新增「4.6 渠道侧原始 ID / URL」:三字段各自
出现在哪些 Action、什么时候才有、**VendorAssetUrl 约 12h 过期别缓存**、
**别拿 vendor id 当句柄回传**。

顺带:`useKuaizi` 改名 `kuaiziLiveness` —— eslint react-hooks/rules-of-hooks 会把
useXxx 当成 React Hook 报 error。另修 asset-actions 测试里 'group-1' 这种不真实的
fixture(收紧判据后它不再算平台 id)。

11 新测 + 2 条旧测更新。全套 259 files / 3055 pass / 0 fail,lint 0 error。

- docs(enterprise): 补视频面 vendor_task_id 客户文档(此前功能已上线但零文档)

#395 把 vendor_task_id 透给客户了,但 /enterprise/docs 一个字没写 —— 而火山形
(ark)面它【只在响应头】X-Silkroadai-Vendor-Task-Id 里,客户不看文档根本找不到。

火山渠道章节新增「渠道侧原始任务 ID」小节:

- 两个调用面各自怎么取(v1 面 body 字段 + 响应头;ark 面【只有】响应头,
  并说明为什么不塞 body —— 火山官方响应体没这个字段,加键会破坏严格校验)
- curl -i 示例,同时展示响应头与响应体
- 什么时候有:渠道受理后即可(running 期间就能拿到),刚创建时可能缺失
- **形态不固定**:字节方舟渠道给 cgt-…(可与火山对账),其它渠道给自己的编号
  (如 tsk-…)【无法与火山对账】—— 不说清楚客户会拿着 tsk- 去找火山白跑
- 只用于对齐排查,不要当句柄:查询/计费一律以我们返回的 id 为准

防漂移守护测试 +1:文档必须同时出现 vendor_task_id / X-Silkroadai-Vendor-Task-Id
/ tsk-,漏了就红。

全套 259 files / 3056 pass / 0 fail。

- docs(enterprise): vendor 字段说明去掉「句柄」黑话,改成人话

operator 读文档时被「不要当句柄用」绊住并追问 —— 客户面文档出现程序员黑话
就是不合格。两处(视频面 vendor_task_id / 素材面 VendorAssetId·VendorGroupId)
统一改成直说:

这个号只能看、不能拿来调接口。查询任务、对账计费一律用我们返回的 id;
把 vendor_task_id 填进查询接口会返回 404 task not found。
它的唯一用途:与我们(或火山)核对某一条具体任务时,报这个号能更快定位。

顺带把「会查不到」这种含糊说法换成客户实际会看到的错误码
(404 task not found / ResourceNotFound),照着报错就能对上。

全套 259 files / 3056 pass / 0 fail。

---

变更文件：`.env.example`、`src/__tests__/app/enterprise-docs-page.test.tsx`、`src/app/api/__tests__/asset-actions.test.ts`、`src/app/api/route.ts`、`src/app/enterprise/(dash)/docs/assets/page.tsx`、`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/kuaizi-assets.test.ts`、`src/lib/enterprise/__tests__/real-person.test.ts`、`src/lib/enterprise/kuaizi-assets.ts`、`src/lib/enterprise/real-person.ts`。

#### 8fcbaa4 · 2026-08-19 22:54:48 · fix(enterprise): volc 渠道下架 fast / mini 两档 —— 实测不落火山方舟 (#397)

## 为什么

volc 渠道的产品定义是「客户拿火山官方 SDK 零改动接入、拿到完全原生的火山
体验」。2026-08-19 实测发现其中两档根本不是火山出的片:

    doubao-seedance-2.0        vendor_task_id = cgt-20260819224039-bfjdv  ✅ 方舟
    doubao-seedance-2.5        vendor_task_id = cgt-20260819224039-grjkl  ✅ 方舟
    doubao-seedance-2.0-fast   vendor_task_id = tsk-ghuya22ne4tyq74q      ❌ 非方舟
    doubao-seedance-2.0-mini   vendor_task_id = tsk-ghuyk75kw81r85y8      ❌ 非方舟

每档一条 480p/4s 真机任务;mini 两次独立复现同样是 tsk-。切分是确定性的
(贵的两档走火山、便宜的两档走别家),不是随机负载均衡。

这不是 ID 形态问题,是货不对板 —— 先下架,待上游把我们这条线锁死在方舟
渠道后再放开。

## 客户暴露面:零

查任务表:liyan 最后一条 2026-08-03、xzp 2026-08-04,都在 2026-08-17 换
筷子上游【之前】。换上游之后跑过 volc 视频的全是测试账号。真客户一条没踩到。

历史比例查不到 —— vendor_task_id 没落库,容器日志窗口又只到今天部署之后。
(落库是下一个 PR 的事,那之后才有持续可观测性。)

## 改了什么

- `isVolcModelWithdrawn()` + `WITHDRAWN_VOLC_HINT`(两处共用同一文案口径)
- 主闸在 `resolveEnterpriseModel` 的 volc 分支最前面 —— v1 形与火山方舟形
  两个调用面共用这一道,连参数校验都不必走
- `submitVolcVideo` 兜底再拦一次:下架档位【一个字节都不发上游】,不白花钱
- 逃生阀 `ENTERPRISE_VOLC_ALLOW_LOW_TIERS=1`:上游修好后先用它验证
  vendor_task_id 确实回到 cgt-,再删代码里的下架名单
- `/enterprise/docs` 火山章节:模型表删两行 + 显式写明暂停原因与替代档位

其它渠道(国内 / 海外 / proMax)的 seedance-2-0-fast / -mini 完全不受影响 ——
本次改动全部关在 volc 分支内。

## 门

259 files / 3061 pass / 0 fail(+5 新测:v1 与 ark 两面各一条下架守护、
adapter 层「不发上游」守护、逃生阀恢复可用)。tsc / prettier clean,
eslint 0 error(唯一 warning 是既有的 cancelVolcVideo(_id))。

变更文件：`.env.example`、`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/seedance/__tests__/kuaizi-adapter.test.ts`、`src/lib/seedance/kuaizi-adapter.ts`。

#### 975c631 · 2026-08-19 23:19:38 · feat(enterprise): volc 渠道对客只出火山原生 id 与 URL (#398)

volc 卖的是「客户拿火山官方 SDK 零改动接入」的原生体验。此前对客暴露的其实是
【中间上游发的号】,火山自己的号另外挂在 Vendor* 字段里 —— 客户手上等于有两套
标识,还得自己分辨哪个能用。本 PR 把它归一:**对客只出火山的号和链接**。

## 实测依据(2026-08-19)

素材 Id 上游十进制 192295008202653711 ↔ 火山 asset-20260819215920-b5sjp
组 Id 上游十进制 192295006424268815 ↔ 火山 group-20260819215915-j5dxc
任务 id 上游 kz-cgt-… ↔ 火山 cgt-20260819224039-bfjdv
素材 URL 上游回显客户入参链接 ↔ 火山 TOS 签名链

⚠️ 上游那个 `URL` 字段是**客户创建时传入链接的原样回显**(传 picsum 进去查回来
还是 picsum),根本不指向已入库的素材本体 —— 真正能取到素材的只有 VendorAssetUrl。
所以换掉它不只是「更原生」,是修一个残废字段。

## 三件事

**① 出参归一**:`Id` ← VendorAssetId / VendorGroupId,`URL` ← VendorAssetUrl,
任务 `id` ← vendor_task_id;`Vendor*` 三个键与 `X-Silkroadai-Vendor-Task-Id`
响应头**全部撤掉** —— 火山官方响应里根本没有这些键和这个头,留着反而不原生。
素材行上的 `GroupId` 也一并回显成火山组号(一份响应里不能混两套命名空间)。

**② 压着等火山编号**。火山编号要等上游受理后才有(素材实测 ~7.5s 且 Processing
期就有;视频 ~10.5s)。这段等待消不掉,只能我们压着,拿到了再吐给客户。
超时一律**报错**(operator 拍板:宁可报错,也不吐一个非火山的号):
素材 → 504 AssetPending 已知代价:上游那条已建好 → 成孤儿,客户重试会重复建
视频 → 504 upstream_timeout 已知代价:上游会照跑并计入我们的账单 → 我们自己吃掉
封顶 `ENTERPRISE_VOLC_VENDOR_WAIT_MS`(缺省 60s)。

视频侧还多一道:拿到的编号若**不是 cgt- 形**(= 没落方舟)→ 502 `non_ark_route`

- console.error 报警。在售的 2.0 / 2.5 实测都落方舟,真出现说明上游路由变了,
  必须立刻知道 —— 不能悄悄把非火山的片子交给客户(fast/mini 就是这样,已 #397 下架)。

**③ 新表 `volc_id_map`**(纯增量 migration)。上游**不认**火山的号 —— 实测
`GetAsset({Id:'asset-…'})` → `InvalidParameter: invalid Id`,所以打上游前必须换回去。
不是单点故障:上游 List* 每行同时带两个号,查询响应流过时顺手回填(自愈),
表丢了也能靠翻页重建。

## 存量客户不断

`toUpstreamId()` 查不到映射时**原样返回** —— liyan / xzp 手里的老号继续能用,
换 id 形态不是破坏性变更。轮询侧还保留了 undisguise 老路径兜底。

## 范围

改动全部关在 volc 分支内(`shouldUseKuaiziAssets` / `region==='volc'`)。
平台素材库、cn / global / promax 三个渠道一个字未动。

## 门

259 files / **3066 pass / 0 fail**。tsc / prettier clean,eslint 0 error。
migration 在临时库上验过:建表 + 两个索引干净应用,upsert 语义符合预期,已删库。

变更文件：`.env.example`、`prisma/migrations/20260819230000_volc_id_map/migration.sql`、`prisma/schema.prisma`、`src/__tests__/app/enterprise-docs-page.test.tsx`、`src/app/api/route.ts`、`src/app/enterprise/(dash)/docs/assets/page.tsx`、`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/kuaizi-assets.test.ts`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/kuaizi-assets.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/enterprise/volc-id-map.ts`、`src/lib/seedance/__tests__/kuaizi-adapter.test.ts`、`src/lib/seedance/kuaizi-adapter.ts`。

#### 21ca10f · 2026-08-19 23:51:01 · fix(enterprise): volc 落非方舟改为【放行 + 降级】,不再 502 拒掉 (#399)

operator 决定:先放行,同时向上游反馈路由问题(#398 的守门上线当天就把
doubao-seedance-2.0 全拦了,而这条线目前只剩 2.5 可用)。

## 但不能把 tsk- 直接给客户

上游路由到非方舟渠道时,vendor_task_id 是那家自己的号(tsk-…)。直接对客暴露会:

- 破坏火山 SDK 的形态预期(客户按 cgt- 校验)
- 暴露第三方(#271)
  所以放行 = **降级回火山方舟形的伪装号**(#398 之前的行为),而不是把 tsk- 吐出去。

落方舟的任务仍拿【真】火山号 —— #398 的收益不受影响。

## 路由会漂,静态名单靠不住

2026-08-19 实测:doubao-seedance-2.0 在 22:40 返 cgt-(方舟),23:26 复测 4/4 返
tsk-(非方舟)—— 同一模型同一参数,45 分钟内路由就变了。同时段 2.5 是 4/4 方舟。
所以只能【每条任务实时判定】,不能靠档位名单。

## 可观测 + 可收紧

- 每条降级都打 `[kuaizi-adapter] NON_ARK_ROUTE 任务未落火山方舟(已降级放行)`
  带 model / upstreamId / vendor_task_id → 可直接 grep 计数,给上游摆证据
- `ENTERPRISE_VOLC_REQUIRE_ARK=1` 恢复直接 502 —— 上游锁定方舟后置 1,守住不再回归

## 文档口径同步

「任务 ID 就是火山官方任务号」→「为火山方舟形;**由火山方舟受理的**任务,该编号即
火山官方任务号」。放行期间这个说法两种情况下都成立,不过度承诺。

259 files / 3068 pass / 0 fail;tsc / prettier clean,eslint 0 error。

变更文件：`.env.example`、`src/__tests__/app/enterprise-docs-page.test.tsx`、`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/seedance/__tests__/kuaizi-adapter.test.ts`、`src/lib/seedance/kuaizi-adapter.ts`。

#### 6bae4e6 · 2026-08-21 10:21:32 · feat(image-adapter): 新接两家全量上游 ominiapifull / frimodel (#400)

给全量线(openAllTiers,合成官方 usage)扩容两条上游,零机制改动 —— 只在
providers.ts 加两行,守门/计费/C2PA 剥离/错误脱敏/n 扇出全部按 provider 复用。

- ominiapifull:ominiapi 平台【另一个账号的 key】,端点 www.ominiapi.com。与既有
  gated 的 `ominiapi`(api. + 盈利档守门,ch154 现已停用)是两条独立渠道,勿混。
- frimodel:new-api 型网关,**API host = api.frimodel.com**(operator 给的
  platform.frimodel.com 是控制台,nginx 对 /v1/* 恒 403)。同为 Adobe Firefly 转售。
  契约差异:generations 无视 response_format 恒返预签名 S3 url(适配器 url→b64
  兜底拉回,URL 绝不外泄),edits 直接给 b64;size / quality 均如实生效。

VPS 实测(2026-08-21):两家 1024² low、frimodel 3840×2160 high 与 multipart
edits 全部 200 出真尺寸图;frimodel 4K 出图 46s + S3 拉回 0.3s;两家出图都带
Firefly C2PA(proxy 回程按内容剥,自动继承)。

+4 单测(两条路由 + frimodel url→b64 不外泄 + brand 脱敏),
vitest src/lib/image-adapter 81/81,tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/providers.ts`。

#### 4c4ea9c · 2026-08-22 10:16:28 · fix(enterprise): volc 素材错误归一 —— 不存在返 404,不再泄露上游内部 id (#401)

客户实测火山渠道报障:删掉素材 / 素材组后再查,拿到 **HTTP 500** 而不是 404。

## 复现 + 归因

复现了,而且直连上游(绕过我们)证实根因在上游 —— 它对不存在的资源就返:

    HTTP 500  Code=InternalError
    Message="get asset failed: rpc error: code = NotFound desc = asset not found: id=192612151255367695"

我们此前是**原样透传**。三处不合格:

① **状态码错**。火山官方对不存在的资源返 404。500 还会让客户的重试逻辑误判成
「服务端故障可重试」,实际是终态,白重试。
② **错误码错**。InternalError 不是「不存在」的语义。平台素材库面用的是
AssetNotFound / GroupNotFound(app/api/route.ts),volc 面必须同口径 ——
否则同一个平台两套素材库两种错误码,客户得写两套分支。
③ **泄露上游内部 id**。`id=192612151255367695` 正是上游的十进制号 —— #398 刚把
对客 id 全换成火山号,错误信息又把上游号漏出去,等于白做(#271)。

## 改法

新增 `mapUpstreamError()`:

- not-found 语义(gRPC code 或文案里出现,两种都认)→ **404 + AssetNotFound /
  GroupNotFound**,并回显**客户自己的号**(不是上游的)
- 其余 5xx → 502 + `sanitizeUpstreamMessage()` 后的文案(剥 rpc 包装 + 内部 id)
- 非 not-found 的 4xx → 保持原状态码 + 上游 code(参数错还是要让客户看见)

按 Id 操作的 6 个 Action 都把客户的号传进 `call()`,供 404 文案回显。

## 客户报的另一条(ListAssets Statuses=Processing)不是 bug

实测:`Statuses=['Processing']` 只返回 Processing 的那条、`Statuses=['Active']`
只返回 Active 的那条 —— 筛选正确。客户脚本期望「结果为空」,是它假设那时素材都
已转 Active(异步入库有时序差),属测试时序假设问题。客户自己也标注了
「不一定是平台筛选错误」。

## 门

258 files / 3074 pass;唯一失败的 `client.smoke.test.ts` 需要 SSH 隧道打真实
new-api,在干净的 origin/main 上同样失败(CI 不跑它),与本改动无关。
tsc / prettier clean,eslint 0 error。

变更文件：`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/kuaizi-assets.test.ts`、`src/lib/enterprise/kuaizi-assets.ts`。

#### 887a2c9 · 2026-08-25 00:46:58 · fix(image-adapter): 上游超时 300s→600s —— 我们自己掐死了本会成功的请求 (#402)

大客户(多图 n>1,completion_tokens 1 万+)的单次生成实测要 250-300+ 秒,擦着
UPSTREAM_TIMEOUT_MS 的 300s 线被我们自己 abort,new-api 随即 failover 换渠道再等
300s,一次请求叠出 6-12 分钟 —— 而上游后台一切正常。

实测证据(同一批 adapter 日志):
ok ms=287685 ← 287 秒成功
fetch failed ms=300001 aborted
4 分钟内单副本 178 次 fetch failed + 38 次 aborted,而真正拿到上游 HTTP 错误响应
的只有 8 次 —— 95% 的失败是本超时掐的,不是上游拒绝。

600s 与链路其余各层对齐(Caddy 3010 response_header_timeout 600s、
instrumentation.ts 的 undici dispatcher 600s),本常量原是整条链最短的一环。

线上实测(server2 滚动重启六副本后,同口径 5 分钟):
一次成功率 70.6% → 92.7%
需重试请求 降约 78%
3 跳 p50 622s → 345s
每次白烧的失败尝试都是一次真实上游调用,同时降低"扣费没出图"风险。

另:固定 portal 网络网段。Docker 按创建顺序分配 172.1x,换机器会漂;new-api 那个栈
更要命(6 条 image2 渠道的 base_url 硬编码了它的网关 172.20.0.1),已在注释里标明。

变更文件：`docker-compose.prod.yml`、`src/lib/image-adapter/adapter.ts`。

#### 827b8b3 · 2026-08-25 01:48:05 · feat(image-adapter): 新守门上游 oaidist(真 OpenAI 签名)+ 按返回图实际尺寸计费 (#403)

新接 operator 提供的 new-api 型分销网关(64.32.31.178:3009)为守门线新 provider:

- oaidist:出图带 OpenAI 原生 C2PA 证书链(签名证书 OpenAI OpCo, LLC + OpenAI TSA
  时间戳链,10/10 实测无 adobe/firefly 痕迹)→ 回程剥离层天然不触发,签名保留 =
  客户可验官方凭证(新增守护测试固化该行为,防未来改成全剥)。上游多模型,渠道只配
  gpt-image-2。VPS 实测:1024²/2560×1440/3840×2160 全部逐像素如实出图,4K high 36s。

- ImageProvider 新增 gateMinCt 字段:自定义守门线(纯盈利档,无狭长放行 —— 兜底线
  现全是 openAllTiers 官方账单上游,狭长图落下去照样对得上账,狭长条款只会把亏钱的
  狭长低档放进来)。oaidist 取 1,756 = ¥0.06/张成本保本线(operator 2026-08-24 拍板):
  1024² medium 起放行,1280×1024 medium(1,510)及以下拒,low 族(≤659)全拒。
  存量 provider 缺省走旧守门(3,846 + 狭长放行),行为不动。

- 计费尺寸一律优先【返回图实际尺寸】(解码 IHDR/SOF,毫秒级):oaidist 对约束外尺寸
  不拒反而静默降级(实测 7000² 请求 200 返 2048²),旧口径按请求值合成会 38 倍超收。
  实际尺寸读不出(webp 等)→ 退回请求值(旧行为);如实出图的上游逐 token 等价。

+13 新测试(oaidist 路由/守门矩阵/降级计费/brand 脱敏 + OpenAI C2PA 保留),
vitest 全套 3092 pass / 1 skip / 0 fail,tsc/lint/prettier clean。

变更文件：`src/app/v1/__tests__/image-metadata.test.ts`、`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/adapter.ts`、`src/lib/image-adapter/providers.ts`。

#### d46b447 · 2026-08-25 17:02:44 · feat(image-adapter): oaidistfull —— oaidist 同上游的全量线(openAllTiers) (#404)

镜像 wetokengated/wetoken 双线玩法:同一上游(64.32.31.178:3009)、同一 key,
providers.ts 加一行 openAllTiers 全量线,兜住被守门线(ch201 gateMinCt 1,756)
拒下来的低档/auto 流量,合成官方 usage。约束外尺寸静默降级由 #403 的
按返回图实际尺寸计费兜底,size=auto 同样按实际尺寸。

+3 测试(路由/auto 实际尺寸计费/与 gated 线对照),全套 3095 pass / 1 skip,
tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/providers.ts`。

#### fa19314 · 2026-08-26 12:43:40 · fix(enterprise): volc 适配补齐 —— 原生模型名 / ratio 不硬塞 / 官方参数一律透传 (#405)

客户实测火山渠道报了三条,复现时又挖出两条同源的。根子是一样的:我们在
volc 这条「原生火山」通道上做了太多自作主张的翻译与默认值。

## ① 客户传火山原生模型名 → 403,整条路堵死

    POST /api/v3/… {"model":"doubao-seedance-2-5-260628"}
    → 403 region_mismatch: this API key is bound to the cn region

根因:`normalizeArkModel` 把原生 id 归一成【国内版】短名 seedance-2-5 → region
判成 cn → volc 客户的 key 打 cn 区必 403。而这个渠道的卖点恰恰是「拿火山官方
SDK 零改动接入」,客户当然会传原生名。

同一个 `doubao-seedance-2-5-260628` 对 cn 客户和 volc 客户是**两个意思**,只能靠
调用方凭据区分。新增 `callerHasVolc()`(鉴权【前】的探测,不验签不授权 —— 拿错了
最多让模型名按 volc 解释,随后真正的鉴权照常拒,安全上无影响):

- sk-ent-… → enterpriseKey.region === 'volc'
- AK/SK 与 sk_ent_… → 账号是否开通 volc 上游
  volc 调用方下,原生 id 解释成火山渠道;ark 面回显也改成原生 id。
  非 volc 调用方一个字节都没变。

## ② 视频续写失败:我们替客户硬塞了 ratio

`ratio` 缺省时代码写死 `'16:9'`。而「视频续写 / 视频编辑」上游只接受
`adaptive` —— 客户按火山官方用法不传 ratio,我们却替他填了 16:9 → 上游拒。

改成:**不传就不注入**,由上游按任务类型自己定。与 images 面 `aspect_ratio=auto`
那次是同一个教训 ——「不指定」是一种有意义的取值,不能被我们的默认值吃掉。

## ③ 火山官方参数被吃掉(不止客户报的那一个)

客户报 `bitrate_mode` 被拦。查下来共 **5 个**官方字段进不去上游:

    bitrate_mode / camera_fixed / service_tier / priority / callback_url

其中 **camera_fixed 我们文档里明确写了支持**,客户传了以为生效,实际根本没到
上游 —— 这比 400 更糟,是静默失效。

逐个补白名单只会继续落后于上游。改成反向白名单:**只挡我们自己消费或翻译掉的
键,其余原样透传**,能不能用由火山判 —— 这才是「原生」该有的样子。ark 面的
未知字段 400 对 volc 调用方也一并放开(只落日志)。

`callback_url` 例外,仍不透传:上游会直接回调客户、回调体里带的是上游任务号
(kz-cgt-…),既拆穿原生形态也泄露中间层(#271)。要支持得我们自己中转,另起一件事。

## ④ 顺带修:等任务号期间任务已失败,却空等 60 秒才给个笼统超时

#398 的「压着等火山任务号」只看 vendor_task_id、不看 status。实测引用一个入库
失败的素材:客户等满 60s 只拿到 `upstream_timeout`,真实原因(素材不合格)全丢了。
现在等待期间一旦任务终态失败,立刻带**上游真实原因**返回 400。

## 门

259 files / 3104 pass / 0 fail(+11 新测:原生名双向解释、ratio 注入与否、
5 个官方字段透传、消费键不重复透传、callback_url 不透传、早失败短路)。
tsc / prettier clean,eslint 0 error。改动全部关在 volc 分支内。

变更文件：`src/__tests__/app/enterprise-docs-page.test.tsx`、`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/ark-format.test.ts`、`src/lib/enterprise/__tests__/ark-v3.test.ts`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/ark-format.ts`、`src/lib/enterprise/keys.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/seedance/__tests__/kuaizi-adapter.test.ts`、`src/lib/seedance/kuaizi-adapter.ts`。

#### 8f2f3b2 · 2026-08-26 13:11:25 · fix(enterprise): volc 查询响应回显上游【已推导】的 duration / ratio,不再吐回 -1 (#406)

客户报障:提交 `duration: -1`(智能时长),任务完成后查询响应里的 duration 还是 -1,
拿不到模型实际选了几秒。

## 根因

查询响应的元数据一律取自**我们库里的 task 行**,而 task 行存的就是**提交参数** ——
客户传 -1,库里就是 -1,于是永远回显 -1。

`ratio` 有同样的毛病:客户不传时 proxy 把 '16:9' 写进库(即便 #405 之后我们已经
不再往上游注入它),回显的仍是这个我们自己补的值,而不是上游实际采用的比例。

## 上游其实给了真值(实测)

直连上游打一条 duration=-1 的任务,全程跟踪:

    status=running     上游 duration = (无)
    status=succeeded   上游 duration = 5      ← 模型实选

即上游**在任务完成时**给出推导后的值,只是我们没用。

## 改法

- `pollVolcVideo` 把上游已推导的 `duration` / `ratio` / `resolution` 透出来
  (上游没给就不带这几个键)
- ark 查询响应改成 `上游值 ?? 库值`:上游给了就以上游为准,没给才回落提交参数
  → 生成中仍显提交值(尚未推导),完成后显真实值

**其它渠道不受影响**:cn / global / promax 的适配器不返回这几个字段,`?? task.*`
自动回落,行为逐字不变(已加用例守住)。

## 门

259 files / 3108 pass / 0 fail(+4 新测:上游给值时透出、running 期不带键、
ark 优先上游值、上游没给时回落库值)。tsc / prettier clean,eslint 0 error。
文档同步说明「完成后 duration 是模型实际选定的秒数」。

变更文件：`src/__tests__/app/enterprise-docs-page.test.tsx`、`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/seedance/__tests__/kuaizi-adapter.test.ts`、`src/lib/seedance/kuaizi-adapter.ts`。

#### 805851d · 2026-08-26 16:31:49 · feat(video): MiniMax-H3 视频适配器 —— new-api 渠道回调 /minimax-adapter,透传 token.xinhankr 上游 (#407)

- 走 ch95/ch41 同款「portal 适配器 + new-api 渠道」模式:渠道 type=1,base_url 指向
  /minimax-adapter,渠道 key = 上游 key(鉴权头原样透传,portal 不存 key)
- 客户格式 = 上游格式(统一视频 /v1/video/generations)→ 近乎纯透传;只做
  duration 门控(new-api 按 ModelPrice × GR × 请求秒数计费,缺失/越界 400 不改写)、
  resolution 归一(768P/2K)、data URL 参考媒体转存 R2、响应包 OpenAI-video 信封
- 路由:/minimax-adapter/v1/videos{,/[id],/[id]/content} + /v1/video/generations 备用路径;
  middleware matcher 排除 minimax-adapter/(避开 10MB body 缓冲)
- categorize:minimax-h → video(海螺视频入视频分组,不污染 chat picker;M 系文本不受影响)
- 16 新适配器单测 + 2 categorize 断言;全套 3124 pass / 1 skip / 0 fail

变更文件：`.env.example`、`src/__tests__/lib/models/categorize.test.ts`、`src/app/minimax-adapter/v1/video/generations/[id]/content/route.ts`、`src/app/minimax-adapter/v1/video/generations/[id]/route.ts`、`src/app/minimax-adapter/v1/video/generations/route.ts`、`src/app/minimax-adapter/v1/videos/[id]/content/route.ts`、`src/app/minimax-adapter/v1/videos/[id]/route.ts`、`src/app/minimax-adapter/v1/videos/route.ts`、`src/lib/minimax/__tests__/adapter.test.ts`、`src/lib/minimax/adapter.ts`、`src/lib/models/categorize.ts`、`src/middleware.ts`。

#### 623712a · 2026-08-27 01:22:30 · fix(enterprise): volc 响应全面以上游为准 + 上游字段契约守护(断根) (#408)

- fix(enterprise): volc 查询响应补齐火山官方字段集(客户契约测试报障)

客户对 volc 渠道跑响应基准比对,5 个字段缺失:

    framespersecond          期望 24
    generate_audio           期望 true
    draft                    期望 false
    service_tier             期望 'default'
    execution_expires_after  期望 172800

(已匹配的:resolution / ratio / duration。)

## 根因:上游给了,我们在出口砍掉

实测上游【完成态】原始响应:

    "execution_expires_after": 172800,
    "framespersecond": 24,
    "generate_audio": true,
    "seed": 26206,
    "tools": []

这批字段被关在 `buildArkTaskResponse` 的 `extended` 分支里,而
`extended = global || promax` —— **volc 恒为 false**,于是全被丢掉。

⚠️ 而且不能简单让 volc 也走 `extended`:那个分支里的值是**硬编码占位**
(`framespersecond: 0`、`execution_expires_after: 0`、`service_tier: ''`),
打开了照样对不上基准。必须用上游真值。

## 改法

新增 `volcMeta` 入参(仅 volc 传,其余渠道传 null → 行为逐字不变):

- 值优先取**上游真值**(adapter 新透出 framespersecond / generate_audio /
  execution_expires_after / seed / tools)
- 上游未给的项(running 期 / 降级 / 失败态)走**火山官方默认值**
  fps 24、48h 过期、service_tier 'default'、draft false
- `draft` / `service_tier` 上游本就不返回,按火山官方语义合成

三条出口全覆盖:正常完成、降级(上游瞬时不可达)、失败态 —— 客户的契约校验
不分成功失败,字段必须恒在。

## 门

260 files / 3127 pass / 0 fail(+3 新测:上游真值透出、ark 出齐且值对基准、
running/降级期走默认值且字段恒在)。tsc / prettier clean,eslint 0 error。

- fix(enterprise): volc 响应全面以上游为准 + 上游字段契约守护(断根)

客户对 volc 做响应基准比对,连续两轮报障。逐个补字段治不了本 —— 根子是
**我们逐字段重建响应,上游有什么我们并不知道**。这次用 diff 把两边钉死。

## 方法:拿真实上游响应和我们的对客响应做逐字段 diff

同一条任务,直连上游 vs 走我们门户。结果分三类:

    ❌ 上游有我们没有   framespersecond / generate_audio / execution_expires_after
                       / seed / tools / content.last_frame_url
    ⚠️ 两边不一致       created_at(差几秒)/ updated_at(我们是 Date.now())
                       / ListAssetGroups 的 TotalCount 被我们改名成 Total
    ➕ 我们造上游没有   error{code,message} —— 火山官方形要求恒在,保留

## 修了什么

**① 火山官方字段集出齐**(客户基准直指的 5 项)
上游完成态本来就返回 framespersecond=24 / generate_audio / execution_expires_after
=172800 / seed / tools,被关在 `extended` 分支里(该分支只对 global/promax 为真)。
新增 `volcMeta` 入参,值取**上游真值**;上游未给的(running/降级/失败态)走火山官方
默认值,保证字段恒在。`draft` / `service_tier` 上游本就不返回,按官方语义合成。
⚠️ 不能简单让 volc 走 `extended` —— 那分支里是硬编码占位(fps 0、expires 0、
tier ''),打开了照样对不上。

**② 时间戳以上游为准**
`created_at` 此前用我们库行的时间(比上游晚几秒);`updated_at` 更离谱,是
`Date.now()` —— **客户每查一次就变一次**,根本不是"任务更新时间"。改成取上游真值,
上游未受理返 0 时才回落库值(不能把 0 给客户)。

**③ `content.last_frame_url` 跟随上游**
火山成功态该键恒在(无尾帧为空串)。我们此前只在非空时才带 —— 基准比对里
「键缺失」和「值为空」不是一回事。

**④ 分页壳还原成火山官方形 `TotalCount`**
此前改名成平台库面的 `Total`。volc 卖的是原生火山,不该迁就我们自己的老接口。
平台库面(assets.ts)仍用 `Total`,两套面各自对齐各自契约。
⚠️ 对客破坏性变更:读 `Total` 的 volc 集成需改读 `TotalCount`。

## 断根:上游字段契约守护测试

把真实上游响应存成 fixture,断言**上游每个字段要么被透出、要么在明示丢弃名单里**
(名单每条都写了理由:id 换我们的号、vendor_task_id 不外泄、kz_video_url 是上游
转存域名绝不外泄…)。上游将来加字段,更新 fixture 就会自动暴露我们没适配 ——
不必再等客户测出来。

另加两条守护:上游转存域名 `bk-hs-p-bj-lizhen` 不得出现在对客响应里;
`updated_at` 必须是上游值而非 Date.now()。

## 审计中排除的误报

`UpdateAssetGroup` 一度疑似没生效 —— 复核是审计脚本比对了两个不同的组,
实测改名正常。`VendorGroupId` 缺失是 #396 有意为之(对客只出火山号)。

## 门

260 files / 3133 pass / 0 fail。tsc / prettier clean,eslint 0 error。
改动全部关在 volc 分支内(`volcMeta` 只有 volc 传,其余渠道传 null)。

---

变更文件：`src/lib/enterprise/__tests__/kuaizi-assets.test.ts`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/ark-format.ts`、`src/lib/enterprise/kuaizi-assets.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/seedance/__tests__/kuaizi-adapter.test.ts`、`src/lib/seedance/kuaizi-adapter.ts`。

#### 847a32d · 2026-08-27 01:49:23 · feat(image-adapter): background:transparent 按上游能力路由 —— 未验证的 503 让路,支持的透传 (#409)

客户实测(2026-08-26)暴露:不支持透明的上游对 background:transparent 会 200 返回
【画进像素的假棋盘格】(rgb24 无 alpha),客户拿废图还被计费,比失败更糟。

- ImageProvider 新增 noTransparentBackground:标了的 provider 遇 background=transparent
  直接 503(调上游之前,不花钱)让 new-api failover 到支持透明的渠道;flag 压过
  openAllTiers;大小写/空白不敏感;JSON 与 multipart edits 两路都拦。
- 逐家实测定档:ominiapi 平台真出 alpha(1024² RGBA、54% 采样像素 alpha<250)→
  ominiapi/ominiapifull 放行;oaidist/oaidistfull 信任放行(真 OpenAI 原生参数,
  号池恢复后补实测);we-token 三线探测期间 adobe 全线 502 无法判定 + codexvip/frimodel
  未验证 → fail-closed 全拒,恢复后用 probe-transparent.py 重探再翻开关。
- 参数本身沿用 FORWARD_EXTRAS 透传,支持的上游行为零变化;不带/opaque 不受影响。

+6 测试,vitest 全套 3139 pass / 1 skip / 0 fail,tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/adapter.ts`、`src/lib/image-adapter/providers.ts`。

#### a051ca9 · 2026-08-27 02:06:09 · feat(image-adapter): 透明出图校验 —— 假棋盘格按上游失败处理 (#410)

- feat(image-adapter): background:transparent 按上游能力路由 —— 未验证的 503 让路,支持的透传

客户实测(2026-08-26)暴露:不支持透明的上游对 background:transparent 会 200 返回
【画进像素的假棋盘格】(rgb24 无 alpha),客户拿废图还被计费,比失败更糟。

- ImageProvider 新增 noTransparentBackground:标了的 provider 遇 background=transparent
  直接 503(调上游之前,不花钱)让 new-api failover 到支持透明的渠道;flag 压过
  openAllTiers;大小写/空白不敏感;JSON 与 multipart edits 两路都拦。
- 逐家实测定档:ominiapi 平台真出 alpha(1024² RGBA、54% 采样像素 alpha<250)→
  ominiapi/ominiapifull 放行;oaidist/oaidistfull 信任放行(真 OpenAI 原生参数,
  号池恢复后补实测);we-token 三线探测期间 adobe 全线 502 无法判定 + codexvip/frimodel
  未验证 → fail-closed 全拒,恢复后用 probe-transparent.py 重探再翻开关。
- 参数本身沿用 FORWARD_EXTRAS 透传,支持的上游行为零变化;不带/opaque 不受影响。

+6 测试,vitest 全套 3139 pass / 1 skip / 0 fail,tsc/lint/prettier clean。

- feat(image-adapter): 透明出图校验 —— 假棋盘格按上游失败处理,重试摇到真 alpha

#409 的白名单路由治不了号池型上游:实测 ominiapi 同账号 50/50 随机(3 连发 2 真 RGBA
1 假棋盘格,池内子账号支持不一)—— 客户拿到哪种全凭运气,正是客户复现的现象。

- imageHasAlpha:PNG colortype 6/4 → true;PNG 其他 / JPEG → false;webp 等识别不出 → null
  (存疑放行不误杀)。
- transparent 请求出图后逐张校验:无 alpha 的张丢弃(号池摇骰);全军覆没 → 503 不计费,
  new-api RetryTimes 重试/换渠道直到摇到真透明。非透明请求零变化。
- n>1 部分真部分假 → 只返真的、按实收张数计费。

+4 测试,全套 3143 pass / 1 skip / 0 fail,tsc/lint/prettier clean。

---

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/adapter.ts`。

#### 108871c · 2026-08-27 16:10:32 · feat(enterprise): volc 响应补 upstream_id —— 满足客户契约脚本 (#411)

客户的契约脚本(seedance_client.py:313/404)从查询响应里读 `upstream_id`,
用 `^cgt-\d{14}-[A-Za-z0-9]+$` 校验火山官方任务号格式,**缺了就把整轮判失败**。
他们最新一轮 5 个步骤里有 3~4 步"脚本判失败",实际业务全部跑通,唯一原因就是这个字段。

## 值取什么

`upstream_id = 我们的对客 id`。#398 起对客 id 本身就是火山官方任务号
(`cgt-20260827125333-rjzv8`),客户报告里的任务号也正是这个形态 —— 它本来就
满足脚本那条正则。所以这个字段是**给客户脚本的别名**,不引入第二套号。

⚠️ **绝不能填上游的 `vendor_task_id`**:落非方舟时那是 `tsk-…` 形,既过不了
客户的正则,又把中间层泄露出去(#271)。已加用例把这条钉死。

## 范围

只有 volc(`volcMeta` 非空 / `map.region === 'volc'`)带这个字段;
cn / global / promax 保持火山官方形不变 —— 官方响应里没有 `upstream_id`。
提交与查询两处都带(客户脚本 create、query 都读)。

对客只是**新增字段**,不改动既有任何字段,对现有集成无破坏。

## 门

260 files / 3147 pass / 0 fail(+4 新测:查询/提交带且等于 id、非 volc 不带、
绝不回填 vendor_task_id)。tsc / prettier clean,eslint 0 error。

变更文件：`src/lib/enterprise/__tests__/ark-format.test.ts`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/ark-format.ts`、`src/lib/enterprise/proxy.ts`。

#### dbeb2e7 · 2026-08-27 21:57:57 · feat(image-adapter): frimodelmedium —— frimodel 新账号,所有 medium 请求专线 (#412)

operator 2026-08-27 拍板:quality=medium 的请求(任意尺寸,含 size=auto)全部走
frimodel 新账号;其余档 503 让路。两个新机制,其余全继承:

- ImageProvider.upstreamModel:上游模型名覆盖 —— 该账号只认 gpt-image-2-high /
  gpt-image-2-adobe 变体名,不认裸 gpt-image-2(JSON + multipart 两路都覆盖,
  存量 provider 仍送 gpt-image-2 有守护测试)。选 -high:上游 quality 反正钉死
  medium 刻度,给客户品质更高的一条;换 -adobe 改一行。
- ImageProvider.onlyQualities:按归一后 quality 守门,不看尺寸(auto/standard/缺省
  →low 不算 medium);计费走返回图实际尺寸。

实测契约(2026-08-27):尺寸分毫不差(1024²/4K 精确)、generations 直返 b64、
edits 恒返 Firefly S3 预签名 url(url→b64 兜底接住不外泄)、透明不支持
(colortype=2 假图 → noTransparentBackground 拒)、上游 usage 恰为官方 medium
精确值(照旧丢弃自合成)。

+10 测试,全套 3157 pass / 1 skip / 0 fail,tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/adapter.ts`、`src/lib/image-adapter/providers.ts`。

#### 49f6fdc · 2026-08-27 22:21:41 · fix(image-adapter): frimodelmedium 上游模型名切 gpt-image-2-adobe(上游建议的稳定线) (#413)

条件不变(onlyQualities=['medium'] 全量 medium 专线),只换 upstreamModel:
上游明确建议用 -adobe(稳定);-high 实测契约相同(quality 同样钉死 medium 刻度)。
2 处测试断言同步。全套 3157 pass / 1 skip,tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/providers.ts`。

#### 4b8213b · 2026-08-28 01:46:52 · feat(image-adapter): frimodellow —— 所有 low/auto 请求专线(frimodel 第三账号) (#414)

镜像 frimodelmedium 模板:onlyQualities=['low'](注意 normQuality 把 auto/standard/
缺省归一成 low → 本线承接 low+auto+缺省全部流量)+ upstreamModel=gpt-image-2-low
(上游指定)。透明拒 / url→b64 / C2PA 剥 / 实际尺寸计费 / 官方合成 usage 全继承。

⚠️ 接入当天上游 -low 线路 500 do_request_failed(同 key -adobe 正常 → 他家 low
上游断,非账号问题)—— 渠道先建停用,上游修好再开。

+9 测试(low 族放行矩阵 / 非 low 拒 / auto 实际尺寸计费 / 透明拒 / 与 medium 线
互斥守护),全套 3166 pass / 1 skip,tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/providers.ts`。

#### 9949729 · 2026-08-28 01:59:29 · fix(enterprise): volc 素材引用翻回上游号(#398 回归)+ 「素材不存在」不再误报成「任务已失效」 (#415)

客户契约脚本 04(素材引用生视频)两条请求全挂,报「任务已失效或不存在,请重新提交」。
这句是**我们自己的文案**,而且完全指错了方向 —— 客户照着重提交多少次都没用。

## 真实原因:#398 的回归,被错误分类盖了两周

上游原文(直连上游查到的):

    The parameter `content[1].image_url.url` specified in the request is not valid:
    The specified asset asset-20260828014656-n7mc9 is not found

#398 把**对客**素材号换成了火山形(asset-YYYYMMDDHHMMSS-xxxxx),素材库 API 那边
做了双向翻译,但**生成请求里的 `asset://` 引用没跟着翻回上游号** —— 上游只认它自己
的十进制号。A/B 实测,同一张素材:

    asset://asset-20260828014656-n7mc9  (火山号,客户拿到的)  → failed  is not found
    asset://193477566093328454          (上游号,映射表里的)  → succeeded ✅

之所以两周没被发现,是因为报错被盖住了(见下)。我此前判断「两种 id 都能用」是**错的**:
当时只看了提交返回 200,没跟到终态 —— 提交是异步的,素材无效要等上游受理才暴露。

## 三处修复

**① 生成请求里的 asset:// 翻回上游号**(volc 专用)
深走整棵 body 树,只改写恰好以 `asset://` 开头的字符串 —— 引用可能在 content[] 里,
也可能在顶层 images[] / first_frame 等别名里,逐个字段列举必然漏。
映射查不到的原样透传(存量客户手里的上游号继续能用)。

**② 「素材不存在」不再被 task_gone 吞掉**
`task_gone` 的正则里有个**裸的 `not found`**,把「The specified asset … is not found」
匹配走了。现在素材分支【先于】任务态判,且 task_gone 收紧成必须明确提到 task/任务。
新文案直接给出素材 id 和可操作提示。

**③ 早失败日志留上游原文**
#405 的 EarlyTaskFailure 只记了**分类后**的文案,日志里只剩「任务已失效」,排查时
完全看不出是素材问题。现在同时记 `upstream_reason` 原文(截断 500)。
—— 这条是本次能在 20 分钟内定位的关键,也是上次没能及时发现的根因。

## 门

260 files / 3161 pass / 0 fail(+4 新测:引用翻译、查不到原样透传、素材不存在归类、
真任务不存在仍归 task_gone)。tsc / prettier clean,eslint 0 error。改动仅 volc。

变更文件：`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/seedance/__tests__/upstream-error.test.ts`、`src/lib/seedance/kuaizi-adapter.ts`、`src/lib/seedance/upstream-error.ts`。

#### acec68d · 2026-08-28 12:03:02 · feat(enterprise): volc 支持内联 base64 参考素材(自动转存 R2) (#416)

客户把「图片/音频 Base64 被 4000 字符 URL 长度限制拒绝」列为明确不兼容项。

## 归因:4000 是【上游】的硬限制,不是我们的

我们代码里搜不到 4000。实测两边一字不差:

    走我们的接口:  上游原因:content[1].image_url.url is too long (6118 chars, max 4000)
    直连上游:      content[1].image_url.url is too long (6118 chars, max 4000)

所以我们只是如实透传了上游的拒绝(分类也正确:invalid_parameter)。
但 4000 字符 ≈ 2.9KB 二进制,任何真实图片/音频都进不去 —— 等于 base64 这条路不通。

## 真正的缺口:同平台两条渠道能力不一致

**cn 渠道早就支持 base64** —— `toHttpMediaUrl` 把 data URL 转存我们 R2,再把直链
发上游(上游只吃 http(s))。volc 没做这一步,原样透给上游就撞 4000 上限。

本 PR 给 volc 补上同样的能力:内联 `data:(image|audio|video)/*;base64,…` 自动转存
R2(`seedance-volc-ref/{uuid}`),换成直链再发上游。单个媒体上限 20MB(与 cn 一致),
超限给明确 400 而不是静默塞给上游。

⚠️ 这不违背「原生火山」:火山官方同样吃不下 6KB base64,我们是**做了超集**,
不是改了契约 —— 上游看到的就是普通 http 直链,与客户自己传 URL 无差别。

## 安全:必须在鉴权之后做

这段会往 R2 上传,顺手把它从鉴权前挪到了鉴权后(原先 asset:// 翻译也在鉴权前)——
否则未鉴权的请求就能让我们写 R2。

## 门

260 files / 3172 pass / 0 fail(+2 新测:base64 转存后不含 data URL、超 20MB 给
可操作 400)。tsc / prettier clean,eslint 0 error。文档同步说明。

变更文件：`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`。

#### 2c02e7b · 2026-08-28 17:24:37 · feat(image-adapter): pandatk —— Adobe Firefly 全量线(openAllTiers) (#417)

providers.ts 一行接入,机制零改动:认裸 gpt-image-2、b64 直返、尺寸全如实
(1024²/1536×1024/2048²/2560×1440/4K 实测逐像素精确)、quality 上游钉死 medium
刻度(照旧丢弃自合成官方 usage)、41-67s。openAllTiers 全量兜底,透明未验证
fail-closed 拒,brand 正则 pandatk/firefly。

+4 测试,全套 3176 pass / 1 skip,tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/providers.ts`。

#### 69bb59c · 2026-08-28 22:59:03 · fix(image2): 响应回显官方枚举 + 错误体补 model_not_found/too_many_images(客户合规反馈) (#418)

客户官方兼容测试 20 项里 8 项不符,聚成两类根因:

P1 回显不合规(清客户 F7x6 + auto/standard 问题):reshapeOpenAiImageResponse
的回显从"鹦鹉学舌请求原值"改成"官方枚举归一"——

- quality:官方响应枚举只有 low/medium/high;入参 auto/standard/缺省/未知按官方
  语义归一成 low(与适配器 normQuality 同源)。客户传 auto 曾回 auto、上游漏
  standard 都非法,现在都纠正;覆盖上游带的非法值(不再 undefined 才补)。
- output_format:按返回图实际字节 sniff(PNG/JPEG/WebP 魔数,放在 transcode
  之后 = 交付真形态),消解请求 webp 上游出 png 却回显 webp 的不一致。
- background:opaque/transparent 枚举,非法值不回显。

P2 错误体不合规(清客户 F3x3 抹 new_api_error):error-normalize 扩两桶——

- model_not_found:上游显式 model 未知/不支持 400 invalid_request_error +
  code model_not_found + param model;歧义的 no available channel for model X
  仅当 model 未被我们特殊处理时判未知(400),gpt-image 的无渠道仍容量 503
  (不误终态化真实临时缺渠道)。
- too_many_images:超 16 图 400 too_many_images param image。

echo 四个 helper 抽出并 export 供单测。+30 单测(echo 26 + error 8 新桶,-2 改旧
断言:缺省回显 low 不是 auto、上游 standard 被纠正)。全套 3213 pass / 1 skip,
tsc/lint/prettier clean。

已知未处理(需 live 复现,另开):#8 webp 非严格模式 worker 超时、#14 streaming
partial images 未支持应返官方形拒绝。

变更文件：`src/app/v1/[...path]/error-normalize.ts`、`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/error-normalize.test.ts`、`src/app/v1/__tests__/image-echo-conformance.test.ts`、`src/app/v1/__tests__/proxy.test.ts`。

#### 656deaa · 2026-08-29 12:40:11 · fix(proxy): gpt-image-2 上游返 url 时剥 C2PA + 转存(堵 adobe 泄漏) (#419)

客户 2026-08-29 用 contentcredentials 读到出图带 "Adobe Inc." / "Adobe Firefly"
C2PA 凭证。根因:reshape / handleGptImageChat 的剥离只作用于 b64_json,而当
gpt-image-2 上游【返回 url 而非 b64】时(直连 adobe 渠道形态,非适配器渠道),
url 分支把上游图床 url 原样透传给客户 —— 那张图带着 adobe 私钥签名的 C2PA 原封不动,
且暴露上游域名。适配器渠道因为内部 url->b64 转换不受影响,所以主路径实测干净、
偏偏这条 url 直传分支漏了。

修:新增 rehostStrippedImageUrl(fetch 上游 url -> stripAdobeImageMetadata ->
storeGeneratedImage 转存我们图床),补两处 gpt-image-2 的 url 分支:

- handleGptImageChat(chat completions 生图):item.url 分支改走 rehost
- reshapeOpenAiImageResponse(images 生图/改图):新增 gptDefaults 门控的 url-item
  pass,拉下剥离转存后替换成我们的 url;仅 gpt-image 且有 req 时做,不碰 gemini/透传。
  拉取失败(极少)退回上游 url,不静默丢图。

+3 测试(chat url 分支剥+转存、images url-item 剥+转存、拉取失败兜底)。
全套 3216 pass / 1 skip,tsc/lint/prettier clean。

变更文件：`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`。

#### df10d5e · 2026-08-29 20:19:44 · fix(image2): 非严格模式也真交付 output_format=jpeg(客户 #9/#13:请求 JPEG 却拿 PNG) (#420)

客户反馈:请求 output_format=jpeg / output_compression,实际文件仍是 PNG(200 假成功)。
根因:所有 adobe/gpt-image 上游都无视 output_format 恒返 PNG,而我们只在【严格模式】
(opt-in)才 png→jpeg 转码;客户用的非严格默认模式不转码 → 拿到 PNG。#418 只做到
"诚实回显 png",没做到"真给 jpeg"。

修:gpt-image-2 请求 output_format=jpeg 时在【所有模式】服务端 png→jpeg 转码真交付,
output_compression 映射成转码 quality。上个 PR 的 sniffImageFormat 会据真字节把回显纠成
jpeg,字节/元数据一致。严格模式语义不动(它自己的 400 校验保留)。

- gptImageTranscodeTarget:output_format → 'jpeg' | null(jpeg/jpg 转;png/空/未知不转)
- webp:jimp 1.6.1 不支持 webp 编码,不引 native 依赖 → webp 请求交付 png + 诚实回显
  png(#418 行为,不回归)。客户当前反馈只涉及 jpeg。
- transcodePngB64(原 pngToJpegB64 泛化):quality 来自 output_compression(0-100,缺省 90)
- reshape transcodeJpeg:boolean → transcodeTo:'jpeg'|null + transcodeCompression;两处
  DALL·E 入口(multipart + JSON)在严格/非严格都计算 transcodeTo

+4 测试(非严格 jpeg 真字节+回显、compression 影响文件大小、png 不转、webp 诚实回显)。
全套 3220 pass / 1 skip,tsc/lint/prettier clean。

变更文件：`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`。

#### b8303f4 · 2026-08-29 22:08:14 · perf(portal): 页面切换秒响应 — 客户后台 loading 骨架屏 + /dashboard 数据获取全并行 (#421)

两个 P0,解决「从调用日志切到概览卡 1-2 秒没反应」:

1. (authenticated)/loading.tsx — 全组导航即时切换到骨架屏(header/sidebar
   由 layout 持有不动),数据到了再流入真页;同时让 force-dynamic 路由的
      <Link> prefetch 生效。
2. /dashboard 把原来 4 波串行 await(balance → new-api 聚合+3 日志切片 →
   充值流水 → reseller)合并成一个并行 wave,TTFB 从各波之和降为最慢单项;
   allSettled 保留原有分区降级语义(单项失败只影响自己的区块)。

vitest 3220 pass / 1 skip / 0 fail;tsc + lint + prettier + next build 全绿。

变更文件：`src/app/(authenticated)/dashboard/page.tsx`、`src/app/(authenticated)/loading.tsx`。

#### a087a4c · 2026-08-29 22:33:10 · perf(portal): P1 — /dashboard Suspense 流式渲染 + 用量聚合 stale-while-revalidate (#423)

延续 #421 的页面切换优化,消掉剩下两处「等最慢的」:

1. /dashboard 拆快壳 + 流式慢区块(新 sections.tsx):壳(标题/tabs/余额
   提醒表单/充值流水/reseller,全本地 DB)立即渲染;余额卡、用量卡、
   图表、调用明细各自包 <Suspense>,await page 里只发起一次的共享
   promise(loadBalanceData / loadUsageData,永不 reject),数据到了
   独立流入。分区降级语义与拆分前一致。
2. usage-aggregate 加 SWR:缓存超 5min TTL 但 <30min → 立即返回 stale,
   后台异步重算写回(进程内 Map 去重防并发重复);此前每 5 分钟第一个
   访客要同步扛最多 50 页 × 1000 行的全量拉取。>30min 老缓存仍走同步
   重算,fallback / hard-fail 路径不变。

测试:dashboard-page.test 从 renderToString 切到 Fizz(renderToPipeableStream

- onAllReady)拿完整 HTML,14 条断言原样全过;usage-aggregate 新增 SWR
  立即返回 / 超窗同步 / 并发去重 3 用例。全套 3222 pass / 1 skip / 0 fail;
  tsc + lint + prettier + next build 全绿。

变更文件：`src/__tests__/app/dashboard-page.test.tsx`、`src/__tests__/lib/newapi/usage-aggregate.test.ts`、`src/app/(authenticated)/dashboard/page.tsx`、`src/app/(authenticated)/dashboard/sections.tsx`、`src/lib/newapi/usage-aggregate.ts`。

#### b2e3bef · 2026-08-29 22:33:21 · feat(proxy): OpenAI Batch API 兼容 — /v1/files + /v1/batches + worker 逐行重放生图管线 (#422)

客户 SDK client.batches.* / client.files.* 直接可用(此前兜底透传 new-api 全 404)。
MVP 只收 endpoint=/v1/images/{generations,edits};worker(instrumentation 第 6 调度器)
逐行 self-fetch 重放本实例同步管线,计费/failover/错误归一零改动。JSONL 存 PG Bytes
(公开读 image bucket 放不得客户 prompt),20MB/1000 行上限;b64_json 改写成 URL 形;
不做官方 5 折(上游成本没变)。migration 3 表全 additive;逐行结果幂等落库支持重启续跑;
24h 超窗 expired;每用户在途 5 批。39 新测 + instrumentation 测试更新。

变更文件：`.env.example`、`CLAUDE.md`、`prisma/migrations/20260829120000_add_batch_api/migration.sql`、`prisma/schema.prisma`、`src/__tests__/instrumentation.test.ts`、`src/app/v1/[...path]/batches.ts`、`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/batches.test.ts`、`src/instrumentation.ts`、`src/lib/batch/__tests__/validate.test.ts`、`src/lib/batch/__tests__/worker.test.ts`、`src/lib/batch/store.ts`、`src/lib/batch/validate.ts`、`src/lib/batch/worker.ts`。

#### 10589bb · 2026-08-29 22:52:59 · perf(portal): P2 — 周期 tab useTransition 即时反馈 + recharts 图表懒加载 (#424)

收尾 #421/#423 的页面流畅度系列:

1. PeriodTabs 从 <Link href=\"?period=\"> 换成 useTransition + router.push:
   点击立即乐观高亮目标 tab(pending 期间 pulse 提示),数据到了 active
   prop 跟上;之前点击后要等整页服务端渲染完才有任何视觉变化。
2. ModelConsumptionChart 加懒加载壳(next/dynamic + ssr:false):recharts
   从 dashboard 路由关键 JS 里拆出,SSR 放等高占位(图表卡同壳不跳版),
   hydration 后另起 chunk 渲染;enterprise 版 dashboard 同步切换。

测试:dashboard-page.test 的 next/navigation mock 补 useRouter,图表 stub
改 mock 懒加载壳;全套 3261 pass / 1 skip / 0 fail;tsc + lint + prettier +
next build 全绿。

变更文件：`src/__tests__/app/dashboard-page.test.tsx`、`src/app/(authenticated)/dashboard/model-consumption-chart-lazy.tsx`、`src/app/(authenticated)/dashboard/period-tabs.tsx`、`src/app/(authenticated)/dashboard/sections.tsx`、`src/app/enterprise/(dash)/page.tsx`。

#### 03e9b83 · 2026-08-29 23:05:35 · docs(portal): /docs 新增第 22 章「Batch API · 批量生图」(#422 兼容层客户文档) (#425)

PR #422 上线了 OpenAI Batch API 兼容层(/v1/files + /v1/batches,仅
/v1/images/{generations,edits}),但公开 /docs 一直没有对应章节。本 PR
补上完整客户文档(非 teaser):

- 四步流程表:上传 JSONL(purpose=batch)→ 创建 batch → 轮询 → 下载
  output/error 文件;其余管理端点(list / get / delete / cancel)一并列出
- JSONL 行格式:custom_id / method / url / body 四字段表 + 文生图示例
  (gemini-3.1-flash-image-preview + gpt-image-2,避开 default 组无渠道的
  2.5)+ 图生图行的 image 字段(公网 URL / data URL,数组=多参考图)
- Python(openai SDK 官方 client.files/batches.*)与 curl 完整四步示例 +
  输出文件行结构(response.body.data[0].url / error.code=request_failed)
- 状态机表:validating / failed(校验错带行号,不扣费)/ in_progress /
  completed / cancelling→cancelled / expired(24h 超窗保留部分结果)
- 限制表:20MB / 1000 行 / 每账号在途 5 批 / completion_window 仅 24h /
  b64_json 改写成图床 URL(自定义 OSS 照常生效)/ 按同步价计费无 5 折 /
  执行速度预期
- 常见错误表:unsupported_endpoint / unsupported_purpose / 413
  file_too_large / 429 batch_limit_reached / 校验错误码全集 / 行级失败
  (含 503 no available channel)进 error 文件不影响整批 / 404 not_found
- 第 10 章 API 速查表登记 /v1/files + /v1/batches(见第 22 章)+ TOC 入口

事实全部对照 src/app/v1/[...path]/batches.ts + src/lib/batch/{store,
validate,worker}.ts 核实。追加为末章(22)不插中间,避免动第 12/18/19 章
的既有交叉引用编号。

测试:docs-page.test.tsx 追加 5 个断言块(anchor+TOC+速查表 / 端点全集 /
JSONL 字段+示例模型 / 限制表 / 状态机+错误码);全套 vitest 264 files /
3266 pass / 1 skip / 0 fail,tsc + lint + prettier clean。

变更文件：`src/__tests__/app/docs-page.test.tsx`、`src/app/docs/page.tsx`。

#### dd3c6a9 · 2026-08-30 10:08:01 · fix(proxy): gpt-image 官方契约对齐一批 — variations 拦 400 / 流参数剥离 / n 门 / mask 双修 / az 变体 / strict 泄漏 (#426)

- /v1/images/variations 直接 400 unsupported_endpoint(官方仅 dall-e-2 支持,我们不供;
  原裸透传 new-api,上游原始报错不走脱敏直漏客户)
- gpt-image 请求剥 stream/partial_images:images 流式未实现(伪流式另 PR),留着会让
  上游真返 SSE 时原样 200 透传、绕过 C2PA 剥离/转码/图床整条后处理链
- n 范围门(官方 1-10 整数):非法直接 400 param:n,不再打上游(n=1000 是真金白银)
- mask 双修:JSON 形 mask(data/http URL)转成 multipart 文件部件(原被当标量文本,
  上游收不到蒙版静默整图重绘);formImageFiles 排除 mask(不参与 edits/generations
  分流判定与尺寸重试基准)
- az-gpt-image-2-{1,2,4}k 变体正则修复(原锚定 ^gpt-image-2- 匹配不到 az- 前缀,
  isGptImageModel 认但翻译不生效 → 上游拿到未知模型名)
- 上游 URL 剥 portal 自有 query(strict/async/webhook)
- 严格模式补 moderation 值校验(auto|low)

9 新测 + 1 旧测更新(n 非数字串:原「留给 new-api 报错」→ 现代理层 400)。

变更文件：`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`。

#### d11f198 · 2026-08-30 10:13:07 · fix(enterprise): 计费流水亮出关联任务 ID + 说明扣费时点(客户误报「计费不一致」) (#427)

客户看到计费流水 00:02:07 一笔 ¥15.4399,调用日志里 00:02:21 有条同价任务 ——
时间对不上,报「计费流水跟调用日志不一致」的严重 bug。

## 对账结论:账分毫不差,是展示让人没法对

    任务 98 = 已扣费 94 + 失败 4(失败不计费 ✓)
    流水 97 = 消费 94 + 入账 3
    任务实付合计 836.4608 = 消费流水合计 836.4608(逐分一致)
    孤儿检查:消费流水 ref 缺任务 = 0;扣了费无流水 = 0

错位的真相:**流水时间 = 任务完成扣费时刻,调用日志时间 = 任务创建时刻**。
15 秒的视频要生成 ~9 分钟,于是两张表按时间排序后天然错开一位:

    00:02:07 那笔流水 = 23:53:15 创建的任务(完成于 00:02)
    00:11:14 那笔流水 = 00:02:21 创建的任务(完成于 00:11)

客户把相邻 14 秒的两行当成了同一件事。

## 为什么客户没法自己对出来

ledger_entries 的 `ref` 一直存着任务 ID,但**流水页和导出 CSV 都没显示它**,
备注只有模型名 —— 客户想对账只能按时间猜。

## 改动

- 流水页加「关联任务」列(monospace 显示 ref 任务 ID)
- 表格上方加一句说明:消费的「时间」为任务完成扣费时刻,晚于任务创建;对账以任务 ID 为准
- 导出 CSV 同步加「关联任务ID」列

纯展示改动,不动账。

264 files / 3266 pass / 0 fail;tsc / prettier clean,eslint 0 error。

变更文件：`src/app/api/enterprise/export/billing/route.ts`、`src/app/enterprise/(dash)/billing/page.tsx`。

#### 7c60ffe · 2026-08-30 10:14:15 · feat(proxy): gpt-image 伪流式 — stream:true 按官方 Images streaming 契约返 SSE completed 事件 (#428)

客户 SDK client.images.generate(stream=True) 可用:立即 200 开 SSE、15s 注释保活
(慢图 300s+ 不再依赖 withKeepalive 的「85s 后变 200」妥协),完成后发官方形
image_generation.completed / image_edit.completed(b64_json/created_at/size/quality/
background/output_format/usage;response_format=url 扩展带 url)。上游那腿仍恒非流
(stream/partial_images 照旧剥),不发 partial_image(上游不产渐进图,SDK 事件驱动
解析不受影响)。失败 → 官方 error 事件。stream 限 n=1(400)。

5 新测 + 1 旧测改写(原「上游 SSE 成功体原样透传」的旁路场景已被剥参数取缔,
改测「200 非 JSON 体防御透传」)。

变更文件：`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`。

#### 4b4efe0 · 2026-08-30 13:03:42 · feat(proxy): /v1 面开 CORS — 浏览器前端可直调(对标 api.openai.com) (#429)

预检 OPTIONS 此前被 Next 自动应答成裸 204(无 Access-Control-Allow-* 头)→ 浏览器前端
客户全灭。现:OPTIONS 自答 204 + ACAO * + 回显 request-headers(authorization 不吃
通配符)+ max-age 86400;四个方法出口统一补 ACAO _(portal 自答的校验 400 / reshape /
伪流式 SSE / balance / batch 面此前都没带,只有透传继承 new-api 的头);顺手剥
allow-credentials(与 * 是 spec 非法组合,防未来改回显 origin 时意外开带 cookie 跨域)。
鉴权是 Bearer key 非 cookie,_ 不带 credentials 无 CSRF 面。5 新测。

变更文件：`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`。

#### 807cc16 · 2026-08-31 15:27:53 · feat(enterprise): 海外版(global)上 seedance-2-5-global —— 费率与 promax-2.5 同价 (#430)

operator:海外版 global 此前没有 2.5(文档写「新代海外出片请用 proMax」),上游
(intl 端口)现已提供,价格与 proMax 的 2.5 相同,现在上。

## 实现:variant 复用 promax-2.5,region=global

    对客名   seedance-2-5-global(720p / 1080p,无 480p / 4k)
    上游     SEEDANCE_GLOBAL_MODEL_25(缺省 = promax 2.5 同一 SKU artsdance2-5-intl-260628)
    费率     与 promax-2.5 完全同价(72.76/80.24;含视频 43.52/47.94)
    key      客户的 global 上游 key(区别于 promax key)

**variant 直接复用 'promax-2.5' 而不是新建**:operator 拍板同价,复用 = 单一价源,
promax 调价 global 自动跟随,不会出现两张表漂移。region 仍是 global —— 计费折扣
(EnterpriseModelDiscount 按 region+variant)、上游 key 选取、480p 拦截文案都走 global。

⚠️ variantForModel 兜底链加了一条:`is25 && '-global' → 'promax-2.5'`,必须先于
纯 2.5 判 —— 否则 global 2.5 落到 cn '2.5' 档(70/90)按错价计费。已加守护测试钉死。

## 文档:价格差异必须显著

global 2.0 系与国内版同价,但 **global 2.5 = proMax 价,不同于国内版 2.5**
(720p:72.76 vs 70;1080p:80.24 vs 90)—— 客户按「global 与国内一致」的惯性下单
会对不上账。文档在 global 段落里加了显式 ⚠️ 说明,价格从费率表动态渲染(不写死)。

## 门

264 files / 3289 pass / 0 fail(+4 新测:/models 12 短名、720p 解析与 region、
480p/4k 拦截、费率守护)。tsc / prettier clean,eslint 0 error。

变更文件：`src/__tests__/app/enterprise-docs-page.test.tsx`、`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/seedance/__tests__/cn-billing.test.ts`、`src/lib/seedance/cn-adapter.ts`。

#### a79d6ba · 2026-09-01 01:09:56 · feat(enterprise): volc 素材组支持重名 —— 名字所有权收归我们(组表) (#431)

客户反馈:CreateAssetGroup 火山官方允许重复名称,我们不允许。

## 归因(前轮已实测):限制在上游的库,不在我们

同名建组直连上游同样失败 —— 它的 MySQL `asset_group` 表建了唯一索引
`uk_biz_ns_name`(还把 `Error 1062 … open_platform_api …` 裸奔给了我们)。
火山官方允许重名(组 id 是数字串,Name 只是标签)。

## 方案:名字这个属性收归我们,上游只当存储

    建组发给上游的 Name = 机器名 g-{16hex}(永不重复)
    客户设的名字/描述   = 新表 volc_group_meta(vendor_id 主键)
    读回来时            = 用我们的表覆盖上游的机器名

重名问题**在结构上消失**(不是被绕过)—— 上游的唯一索引再也撞不上。
顺带:上游侧从此看不到客户的业务命名(少泄露一点客户数据给中间商)。

## 各 Action 的变化

- CreateAssetGroup:上游发机器名,不再发 Description;客户名落表(写失败 fail-closed
  抛 503 —— 名字现在是我们的权威数据,不能静默变成机器名)
- Get/List:nativeRow 组路径覆盖 Name/Title/Description;无表行(老组/真人认证组)
  回落上游名 —— 老组本就不重名,零迁移
- UpdateAssetGroup:只写我们的表,不再 PUT 上游(上游那边是机器名,改它没意义);
  先 GetAssetGroup 保住「组不存在 → 404」语义 + 拿老组首次改名的回落名
- DeleteAssetGroup:清表行(best-effort)
- **ListAssetGroups 的 Filter.Name 改本地过滤**(上游只有机器名,转发必然查空):
  拉全量(封顶 500,超限落日志)→ 覆盖名字 → contains 过滤 → 本地分页
- sanitizeUpstreamMessage 补 SQL 剥离:`Duplicate entry` → 「名称已存在,请更换名称」,
  `Error 1062 (...)` / 索引名 / open_platform_api 一律不对客(防素材名等其它唯一索引路径)

## 门

264 files / 3294 pass / 0 fail(+6 新测:机器名 + 客户名不发上游、同名两次都成功、
覆盖与老组回落、Update 不打上游、Name 本地过滤、SQL 报错不裸奔)。
migration 在临时库验过:干净 apply + 同名两行可插。tsc / prettier clean,eslint 0 error。

变更文件：`prisma/migrations/20260831130000_volc_group_meta/migration.sql`、`prisma/schema.prisma`、`src/lib/enterprise/__tests__/kuaizi-assets.test.ts`、`src/lib/enterprise/kuaizi-assets.ts`、`src/lib/enterprise/volc-group-meta.ts`。

#### 897b40c · 2026-09-03 13:09:04 · feat(enterprise): submit 到达对账日志 —— body 读失败/非 JSON/正常到达三路留痕 (#432)

客户「发了 N 个我们只见 M 个」(2026-09-03 weirdo 5 并发只到 4)以前只能靠
volc 透传日志间接推断,且 req.text() 失败与 invalid_json 完全无痕。现在
handleSubmit 三条入口路径都留日志,submit received 带 client_request_id
可直接与客户对账。

变更文件：`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`。

#### 6e2682d · 2026-09-03 23:11:29 · feat(enterprise): 请求日志系统 —— 一条请求的全貌持久化 + 后台筛选/详情/导出 (#433)

背景:请求级细节(入参/上游响应/耗时/归属)此前只在 console.log → docker logs,
容器重建即清零(#260 教训),3 副本分散无法筛选导出;持久化的只有任务终态账本。

- 新表 enterprise_request_logs(migration 20260903090000,纯 additive):
  kind/format/user/key/region/model/task_id/vendor_task_id/client_request_id/
  双侧 HTTP status/缓存命中/outcome/错误码文案/总耗时+上游耗时/入参/上游响应/IP/UA
- 采集(src/lib/enterprise/request-log.ts,fire-and-forget 绝不影响客户请求):
  · submit 全量(含没过鉴权/余额门就被拒的 —— 对账要数得到被拒的)
  · poll 只记有信息量的:终态迁移 / 上游真报错(缓存重放不刷屏)/ 没打上游就被拒;
  ENTERPRISE_REQLOG_POLL_ALL=1 临时全量排障
  · reconcile 动作(back_charged/terminalized/expired/marked_failed)
  · 入参落库前脱媒(base64/data URL → 占位符)+ 32KB 截断
- 后台 /enterprise-admin/logs(superadmin):日期/客户/渠道/类型/结果/模型筛选 +
  任务号检索 + 分页 50/页;详情页 = 入参/上游响应 pretty JSON + 同任务时间线;
  CSV 导出(BOM,5 万行上限)+ 单条 JSON 下载
- 保留期 60 天(ENTERPRISE_REQLOG_RETENTION_DAYS),主站实例 12h cron 清理
  (企业实例 instrumentation 门不跑定时任务,同库代清)
- 红线:upstream_body 含上游中间商域名,仅 superadmin 面可见,绝不接客户面(#271)

测试:42 新(采集 22 + 清理 4 + admin 端点 6 + proxy 集成 7 + reconcile mock 扩);
全套 3336 pass / 1 skip / 0 fail;migrate diff 校验手写 SQL 与 schema 逐字一致。

变更文件：`prisma/migrations/20260903090000_enterprise_request_logs/migration.sql`、`prisma/schema.prisma`、`src/app/api/admin/enterprise/__tests__/logs-export.test.ts`、`src/app/api/admin/enterprise/logs/[id]/route.ts`、`src/app/api/admin/enterprise/logs/export/route.ts`、`src/app/enterprise-admin/(panel)/layout.tsx`、`src/app/enterprise-admin/(panel)/logs/[id]/page.tsx`、`src/app/enterprise-admin/(panel)/logs/page.tsx`、`src/instrumentation.ts`、`src/lib/enterprise/__tests__/ark-v3.test.ts`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/__tests__/reconcile.test.ts`、`src/lib/enterprise/__tests__/request-log.test.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/enterprise/reconcile.ts`、`src/lib/enterprise/request-log.ts`、`src/lib/scheduler/__tests__/enterprise-reqlog-cleanup.test.ts`、`src/lib/scheduler/enterprise-reqlog-cleanup.ts`。

#### d5b98f7 · 2026-09-04 01:33:09 · feat(enterprise): 请求日志 P2 —— 素材库 Action API 落日志 (#434)

P1(#433)闭环了视频线(submit/poll/reconcile),本 PR 把素材库 /api Action 面接入
同一张 enterprise_request_logs:

- 新列 action(Action 名)+ resource_id(素材/组 id,含筷子十进制号),migration
  20260904040000 纯 additive;kind 新值 asset_action;format 列在素材行复用为
  落库位置 platform | kuaizi(真人认证按 provider 记 kuaizi)
- /api 路由包 wrapper(与 proxy handleSubmit 同形):Action 全量落库(量级远低于
  轮询),含鉴权失败/参数 400;入参照旧脱媒+截断;创建类 Action 成功后回填新建 id
- writeRequestLog 错误提取兼容火山 envelope({ResponseMetadata:{Error:{Code,Message}}})
- 后台:kind 筛选加「素材库」、类型列显示 Action 名、任务列改「任务/素材 ID」、
  检索 q 命中 resource_id、详情页 + CSV 导出加两列
- 修 P1 测试盲区:instrumentation.test 未 mock 新清理调度器 → register() 真跑
  sweep 打真 prisma,慢机下抖动超时;补 mock + 断言 7 个调度器

测试:9 新(Action 落库 4 + request-log 3 + 断言修正);全套 3343 pass / 1 skip
(个别时序敏感老测试在本机高负载下偶发超时,隔离重跑全过,与本改动无关)。

变更文件：`prisma/migrations/20260904040000_reqlog_asset_actions/migration.sql`、`prisma/schema.prisma`、`src/__tests__/instrumentation.test.ts`、`src/app/api/__tests__/asset-actions.test.ts`、`src/app/api/__tests__/real-person.test.ts`、`src/app/api/admin/enterprise/__tests__/logs-export.test.ts`、`src/app/api/admin/enterprise/logs/export/route.ts`、`src/app/api/route.ts`、`src/app/enterprise-admin/(panel)/logs/[id]/page.tsx`、`src/app/enterprise-admin/(panel)/logs/page.tsx`、`src/lib/enterprise/__tests__/request-log.test.ts`、`src/lib/enterprise/request-log.ts`。

#### a6c9a36 · 2026-09-04 09:56:29 · feat(enterprise): 运营后台两级管理员 + 管理员操作审计日志 (#435)

放开 /enterprise-admin 给次级管理员,超管可通过审计日志监督其全部操作。

- 次级管理员 = 新表 enterprise_admins 有行的 User(role 仍 customer)——
  【不动全局 UserRole】:staff/admin role 会连带解锁主站 /admin,权限外溢;
  这套标记只对企业运营后台生效
- 守门统一到 src/lib/enterprise/admin-auth.ts:resolveEnterpriseAdmin 两级
  (super = 全局 superadmin / break-glass;secondary = 有行),日常端点全开次级,
  监督面(管理员管理 / 审计日志)superOnly
- 审计:新表 admin_audit_logs,每个【成功的写操作】一行(入账/开户/客户折扣/
  删账号/密钥启停/设密码/上游key/议价/全局折扣/授予撤销管理员),操作者/等级/
  action/target/params(脱敏:password·upstream_key·secret·token → [redacted])/
  IP/UA;fire-and-forget 绝不影响操作本身;超管操作同样记;永久保留
- 后台新页(superadmin-only):/enterprise-admin/audit(筛选/分页/params 展开/
  CSV 导出)+ /enterprise-admin/admins(授予[已有账号或建纯登录新账号]/撤销);
  layout 两级导航,次级看不到监督面入口
- migration 20260904060000 纯 additive;Caddy/middleware 白名单天然覆盖,零运维改动

测试:24 新(admin-auth 12 + admins 端点 8 + 审计接线 4)+ 4 个存量测试 mock 迁移;
全套 3367 pass / 1 skip / 0 fail;migrate diff 校验 SQL 与 schema 一致。

变更文件：`prisma/migrations/20260904060000_enterprise_admins_audit/migration.sql`、`prisma/schema.prisma`、`src/app/api/admin/enterprise/__tests__/admins.test.ts`、`src/app/api/admin/enterprise/__tests__/audit-integration.test.ts`、`src/app/api/admin/enterprise/__tests__/customers.test.ts`、`src/app/api/admin/enterprise/__tests__/global-discount.test.ts`、`src/app/api/admin/enterprise/__tests__/logs-export.test.ts`、`src/app/api/admin/enterprise/__tests__/set-password.test.ts`、`src/app/api/admin/enterprise/admins/[id]/route.ts`、`src/app/api/admin/enterprise/admins/route.ts`、`src/app/api/admin/enterprise/audit/export/route.ts`、`src/app/api/admin/enterprise/credit/route.ts`、`src/app/api/admin/enterprise/customers/[id]/route.ts`、`src/app/api/admin/enterprise/customers/route.ts`、`src/app/api/admin/enterprise/global-discount/route.ts`、`src/app/api/admin/enterprise/keys/[id]/route.ts`、`src/app/api/admin/enterprise/logs/[id]/route.ts`、`src/app/api/admin/enterprise/logs/export/route.ts`、`src/app/api/admin/enterprise/onboard/route.ts`、`src/app/api/admin/enterprise/rate-override/route.ts`、`src/app/api/admin/enterprise/set-password/route.ts`、`src/app/api/admin/enterprise/upstream-key/route.ts`、`src/app/enterprise-admin/(panel)/admins/admins-manager.tsx`、`src/app/enterprise-admin/(panel)/admins/page.tsx`、`src/app/enterprise-admin/(panel)/audit/page.tsx`、`src/app/enterprise-admin/(panel)/layout.tsx`、`src/lib/enterprise/__tests__/admin-auth.test.ts`、`src/lib/enterprise/admin-auth.ts`。

#### 3634baa · 2026-09-04 10:23:16 · fix(enterprise): 运营后台不再向次级管理员显示「(次级管理员)」标识 (#436)

operator 要求:次级管理员不应知道自己是次级。header 只显示邮箱;
等级差异仅体现在导航可见性(监督面入口 super-only),对本人不点破。

变更文件：`src/app/enterprise-admin/(panel)/layout.tsx`。

#### 5cc433b · 2026-09-04 11:20:12 · feat(enterprise): 素材库失败把上游原因带进请求日志 —— 「素材入库失败」不再查无可查 (#437)

背景:shujubao 2026-09-04 10:49 CreateAsset 502(AssetCreateFailed),日志行
上游 HTTP/耗时/原文全空 —— 筷子把素材标 Status=Failed 的那行响应(含具体原因)
被静默丢弃,docker 也无痕,admin 只能看到一句「素材入库失败」。

- RealPersonError 加可选 upstream {status, body}(withUpstream 链式,8KB 截断);
  只进 admin 请求日志,绝不对客回显(#271:上游原文可能含筷子身份)
- kuaizi-assets 全部上游失败路径附带原文:call() 改读 text(不可达/非 JSON/鉴权失败/
  action failed 全带 status+body);CreateAsset 入库 Status=Failed 分支【新增 docker warn
  留上游行原文】+ 随错误带出;入库超时/建组建材「未返回编号」同样附带
- /api route 两处 RealPersonError catch:err.upstream → ctx.upstream_status/upstream_body
  → 日志详情页「上游响应」区直接可见

测试:+4(路由集成 2:上游原文进日志且不进对客响应 / 无细节不炸;
kuaizi 单测 2:action failed 附原文 / ingest Failed 附 Reason + warn);
全套 3371 pass / 1 skip / 0 fail。无 migration。

变更文件：`src/app/api/__tests__/asset-actions.test.ts`、`src/app/api/route.ts`、`src/lib/enterprise/__tests__/kuaizi-assets.test.ts`、`src/lib/enterprise/kuaizi-assets.ts`、`src/lib/enterprise/real-person.ts`。

#### bcfbe41 · 2026-09-05 00:36:57 · feat(enterprise): volc 支持按客户配筷子 key(视频/素材/活体全链路)+ 活体报错净化 (#438)

## 起因

上游把活体检测挪到了新渠道:老渠道(平台 env key)的 CreateVisualValidateSession
从 2026-08-19 的正常,变成了「该渠道暂不支持活体检测」(客户 jingdong 实测报障)。
三把 key 直连对比坐实:老 key 500、operator 提供的新 key 200。

**整体换 env key 不可行** —— 筷子素材/任务按账号隔离,换 key = 所有存量客户的素材、
在途任务全部失联。唯一平滑路径:**按客户切**。

## 实现

`enterprise_upstream_keys(region='volc')` 的 key 行此前只是占位符(volc 全走平台
env key)。现在:**行里存的是真实 kz- key 时优先用它**,否则回落 env —— 存量客户
(占位符行)行为逐字不变。

贯穿三条链路:

- 视频:submitVolcVideo / pollVolcVideo 加 upstreamKey;proxy 从 cust.upstreamKey
  取(customerKuaiziKey 判 kz- 前缀);**对账器同样按任务归属客户取 key** ——
  否则配了新 key 的客户,其任务在他自己的筷子账号里,env key 轮询必 404 →
  误终态化
- 素材:handleKuaiziAssetAction 加 apiKey,call/waitForVendorAssetId 全线贯穿
- 活体:createVisualValidateSession / getVisualValidateGroupId 加 apiKey;
  route.ts 解密客户 volc key 行统一下发

按客户 key 的额外收益:素材库天然按客户隔离(此前全平台共库、客户互相可见)。

## 顺带:活体报错净化

上游把「rpc error: code = InvalidArgument desc = 该渠道暂不支持活体检测」整串
裸奔,我们此前原样透传(真人认证路径只处理了「未完成→404」一种)。现在:

- 「不支持活体检测」→ 503「真人认证服务暂不可用(渠道未开通活体检测)」
- 其余错误剥 rpc 包装再对客

## 门

270 files / 3375 pass / 0 fail(+5 新测:submit Bearer 覆盖、customerKuaiziKey
判据、assets ApiKey 覆盖、对账器按客户 key、占位符回落)。
tsc / prettier clean,eslint 0 error。无 migration。

变更文件：`src/app/api/__tests__/real-person.test.ts`、`src/app/api/route.ts`、`src/lib/enterprise/__tests__/kuaizi-assets.test.ts`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/__tests__/reconcile.test.ts`、`src/lib/enterprise/kuaizi-assets.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/enterprise/real-person.ts`、`src/lib/enterprise/reconcile.ts`、`src/lib/seedance/__tests__/kuaizi-adapter.test.ts`、`src/lib/seedance/kuaizi-adapter.ts`。

#### f002965 · 2026-09-05 00:39:40 · feat(enterprise): volc ListAssetGroups 支持 Filter.GroupIds(火山官方参数,此前被静默忽略) (#439)

客户契约测试:火山官方 ListAssetGroups 支持 `Filter.GroupIds`(按组 id 列表过滤),
我们传了照样返回全量 —— 比报错更糟,客户以为过滤生效了。

① 我们的 zod schema 没收 GroupIds → 静默剥掉(zod 只留声明过的键)
② 上游实测【也】忽略该参数:Filter.GroupIds=[单个id] → TotalCount=73 返回全量
—— 所以就算转发也没用,必须本地过滤

与 #431 的 Name 本地过滤同一条路:拉全量(封顶 500)→ 覆盖名字 → 过滤 → 本地分页。
GroupIds 匹配**火山号与上游号都认**(宽进,与 id 体系一致:存量客户手里可能是上游号);
与 Name 同给时取交集;查无返回空结果(而不是客户报的「忽略后返回全量」)。

270 files / 3373 pass / 0 fail(+2 新测:三种 id 形态过滤 + 查无为空、Name 交集)。
tsc / prettier clean,eslint 0 error。

⚠️ 与 #438(按客户 key)同文件,后合者需 rebase。

变更文件：`src/lib/enterprise/__tests__/kuaizi-assets.test.ts`、`src/lib/enterprise/kuaizi-assets.ts`。

#### 6821339 · 2026-09-06 23:08:13 · feat(image-adapter): C2PA 剥离下沉到适配器层(堵 :3000 绕过客户的 adobe 图泄漏) (#440)

此前 adobe C2PA 剥离只在 portal /v1 reshape 层做。但 new-api :3000 公网可直连,
客户绕过 portal 就拿到带 Adobe C2PA 的图(2026-09-02 排查发现,见 memory
ch83-adobe-c2pa-image-leak)。适配器是所有 adobe 图片渠道的公共必经点,在这里剥 =
portal 与直连客户都覆盖,也不用追每家上游身份变化(oaidist 2026-08-24 是真 OpenAI
签名、2026-09-06 复测已静默变 Adobe —— 上游会偷偷换后端)。

- handleAdapterImage 最终 return 前对每张 items[].b64_json 做 stripAdobeImageMetadataB64。
- 内容自定向:仅命中 adobe/firefly 标识的图才剥,OpenAI 原生/azure/gemini 字节原样。
- 放在 dims/alpha 读取与 usage 合成之后 —— 剥离只删元数据块、不改像素与尺寸,计费不受影响。
- portal reshape 的剥离保留作双重防御(适配器剥后成 no-op,无害)。

+2 测试(adobe 图剥离+像素无损 / 无 adobe 图原样不动),全套 3380 pass / 1 skip,
tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/adapter.ts`。

#### e6fddb3 · 2026-09-06 23:42:08 · feat(image-adapter): 响应合规下沉到适配器层(echo/jpeg/错误官方形,覆盖直连绕过客户) (#441)

new-api :3000 公网可直连,VIP 客户 c-70fd7c5f(¥248万充值/1850万请求)直连绕过 portal,
享受不到 portal /v1 reshape 层的合规处理(回显/JPEG/错误归一)—— 其历次合规投诉
(#9 JPEG/#13 quality-compression)根因在此。实测确认 new-api 透传适配器顶层字段
(created/usage 原样传出)→ 在适配器补合规,portal 与直连客户都覆盖。

- echo:响应加官方枚举顶层字段 quality(normQuality 归一 low/medium/high)/ background
  (透明校验通过=transparent 否则 opaque)/ output_format(按最终字节 sniff)/ size(计费尺寸)。
- jpeg:output_format=jpeg → Jimp 转码成真 jpeg 字节(#9;上游多恒返 png)。放在计费之后
  (转码不改尺寸)、C2PA 剥离之前。
- 错误官方形:terminalReject safety 从旧 content_policy_violation 对齐官方现行
  moderation_blocked / user_error;官方 message 含 "safety system" 仍命中 portal
  IMAGE_SAFETY_RE → portal 再归一幂等,portal 客户不受影响。
- portal reshape 同逻辑保留作双重(值相同,幂等)。

+5 测试(echo 四字段 / high / transparent / jpeg 转码,safety 断言改 moderation_blocked),
全套 3383 pass / 1 skip,tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/adapter.ts`。

#### 89281f8 · 2026-09-07 00:07:13 · feat(seedream): Seedream 5.0 Pro 适配器 —— seedream-5-0-pro 经 service-inference.ai,按张合成计费(官方 5.5 折)+ 图层拆分 (#442)

- feat(seedream): Seedream 5.0 Pro 适配器 —— seedream-5-0-pro 经 service-inference.ai,按张合成计费(官方 5.5 折)+ 图层拆分 + /docs

* src/lib/seedream/adapter.ts + /seedream-adapter/v1/images/generations:对客 seedream-5-0-pro →
  上游 dola-seedream-5-0-pro-260628-ep;输入图四字段归一(URL / base64 直传);恒要 b64_json
  (上游 url 是火山 TOS 24h 链接);n 本层扇出(上游忽略 n);图层拆分单次;上游 4xx → 400 脱敏
  终态,5xx/超时/无图 → 502 不计费。
* 合成 usage = 售价 quota(ModelRatio=CompletionRatio=1 ⇒ quota = input_tokens + output_tokens):
  官方 USD × 0.55 × 6.8 —— 普通 ≤2.36MP ¥0.1683 / >2.36MP ¥0.3366;图层拆分每张输出 ¥0.0842 /
  ¥0.1683;参考图第 2 张起 ¥0.0112;按返回图实际尺寸分档,阈值取上游计费元数据 le_236w。
* /v1 代理钩子:缺省 response_format=url → b64 存客户 OSS / R2 换永久 url;图层拆分空 prompt
  占位空格(new-api 要求非空);multipart images.edit → 转 JSON 打 generations;无渠道按容量 503。
* middleware matcher 排除 seedream-adapter/(大 base64 入参避开 10MB 缓冲截断)。
* scripts/setup-seedream-5-pro.mjs:三键镜像 + UUG + ModelRatio/CompletionRatio=1 + 建渠道
  (pass_through_body_enabled 必须 true,auto_ban 0)。
* /docs#seedream-image 章节 + 客户指南;docs/ 加 ch166 现状报告;CLAUDE.md 进度。
* 测试:seedream 适配器 23 + 代理 6;全套 3408 pass / 1 skip。本地 dev 打真上游冒烟通过。

- chore(docs): prettier 格式化 ch166 现状报告(CI Format)

---

变更文件：`CLAUDE.md`、`docs/SEEDREAM-5-PRO-CH166-STATUS-2026-09-06.md`、`scripts/setup-seedream-5-pro.mjs`、`src/app/docs/page.tsx`、`src/app/seedream-adapter/v1/images/edits/route.ts`、`src/app/seedream-adapter/v1/images/generations/route.ts`、`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`、`src/lib/image-adapter/adapter.ts`、`src/lib/seedream/__tests__/adapter.test.ts`、`src/lib/seedream/adapter.ts`、`src/middleware.ts`。

#### fe52023 · 2026-09-07 00:14:03 · chore(seedream): setup 脚本缺省不写 group_ratio_setting(prod 三键已分叉,PUT 会 403 未镜像组)+ 打印分叉报告 (#443)

默认不写 group_ratio_setting；打印三键分叉，显式 --sync-group-setting 才镜像；GroupRatio 已为 1 时跳过写入。

变更文件：`scripts/setup-seedream-5-pro.mjs`。

#### f6fc4ac · 2026-09-07 00:16:23 · docs(claude.md): seedream 线 merge + 部署 + ch214 + 三键分叉记录 (#444)

仅更新上游 Seedream 部署/渠道 214 与三键分叉记录；不改变运行代码，不代表 LLmRoute 已上线。

变更文件：`CLAUDE.md`。

#### 2479875 · 2026-09-07 22:34:17 · fix(seedance): 报错文案原生化 —— 剥掉三层封装壳,直出火山风格原文 (#445)

客户投诉这条报错封装味太重:

    参考图未通过内容安全审核 —— 请修改参考图后重试(上游原因:资源同步失败: url= :
    The request failed because the input image may contain sensitive information)

拆开是三层壳:
① 我们的中文分类前缀「参考图未通过内容安全审核 —— 请修改参考图后重试」
② 「上游原因:」四个字 —— 直接承认存在中间层
③ 中间层自己的包装「资源同步失败: url= :」(URL 被脱敏后留下 `url= :` 残渣)

火山官方在这个场景就返回最里面那句英文。

## 改法:原文优先,中文只做兜底

classifyUpstreamError 全部分支改成 `nativeOr(clean, 中文兜底)`:

- 有火山风格原文 → **直出**(先过 stripVendorWrapping:剥「资源同步失败/素材转换失败/
  素材处理失败」类中间层前缀、`url= :` 残渣、rpc 包装、首尾孤立标点)
- 没有原文(body 空)→ 中文兜底(措辞里也去掉了「上游」字样)
- detail() 删除,「上游原因:」从代码里消失
  分类职责完整保留在 category 字段(终态判定/轮询停止逻辑不受影响)。

客户那条现在输出:

    The request failed because the input image may contain sensitive information

—— 和火山直出一模一样。已用客户原始报文做了钉死测试(零封装痕迹逐词断言)。

## 顺带修掉挂了很久的 backlog:HTML 错误页

原文优先暴露了一个新风险:nginx 502 的 HTML 错误页会被当「原文」整页透出。
nativeOr 加 HTML 守门 —— 含标签的一律当没有原文,走中文兜底,一个尖括号都不透。

## 不放松的红线

request_id / 上游域名 / 厂商标识的剥离(#271)一条没动,泄露类断言全部保留。

## 门

271 files / 3413 pass / 0 fail(改 14 条既有断言到新契约,+2 新测:客户案例钉死、
HTML 守门)。tsc / prettier clean,eslint 0 error。cn / global / promax / volc
共用这个分类器,四渠道文案一起原生化。

变更文件：`src/lib/seedance/__tests__/cn-adapter.test.ts`、`src/lib/seedance/__tests__/kuaizi-adapter.test.ts`、`src/lib/seedance/__tests__/upstream-error.test.ts`、`src/lib/seedance/upstream-error.ts`。

#### b40842e · 2026-09-07 23:08:11 · feat(seedance): 国内版 seedance-2-5 开 480p 档 —— 走原版 260628 上游 (#446)

pro 版 artsdance-2-5-pro-260801 拒 480p(2026-09-07 实测仍拒),原版
artsdance-2-5-260628 实测收 480p。MODEL_MAP 2.5 加 480p×{无ref,-ref}
两档,upstream 按分辨率分流(480p→原版,env SEEDANCE_XHK_MODEL_25_480P
可覆盖;720p/1080p 不动);proxy 撤 cn 2.5 的 480p 400 门(4k 由通用门
拦;volc 走独立 VOLC_RESOLUTIONS 不受影响);费率 480p ¥70/¥42 表内
已预置无需改。docs 档位/费率/参数说明同步。

⚠️ 拿货 9.5 折,毛利极薄、折扣 <0.95 客户倒挂 —— operator 知悉拍板照开。

变更文件：`src/app/enterprise/(dash)/docs/page.tsx`、`src/lib/enterprise/__tests__/proxy.test.ts`、`src/lib/enterprise/proxy.ts`、`src/lib/seedance/__tests__/cn-adapter.test.ts`、`src/lib/seedance/__tests__/official-price-parity.test.ts`、`src/lib/seedance/cn-adapter.ts`。

#### be40c03 · 2026-09-07 23:30:05 · docs(enterprise): 接入文档三处补新 —— duration 分系区间/-1、HTTPS 答案切主域名、价格算例补 seedance-2-5 (#447)

- duration 参数行:2.0 系 4-15 / seedance-2-5 系 4-30,-1 = 智能时长(此前只写 4-15)
- FAQ「HTTPS 证书报错」:主域名受信 HTTPS 为首选,自签说明仅限裸 IP 兼容入口
- §2 参考算例与 FAQ 价格例补 seedance-2-5(官方 ¥7.62 / 8.5 折 ¥6.48)+ 480p 约为 720p 一半的提示

变更文件：`src/app/enterprise/(dash)/docs/page.tsx`。

#### 1c94f20 · 2026-09-07 23:55:07 · feat(image-adapter): oaidist/oaidistfull(ch201/202)上游换到 llmway.ai (#448)

64.32.31.178:3009 首接是真 OpenAI 签名,2026-09-06 复测【静默变 Adobe Firefly】
(上游会偷偷换后端)。2026-09-07 operator 换到 llmway.ai:实测真 OpenAI 签名
(OpenAI OpCo 证书链无 adobe)、quality 三档真分档(high 质量本批最佳)、尺寸如实、
速度最快(23-29s)。

- providers.ts oaidist/oaidistfull baseUrl → https://llmway.ai(slug 名保留,渠道
  base_url 路径不变,只换 baseUrl;渠道 key 字段在 new-api 侧同步换成 llmway key)。
- brand 正则加 \bllmway\b(+ 保留旧 distributor/IP 历史兜底)。
- 守门 gateMinCt 1756 / openAllTiers 不变;C2PA 由适配器层按内容统一剥(#440),
  上游身份再漂移也不漏。

测试路由/brand 断言同步 llmway,全套 3415 pass / 1 skip,tsc/lint/prettier clean。

变更文件：`src/lib/image-adapter/__tests__/adapter.test.ts`、`src/lib/image-adapter/providers.ts`。

## dev 独有提交清单（合并前）

```text
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

合并前 dev 为 `ce23083`；上游为 `1c94f20`。以下三方审计分别以这两个提交和最终工作树比较，提交后另跑逐修复 SHA → merge commit diff。

### 七个冲突文件的三方语义取舍

| 文件                                                | 合并前 dev                                                                                 | main 上游                                                                                                 | 最终结果与放弃项                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/(authenticated)/dashboard/page.tsx`        | LLmRoute 欢迎栏、余额大卡、三项指标、热门模型及本地面板；慢数据串行等待                    | 快壳、本地 DB 并行、共享慢请求 promise 与 Suspense                                                        | 保留 dev 布局，使用上游 loaders；新增 portal-sections 承载原 UI 的异步区块，放弃上游旧五卡视觉布局和 dev 串行等待                                                                                                                                                                                                         |
| `src/app/(authenticated)/dashboard/period-tabs.tsx` | Portal 主题 Link tabs                                                                      | router.push/useTransition、乐观选中与 busy/pulse                                                          | 接收上游交互，保留 Portal 主题；不再等整页完成才显示切换反馈                                                                                                                                                                                                                                                              |
| `src/__tests__/app/dashboard-page.test.tsx`         | RMB-only、热门模型、明细、降级断言                                                         | Fizz onAllReady 渲染异步组件，mock lazy 图表                                                              | 保留所有 dev 业务断言与上游异步测试方法；热门模型标题沿用 dev，未删场景                                                                                                                                                                                                                                                   |
| `src/__tests__/instrumentation.test.ts`             | DEV_PROXY_URL/ProxyAgent 回归与 5 调度器                                                   | 新 Batch/请求日志清理，7 调度器 mock                                                                      | 同时保留代理测试与 7 项调用断言；Batch 内部默认门独立测试，避免真实 scheduler/Prisma 泄漏到单测                                                                                                                                                                                                                           |
| `src/app/docs/page.tsx`                             | DocsContent 公共/登录内嵌双入口                                                            | 单文件大页面新增 Batch、Seedream、错误与图片文档                                                          | page.tsx 保持 dev；三方 merge-file 将上游文档补入 docs-content，并替换新增旧品牌域名；Batch 明示暂未开放；放弃上游重复大页面与已部署承诺                                                                                                                                                                                  |
| `src/app/v1/[...path]/route.ts`                     | 固定 SKU 原名计费、尺寸强校验、n≤4 扇出、单请求多图、失败不伪报尺寸、尾斜杠守门、CORS 透传 | 普通/az 别名、n≤10、mask、strict 参数剥离、JPEG 压缩、回显归一、URL 清理、SSE、Batch、Seedream、CORS 自答 | 固定 SKU 继续原名进 new-api、不降级尺寸、n≤4 且拒流式；普通/az 型号完整接上游归一，az 在 JSON/multipart/chat 三路适配。JPEG 用上游压缩参数且保留 dev 转码失败 warning。固定 URL 先经尺寸守门，普通 URL 用上游转存；两类均剥元数据。CORS 接收上游自答、删除重复 OPTIONS；尾斜杠仍规范化。Batch 默认 503，worker 默认不启动 |
| `src/lib/seedance/kuaizi-adapter.ts`                | contentObj 类型格式与旧 VOD 注释                                                           | 同类型的格式变化、正确 TOS 注释，原生参数/响应/客户 key/错误行为                                          | 采用上游 TOS 语义；最终与 main 仅格式差异，运行逻辑逐字保留                                                                                                                                                                                                                                                               |

### 自动合并文件及不变量复核

- Enterprise proxy/reconcile/ark-format、image-adapter、seedream/minimax、upstream-error 的核心实现与 main 保持一致。cn-adapter/keys 仅原有注释或格式差异，global 2.5 价档、cn 480p、volc 客户 key 传递、过期/失败分类均保留。
- `src/lib/newapi/client.ts`、动态拓扑入口、系统 token 与 shadow meter 相对合并前 dev 未改；持久 token 回归仍断言 JWT → `/api/user/token` → 持久令牌，绝非 JWT 直接持久化。完整 CI 覆盖开户/Key/充值幂等及拓扑。
- Compose 与合并前 dev 完全一致：拒绝新增固定网段。vendor/stripe-node gitlink 不变；package.json/lockfile 不变；用户 `.env` 和未跟踪需求文档不提交。
- Nginx 主站新增 `/minimax-adapter/`、`/seedream-adapter/` 返回 404，API 白名单不变。部署时须先安装 Nginx 隔离再启新镜像。上游部署记录仅作历史材料；CLAUDE.md 改为本项目实际状态，不复制 server1/server2/ch214 已部署断言。
- Batch 的 HTTP release gate 位于统一路由分发前，关闭时不会解析/保存客户凭据；scheduler 的 release gate 在定时器创建前。默认 `PORTAL_BATCH_ENABLED=false`。原有实现和回归保留，不能将它误报为可用于生产收费的崩溃恢复机制。

### 测试适配逐项说明（没有反转上游修复回归）

1. 本项目原有 OPTIONS 测试从“调用 new-api 预检”改为“Portal 自答 204、回显 authorization/content-type、不 fetch”。原因是采用 #429 的入口契约；上游 #429 的缺省头、异常出口、流式等新增回归全部保留。与持久 token 事故不同，这不是将上游“必须调用”反向改成“不调用”：被替换的是 dev 原有实现，上游原始预检无头故障由其原样新增测试覆盖。
2. 上游新增图片 URL/Seedream 测试的图床域名断言从 images.silkroadai.io 改为 images.llmroute.club；仍检查转存、PNG 元数据、扩展字段与上传次数，未放宽行为断言。
3. dashboard 同意上游使用流式测试渲染器，保留本项目“热门模型”和“不展示 quota”断言。docs 旧错误标题与 4 条旧固定 SKU alias 用例的差异在本轮开始前已存在：dev 将固定 SKU 作为计费名，不能按上游旧别名覆盖；本轮没有删除新回归来掩盖冲突。
4. 额外新增默认 Batch 入口/worker 关闭回归，以及 az chat 变体映射、fixed SKU string stream 拒绝回归。首轮定向真实暴露固定 URL 转存抢先导致尺寸守门失效，已修代码而非改测试；原测试重跑通过。

### 高风险时序与 migration 验证

- 上游原样测试验证：TaskTypeConstraint/审核 4xx 落 failed 后后续轮询不打上游；429/5xx 保持在途状态、不误终态化；volc 对账按客户 key；缓存 TTL 到期、并发合流和失效；完成计费/失败不扣费；等待 vendor ID 早失败与超时；JPEG 字节/压缩、实际尺寸计费、mask 和流式参数后处理。
- PostgreSQL 16 临时容器（仅本机 127.0.0.1:55440、tmpfs、合成数据，无生产数据）：合并前 70 migration → 本轮新增 6 migration 全部通过，共 76 条；`migrate status` up to date；`migrate diff --from-config-datasource --to-schema` 为 No difference detected。
- Prisma 实写验证同名两组、ID 映射、请求日志 action/resource_id、batch bytea 原文；历史价格/档次行计数不变；启用档清空 channel 的非法写入被数据库约束拒绝。
- 空库历史基线重放的既有缺陷：历史 seed 创建启用空渠道，原有 `20260903090000_reconcile_catalog_tier_topology` 会按预期 fail closed。首次 PG18 预演暴露该问题；PG16 正式升级预演先应用前 69 条、用 Prisma 在隔离库构造合法拓扑，再应用原样第 70 条，最后验证本轮 6 条。未改旧 migration、未谎称空库无准备全链成功。这与生产已通过第 70 条的升级场景区分记录。
- 本地 Nginx 1.28 隔离容器使用临时自签证书运行 `nginx -t` 通过；没有接触生产证书或登录 VPS。

### 验证结果与分支状态

- 第一轮定向：1277 passed / 7 failed，失败为固定 URL 两例真实冲突 + 五例图床品牌断言；修复后代理/Batch 定向 540 passed；补充边界后代理 338 passed。
- 完整 `pnpm test`：3586 passed / 1 skipped / 1 failed。失败仅原有 `client.smoke.test.ts` models 列表期待 Array 却得 null。独立检查本机配置的 `http://127.0.0.1:3000/api/channel/models_enabled` 返回 HTTP 200 text/html，并非有效模型 JSON；未改 smoke、未改用户环境或开 VPS 隧道。health 返回 true 因此也不能当真实 new-api 链路验收证据。
- 首轮 test:ci：281 files / 3584 passed / 1 skipped；最后新增 2 边界回归后重跑结果见追加记录。Prisma validate、typecheck、lint 0 error、生产构建通过；lint 93 warnings。构建静态 pricing 因本地 DB 不可达出现 ECONNREFUSED 降级，构建本身成功，不代表 pricing 数据已验收。
- prod 保持 `02cbf26`，不 fast-forward，不部署。完整联机 smoke 未通过，因此本轮只完成 dev 集成；后续修正本机 new-api 验证目标后，验证通过再按约定 dev → prod fast-forward。

最终代码复验：`test:ci` 为 **281 files / 3586 passed / 1 skipped**；typecheck、lint（0 error / 93 warnings）与生产构建通过。上游所有新增回归案例保留，仅图床品牌断言按 LLmRoute 适配；两条补充代理边界测试通过。

### 提交后的修复 SHA 审计

合并提交为 `f555455`（父提交 `ce23083`、`1c94f20`）。逐个实际执行 `git diff <upstream-fix>..f555455 -- <affected-files>`，共 19 个 fix 提交；完整 diff 保存在本机 `/tmp/llmroute-sync-20260908/audit-*.diff`。上游后续提交对前序行为的替换按逐提交报告解释；最终与 main 的剩余差异逐文件审计如下。

| 修复提交  | 最终语义检查                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `40f521e` | 最终相对 main 差异限：`src/lib/seedance/cn-adapter.ts`、`src/lib/seedance/kuaizi-adapter.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。 |
| `3a3b652` | 最终与 main 相同；中间差异来自本轮后续上游提交，核心修复未覆盖。                                                                                |
| `acbb827` | 最终与 main 相同；中间差异来自本轮后续上游提交，核心修复未覆盖。                                                                                |
| `8fcbaa4` | 最终相对 main 差异限：`.env.example`、`src/lib/seedance/kuaizi-adapter.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。                   |
| `21ca10f` | 最终相对 main 差异限：`.env.example`、`src/lib/seedance/kuaizi-adapter.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。                   |
| `4c4ea9c` | 最终与 main 相同；中间差异来自本轮后续上游提交，核心修复未覆盖。                                                                                |
| `887a2c9` | 最终相对 main 差异限：`docker-compose.prod.yml`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。                                              |
| `fa19314` | 最终相对 main 差异限：`src/lib/enterprise/keys.ts`、`src/lib/seedance/kuaizi-adapter.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。     |
| `8f2f3b2` | 最终相对 main 差异限：`src/lib/seedance/kuaizi-adapter.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。                                   |
| `623712a` | 最终相对 main 差异限：`src/lib/seedance/kuaizi-adapter.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。                                   |
| `49f6fdc` | 最终与 main 相同；中间差异来自本轮后续上游提交，核心修复未覆盖。                                                                                |
| `9949729` | 最终相对 main 差异限：`src/lib/seedance/kuaizi-adapter.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。                                   |
| `69bb59c` | 最终相对 main 差异限：`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。  |
| `656deaa` | 最终相对 main 差异限：`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。  |
| `df10d5e` | 最终相对 main 差异限：`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。  |
| `dd3c6a9` | 最终相对 main 差异限：`src/app/v1/[...path]/route.ts`、`src/app/v1/__tests__/proxy.test.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。  |
| `d11f198` | 最终与 main 相同；中间差异来自本轮后续上游提交，核心修复未覆盖。                                                                                |
| `3634baa` | 最终与 main 相同；中间差异来自本轮后续上游提交，核心修复未覆盖。                                                                                |
| `2479875` | 最终相对 main 差异限：`src/lib/seedance/__tests__/cn-adapter.test.ts`；已按上文品牌/固定 SKU/UI/文档入口及格式语义复核。                        |

分支最终处置：只推送 origin/dev；main 为 `1c94f20`，prod/origin/prod 保持 `02cbf26`。联机 smoke 与真实生产验收仍未通过/未执行，不宣称可以发布。用户 `.env` 修改与未跟踪需求文档仍留在工作区。
