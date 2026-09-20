# 上游同步报告：2026-09-20

## 范围与基线

- 本次上游来源：`upstream/main`，已从 `8ac4b57` 更新到 `02426af`。
- 本次范围：上游提交 `#466`–`#483`，共 18 个提交；北京时间 2026-09-16 至 2026-09-20。
- `main` 在同步前为 `33ebe6b`，没有领先 `origin/main` 的项目自定义提交；已先将 `main` fast-forward 到 `02426af`。
- 当前项目自定义代码仍在 `dev`，尚未执行 `main → dev` 合并；本报告先于合并生成。

## 逐提交行为变化

1. `4e6a65c`（2026-09-16 10:25，#466）
   - `/v1/images/edits` 在 `size=auto` 或省略尺寸时，根据输入图比例补出明确尺寸，再交给上游。
   - 新增代理回归测试，覆盖自动尺寸和输入图比例。
2. `4389137`（2026-09-16 10:29，#467）
   - 记录 #466 的上游行为、按张计费的 `auto` 方图陷阱和运维说明；无运行时代码变化。
3. `143f54a`（2026-09-16 12:31，#468）
   - `size=auto` 时把 `aspect_ratio` 写入 prompt，明确画幅优先于输入图比例。
   - 扩充代理测试，锁定 prompt 改写和尺寸选择顺序。
4. `57ec216`（2026-09-16 12:33，#469）
   - 补充 #468 的文档和 gotcha 记录；无运行时代码变化。
5. `8ac4b57`（2026-09-16 12:39，#470）
   - 将亚洲账号池拆成 `wetokenasia-low`、`wetokenasia-medium`、`wetokenasia-high` 三条按档专线。
   - 仅增加 provider 路由和测试；是否实际可用仍取决于渠道/凭据配置。
6. `8bde26a`（2026-09-16 22:44，#471）
   - 图片 edits 的文本 token 改用 `o200k` tokenizer，并按 32px patch 计算输入图片 token。
   - image-adapter 与 image-adapter25 共用新的 token 计算实现；新增 `gpt-tokenizer` 依赖。
7. `e2ee84f`（2026-09-17 00:02，#472）
   - 对文本 token 加官方固定开销 `+6`。
   - 输入图改为官方三段缩放规则，新增图片 token 计算模块；同步修正 2.5 适配器。
8. `b343112`（2026-09-17 16:31，#473）
   - 接入 `zdchat25` 全量 Image 2.5 线路。
   - 远程图片 URL 转 base64 增加重试，避免图床刚返回时读到 0 字节。
9. `b65c199`（2026-09-18 14:51，#474）
   - 未知模型从 503 改为官方语义 404。
   - Anthropic `/messages` 的 `tools[]` 结构增加严格 400 校验，并补齐模型不存在与 tools guard 测试。
10. `a02e4cf`（2026-09-19 19:53，#475）
    - 对 GPT Image 第一、二批官方行为对齐：`n` 多图计费、超大输入图缩放、尺寸约束默认 400、edits 缺图 400、mask 透传。
    - 扩充 image-adapter、image-adapter25 和代理测试；涉及计费和请求失败语义，需重点回归。
11. `1ee9986`（2026-09-19 20:07，#476）
    - 增加 GPT Image 官方入参校验：`quality`、`size` 形态、`n` 类型/范围、`prompt`、`style`、`input_fidelity` 和 PNG 压缩。
    - 将非法输入统一在转发前返回 400，并补齐请求测试。
12. `e83734e`（2026-09-19 20:28，#477）
    - `size=auto` 按官方 1.5MP 语义选尺寸并计费；generations 使用 1122×1402，edits 跟随输入图比例。
    - 新增 `auto-size` 模块，并将尺寸/计费逻辑从代理层收口到适配器。
13. `a3381de`（2026-09-19 20:46，#478）
    - 真正交付 WebP（使用 `sharp` 转码）。
    - 增加伪流式 `partial_image` 事件、`sequence_number` 和 `data[].generation_id`。
    - 新增 `sharp` 依赖、图片转码与 generation ID 模块；需要检查 Docker 原生依赖和内存风险。
14. `602cf0f`（2026-09-19 22:00，#479）
    - Image 2.5 的 `quality` 补充 `xhigh`、`max`，修复上一批校验对 2.5 的误伤。
    - Image 2.5 edits 补齐 mask 透传和回归测试。
