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
