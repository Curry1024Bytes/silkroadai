# 2026-09-09 发布准备：关闭新功能，恢复真实联机检查

本次从 `dev@9f9036b` 继续处理发布前问题。上游 #449–#451 的合并与冲突审计见 [同步报告](UPSTREAM-SYNC-2026-09-09.md)。operator 仍要求「先不上线」；本次只准备代码、测试和发布记录，不推进 prod，不在服务器执行部署命令。

## 采用的发布范围

- 保留上游修复和 LLmRoute 现有业务定制，继续使用原图片适配器、固定分辨率 SKU、动态档次拓扑与持久客户 token。
- Batch 保持关闭。新 Image 2.5 也增加默认关闭的程序开关，供应商缺陷留待独立修复与验收后再启用。
- 完整测试与构建通过，代码可以进入后续发布流程；这不代表新供应商、收费模型调用、真实支付或数据库升级已经在生产验收。

## 本次代码改动

### Image 2.5 默认关闭

新增 `PORTAL_IMAGE_ADAPTER25_ENABLED`，只接受字符串 `true` 为启用。变量未设置、`false`、`1`、`TRUE` 均关闭。

两个内部 POST 路由通过 `src/lib/image-adapter25/entrypoint.ts` 检查开关。关闭时直接返回中性 `503/upstream_unavailable`，不读取请求体、不调用供应商、不合成 usage；启用时把原请求、模式、provider 交给原适配器，原样返回响应。`.env.example` 与 `.env.prod.example` 都补充默认 `false`；生产模板同时明确既有 `PORTAL_BATCH_ENABLED=false`。本次没有修改实际 `.env`。

新增 10 项入口测试，覆盖两个路由的四种关闭值以及显式启用后的请求/响应透传。上游的适配器实现、provider 注册表、`adapter25.test.ts`、图片 echo 回归与价格回归均未改动，原图片适配器也未改动。

开关只隔离尚未验收的路径，没有修复以下 Image 2.5 内部问题：多图输出按第一张图尺寸合成费用、WebP 尺寸/透明度判断不完整、远程图片下载缺少内网地址与重定向保护且读取后才检查大小、收到响应头后缺少 body 超时、edits mask 未透传。启用前必须分别修复、用失败场景回归并完成供应商真实计费验收。Batch 的收费后崩溃重放和明文凭据保存问题也仍待处理。

### 联机测试先核对目标

新增 `scripts/check-newapi-smoke-target.ts`：先无凭据 GET `/api/status`，拒绝重定向、非 JSON、错误 envelope、超大响应、超时，以及含凭据或额外路径的服务地址；确认 `success=true` 且存在版本字段后，才执行原模型列表鉴权测试。错误信息不输出响应体、凭据或底层异常原文。

原 `client.smoke.test.ts` 仅增加 `beforeAll` 前置检查并修正隧道说明；原有三项测试名称、调用和断言保持不变。`pnpm test:smoke` 可单独运行该文件，完整 `pnpm test` 也执行同一前置检查。另加 13 项前置检查测试。

修改理由：原本 `/api/status` 的 HTTP 200 并不足以区分 new-api 与其他应用，容易把错误端口视为健康，还会把管理员鉴权请求发到错误应用。此修改加强前置条件，没有将失败测试改为可跳过，也没有削弱模型列表断言。隧道恢复前，HTML 响应确实让整个 smoke suite 失败，三项测试未执行；没有把该轮结果算作通过。

## 隧道诊断与恢复证据

- 最初本机 3000 由 HBuilderX 的 `uniapp-cli-vite` 占用，返回 HTTP 200 HTML；既有 LLmRoute SSH control socket 不存在。没有停止 HBuilderX 或修改其他项目端口。
- operator 随后启动 SSH 隧道。`lsof` 确认 SSH 监听 `127.0.0.1:3000`，HBuilderX 仍监听 IPv6 3000；因此本次显式使用 IPv4 地址，不依赖 `localhost` 的地址选择。
- 无凭据前置检查通过后，以命令级 `NEWAPI_BASE_URL=http://127.0.0.1:3000` 覆盖运行完整测试，未编辑用户 `.env`。
- 原三个 smoke 测试全部通过，包括真实 `/api/channel/models_enabled` 的管理员鉴权和非空模型列表。请求仅为 GET 状态/列表；没有调用 `/api/user/token`、创建/删除 Key、修改渠道/价格、发起生成或支付。

## 验证结果

环境：Node `24.19.0`、pnpm `10.30.3`、Vitest `4.1.10`。

| 检查                               | 结果                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| 恢复隧道后的完整 `pnpm test`       | 287 files 全部通过；3680 passed / 1 既有 skipped，0 failed；包含真实联机 smoke        |
| `pnpm typecheck`                   | 通过                                                                                  |
| `pnpm lint`                        | 0 error / 93 个既有 warnings                                                          |
| `PORTAL_SCHEDULERS=off pnpm build` | 通过；本机数据库不可达时静态 pricing 有既有 ECONNREFUSED 降级日志，不代表价格数据验收 |
| 本次文件格式与差异检查             | Prettier 与 `git diff --check` 通过                                                   |

证据目录：`/tmp/llmroute-release-readiness-20260909/`。其中 `full-test-tunnel.log` 为恢复后的完整通过结果，`preflight-tunnel.log` 为无凭据目标确认；旧的 `full-test.log` 和 `preflight-current.log` 留作错误目标的失败对照。

本轮未改 Prisma schema/migration、计费实现、固定 SKU 代理或 new-api 客户端。9 月 8 日的 PostgreSQL 16 隔离迁移验证与 9 月 9 日的费率原故障对照、冲突语义审计、Nginx 隔离测试继续有效；它们均不能替代实际发布时的生产检查。

## 后续发布顺序

1. operator 重新安排上线后，将已验证 dev fast-forward 到 prod，仅从 prod 发布；当前 main 保持 `fd6b2cd`，prod 保持 `02cbf26`。
2. 按权威运维手册核对生产分支、备份 `.env` 和 PostgreSQL，确认两个功能开关都为关闭；不启用可选 Compose profile，不配置新供应商渠道。
3. 核对 Seedance 2.5 在途任务的费率切换边界，以及生产 `SEEDANCE_XHK_MODEL_25_480P` 是否覆盖代码新默认值。
4. 安装并验证包含四类内部适配器公网 404 的 Nginx 配置；执行待发布的 6 条 migration，再按手册切换已构建镜像。
5. 核对迁移状态、容器健康、Portal→new-api、主站/API 公网边界和 OAuth 入口；涉及真实生成或支付的验收单独安排，不能用本次只读 smoke 代替。

用户现有 `.env` 和未跟踪需求文档保持原样，不纳入本次提交。
