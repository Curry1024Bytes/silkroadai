# 上游同步报告：2026-10-25

## 合并前范围与结论

本报告在实际 main → dev 合并前输出。来源固定为 `upstream/main@48f914ba6b6bf2dbce3ca9f446d3a0fb5bc56e48`；2026-10-25 远端核对 origin/main 与 upstream/main 均仍为该版本。已集成上游基线 `9b857a4f`，本批55提交；开发基线 `84b5125e`，远端回退标签 `backup/pre-upstream-clean-20261025` 已核验且离线恢复通过。main 已fast-forward到该上游提交，验证此前main完全属于上游祖先，没有本项目自定义提交。

用户确认开始集成，采用上游模型广场并保留LLmRoute定制。具体业务取舍见 `docs/UPSTREAM-INTEGRATION-DECISIONS-2026-10-25.md`。55项逐提交行为如下；上游自己的部署/画质/付费记录均不冒充本项目验收。

当前 dev 与上游独有提交数量（dev / upstream）：`233	55`。预演有 33 个冲突文件。

## 逐提交变化（北京时间）

### #513 · f58c0bf7 · 2026-10-09 17:52:23

feat(seedance): service-inference.ai 提交路径对上游 500/502/503 单次退避重试 (#513)

- 新增 service-inference 提交遇500/502/503后单次退避重发，504及连接错不重试；重POST仍缺少幂等或明确未受理证明，本项目将默认关闭自动提交重试并保留显式配置与测试。

### #514 · 64e350c4 · 2026-10-09 18:35:40

feat(image-adapter): 接入 pixellelabs(尺寸白名单 + high→medium 上游替换、回显/计费仍按 high) (#514)

- 图片provider增加尺寸白名单及请求quality→上游quality映射；pixellelabs高档发medium但回显/usage按high。代码能力保留，不能据此开通高档收费渠道。

### #515 · 04ad1cd3 · 2026-10-10 08:00:41

feat(image-adapter25): 接入 qimg25 全量线(Firefly 中转:flare OpenAI 原生签名、sunburst Adobe 签名) (#515)

- 新增qimg25两模型provider及错误品牌清理；使用本地usage合成，远程返图仍经下载路径处理，渠道未自动配置。

### #516 · fdc5f7dd · 2026-10-10 12:20:11

feat(image-adapter25): 接入 yobox25 全量线(max.yoboxai.com,同后端元数点/synoralink,flare+sunburst 全 OpenAI 签名) (#516)

- 新增yobox25两模型与五档透传、错误清理；仅provider注册及测试，未新增数据库或本项目渠道。

### #517 · 1a86dcca · 2026-10-10 12:20:15

feat(image-adapter): 接入 yobox 全量线(max.yoboxai.com,真 OpenAI API 直通 2.0,三档真、auto=官方缺省尺寸) (#517)

- 新增yobox图片2.0全档provider；拒绝透明请求、auto按实际返图计算，保留原统一适配器校验。

### #518 · 2d4e65ca · 2026-10-11 08:10:08

feat(image-adapter): 接入 qimg 2.0 low/medium 守门线(qimg.cc Adobe Firefly 中转,high 网关静默降 medium) (#518)

- 新增qimg图片2.0 provider，最初只允许low/medium并对high让路，透明请求不转发；后被#525放宽。

### #519 · fb7f58a1 · 2026-10-12 12:29:54

fix(image-adapter25): n>1 对非原生 n 上游并发扇出单图请求(修「n 最多 3」) (#519)

- Image2.5增加nativeN策略；其他provider对n张并发发n次单图，补齐轮也并发，usage按交付数；终态错误与全失败需验证不造成重复生成/结算。

### #520 · bdbed9cf · 2026-10-13 12:18:08

feat(image-adapter): 接入 frimodel 第五账号 low/medium 守门线 frimodeladobe2(真 OpenAI 字节经 Firefly S3,$0.054/张) (#520)

- 新增frimodeladobe2并映射上游模型名；最初只允许low/medium，下载URL转base64、透明拒绝及错误清理沿用已有流程。

### #521 · 057a2598 · 2026-10-14 12:34:10

feat(newapi): rc.41+ 具名 PAT 兼容 —— 开户第 3 步按版本分流 + 存量 legacy token 迁移脚本 (#521)

- 开户按new-api版本选择legacy持久token或具名PAT；增加密码proof、最小Key scope及存量迁移脚本；本项目合并时须保留已有legacy SECURITY_PROOF_REQUIRED流程。

### #523 · 304ef61e · 2026-10-14 14:55:23

fix(enterprise): 海外版(BytePlus 形)查询回显不再出 framespersecond=0 等占位值 (#523)

- Enterprise海外查询输出不再填framespersecond=0等占位值，按实际元数据/接口规则构造回显。

### #524 · 16e04682 · 2026-10-14 16:15:35

fix(enterprise): conformance 第二轮 —— 末帧透出 + service_tier/priority 同步 400 + 基本校验先于版本门 + region 文案 (#524)

- 补末帧回显；service_tier/priority非法值返回400，基本参数校验提前于版本门，并调整region提示。

### #525 · 57219d0a · 2026-10-15 08:22:27

feat(image-adapter): qimg 2.0 线放全量(onlyQualities low/medium → openAllTiers) (#525)

- qimg2.0从low/medium白名单改为全档透传；保留透明限制。原高档拒绝测试随产品策略改变，上游的供应商实测不等于本项目验收。

### #522 · 1649f1c9 · 2026-10-15 08:24:34

fix(newapi): rc.44 预演修正 —— admin 校验 scope 真名 admin.user.update + PUT 用户剔 admin_permissions + 真机 smoke (#522)

- 修正admin验证scope为admin.user.update，重置密码前移除服务端管理字段，新增联机smoke；维护操作不自动执行。

### #526 · 2b407e50 · 2026-10-15 12:30:18

feat(image-adapter25): 接入 suduma25 异步任务线(submit + poll 分支,quality 全量) (#526)

- 新增suduma25异步提交/轮询transport；参考图和mask转dataURL，图床附UA，轮询错误/超时归一；沿用多图与usage处理。

### #527 · 88ce2342 · 2026-10-15 12:30:30

feat(image-adapter): 接入 suduma 2.0 异步任务线(submit + poll 分支;表内尺寸;low→medium 映射;假透明拒) (#527)

- 新增suduma2.0异步transport与尺寸白名单、low→medium映射、透明拒绝；不改变其他provider同步路径。

### #528 · 12ac6182 · 2026-10-15 13:38:06

feat(enterprise): 海外版 proMax 上游换 service-inference.ai dreamina-sd-max + 重开 480p + svcinf 任务记 v1/v2 版本 (#528)

- proMax引入service-inference线路、480p及提交API版本记录；新增volc_id_map.api_version以保证切版本后旧任务查询，最终线路选择还受#563覆盖。

### #529 · edb64282 · 2026-10-15 13:54:11

docs(progress): #528 proMax svcinf 部署 + 真金 smoke 实录 (#529)

- 记录#528在上游环境的部署和付费测试；仅文档，不能将其中账号、部署、验收视为本项目事实。

### #531 · b71d900a · 2026-10-15 21:56:10

feat(image-adapter25): 接入 ztyunjuan25 全量线(qimg 同后端族第二账号池;flare OpenAI 签名、sunburst Adobe 签名) (#531)

- 新增ztyunjuan25两模型五档provider及返图/错误清理测试；不自动配置本项目渠道。

### #530 · f8d24233 · 2026-10-15 21:56:24

feat(image-adapter): 接入 ztyunjuan 2.0 全量线(qimg 同后端族第二账号池,Adobe 签名三档真) (#530)

- 新增ztyunjuan2.0全档provider、透明限制和错误清理；quality映射随后被#549调整。

### #532 · 4304494d · 2026-10-16 09:11:36

feat(image-adapter): 接入 junzehigh 全量线(钧泽 gpt-image-high SKU,10k pool 网关,upstreamModel 映射) (#532)

- 新增junzehigh并将客户gpt-image-2映射到供应商gpt-image-high，沿用尺寸/透明和usage规则。

### #533 · fabe504f · 2026-10-16 14:18:18

feat(image-adapter): 接入 llmway 2.0 全量线(Firefly medium 档上游,low/high→medium 替换,回显按请求档) (#533)

- 新增llmway2.0，将low/high均映射为medium，客户回显与合成usage仍按请求档；此经营取舍不能作为本项目高档交付验收。

### #534 · ea688f31 · 2026-10-17 09:10:41

feat(pay): 充值档位加 ¥5000/¥10000 + 限额上调 + 下架首充 20% bonus (#534)

- 充值UI增加5000/10000档，默认单笔/日累计限额提升并关闭首充赠送；本项目保留当前充值/赠送默认值，兼容能力与经营决策分开。

### #535 · 8784e522 · 2026-10-17 09:39:03

chore(newapi): legacy token 迁移脚本 dry-run 免凭据 + --apply 终端交互输 root 密码;runbook 补 PAT 换 token 实操 (#535)

- legacy迁移脚本dry-run不要求root凭据，apply改终端交互输入密码并补PAT操作文档；不自动执行密码重置或凭据迁移。

### #536 · 729aed5e · 2026-10-17 15:28:33

feat(enterprise): 海外版 global 上游换 service-inference.ai dreamina-sd-max(独立 key)+ 开放 global 480p (#536)

- global新增独立service-inference凭据和模型覆盖，支持该线路480p；本项目保留现有渠道默认行为，显式配置后才选择新协议能力。

### #537 · cc39689e · 2026-10-17 15:40:29

docs(progress): #536 global svcinf 部署 + 真金 smoke 实录 (#537)

- 记录#536上游部署与付费验证；无运行时代码，不代表LLmRoute已切换global线路。

### #538 · 7389e72e · 2026-10-18 07:43:12

feat(image-adapter): 接入 luckfill 2.0 全量线(Firefly 转售真 OpenAI 字节,只渲染 medium;low/high→medium 替换) (#538)

- 新增luckfill2.0，low/high发medium并按请求档回显，451审核类错误归终态；渠道与画质仍待本项目独立验收。

### #539 · 11f2b9c4 · 2026-10-18 23:24:50

feat(image-adapter25): 接入 sudumagzs25 同步线(-gzs 变体;modelMap 上游模型名映射 + 同步路径图床 UA) (#539)

- Image2.5增加modelMap及同步返图额外headers；sudumagzs25映射-gzs模型与图床UA，其他provider默认保持。

### #540 · 0f5b3a80 · 2026-10-18 23:25:04

feat(image-adapter): 接入 sudumagzs 同步 2.0 线(gpt-image-2-gzs 变体;upstreamModel 映射 + 图床 UA + 表内尺寸 + low→medium) (#540)

- 图片2.0新增sudumagzs同步线、尺寸白名单、low→medium及图床UA，支持300s上游超时。

### #541 · aeff12f1 · 2026-10-18 23:50:52

feat(image-adapter25): sizes 白名单(provider 级)+ sudumagzs25 启用 5 个如实尺寸 (#541)

- Image2.5增加provider尺寸白名单，sudumagzs25仅接受列出的显式尺寸；auto保持透传，表外503不调用供应商。

### #542 · 074ff555 · 2026-10-19 00:05:48

feat(image-adapter): 接入 monkeycoding 2.0 全量线 + 2.5 三档线(api.monkeycoding.club) (#542)

- 新增monkeycoding2.0/2.5注册、错误清理和n扇出覆盖；2.5最初限制三档，随后#543放开；上游画质声明不当作本项目验收。

### #543 · d0087ba4 · 2026-10-19 00:41:49

feat(image-adapter25): monkeycoding25 改全量线(5 档全收,去掉 qualities 三档白名单) (#543)

- monkeycoding25移除quality三档限制，五档都可转发；这一放宽属于上游策略变化，启用前仍需真实交付审核。

### #544 · a1d7d5e5 · 2026-10-19 00:59:47

fix(image-adapter): monkeycoding / monkeycoding25 上游改走裸 IP 47.251.171.153(域名限速) (#544)

- monkeycoding两provider的目标改为固定IP以绕开其域名限速；需审查HTTPS/错误清理及部署可达性，不自动创建渠道。

### #545 · e875532f · 2026-10-19 15:56:07

feat(enterprise): 下架 global fast/mini 1080p(artsmcp key 失效)+ 海外线 2.0 pro/fast 带 tools 提交即 400 (#545)

- 上游因自己的key状态移除global fast/mini1080p，并提前拒绝部分海外2.0 tools；本项目不直接删除现有可用规格，应按实际选定transport校验。

### #546 · 239ec1a2 · 2026-10-19 16:15:59

feat(enterprise): 对账定时 sweep + 后台详情触发对账 + 任务终态回调投递(callback_url) (#546)

- 增加Enterprise定时对账、后台触发及终态回调；新增callback五列。需审查幂等补扣、崩溃恢复、回调SSRF/DNS、终态与重试边界。

### #547 · 7463d74b · 2026-10-19 16:45:33

docs(progress): #546 对账 sweep + 回调投递 部署与真金 smoke 实录 (#547)

- 记录#546上游部署与回调验证；仅文档，不证明本项目回调安全或当前生产已启用。

### #548 · cdf01a6c · 2026-10-20 08:34:14

feat(proxy): gpt-image 伪流式 partial_image 改为开流即发「生成中」占位帧 (#548)

- 图片伪流式在生成开始发占位partial_image，完成后才发真图；不把占位帧计入实际交付/usage，固定SKU原禁流逻辑保留。

### #549 · 84ebc6bc · 2026-10-20 08:43:06

feat(image-adapter): ztyunjuan 2.0 全量改 low/high→medium 上游替换 (#549)

- ztyunjuan2.0改low/high→medium映射，回显及合成usage仍按请求档；不能将上游经营决定直接用于本项目收费宣传。

### #550 · 0c06623c · 2026-10-20 08:55:28

feat(proxy): 伪流式占位帧改成动图(APNG / 动态 WebP),静态图客户会以为卡死 (#550)

- 占位图改APNG/动态WebP，增加生成与缓存模块；验证格式、时序、内存、取消与完成事件不混淆。

### #551 · cce8fd8e · 2026-10-20 09:09:02

docs: /docs 第 13 章补 gpt-image 流式返回(stream + partial_images 占位动图)说明 (#551)

- 公开文档增加stream/partial_images占位动图说明；本项目迁入LLmRoute docs-content，不覆盖自有页面与域名。

### #552 · c7112a63 · 2026-10-20 09:25:22

fix(deploy): 滚动部署排空(stop_grace 630s + 排空期 Connection: close)+ monkeycoding 审核拒终态化 (#552)

- 增加stop_grace_period=630s及SIGTERM响应Connection:close排空钩子；另将monkeycoding审核拒绝归终态。按本项目Nginx单实例拓扑适配，不照搬副本配置。

### #553 · 355fbc94 · 2026-10-20 11:05:50

docs(claude): gotcha #22 按 2026-10-20 实测修正 —— 排空四件套(docker-proxy / least_conn 钉死副本 / Caddy 主动探测)+ 部署结果 (#553)

- 补充上游docker-proxy/least_conn/Caddy排空运维记录；仅记录适用原理，不替换当前权威运维手册。

### #554 · 0ff135a8 · 2026-10-21 13:37:01

fix(seedance): 参考音频门控对齐火山官方 —— 配参考视频即可,不再强制要图 (#554)

- Seedance参考音频门控允许有参考视频时不再强制额外参考图；保留其他数量/格式及模型约束。

### #555 · fb4a368e · 2026-10-21 14:03:00

docs(claude): 记录 #554 seedance 参考音频门控修复 + 真金 smoke 结果 (#555)

- 记录#554上游修复与付费测试；仅文档，无本项目收费验收。

### #556 · cbae6702 · 2026-10-22 08:43:08

chore(gpu): 下线主站 GPU 租赁页 — 删 /gpu 路由 + 侧栏/首页入口 + sitemap/robots (#556)

- 删除GPU页、组件、导航、robots/sitemap与测试；本项目尚未安排下架该产品范围，保留现有页面及相关回归。

### #557 · 02e6ac83 · 2026-10-22 09:28:44

feat(dashboard): 汇总卡大数字紧凑显示 — 万 / K·M·B 主显 + 精确值退副行 (#557)

- 仪表盘大数增加万/K/M/B紧凑表示，并保留精确值副行；适配LLmRoute现有布局、人民币单位与金额精度。

### #558 · 3a2b21b7 · 2026-10-22 10:59:11

feat(models): /models 整页替换为 vendored new-api 模型广场 + portal 改 AGPL-3.0 (#558)

- 引入vendored new-api模型广场及依赖，替换/models并更改许可证；采用组件交互，目录与完整报价经Portal适配，两入口共用，保留来源/版权说明。

### #559 · 2a889c62 · 2026-10-22 22:44:52

feat(keys): API Key 可设额度上限与到期时间(同步 new-api token 配额 / 过期) (#559)

- Key增加额度和到期UI/API，GET全量token后合并PUT；本项目保留到期与别名/协调保护，有限额度默认关闭，token无限政策保持。

### #560 · f9009e12 · 2026-10-23 09:00:21

fix(enterprise): 样片出正片(draft_task)放行海外 global / proMax 2.5 线 + 修 CI Type Check 红 (#560)

- 海外global/proMax2.5放行draft_task样片转正片，并修类型检查；验证客户任务归属、旧任务和终态保护。

### #561 · 45f3966a · 2026-10-23 09:12:24

feat(proxy): 裸名按量 gemini-3-pro-image / gemini-3.1-flash-image 接入 + Gemini 生图 chat stream:true 回 SSE (#561)

- 裸名Gemini图像模型接入已有图片兼容分支，chat stream:true返回OpenAI形SSE；实际请求仍通过new-api，保留固定SKU和计费语义。

### #563 · 67414739 · 2026-10-23 09:23:33

feat(enterprise): 海外版 proMax 换回 artsmcp intl 上游(新 key 写客户行)+ 关闭 proMax 480p + tools 快失败只留 global (#563)

- proMax恢复artsmcp intl路径、关闭该路径480p，tools快失败收窄global；保持存量service-inference任务可按原版本查询。

### #564 · bae3ff75 · 2026-10-23 09:42:39

feat(gemini-adapter): Gemini 按量生图上游适配器 — usageMetadata 重写成官方 token 常数(首个上游 yobox) (#564)

- 新增内部Gemini adapter，改写图片usage token并将单次JSON包装SSE；新增路径需公网隔离，计量表及不确定输入需审查，默认不启用未验收收费适配器。

### #565 · 42c65c35 · 2026-10-23 10:02:35

docs(progress): #563 proMax 换回 artsmcp 部署 + key 写入 + 真金 smoke 实录 (#565)

- 记录#563上游客户key写入及付费验收；不迁入真实凭据，不据此改本项目客户行。

### #566 · 74a4bee6 · 2026-10-23 10:19:48

feat(pricing): 客户专属倍率读路径 — /keys /pricing /models 按 GroupGroupRatio 显示有效倍率 (#566)

- 新增客户有效分组倍率读取并接入keys/pricing/models，代理按用户缓存；本项目保留客户价失败关闭、完整媒体价格与刷新生效，避免匿名降级及重复倍率计算。

### #567 · 085c0968 · 2026-10-23 15:44:26

feat(seedream): 接入 Seedream 5.0 Flash + Pro 像素阈值跟进上游 le_261w (#567)

- 新增Seedream5 Flash并调整Pro像素阈值及相关usage；新增型号只继承能力，不自动上架/改价，需检查既有规格和计费兼容。

### #568 · 48f914ba · 2026-10-23 16:11:16

feat(gemini-adapter): 官方表补 gemini-3.1-flash-lite-image(1K 1120 单档) (#568)

- Gemini adapter补3.1-flash-lite-image单档输出token表；仍受未启用适配器及计量核验边界约束。

## 数据库、环境、依赖与发布影响

- 新增两条forward migration：`20261015120000_volc_id_map_api_version` 给volc_id_map加可空api_version；`20261019120000_seedance_task_callback` 给seedance_video_tasks加callback_url/format/status/sent_at/error五个可空列。无删除/回填。须在隔离PostgreSQL预演，再先迁移后切换应用；检查现有schema及migration checksum。
- 环境模板新增NEWAPI_ACCESS_TOKEN_MODE、SEEDANCE_SVCINF_PROMAX__、SEEDANCE_SVCINF_GLOBAL__、SEEDANCE_SVCINF_SUBMIT_RETRY_MS。保留LLmRoute域名及现有配置；不把占位key写入生产，不自动执行密码迁移。新增有限Key额度与未验收Gemini适配器采用明确默认关闭入口；最终开关名称及默认值在合并后审计补充。
- #534改变充值默认限额及赠送，涉及经营规则；本轮保留本项目默认策略，不随上游改价或下架赠送。
- #558引入UI、图表、查询、国际化等依赖，并提升lucide-react。保留本地Prisma双client生成、MariaDB只读依赖和既有脚本；按合并后的package重新生成锁文件，验证构建、运行产物与客户端体积。许可证、原MIT来源和vendored文件版权信息一并保留，并记录Portal代码来源变化；不修改new-api后端源码。
- Compose只吸收适用的排空时限，保留api-replicas/seedance profile及当前端口、日志卷、网络。Nginx增加gemini-adapter内部路径隔离；Cloudflare不计划改动。上游Caddy/多副本说明不作为当前服务器事实。
- #546回调和sweep涉及网络访问与补扣，审查DNS/重定向/私网防护、终态CAS、崩溃恢复和并发幂等；不把编译成功当计费正确。
- 图片provider包含请求quality与交付quality不一致、原始IP目标和远程下载差异，代码存在不等于已配置渠道。既有Image2.5/Batch开关保持，不进行收费模型请求。
- UI广场直接透传new-api价格会绕过Portal展示过滤，且最低倍率、汇率/充值折算、缺价兜底和缓存语义不同；采用上游界面并用现有服务端目录/报价适配，保留明确分组、完整计费条件、客户身份隔离及失败关闭。
- 发布仍以 `deploy/部署与运维手册.md` 的新服务器/Nginx/双PostgreSQL环境为准，旧AGENTS历史MySQL/VPS快照不用于当前操作。线上Portal镜像与独立视频维护程序需分别核验/备份。未经验证不推进prod。

## 预判冲突文件

- `.env.example`
- `CLAUDE.md`
- `package.json`
- `pnpm-lock.yaml`
- `src/__tests__/app/dashboard-page.test.tsx`
- `src/__tests__/app/gpu-page.test.tsx`
- `src/__tests__/app/models-page.test.tsx`
- `src/__tests__/app/portal-keys/keys-list-ui.test.tsx`
- `src/__tests__/app/sitemap.test.ts`
- `src/__tests__/instrumentation.test.ts`
- `src/__tests__/lib/server-only-guards.test.ts`
- `src/app/(authenticated)/dashboard/page.tsx`
- `src/app/(authenticated)/keys/keys-list.tsx`
- `src/app/(authenticated)/keys/page.tsx`
- `src/app/(authenticated)/sidebar.tsx`
- `src/app/api/portal/keys/route.ts`
- `src/app/docs/page.tsx`
- `src/app/gpu/page.tsx`
- `src/app/models/models-browser.tsx`
- `src/app/models/page.tsx`
- `src/app/pricing/page.tsx`
- `src/app/v1/[...path]/route.ts`
- `src/components/gpu/PricingCard.tsx`
- `src/components/gpu/ServiceFlow.tsx`
- `src/data/gpu-pricing.ts`
- `src/i18n/gpu-page.ts`
- `src/instrumentation.ts`
- `src/lib/enterprise/__tests__/proxy.test.ts`
- `src/lib/enterprise/proxy.ts`
- `src/lib/enterprise/reconcile.ts`
- `src/lib/enterprise/volc-id-map.ts`
- `src/lib/newapi/__tests__/provision-login-session.test.ts`
- `src/lib/newapi/client.ts`

主要语义：newapi/client合并PAT与本地安全proof及token更新协调；models改用广场但保留目录/价格；pricing保留本地复杂报价；公共v1代理保留固定图片SKU、异步图片和视频缓存交付；Enterprise保留终态与本地日志；instrumentation保留私有日志清理；GPU页保留；配置与文档保留LLmRoute当前部署事实。不能整文件使用ours/theirs代替业务审计。

## 验证计划与合并后记录

合并前跑现有完整非smoke测试记录基线。合并后保留上游新增回归，针对授权过期/重试、安全proof、Key更新协调、计费终态、回调失败、并发、价格身份与缓存等运行真实失败场景测试。执行typecheck、lint、完整测试、Prisma验证和生产构建；对所有修复提交使用 `git diff <fix>..<merge-result> -- <affected-files>` 核查核心行为。生产只读验证不替代代码测试，收费调用未获授权。

以下合并后三方审计、具体测试调整和验证结果待实施完成后填写；当前没有宣称合并或上线成功。

合并前基线：`pnpm test:ci` 为 360 files / 5725 passed / 1 skipped，无失败；日志 `/tmp/llmroute-baseline-20261025.log`。

媒体追加风险：保留本地事务创建任务映射和碰撞拒绝，不退回best-effort upsert；回调按提交时保存的格式发送，且必须重读数据库确认真实终态。新自动对账默认关闭，避免未经确认扩大补扣范围。回调即使默认关闭也须补齐可启用路径的网络与终态保护。

## 合并后审计与本地验收（发布前）

### 根代理：公共代理、配置、界面与产品策略

基线：dev459edd00（应用84b5125e），共同祖先9b857a4f，上游48f914ba。

- `.env.example`：两侧都保留：镜像分组、人民币换算和LLmRoute域名来自dev；PAT/SVCINF新增配置来自上游。充值默认保持原值，新增能力默认关闭，重发默认0；未修改真实.env。
- `CLAUDE.md`：保留dev本项目上下文，新增本轮报告索引；不采用上游部署/客户密钥/收费验收作为本项目事实。上游技术行为逐项进入同步报告。
- `package.json`：保留llmroute名称、Prisma双client脚本及本地MariaDB依赖；接入模型广场18项新增直接依赖及既有lucide版本更新、上游许可证声明和来源文件。
- `pnpm-lock.yaml`：按合并manifest使用项目指定corepack pnpm10.30.3和官方registry生成；本地镜像源缺@visactor/react-vchart2.2，未降级或改本机registry设置。安装禁用脚本，Prisma单独生成。
- `src/__tests__/app/dashboard-page.test.tsx`：保留两侧数字/布局回归；新增大数场景接到本地PortalBalance/PortalUsageStats。仅USD副行断言改为不显示，继续保留本地人民币单币展示；大数精确值、万/K/M/B与不溢出断言保留。
- `src/__tests__/app/gpu-page.test.tsx`：上游删除，保留dev整套GPU产品测试；本轮没有下架该产品决策。
- `src/__tests__/app/sitemap.test.ts`：保留dev GPU路由契约，放弃上游下架GPU后删除该URL的策略断言。没有删除其他路由校验。
- `src/__tests__/instrumentation.test.ts`：合并私有日志清理与drain安装断言；补mock新的对账scheduler和既有价格scheduler，避免测试导入真实数据库调度；所有原运行时/profile禁用断言保留。
- `src/__tests__/lib/server-only-guards.test.ts`：并集保留user-tier-multiplier与上游token-meta/effective-group-ratios服务端边界；保留客户端导入扫描。
- `src/app/(authenticated)/dashboard/page.tsx`：保留dev账户概览栅格与Portal专用组件；将上游数字格式能力接进这些实际使用的组件，未用上游旧五卡壳覆盖布局。
- `src/app/(authenticated)/sidebar.tsx`：保留dev导航和GPU入口，模型入口进入新的共享广场。上游本文件仅删除GPU，不采用此产品下架。
- `src/app/docs/page.tsx`：保留LLmRoute docs-content外壳及工作台共用入口；将#551流式说明和示例迁入docs-content，保留新增3项文档回归；注明固定SKU不支持stream和占位图不是真实生成。
- `src/app/gpu/page.tsx`：上游删除，保留dev公开GPU页面与品牌；本轮未安排产品下架。
- `src/app/pricing/page.tsx`：保留dev完整结构化人民币/专属倍率/历史过滤逻辑；加入#566专属标识，不叠加第二次倍率计算或60秒报价缓存。会话读取异常也失败关闭。上游新增3个价格场景保留，fixture改接当前授权报价来源。
- `src/app/v1/[...path]/route.ts`：冲突为import，两侧必要import均保留。其余自动合并后逐段比对：保留固定SKU原名/尺寸/禁流/计费、异步任务、私有日志与视频缓存交付；接入裸名Gemini和Images流式占位。额外修复慢SSE错误帧及占位资源边界。
- `src/components/gpu/PricingCard.tsx`：上游删除，保留dev GPU产品卡片。
- `src/components/gpu/ServiceFlow.tsx`：上游删除，保留dev GPU交付流程组件。
- `src/data/gpu-pricing.ts`：上游删除，保留dev GPU数据，未随同步改变产品价格。
- `src/i18n/gpu-page.ts`：上游删除，保留dev GPU多语言文本。
- `src/instrumentation.ts`：并存dev私有请求日志清理/DEV_PROXY_URL与上游drain/新scheduler能力；新自动对账在自身严格默认关闭门内，不自动补扣；Node http载入显式限nodejs避免Edge产物警告。

### 无文本冲突的策略保留

- #534保留充值限额、支付渠道默认限额、金额档位、首充/邀请码赠送和相关落地页文案。上游新增首充开关能力保留但默认true，原关闭开关的零赠送/不claim回归通过显式mock false保留，未反向改原断言。GPU相关robots/sitemap/landing/reseller导航同步保留。
- 新Gemini内部入口仅PORTAL_GEMINI_ADAPTER_ENABLED精确true启用；关闭时在读body及调用供应商前503。Nginx主站新增gemini-adapter的404隔离，API-only规则仍覆盖非白名单入口；无Cloudflare修改。入口开关及坏path新增6项回归。
- Compose保持原网络/profile/私有日志卷和单Portal发布；实际portal与API anchor增加630秒停机余量。drain显式Connection头可覆盖close的问题已用真实HTTP server复现，修复对象/原始数组及statusMessage重载，加4项回归。
- 两个新增nullable migration保持上游内容；本地PostgreSQL16用合并前Prisma schema建库、执行两条增量SQL，现存queued/completed、billed、token/cost和映射3行逐字段一致，新增列NULL与读写通过，迁移后与新schema零diff。这不是完整历史迁移重放或生产快照恢复。
- 额外真实HTTP用合成隔离库验证匿名/A/B并发报价、0倍率、改价刷新、坏专属归属503且不影响其他用户、工作台鉴权入口200。浏览器实际构建产物验证搜索/分组/卡片表格/视频完整报价与跨午夜规则，390px宽无横向溢出；这些是合成数据，不是线上模型价格验收。
- 本轮未改SDK机器模型目录、实际模型路由、渠道key、生产价格或new-api后端源码；未执行收费调用。

### 当前外部验证限制

生产SSH使用配置的llmroute-prod目标和llmroute_ed25519密钥，服务器103.240.199.146拒绝publickey；无既有control socket。实际配置的本机new-api smoke地址是127.0.0.1:13000，状态前置检查不通过，不能伪造mock冒充真实服务验收。已向用户请求恢复访问，本地继续验证；当时未推进生产与prod；后续恢复及最终结果见本文末节。

### 授权与Key

对比基线：合并前 dev `459edd00`（已备份应用 `84b5125e`）、上游固定 `48f914ba`（本轮上游基线 `9b857a4f`），最终为当前暂存合并结果。仅本地集成；没有运行凭据迁移、PAT live smoke、生产写入或部署。

### 上游行为与影响

- #521 `057a2598`（2026-10-14 12:34:10 +08:00）：新开户按 NEWAPI_ACCESS_TOKEN_MODE=auto/legacy/pat 或状态版本选择 legacy rotate / named PAT；PAT持久凭据由password proof后创建，最小scope维持api_key:read/reveal/write。存量脚本可显式重置new-api客户密码并CAS更新Portal凭据。无schema migration；不自动调用该脚本。
- #522 `1649f1c9`（2026-10-15 08:24:34 +08:00）：管理员proof scope采用admin.user.update；PUT回写剔除admin_permissions、DeletedAt、original_password、verification_code，保留上游故障修复。live smoke会创建用户和重置密码，未运行。
- #535 `8784e522`（2026-10-17 09:39:03 +08:00）：dry-run免root凭据，--apply才交互读取密码。保留；另外拒绝未知服务版本/无效--limit/空--user、状态请求加期限与拒绝重定向，错误日志不打印错误对象payload。
- #559 `2a889c62`（2026-10-22 22:44:52 +08:00）：Key到期时间/额度由new-api作为唯一数据源，不新增数据库列。本项目接入到期；有限Key额度仅在PORTAL_KEY_QUOTA_LIMITS_ENABLED精确等于true时开放，默认UI隐藏且API拒绝有限额度，默认Key仍unlimited_quota=true。null可保留/恢复无限语义。
- #566 `74a4bee6`（2026-10-23 10:19:48 +08:00）：新增客户身份self/groups有效倍率读取。保留上游兼容函数及原4项测试；实际/keys使用新增严格入口，不回匿名/全局客户价、不取stale、不把客户响应缺失组补全局。pricing页由根代理保留本地结构化/个人倍率管线。

### 冲突逐文件语义选择

- src/lib/newapi/client.ts：保留本地管理请求明确成功校验、无凭据匿名读、价格读取、动态分组、客户Key协调超时、退役严格读/删及既有完整token更新。叠加PAT版本选择、具名PAT创建、管理员显式迁移、有效倍率读。登录session JWT统一以Bearer发送；持久opaque/PAT仍裸Authorization。所有call默认manual重定向，原显式error策略继续覆盖；短效JWT永不持久化。
    - legacy分支采用本地SECURITY_PROOF_REQUIRED精确403挑战流程：methods策略核验→一次密码proof→一次rotate；保留过期proof、错误scope、非挑战错误及不确定网络失败拒绝重试。
    - upstream同名updateTokenForCustomer(tokenId,patch)与本地updateTokenForCustomer(fullToken,timeout)采用重载，前者GET完整记录并验证owner/id/schema后全量PUT，后者维持分组迁移的已验证token/timeout及不回写key逻辑。上游4项原回归的断言保留，新增坏元数据不得PUT回归。
    - #522核心scope及敏感echo剔除原样接入；密码提交失败抛出的错误不保留可能回显密码的payload。最小PAT scope未扩大。
- src/lib/newapi/**tests**/provision-login-session.test.ts：采用完整上游新版测试；只给开户调用补本项目必需的显式newapi_group。预合并本地suite另存provision-legacy-regression.test.ts保留，避免选上游而丢本地场景。
- src/app/api/portal/keys/route.ts：以本地动态tenant/allowed_tier_keys/默认组校验及完整withCustomerKeyMutation创建-落库-失败补偿生命周期为基础，叠加上游到期与可选额度参数/返回字段。无pool/default隐式回退，不移除退役锁及超时检查。有限额度开关在任何创建前拒绝。
- src/app/(authenticated)/keys/page.tsx：保留本地用户隔离、token掩码、用量计算、拓扑失败禁创建、tenant/allowed_tier_keys。接入完整分页token元数据和严格客户有效倍率；倍率失败只隐藏价格徽章，不把挂牌价冒充客户价。server将额度开关显式传客户端。
- src/app/(authenticated)/keys/keys-list.tsx：保留LLmRoute响应式桌面/移动布局、别名编辑、遮罩/自动隐藏、复制/撤销、无可用档次禁创建与不猜pool。叠加上游到期控件/元数据和专属倍率徽章。共用单个调整表单；有限额度开关默认false；关闭时续期PATCH不携带quotaCny，避免改动现存额度。
- src/**tests**/app/portal-keys/keys-list-ui.test.tsx：合并本地选档/布局/别名回归与全部上游额度/到期/专属徽章场景；上游QuotaExpiryFields两项能力测试显式传quotaLimitsEnabled，不改变其名称/核心断言；新增默认关闭仍显示到期控件的回归。

### 无文本冲突但必须审查的伴随修改

- PATCH keys/[id]采用上游到期/额度/组合别名更新，保留原IDOR、撤销状态及new-api先于数据库写入顺序。新增到期/额度分支按当前tenant及allowed_tier_keys再核验分组，使用既有withCustomerKeyMutation协调锁避免和分组迁移/退役抢写；别名-only保留原路径。
- quota-expiry纯函数及原测试保留；请求schema单独放lib/keys/request-schema.ts，避免从Next route导出不受支持的自定义schema。expiresAt必须为带时区的未来ISO绝对时间。
- token-meta上游假定每用户最多10Key、单页100；本地已取消Key数量限制，因此改为分页完整读取，owner/id重复/总数变化/坏元数据全部返回不可用，避免误标无限或永不。无Key秘密落日志。
- scripts/migrate-newapi-legacy-access-tokens.ts仍仅手工执行；没有从仪表盘、scheduler、startup调用。
- live smoke增加NEWAPI_LIVE_ALLOW_MUTATIONS=true和NEWAPI_LIVE_CUSTOMER_GROUP，连同已有root密码三个显式条件才可运行；本轮不运行。目标scoped PAT是否允许本地退役/user/self和有效倍率/self/groups仍需隔离实际版本验收，不能由mock通过推定；未用admin绕过客户授权。

### 测试差异单列

1. PAT上游开户测试补newapi_group，理由为本项目显式分组契约；仍验证rotate必须调用、PAT必须创建、cookie/JWT认证及scope，未反向改断言。
2. 保留的本地legacy/security-proof测试显式pin legacy隔离模式，JWT头预期由裸JWT变为Bearer；redirect预期由error变为manual（两者均不跟随，manual用于上游NoRoute探测）。不减少调用次数与失败分支断言。
3. 上游有限额度POST/PATCH能力suite显式打开默认关闭开关、原成功/IDOR/失败写入断言保留；另增加关闭时UI与API拒绝有限额度但允许无限Key续期回归。
4. 上游宽松有效倍率fallback4项测试未修改；实际严格入口新增独立8项回归覆盖缺组、不复用stale、无身份、坏挂牌价、零倍率及不同凭据/客户。
5. token-meta分页/owner/错误/时区换算新增7项；Key更新不完整/串owner元数据新增4项；退役锁阻止续期及白名单阻止新增回归。

### 验证

- 第一轮授权4文件56 passed；第一次Keys能力检查暴露开关默认关闭与上游显式能力fixture预期差异，按上述第3项显式opt-in保留原断言，并新增关闭策略测试。
- 第二轮Keys/授权/客户倍率/退役定向17文件344 passed；后续补充token PUT元数据验证后需以最终重跑输出为准。
- 已修改运行代码的独立ESLint为0 error/0 warning（最终新增schema/metadata检查后再核对）。全仓typecheck、完整测试、构建由根代理统筹；本地尚未声称生产验收。

### 最后补充

- Key续期时序审查曾加入回读后status_only恢复，但交叉审查复现了最终GET后new-api后台停用仍会被覆盖的P1竞态；该自动恢复代码及本轮新增的恢复成功断言已全部撤回。没有保留危险开关，没有用额外GET宣称解决。最终行为见下面的安全修正。
- 对#522补充一项原始故障回归，GET返回admin_permissions及server-managed echo时，验证PUT剔除四字段且保持admin.user.update proof scope及其他客户字段。
- 新增7项客户有效倍率client回归，覆盖customer Authorization身份、拒绝负值/畸形数据及403不得换admin重试。
- 全仓 `pnpm exec tsc --noEmit --pretty false` 已通过（本组最后增测前；核心类型变更均已包含）。所负责运行代码和测试ESLint为0 error/0 warning。

- 最终本组定向验证：18 files / 360 passed / 0 failed；保留所有上游既有回归，测试来源/opt-in与必要fixture调整见上。

### 最终安全修正：到期设置与重新启用分离

交叉审查发现：Portal数据库锁不能阻止operator在new-api后台修改状态。任意“GET确认状态后status_only PUT1”都存在最终读取之后被外部停用的窗口，额外GET不能提供原子expected-status保证。因此最终代码完全移除自动reactivation，状态3/4/2的Key仅保存新expiry/quota设置，不发送任何status_only请求。

- 保留上游active-Key四项原始回归的调用次数和关键断言；仍是GET完整token→PUT完整可编辑设置。
- 对更新前已知非active状态，helper返回requiresReactivation；API返回ok=true/settings_saved=true/requires_reactivation=true及共享中文提示，明确只是设置保存成功，没有恢复Key。
- token-meta完整分页同时保留new-api真实status，/keys首屏传upstream_status和requires_reactivation；保存后的客户端维持inactive提示，即使新到期时间在未来也不能隐藏“仍不可用、需管理员恢复或新建Key”。创建新Key仍正常active。
- 本轮自己新增的4项自动恢复相关测试替换为不恢复场景：过期、耗尽、明确停用，以及最后一次GET返回旧快照后operator改status2的竞态。调用真实updateTokenForCustomer函数、fake fetch按new-api非status PUT保留状态语义运行；验证最终仍为status2且绝不出现status_only。没有修改上游既有四项测试。
- 新增API已保存但不可用、UI未来expiry仍提示inactive（三种状态）、元数据四种状态读取共8项回归。没有重新引入后台凭据或绕过客户授权。
- 本次修正定向7 files / 241 passed / 0 failed；全仓tsc通过。最终本组总计待根代理完整检查确认。

- 移除自动恢复后的最终本组验证：18 files / 368 passed / 0 failed；修改的10个代码/测试文件ESLint 0 error / 0 warning；全仓tsc通过。

### 上线前实证修正：空版本自建 new-api 的安全能力探测

根代理生产只读GET /api/status发现success=true但version为空，且NEWAPI_ACCESS_TOKEN_MODE未设。旧auto把空版本当PAT，直接POST /api/verify携带PAT context，可能被自建旧版验证器400拒绝；没有触发持久legacy流程。本轮用暂存旧client真实函数的内存fake-fetch复现：请求顺序仅GET /api/status→POST /api/verify，最终HTTP400，未调用GET /api/user/token。

最终修复：

- accessTokenModeForVersion对空/空白/未知/custom版本返回probe，只缓存明确已知版本；已知rc.2/22/40/41/44及GA的原分流和pin语义保持。
- unknown/probe先用fresh customer login session调用GET /api/user/access_tokens/catalog，requireSuccess/no-store/manual redirect；验证groups/max_tokens/default_expiry_days结构。只读步骤不提交密码、不签proof、不发行/旋转token。
- 官方rc.44源码实际取证确认GET /api/user/access_tokens为ListAccessTokens（data.items/legacy），GET /api/user/access_tokens/catalog为GetAccessTokenCatalog（data.groups/max_tokens/default_expiry_days），两者同样要求browser session。
- 选择catalog而非list作探测，是因为本地旧参考router存在管理员GET /api/user/:id通配路径，列表路径可能被当作id=access_tokens而返回403；独立两级catalog路径避免该碰撞。不能把403误认为旧版。
- 仅该只读探测明确301/404/405缺路由时采用本地legacy+精确SECURITY_PROOF_REQUIRED挑战流程。401/403/429/5xx/超时/断连/畸形成功均停止，不允许退回旋转；确认PAT后verify/create失败也不再fallback，避免不确定结果后第二种凭据写入。
- 官方取证文件为QuantumNous/new-api的v1.0.0-rc.44 router/api-router.go:104–110与controller/access_token.go:59–103。公开源码只读，未向真实new-api发任何创建/验证/旋转操作。

测试变更审计：

- 原已知rc版本开户/PAT创建/scope/旧凭据持久化回归保持。上游“status不可达→先PAT写探测→404后legacy”的原场景保留，但探测断言改成GET catalog，POST verify改为不得调用，原因是此次生产空版本旧服务及旧验证器400实证：能力探测不能先触发不适用的proof操作。这不是取消持久token换取；随后GET /api/user/token仍必须调用。
- 空字符串/undefined/garbage的版本解析期待由pat改probe，真实语义安全修正已单列；其他版本解析预期未变。
- 新增27项回归覆盖空版本旧服务301/404/405、空版本现代PAT、旧服务proof context、probe鉴权/5xx/超时/断连、错误成功结构、已确认PAT后的proof400/403/404和PAT/legacy不确定写入不重放。
- 验证为授权4 files / 80 passed / 0 failed；全仓tsc通过。仅本地修改并stage，无生产凭据迁移或密码重置。

### 模型广场

基线：共同祖先 `9b857a4f`；本项目应用基线 `84b5125e`、合并前 HEAD `459edd00`；上游 `48f914ba`。仅模型广场范围，不修改 new-api 源码、模型路由、结算、Key 权限、机器目录。

### 三方冲突逐文件

- `src/app/models/page.tsx`：祖先从 new-api 模型列表生成 ISR 清单；ours 改为共享 `ModelsCatalog`，使用 LLmRoute 品牌、客户当前报价、动态渲染；theirs 改为模型广场客户端岛及上游 runtime/status 配置。最终接收广场客户端岛和模型广场 metadata，保留共享 ModelsCatalog、force-dynamic、BackButton、LLmRoute 品牌与工作台入口；不采用旧 Silk Road 地址/状态汇率默认值。报价仍在服务端按当前客户加载，认证或报价出错不挂载客户端报价。不是整文件取 ours/theirs。
- `src/app/models/models-browser.tsx`（modify/delete）：祖先为按厂商展开的旧清单；ours 已加入逐档报价、过滤、轻量卡片和完整价格详情；theirs 删除旧文件。最终保留 ours 的组件及导出作为回归兼容实现，两实际入口均改用上游广场。抽取复用已存在 `ModelTierPrices`、`catalogPriceSummary`、`catalogSummaryTier`，不以“删除上游删掉的旧组件”为由丢失完整人民币价格语义。旧组件不再是生产两入口的主界面。
- `src/__tests__/app/models-page.test.tsx`：祖先检查旧清单 SSR；ours 增加两入口、客户身份失败关闭、逐档/零价/缓存价；theirs 用 mock island 验证三个广场壳场景。最终保留上游三个场景名称和范围，品牌/域名/人民币默认 runtime 断言按 LLmRoute 改；保留本地身份失败关闭、客户/匿名及工作台场景。旧 ModelsBrowser/完整报价回归原场景迁入 `models-browser-legacy.test.tsx`，不是删除。新 `models-plaza-pricing.test.tsx` 直接渲染实际上游卡片、表格价格单元、详情组件，并验证新数据入口和价格一致性；仅外部 VChart canvas 模块在 Node 测试中 mock。

### #558 最终集成

- 采用 `src/vendor/newapi-web` 卡片/表格/筛选/侧栏/详情抽屉/性能组件；保留版权头。额外实现 `plaza-data` 与 `plaza-pricing`，不创建另一套路由或计费引擎。
- `loadPlazaData(viewer)` 首先调用原 `loadBrowserCatalog(viewer?.id)`。只有已校验 Portal 模型/档次与当前人民币 `pricesByTier` 能进入展示；new-api `/api/pricing` 仅按同名模型补白名单描述、厂商、已验证数值元数据和允许的客户 API endpoint。模型数、启用组、倍率、价格、表达式、内部字段不透传。
- 不构造假的 model_ratio/model_price。上游旧倍率字段改为可选，Portal 模型携带明确报价，卡片/表格/完整详情共用报价选择与格式化。默认是模型真实默认档或明确命名的现存档，缺价保留未定价，未知所选档不回退。零价保留。
- 保留完整 token 阶梯与缓存读/写、图片 token、媒体各规格、按张/秒/次、跨午夜折扣；“标准/充值价”切换在 Portal 报价中隐藏，人民币不会按 new-api 原始 USD 倍率重复换算。/1K 与 /1M 仅按明确 token 单位变换，媒体单位不受影响。排序读取同一所选档摘要；不同计费单位先分组，不直接比较每秒与每百万 token 的裸数字。
- `runtime` 使用 `public-config` 的品牌和客户 API 地址；不依赖 `/api/status`，无旧域名或汇率 7 兜底。API 示例使用客户模型名与 LLmRoute 地址。
- 两入口都用 `ModelsCatalog → PlazaLoader`，工作台保留 embedded 模式。原机器目录不改。
- 性能接口仍只读：白名单、受限 hours/模型查询；每次以当前目录过滤响应。详情把 new-api 组映射为 Portal 显示名，并仅保留该模型真实成员组。若响应含排除组，不显示其聚合 summary/series。卡片汇总仅保留请求的公开模型，明确标注“模型整体 · 近24小时”，不冒充所选档次指标。性能缓存独立60s/最长10min网络故障回退，当前目录裁剪在缓存之后进行。不调用会同步/写分组的 `listEnabledChannelGroups`。
- 上游动态详情的 `ratio || 1` 改为 `ratio ?? 1` 保留合法0；Portal 报价完全不走此倍率路径。旧固定价缺失改为不可计算，不冒充0。

### #566 与上游测试语义变更

- 客户身份传给现有 Portal 报价加载器；可选 new-api 描述元数据请求仍带客户 Authorization + New-Api-User，单独服务测试检查。价格不重复套 new-api 有效倍率，当前客户倍率来源及失败关闭保持。
- pricing 服务端 `Cache-Control: private, no-store`，无缓存/旧价回退；客户端 query按 viewer key隔离、staleTime=0/gcTime=0，身份/报价请求出错隐藏已有价格，不把旧数据继续当现价。SSR snapshot变化重建客户端岛；刷新可见发布后的价格。
- `models-proxy-route.test.ts` 以下原场景保持：白名单404无请求；性能重复 recent_model 查询；60秒性能缓存按完整查询隔离；性能不带客户身份。
- 原“pricing直接透传上游body”改为“返回校验后的Portal报价”。理由：本文选定目录/价格事实源；原请求路径场景仍覆盖，另测试上游隐藏模型/秘密组/价格/表达式不能混入返回。
- 原“pricing网络失败返回旧缓存”移到性能路径保留网络故障回退场景；新增定价成功→失败→新价发布的序列，断言中间503、恢复后新价，报价不回旧值。
- 原“客户pricing缓存与匿名隔离”改为A/B/匿名各自重新加载；描述元数据身份头另在 `plaza-data.test.ts` 验证。保留跨身份场景，但不再断言定价缓存命中，因为本地既定规则要求发布/专属价刷新立即可见。
- 原“会话解析失败降匿名200”在同样db-down故障下改为503，并断言未加载匿名报价、未调用上游。理由已获功能取舍文档确认：防止个人价不可验证时展示错误公共价。这是显式产品失败策略调整，未用修改断言掩盖bug。
- 页面壳原返回首页文案改本地BackButton“返回”；原Silk Road标语/ai.silkroadai.io/price7.2改为One route. Every model./api.llmroute.club/人民币1。这些是品牌/既有计价单位适配，非测试弱化。

### 当前验证与边界

- 专项：6 files / 46 passed（2026-10-25；包含实际采用的卡片/表格价格/详情组件）。页面壳/两入口8，旧组件7，广场报价11，API11，数据5，性能4。
- 负责的应用代码/测试 scoped ESLint：0 error、0 warning。负责的非vendor文件已prettier格式化；vendor保持上游风格和仓库原有ignore规则。
- 尚待根任务统一typecheck/完整测试/构建、浏览器桌面移动端验收及真实配置只读比对。专项通过不代表已生产验收，不发起收费模型请求。
- 新增依赖仅使用#558已有依赖，无额外库；package/lock由根任务负责。

- 补充精度验收：/1K 使用十进制移位，1e-12元/百万token仍显示为1e-15元/千token，避免非零缓存价变0或前端抛错。

### 媒体与任务

基线 dev `84b5125e`；共同上游基线 `9b857a4f`；目标 `48f914ba`。合并前审查已完成并交由主代理写入正式报告；现已完成媒体文件集成与本地验证，尚未提交、部署或做生产验收。以下时间均为北京时间，行为来自逐提交 diff 及最终目标代码，而非仅提交标题。

### 逐提交行为

| 北京时间       | SHA / PR      | 实际行为                                                                                                                                                                                           | 影响与取舍                                                                                                                                                                   |
| -------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10-09 17:52:23 | f58c0bf7 #513 | svcinf 提交遇任意 500/502/503 默认 1.5 秒后原 body 重 POST 一次；504、4xx、fetch 异常不重试；新增 `SEEDANCE_SVCINF_SUBMIT_RETRY_MS`（0 禁用）。                                                    | HTTP 状态不能证明未创建收费任务，必须收紧；无服务端幂等契约时默认不得自动重放。保留失败场景测试，变更测试断言须单列解释。                                                    |
| 10-14 14:55:23 | 304ef61e #523 | BytePlus 查询形不再输出 fps=0、过期=0、service_tier 空串；改为上游值→提交字段→24fps/172800s/default。                                                                                              | 采用协议兼容，保留上游新增测试。                                                                                                                                             |
| 10-14 16:15:35 | 16e04682 #524 | 轮询补 last_frame_url；非 volc service_tier 仅 default（剥除）、priority 仅0–9整数；模型基本校验提前到 region 门前；region_mismatch 使用真实绑定区域。                                             | 采用；同步400须不提交收费请求；保留本地 auth/终态 guard。                                                                                                                    |
| 10-15 13:38:06 | 12ac6182 #528 | proMax 曾全档转 svcinf、增加480p；配置按region/customer sk-inf key分离；`volc_id_map.api_version` 记创建v1/v2；NULL旧行仅404且无任务体时GET另一版；draft lookup同样按创建版本。                    | 版本隔离采用；proMax最终状态需以#563为准；不修改客户密钥。版本记录失败不可误称可靠持久化。                                                                                   |
| 10-15 13:54:11 | edb64282 #529 | 仅CLAUDE补上游自己的proMax部署/收费smoke记录。                                                                                                                                                     | 不能写作LLmRoute已部署/验收。                                                                                                                                                |
| 10-17 15:28:33 | 729aed5e #536 | global 增加svcinf独立key/base/version/model env配置，480p开放；当时fast/mini1080p仍留artsmcp。                                                                                                     | 新协议能力可接入，但不得自动切本项目渠道；无显式配置保持当前通路。                                                                                                           |
| 10-17 15:40:29 | cc39689e #537 | 仅CLAUDE补global部署/收费smoke记录。                                                                                                                                                               | 上游历史记录不等于本项目事实。                                                                                                                                               |
| 10-19 15:56:07 | e875532f #545 | 删除global fast/mini1080p；global/proMax 2.0 pro/fast带非空tools入口同步400。                                                                                                                      | 删除规格依据上游自有key失效，不能直接套本项目；最终#563仅global保留tools门；应按实际选择的provider约束。                                                                     |
| 10-19 16:15:59 | 239ec1a2 #546 | 每10分钟对最多50客户依次补对账，每客户20条、仅90秒前非终态；admin详情GET也触发；提交保存callback URL/格式；终态CAS pending→sending后POST，0/5/30秒三次尝试，10秒超时，不跟redirect，结果写reqlog。 | 新增5个nullable列；需保留本地pending+billed=false终态CAS和私有reqlog。URL只检查字面量有DNS SSRF；sending中断无恢复；回调须匹配提交格式、确认真实终态，文件失败不得生成重放。 |
| 10-19 16:45:33 | 7463d74b #547 | 仅CLAUDE补sweep/回调部署及收费smoke记录。                                                                                                                                                          | 本项目未执行。                                                                                                                                                               |
| 10-21 13:37:01 | 0ff135a8 #554 | 2.0音频门允许至少1图或1视频；2.5/promax-2.5允许纯音频；cn与公开海外adapter同步；文档更新。                                                                                                         | 采用修复；保留视频+音频和纯音频的原回归。                                                                                                                                    |
| 10-21 14:03:00 | fb4a368e #555 | 仅CLAUDE记音频门修复及上游smoke。                                                                                                                                                                  | 不复制上线事实。                                                                                                                                                             |
| 10-23 09:00:21 | f9009e12 #560 | draft_task 放开global/promax 2.5；查样片与正片提交按同region密钥/套餐，不再拿cn key；无该区域key503；另补PNG类型声明。                                                                             | 采用，必须保留账户/区域隔离且不自动借用别区key。                                                                                                                             |
| 10-23 09:23:33 | 67414739 #563 | proMax新提交回artsmcp intl、关闭480p、fast/mini仅720p；tools限制仅global；保留旧svcinf任务轮询及旧样片出正片能力。                                                                                 | 最终proMax规格接近本地；不执行上游“写客户新key”部署动作。                                                                                                                    |
| 10-23 10:02:35 | 42c65c35 #565 | 仅CLAUDE补proMax换回和key写入/收费smoke记录。                                                                                                                                                      | 不照抄本项目生产事实。                                                                                                                                                       |
| 10-23 15:44:26 | 085c0968 #567 | Seedream Flash别名映射、response model规范回显、错误脱敏涵盖两模型、usage按Flash每图33660quota/参考免费；Pro像素计费档阈值236万→261万；setup脚本可选Flash。                                        | 新能力不代表开通渠道；Pro阈值是实际计费变化需单列，不自动运行setup或修改价格。                                                                                               |

### 配置、数据库与运维

- `20261015120000_volc_id_map_api_version`：单列TEXT NULL；老行保持NULL并GET两版回退；旧程序可忽略此列，无数据删除。
- `20261019120000_seedance_task_callback`：callback_url/format/status/error TEXT NULL，callback_sent_at TIMESTAMP(3) NULL；旧行均不投回调；旧程序可忽略。两migration均需要先迁移再运行依赖列的新程序，部署后callback在途不可宣称无损旧版回滚。
- 本范围新增env为svcinf retry间隔，以及PROMAX/GLOBAL的KEY、BASE_URL、API_VERSION、MODEL_*；env模板不能代表生产设置。本范围无新依赖或Nginx/Cloudflare变更；调度注册与主站实例运行边界由根代理审核。
- Enterprise目前自有账本通过billed CAS与ledger(kind,ref)幂等。失败/过期仅允许pending且billed=false的本地守卫必须保留；成功处理也须检查迟到结果不复活已失败任务。
- 回调重试属于通知重发，接收方必须按X-Task-Id幂等；不能承诺网络语义exactly-once。sending崩溃后当前实现不会自动再发（避免不确定重投，但会丢通知），需要如实记录。

### 合并后三方语义审计

三方基准：应用合并前 `84b5125e`（合并前文档提交HEAD为`459edd00`）、上游 `48f914ba`、当前暂存结果。

| 冲突文件                                     | dev语义                                                                                               | 上游语义                                                                        | 最终语义及明确放弃项                                                                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/enterprise/proxy.ts`                | pending且unbilled才写失败；发生竞态/SQL失败返回可重试503；保留任务归属、reqlog、OSS、视频元数据回填。 | helper移到ark-format；新参数与协议校验；callback保存/终态通知；global规格调整。 | 保留本地所有终态失败保护；采用helper迁移及校验；成功落tokens也用状态CAS，避免迟到成功复活失败。callback按**提交保存格式**发，默认关闭；拒绝上游“用本次poll格式回调”。global按显式provider配置而非上游运营方key状态控制规格。 |
| `src/lib/enterprise/reconcile.ts`            | 失败/过期更新仅pending+billed=false，只有count>0才记真实状态变化日志。                                | 失败/过期后无条件记日志并回调；10分钟sweep调用；成功后回调。                    | 本地CAS与count条件保留；仅已更新且重新读取的row.status等于拟通知终态才通知；成功CAS失败不补扣；回调交付复用客户OSS/品牌URL。放弃无条件失败日志/通知，不放弃回调功能。                                                        |
| `src/lib/enterprise/volc-id-map.ts`          | task映射事务create，碰撞不能覆盖旧映射；错误抛出；素材映射才best-effort。                             | 新api_version列；任务仍best-effort upsert；读取异常当无映射。                   | 在本地事务与防碰撞基础上加创建版本，已知版本不得覆盖；仅NULL旧映射可补已知版本。读取异常503。放弃task upsert/吞错；受理后写入失败返回可恢复句柄保留上游号+创建版本，不再提交生成。                                           |
| `src/lib/enterprise/__tests__/proxy.test.ts` | 本地恢复句柄/IDOR/状态失败回归，若干旧上游测试此前已不在本地。                                        | 新参数校验、metadata、global限制、callback测试。                                | 合并双方已有块，本批新测试标题全部保留；新策略用显式env测试原行为，补默认关闭/旧渠道规格/跨入口回调格式场景。成功更新断言改为CAS updateMany，仍必须写tokens与计费。                                                          |

自动合并文件逐项核对：`ark-format.ts`保留#523非零fps及上游/提交/默认顺序；`keys.ts`保留绑定地区权限，仅采用更准确文案；`seedance/adapter.ts`与`cn-adapter.ts`采用音频+视频门，LLmRoute品牌URL不回退；`draft-task.ts`/`volc-adapter.ts`保留同区域key与创建版本GET查询，映射读异常503；`cn-billing.ts`只增加新规格所需同价表项，未执行价格配置；`request-log.ts`只扩充callback kind，私有日志实现不回退；Enterprise日志页只添加筛选；新增admin详情对账与自动scheduler均受显式开关；Seedream Flash协议完整保留。

已分别运行 `git diff <上游修复> -- <受影响文件>` 检视#523(304ef61e)、#524(16e04682)、#554(0ff135a8)、#560(f9009e12)、#567(085c0968)与最终工作树；核心兼容修复未被本地业务覆盖。更早修复与最终上游对比的差异包括后续上游自身演进，判断基于最终目标48f914ba。

### 测试

最终本地定向：`node_modules/.bin/vitest run src/lib/enterprise src/lib/seedance src/lib/seedream src/lib/scheduler/__tests__/enterprise-reconcile-sweep.test.ts`：**40 files / 817 passed**（2026-10-25）。媒体范围ESLint **0 error / 6既有warnings**；格式已对所有手工编辑文件执行。全局类型/完整测试/构建与隔离migration由主代理统一验收，不能用这里的定向结果替代。

新增真实时序/失败验证：

- 500/502/503默认只发一次；显式重试仍保留原503→200/两次失败回归，已有任务ID或读体中断不再次POST。
- 任务已在上游受理，SQL映射create失败：响应仍200并返回可查询恢复句柄，实际适配器只发1个POST；持续SQL故障仍能从恢复句柄找原任务/创建版本。
- 延迟成功与并行失败、延迟失败与并行成功的双向竞态；本地任务终态、tokens及扣费次数保持正确。
- callback默认关闭、错误终态不投、两个并行触发只抢占一次、发送中断不盲重放、失败重试/成功停止、禁止重定向、恶意持久化URL重新验证。
- 使用真实本机HTTP监听器+实际fetch dispatcher，公网形域名DNS返回127.0.0.1时投递失败且监听器收到**0请求**；DNS混合公网/私网结果拒绝，实际socket只得到已验证IPv4。没有连接真实外部回调。
- ark提交/v1轮询、v1提交/ark轮询、失败终态均按提交格式通知。
- sweep查询异常释放重入守卫，默认启动不查/不补扣，客户失败不影响其他客户。
- Seedream236万默认边界与显式261万边界，非法配置在收费生成前503且fetch=0。

上游测试语义调整（不以反向断言冒充bug修复）：

1. `svcinf-submit-retry.test.ts`默认间隔断言1500→0并改标题，理由为本地不确定收费提交不自动重放；上游全部重试场景继续在已有显式env=1下原断言通过。
2. `cn-adapter.test.ts`原“global fast/mini1080p从MODEL_MAP删除”改为“保留旧渠道规格、显式svcinf提交400且fetch=0”。原因是上游删规格源于其自有key失效，不能转成LLmRoute默认行为。proxy原global480p/tools/1080p回归保持名称与关键结果，仅显式配置svcinf key；另测无配置保留1080p。
3. callback原测试增加显式启用、持久终态fixture及更严格CAS where；原POST次数/重试/redirect结果不变。测试URL `https://h/x`换合法公网形域名，因为现拒单标签主机。
4. `proxy`成功写tokens断言从无条件update改为updateMany；`reconcile`断言增加状态/billed条件，对应真实延迟竞态回归；没有减少计费断言。
5. `seedream`原261万测试保留名称/边界断言，增加显式env=2610000；新增默认236万与非法配置前置拒绝。
6. 本地旧 `upstream-failed-task` mock补`toUpstreamTask`v2返回，原失败/轮询/不计费断言不改。图片转存断言域名沿用本地LLmRoute。

测试保留核查：本批proxy新增测试标题无遗漏。最终对上游全文件标题比较有13个**共同基线9b857a4f已有、但合并前84b5125e已缺失**的更早proxy测试，非本轮删除；主要为旧draft/视频probe/AKSK轮询/BMP测试。此次不声称修复所有历史测试缺口；本批关键失败场景另有现存及新增测试覆盖。

### 最终默认策略与剩余边界

- `SEEDANCE_SVCINF_SUBMIT_RETRY_MS=0`：缺省/非法值0；正值是明确启用旧重试能力，仍需operator确认供应商幂等或未受理契约，未写生产环境。
- `PORTAL_ENTERPRISE_CALLBACK_ENABLED=false`：未开时传合法callback_url明确503，不建生成任务。启用后仅公网IPv4（IPv6不支持），有socket DNS防重绑定。通知最多3次网络尝试，接收方须用X-Task-Id去重；进程中断后的sending保留待人工核查，未实现持久通知队列。
- `PORTAL_ENTERPRISE_RECONCILE_ENABLED=false`：新scheduler与新增admin详情触发默认不运行；既有客户页面主动对账保持。账本CAS后扣款失败的历史人工处理语义未重构。
- `SEEDREAM_PRO_PIXEL_TIER_THRESHOLD`：默认2360000；仅允许显式2360000或2610000，其他值前置503，不静默套价。Flash能力未开渠道、未改目录/真实价格。
- 新svcinf任务创建API版本随映射保留；新可恢复句柄旧应用不识别。若已经开启相关功能并产生新句柄/回调在途，回滚旧代码需要先检查任务状态，不能承诺无条件回退。
- 两migration仅做SQL审计；未登录VPS、未部署、未运行setup脚本、未写渠道/客户key/价格、未发真实收费生成。

### 交叉审查补修：HTTP错误中的已受理任务（2026-10-25）

审查发现此前仅抑制503带任务号的自动重试，但仍返回普通503丢弃句柄。现已修复：`submitSvcinfTask`只有结构化task、合法`mvt-...`号、已知`preparing/pending/processing/completed/failed`状态才作为受理事实，优先于HTTP状态；2xx/4xx/5xx真实受理任务均交回上层持久化并返回客户查询句柄。非2xx必须明确task信封；普通错误中的任意id、缺状态/非法状态、空后缀或request id都不会变成成功。仅2xx允许无error的裸任务形。

新增19项回归：200/400/403/429/500/502/503/504信封、伪任务/错误ID负例（每种在200/400/503核验）、实际cn适配器200/400/503持久化与单次POST、503受理后SQL故障仍返回可恢复句柄。定向更新为37 files / 800 passed；该改动ESLint0 error，仅cn-adapter测试2项既有unused warning。未网络、未收费、未改生产配置。

### 交叉审查补修：版本回退与生成/结算分离（2026-10-25）

1. `fetchSvcinfTask`旧映射无API版本时：第一版404、第二版503/429/401返回第二版真实错误；第二版网络错误仍502；只有两版明确task不存在才给task_gone，第二版普通404页面不能借第一次404宣称任务丢失。原成功跨版本回退与已知版本不跨版逻辑保持。
2. Enterprise客户poll和reconcile共用`task-completion.ts`：生成completed且有合法http(s)视频URL即可保存completed，usage缺失/0时tokens仍NULL、billed仍false、账本0写入；不编造token。真实正整数usage后到可回填并通过原账本幂等结算；首次真实usage不覆盖已记录usage。对账与sweep现在纳入completed未billed；失败、过期CAS仍只允许queued/in_progress，不能把已完成视频改失败。完成后临时查询错误或迟到running/failed不再回显queued。
3. 回调只代表生成终态，不代表费用已结算；生成时usage未就绪也能通知，后补usage不重复投递。客户文档已说明需查询确认最终用量。默认callback/sweep开关继续false。
4. Enterprise及共享cn-proxy在**上游已受理后主任务ownership行create失败**，返回503 `task_record_unconfirmed`，包含accepted=true、retryable=false、task_id、随机request_id，明确Do not resubmit/contact support；头`X-Should-Retry:false`、`X-Request-Id`，不设置Retry-After；日志关联客户和任务（Enterprise reqlog还保留request_id）。这只能抑制遵守提示头的SDK，不能保证所有客户端都不盲重POST。主任务行未保存时Portal归属查询可能404，仍需人工恢复，绝不声称全链路DB失败可自动恢复。
5. 新完成状态不会凭缺失usage直接计费；用量永远缺失或上游结果超过保留期时保持completed/unbilled，后续人工核对边界保留。现有有限批次sweep不被宣称为持久结算队列或高并发容量保证。

新增17项验证：跨API版本404+503/429/401/网络错/普通404/双404；真实账本函数驱动poll→poll、poll→reconcile、reconcile→poll与reconcile→reconcile的缺失/零usage→后补正数usage，后续并行查询账本仍仅1次；回调仅1次；无有效输出不伪完成；完成后的迟到失败、50h过期及瞬时错误均不回退；Enterprise和cn主任务create失败的单次POST、勿重提、关联ID与X-Should-Retry:false。

最新定向 **40 files / 817 passed**；新增/修改相关文件ESLint **0 errors / 0 warnings**；全媒体历史范围warnings仍为此前既有6项。无网络请求、真实收费、生产写操作或新migration。

### 公共流式补修

范围：`src/app/v1/[...path]/keepalive.ts`、route 内占位调用、`src/lib/image/stream-placeholder.ts` 与对应测试。未更改实际模型路由、new-api 鉴权、Key 表、上游生成次数或结算。drain 的显式 Connection 覆盖由根任务另行修复。

### 1. 慢失败的 SSE 终态

交叉审查在新 Gemini `stream:true` 分支发现：超过 keepalive 阈值后，helper 把 HTTP 503 JSON 错误/Promise 异常原样追加到 `: keepalive` 后，虽然 Content-Type 为 text/event-stream，却没有 data/event。用真实 helper 的 20ms 延迟503、1ms阈值实测：200 event-stream、正文含裸JSON、`hasSseErrorFrame=false`。标准 SSE 消费者无法识别失败。

最终改动：

- 阈值内仍原样返回原 Response 或异常；旧同步/快速失败行为保留。
- 慢路径先立即输出第一条 keepalive，避免原实现再等一个 trickle interval 才产生首字节。
- 成功的 SSE 响应正文保持字节不变。
- 慢 HTTP/JSON 错误、网络异常和 body 读取异常封成 `data: {error: ...}\n\n`，随后 `[DONE]` 并关闭流；HTML等非JSON失败不泄漏整页文本。
- 客户取消只停止 keepalive 写入，不取消已经发出的生成任务；关闭已取消流不会产生未处理异常。定时器在最终响应或取消时清理。

原有5个keepalive回归未删改；新增慢200错误信封/400/503、HTML失败、晚reject、body断连、首字节时序与成功原文、取消场景。公共 `/chat/completions` Gemini入口另以真实异步时序模拟HTTP401和网络失败，验证错误是可解析SSE、无伪completed/usage且只调用一次new-api。

### 2. 占位图资源边界

原上游每个新尺寸/格式 miss 都立即启动 native render；LRU只保留64个Promise引用，删除引用不会停止已在运行的渲染。公共请求在new-api鉴权结果回来前启动占位工作，且partial_images=0也预热7种规格。因此仅限制LRU条数不能限制并发或缓存字节。

最终改动：

- 公共请求取消全尺寸预热；只有 `partial_images > 0` 才获取所需规格。零partial不预热、不render。完整请求仍只交new-api鉴权，不用Portal token表替代。
- 同一规格共享正在运行的Promise；全局最多1个规格render。其他规格miss立即返回null，不建等待队列、不积累待处理任务。调用方跳过partial，真实completed及其usage照常交付。
- 缓存上限64条、按base64字符串UTF-16保守计量最多8 MiB；单条最多1 MiB。按LRU淘汰已完成项；拒绝超大输出并释放槽位。失败允许下次重试。
- 重置/清空缓存不重置仍在运行的native任务计数，避免清缓存绕过并发门。
- 画布限制安全整数边长16–3840及总像素≤8,294,400；WebP动图改成一个预分配slab加一个当前帧，避免pages数组和concat副本同时保留。已知raw buffer总量预算64 MiB，超预算退静态WebP；PNG/APNG规格和真实尺寸继续保留。
- 这些上限约束应用持有的缓存/显式raw buffers及render并发，不将其宣称为整个Node/sharp/libvips进程RSS上限。
- 显式 `warmStreamPlaceholders()` API 保留，改为串行、重复调用同Promise；公共请求不调用它。

上游测试变更审计：原预热测试名称/最终7种缓存与幂等语义保留；“调用后立即7个并行任务已进cache”的断言改为等待串行warm完成，再验证7项，同时验证active≤1。原因正是修复该无并发上限的行为，不是删掉预热结果检查。原4K APNG12帧/透明/动画WebP/大图静态/首partial在最终图前等测试保持。

新增回归：100个不同规格miss不会排队或启动额外render、同规格去重、字节与条数LRU上界、失败/超大输出释放槽、清缓存不绕过active槽、非法画布拒绝、WebP工作缓冲预算退静态；路由覆盖JSON和multipart零partial资源计数为0，以及入场拒绝时最终图和usage不变。占位帧仍不含usage，不产生另一条生成/扣费请求。

### 验证

- keepalive + placeholder原测试 + resource tests：3 files / 23 passed。
- 公共代理流式/固定SKU/Gemini相关定向：70 passed；之后新增两项慢Gemini入口回归，再单跑相关5项全部通过（5包含先前已有3项资源路由回归）。
- `tsc --noEmit --pretty false` 通过。
- scoped ESLint 0 error；proxy原fixture参数有15个既有warning，新增实现无warning（同时移除route旧preview逻辑留下的未用ImageFormat type import）。
- 未发起收费模型请求；生产资源压测和部署由根任务处理，不能把单元/隔离验证写成生产容量已验收。

### 完整套件暴露的测试生命周期修正

- 最终完整CI首次为6229 passed / 2 failed；失败的两项zero-partial资源断言观察到active=1。
- 根因不是zero-partial启动渲染，也不是并发门泄漏：此前上游两项“JSON/multipart stream / partial_images 被剥掉”回归只await POST即结束，未读取SSE终态；它们请求partial=2/3，native占位工作因真实渲染仍在后台收尾。在完整套件并发负载下跨越到zero-partial检查。
- 修正这两个旧测试：保留原名称、调用和参数剥离断言，额外消费完整SSE并断言completed及active归零，明确等待自己启动的资源结束。
- zero-partial测试继续严格断言{active:0,entries:0,bytes:0}，并增加生成入口与warm入口均未被调用的断言；未放宽断言、未强行清active计数、未修改生产并发或取消语义。
- 重新运行完整proxy436项 + keepalive/placeholder/resource全部：4 files / 459 passed。待根任务重跑最终完整CI。

## 统一验证最终结果（源码候选）

- 合并前完整非smoke基线：360文件、5725通过、1既有跳过。
- 最终 `pnpm test`：389文件通过、2个显式手工联机套件跳过；6261通过、3跳过、0失败。真实new-api smoke通过只读本机代理转发到SSH隧道，唯一出站为3次GET（status两次、models_enabled一次，41模型）；实际生产凭据只在代理进程内，测试进程没有生产凭据，所有其他HTTP路径/写方法均拒绝。未执行PAT迁移或收费生成。
- 非smoke `test:ci`：388文件、6258通过、1既有跳过（最终完整套件另含3项真实只读smoke）。
- TypeScript通过；lint 0 error / 100 warnings。生产Next构建通过，新增node:http的Edge警告已消除；未修改既有middleware弃用约定。
- 首轮完整验证曾暴露zero-partial测试未等待此前SSE终态的问题，按上节补生命周期检查后全过。另一次与构建并发运行导致4K原生图片测试超过5秒、typecheck遇到正在重建的.next/types；停止并发构建后按原超时/原断言完整重跑通过，未放宽测试标准。
- PostgreSQL16隔离schema增量预演、合成数据真实HTTP报价隔离/刷新、构建产物桌面与390px手机交互均通过；证据在本机 `outputs/upstream-sync-20261025/`。没有把合成报价和图表视为生产验收。
- 部署镜像固定pnpm10.30.3，带入LICENSE、原MIT及vendored NOTICE；构建上下文排除全部.env*与本机outputs。

## 线上只读核对与发布前状态

- SSH最初拒绝配置公钥，随后连接恢复；真实new-api `/api/status` success=true但version为空，`/api/user/access_tokens/catalog`明确404。已修正未知版本只读探测，当前auto能保留legacy+security proof，不改生产凭据或强制配置PAT。
- 本机.env中的旧管理凭据已失效，初次smoke出现401；使用线上当前凭据经只读代理后3项smoke全部通过。原本机.env未修改，未调用GET /api/user/token或任何凭据迁移。
- 当前服务器项目目录是归档副本，没有.git；运行Portal为release-2445fe88，镜像7c84a05304cc，restart0。独立视频维护timer正常，应用与维护镜像分开管理。
- 生产BILLING_SOURCE未设置（默认newapi）、NEWAPI_GROUP_SYNC_MODE=mirror、quota技术单位500000且人民币转换1；Batch/Image2.5为false，新增可选开关未设置（默认false）。
- 发布使用prod确定提交的独立源码仓库/归档，保留原运行配置、网络、密钥与请求日志卷；仅切换Portal，不重启new-api/PostgreSQL/Redis/视频维护程序。旧镜像先打回滚标签、备份配置和数据库，并在生产备份克隆中验证两迁移后才切换。
- 当前段记录的是发布前核对，不是上线成功声明；上线结果将单独追加。

### 构建中断及原站恢复

- 生产主机在候选镜像构建期间失联，未执行增量 migration、Nginx补丁或新应用切换。
  经operator分别授权软重启和一次硬重启，原`release-2445fe88`已恢复。
- 两套数据库完成恢复、全量导出与逐表/字段比较；原用户、余额、Key、目录、价格、渠道、充值、
  订单、账本及计费配置均保持。新增错误日志quota为0，旧记录未丢失；任务/权限差异已单独核清。
- 详细经过、证据及边界见[生产恢复记录](PRODUCTION-RECOVERY-2026-10-25.md)。后续改用独立原生
  amd64构建环境，VPS只加载已验证镜像；该恢复阶段尚未上线候选提交，后续发布结果见文末。

### GitHub CI 4K EXIF 测试耗时审计

- 2026-10-25，CI `40170896389`（`d10234ff`）的 Format、Type Check、Lint 均通过；Test 为
  6257 passed / 1 failed / 1 skipped，唯一失败是
  `fixed 4K normalizes an EXIF-rotated JPEG to the promised display dimensions`
  超过 Vitest 默认 5000ms，未报告尺寸或图片内容断言不符。
- 此用例与公共 v1 代理文件在前一 CI `40170169212`（`4e471dab`）和本次提交之间的 Git blob
  完全相同；前一 CI 的 Test 已通过。用例包括现场生成 3840×2160 JPEG、EXIF 方向处理、
  缩放/编码以及重新解码检查，存在 CI 环境下的执行时长波动。
- 仅将该单项正确性测试的执行预算设为 `15_000ms`；名称、请求、fixture、HTTP 状态、回显尺寸、
  图片字节发生转换以及真实解码后 3840×2160 的断言全部保留。没有修改应用逻辑、生产超时或全局测试超时。
- 延长测试执行预算不视为生产图片处理时延、并发容量或性能验收，也不据此声称新应用已经上线。
- 定向运行该用例：1 passed / 435 filtered；两个改动文件的 Prettier 检查与
  `git diff --check` 均通过。测试文件已逐字比较，除该用例新增的超时参数外没有其他改动。
  随后提交 `8427ffe0` 触发完整 CI `40171693271`，Test、Type Check、Lint、Format 全部通过。

### 正式发布完成

- 2026-10-25 15:52（北京时间）已部署应用 `5a0e613e`；原生 amd64 构建、镜像各层摘要、
  生产备份克隆验证和两条生产 migration 全部通过。VPS 未再次编译，切换首次失败至首次恢复
  探测间隔 10.443 秒，Portal restart count 0，依赖未再次重启。
- 原 41 模型及 69 份活动分组报价保持；3 个存量持久授权与一枚真实客户 Key 的公网只读模型
  列表通过。15 项公网检查、浏览器模型广场与跨域验收通过，未发起收费生成或支付。
- 发布备份、Mac 异机副本、镜像 manifest/config digest、完整验证边界与回退命令见
  [正式发布结果](DEPLOY-UPSTREAM-2026-10-25.md)。
