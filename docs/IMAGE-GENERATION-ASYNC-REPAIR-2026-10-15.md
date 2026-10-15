# 生图超时修复与发布（2026-10-15）

## 问题与修复

客户在图片工具使用 `gpt-image-2.5-sunburst` 时看到 `Failed to fetch`。先前生产取证显示，浏览器请求约 59.4 秒后由入口断开（Nginx 499），而 new-api 约 62.6 秒完成生成并计费。同步请求的连接超时使客户拿不到已经生成的结果；页面还曾同时提交 `aspect_ratio: 16:9` 与竖版 `size: 1024x1536`。

应用提交 `5ffcae03` 将图片工具改为已有的异步生图任务接口：提交立即返回任务号，浏览器轮询结果；刷新或网络中断后可以凭同一把 API Key 继续查询。浏览器只持久保存任务号，不保存 Key。R2 未配置时，任务结果仍可返回内联图片数据。页面选择的尺寸与宽高比保持一致。没有改动 new-api 源码、模型价格、渠道、Nginx、环境变量或数据库 schema。

完整测试暴露了此前留下的 46 项失败。提交 `83ff2aae` 修正 Enterprise 测试使用的旧火山适配器 mock、旧资源域名期望和已过时的默认下架假设，并恢复已有后端支持但页面丢失的 Key 别名编辑入口。`dev` 验证后 fast-forward 到 `prod@83ff2aaed660011fd6e43cb86d76daf7e2c92056`。

## 本地验证

- `pnpm test:ci`：355 个测试文件，5648 passed / 1 skipped / 0 failed。
- `pnpm typecheck`、`pnpm build` 通过；`pnpm lint` 0 error / 100 warning。
- 本次改动文件的 Prettier 检查通过。全仓 `pnpm format:check` 仍报告 13 个此前已存在的文件与用户本地未提交文件，未修改这些用户文件。
- 未发起收费模型调用。

## 生产发布与验收

新服务器 `103.240.199.146` 的 `/opt/silkroadai-portal` 是无 `.git` 的源码拷贝，因此从本地已验证的 `prod` 提交制作干净 Git 归档，排除全部 `.env*`，上传到 `/opt/llmroute-releases/83ff2aae/source`。继续使用服务器原有生产 Compose 和环境文件，仅用 release override 指向该构建上下文及新镜像。构建时线上旧容器保持运行。

- 发布前 Portal 数据库备份、环境/Compose/源码 SHA 备份位于 `/opt/backups/silkroadai-portal/releases/image-async-20261015-075406/`，均为 0600；数据库压缩包通过 `gzip -t`。旧镜像回滚标签为 `silkroadai-portal-portal:rollback-image-async-20261015-075406`。
- 运行镜像为 `sha256:224324c57ba02ef8c26aff5c3bec8cd7b5b779c76639a428320fb54cc3e7f06c`，Portal restart count 为 0。`/opt/deploy-state/portal-source.sha256` 已记录完整应用 SHA。
- 数据库仍为 85 条已应用 migration；切换前进行中图片任务、活动定价发布、在途定价写入和分组退役任务均为 0。Portal→new-api `/api/status` 返回 `200|true`，Portal 启动后日志没有 error/fatal/failed。
- 源站登录页与模型页均为 200。新图片任务接口：无 Key 为 401、无效任务号为 400、假 Key 为 401；无 Key 提交为 401。公网登录页/模型页 200，主站任务接口无 Key 为 401，API 专用域名的内部任务接口为 404。
- 本次只做非收费验收，没有真实图片生成。之前采用同步请求且未拿到任务号的失败请求，不能靠新的任务轮询自动找回结果；新的异步任务可在连接中断后继续查询。