15. `ee2baf4`（2026-09-19 22:19，#480）
    - 校准官方 key：edits 文本/输入图固定开销、auto 缺省尺寸下沉为 1254²、`generation_id` 改 UUID。
    - 重整 Image 2.5 适配器的参数透传和测试，删除被新语义取代的旧代理分支。
16. `bee2576`（2026-09-20 02:10，#481）
    - 接入 `reve.amlkcloud.top` 的 `gpt-image-2` high 专线 `revehigh`。
    - 仅增加 provider 路由和测试；凭据/渠道未在本项目中自动配置。
17. `f6094b2`（2026-09-20 12:11，#482）
    - `/v1/images/edits` 接受官方 JSON `images[{image_url|file_id}]` schema。
    - 代理、原 Image 2.5 适配器和测试全部补齐该结构；保留 multipart 兼容路径。
18. `02426af`（2026-09-20 21:30，#483）
    - 接入 `frimodelhigh` high 守门专线，使用第四个 frimodel 账号和 `gpt-image-2-adobe` 上游模型名。
    - 仅增加 provider 路由与测试；是否启用仍需独立渠道验收。

## 依赖、数据库、部署和安全影响

- 数据库：无 Prisma schema、migration 或数据回填变更。
- 环境变量：上游提交没有新增必填环境变量；新增 provider 需要确认现有渠道凭据是否已配置，不能把 provider 代码存在误报为线路已启用。
- 依赖：新增 `gpt-tokenizer@4.0.0` 和 `sharp@0.34.5`。必须重新安装锁文件并验证 Alpine/Node 22 生产镜像能加载 `sharp` 原生模块。
- Nginx/Cloudflare/Compose：上游没有直接修改；现有内部适配器公网隔离规则应继续保留，不能因为新增 provider 放开内部路径。
- 计费：Image `n`、auto 尺寸和 token 计算均影响计费前的输入与输出单价，必须保留现有固定 SKU、Portal 计费和 new-api 结算语义；本次合并不得执行真实收费请求。
- API 兼容：未知模型 503→404、非法图片/Anthropic tools 参数 400 属于对外可见行为变化；需验证客户端错误处理和文档页面仍与 LLmRoute 路由一致。
- 安全：`images[]` 的 URL/file_id 解析、远程下载、mask 透传和图片转码需要继续限制超时、大小、格式和 SSRF 边界；`sharp` 会增加图片内存占用，需观察容器 OOM 和请求并发。

## 与当前 `dev` 的差异和预判冲突

当前 `dev` 的定价、动态档次拓扑、持久 token 和 Portal UI 改动不在上游本轮修改范围内，预计不会冲突。三方审计重点如下：

- `src/app/v1/[...path]/route.ts`：上游大量加入官方图片入参、auto 尺寸、n 计费、WebP/伪流式和 JSON images 校验；`dev` 保留 LLmRoute 固定 SKU、固定尺寸计费、扇出和失败计费语义。合并时必须以 `dev` 的 LLmRoute 计费/安全语义为主，逐段接入上游校验；不能用上游旧的通用图片价格逻辑覆盖固定 SKU。
- `src/app/v1/__tests__/proxy.test.ts`：保留上游新增回归测试，并逐项审计与当前固定 SKU、失败计费、扇出测试的断言关系；不能为消除冲突反向修改“必须调用”或收费断言。
- `src/app/docs/page.tsx` 与 `src/__tests__/app/docs-page.test.tsx`：保留当前 LLmRoute docs-content 入口，同时接入上游未知模型/请求校验文档变化。
- `package.json`、`pnpm-lock.yaml`：保留上游两个依赖并验证生产镜像原生模块；不引入额外依赖或改变当前构建参数。
- `CLAUDE.md`：保留当前生产 Nginx/Cloudflare、Batch 默认关闭、动态拓扑和部署快照，只吸收上游图片行为记录；不能把上游 provider 凭据或旧部署事实写成生产已配置。

本报告完成后，才允许执行 `main → dev` 合并。合并后必须对每个冲突文件做“dev 合并前版本 / main 上游版本 / 最终结果”三方语义审计，保留上游新增回归测试，运行 typecheck、lint、完整非 smoke 测试、生产构建，并对图片请求校验与计费语义做定向验证。
