# 视频结果地址修复与发布（2026-10-19）

客户查询已完成的视频任务时，`result_url` 返回 `http://localhost:3000/video-cache/task_….mp4`。视频已在 new-api 缓存成功，但该地址只能在服务器本机使用。Portal 原有重写只识别内层 `video_url`，没有处理这一种缓存结果。

应用提交 `2445fe886f1b3c82b11558a4cb32654b576ec58f` 在传统 `/v1/video/generations/{id}` 和 OpenAI `/v1/videos/{id}` 查询中，将当前任务的受控缓存地址转换为 `https://api.llmroute.club/v1/video-cache/{id}.mp4`，同时处理嵌套结果中的同一地址。新增的文件入口仅接受 `task_` 加 32 位字母数字的 MP4 文件名，通过固定内部路径流式读取 new-api，支持 HEAD、Range 和浏览器 CORS。new-api 继续负责成功状态及缓存有效期校验；当前视频缓存保留 48 小时。

没有修改 new-api 源码、模型价格、环境变量、Nginx 或数据库 schema。

## 验证

- 定向测试 427/427 通过；完整测试 5672 passed / 2 skipped / 0 failed，包含真实只读 new-api 模型列表检查。首次联机检查因本机旧管理员令牌失效返回 401，使用生产当前凭据重跑后通过；没有修改测试断言。
- `pnpm typecheck`、`pnpm build` 通过，`pnpm lint` 为 0 error / 100 个既有 warning；改动文件格式检查及 `git diff --check` 通过。
- 生产真实任务在切换前已复现 `SUCCESS` 和本机地址；切换后源站、公网查询均返回公网视频地址。同一文件 HEAD 返回 200、`video/mp4`、2,731,564 字节；公网 `bytes=0-15` 返回 206 和正确 Content-Range。另从 operator Mac 检查公网 HEAD 为 200。
- 主站登录页、模型页均为 200；API 域名页面、原始 `/video-cache/*` 路径和不存在的缓存为 404；假 Key 模型列表为 401。
- 本轮只查询和读取已生成的视频，没有发起收费生成请求。

## 发布记录

验证后按 `dev → prod` fast-forward 并推送。新服务器使用已验证 `prod` 的干净 Git 归档，在 `/opt/llmroute-releases/2445fe88/source` 构建，生产环境仍由服务器原 Compose 提供。候选镜像检查确认 Prisma 文件可读、新文件入口存在且没有 `.env*` 文件。

- 运行镜像：`silkroadai-portal-portal:release-2445fe88`，ID 为 `sha256:7c84a05304cc75bbcd4f17d71e77fd0a5dbe61ccf32e79994a7ef4faf078f5f1`。
- 北京时间 17:14:23 开始切换，17:14:31 登录页就绪。这两个时间不等同于连续采样的不可用时长。
- 发布前环境、Compose、原发布配置和数据库备份位于 `/opt/backups/silkroadai-portal/releases/video-url-2445fe88/`，文件权限 0600，数据库备份通过 `gzip -t`。
- 回滚镜像：`silkroadai-portal-portal:rollback-video-url-2445fe88`，对应原运行版本 `882f4308`；回滚可使用原 `/opt/llmroute-releases/882f4308/release.json`，仅切换 Portal。
- 切换前活动图片、定价发布、在途价格写入和分组退役任务均为 0。Prisma 目录与原版本完全相同；数据库仍为 86 条已完成、0 条待完成以及 1 条既有 rolled-back 记录，没有执行新增迁移。
- Portal restart count 0、启动后 error/fatal 日志 0，Portal → new-api 状态为 `200|true`；数据库、new-api 和 Redis 容器启动时间不变，`nginx -t` 通过。`/opt/deploy-state/portal-source.sha256` 已更新为应用完整 SHA。

任务标识及客户 Key 不写入本公开报告；后续纯文档提交不需要重建运行镜像。
