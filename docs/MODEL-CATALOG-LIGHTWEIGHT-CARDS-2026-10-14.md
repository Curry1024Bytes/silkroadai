# 模型目录轻量卡片改版与发布（2026-10-14）

Operator 选择“轻量卡片”方向重做客户模型目录。本次改动只调整 Portal 展示与前端分类，
没有修改 new-api 源码、渠道、分组、模型目录数据或价格，也没有新增 migration / 环境变量 / 依赖。

## 最终行为

- 用 1 / 2 / 3 列响应式轻量卡片替换按厂商分段的大型等高卡片，手机端为单列，卡片高度随内容变化。
- 顶部提供类型快捷筛选、模型搜索、厂商筛选和 API Key 分组筛选；筛选为空时给出可恢复的空状态。
- 卡片只展示一个明确命名分组的价格摘要。未选择分组时优先展示默认分组，绝不把跨分组最低价冒充客户价；
  选择分组后只显示该分组实际可用的模型。
- “价格详情”使用原生 dialog 展示该模型所有当前可用分组的完整价格，包括 token 阶梯、缓存价、
  图片 token、分辨率、按秒 / 按次与限时折扣信息。支持 Escape、背景关闭和打开时锁定页面滚动。
- 每张卡保留一键复制模型名，成功和失败均有状态反馈；控件具备可见标签、焦点样式和至少 44px 触控高度。
- 最终验收时发现旧名称分类器把 `Nano Banana` 识别为“其他/对话”、把 `wan-3.0` 识别为“对话”。
  回归修复后，Nano Banana 归 Google / 图像，`wan-3.0` 归视频；数据库中的 image / video 元数据未改。

## 代码与验证

主要实现提交为 `631421269ba96a015375e7c2fceaef4241bdb5d0`，分类修复提交为
`464865b43f81e1933aa91644507a99975aa9bec2`。最终应用版本已推送 `origin/dev` 和 `origin/prod`。

- 定向页面、价格摘要和分类测试先后为 65 项、59 项通过。
- TypeScript 类型检查、生产构建和 `git diff --check` 通过。
- lint 为 0 error / 97 个既有 warning。
- 改版后的完整 CI 为 349 个文件通过 / 5 个文件失败，5594 passed / 45 failed / 1 skipped。
  45 个失败与改版前基线的测试名称和次数完全一致，没有新增失败，不能称为完整测试全过。既有失败位于
  `keys-list-ui.test.tsx`、Enterprise proxy / terminal guard / failed task 与 Seedance CN adapter 测试。
- 使用实际 41 模型 / 69 价格数据完成桌面端、390×844 手机端和价格详情 dialog 的视觉验收；
  没有发现横向溢出，筛选区在手机端纵向排列。

## 生产发布

轻量卡片主体先以 `6314212` 发布；分类修复随后以最终应用 SHA `464865b43f81e1933aa91644507a99975aa9bec2`
于北京时间 2026-10-14 16:27 切换。最终镜像为
`sha256:8dbb42bb72c53620db12672e5e1dc44fc97e620fc1dffa43449c05ec84c516fb`，登录页约 8.29 秒恢复，
Portal restart count 为 0。PostgreSQL、new-api、new-api PostgreSQL 和 Redis 的容器身份及启动时间均未改变。

发布前备份位于
`/opt/backups/silkroadai-portal/releases/model-cards-classifier-20261014-162626/`，权限 0700；其中数据库
压缩包、环境、Compose 和容器状态文件均为 0600。数据库备份通过 `gzip -t`，并恢复到临时隔离库核对为
41 模型 / 69 价格 / 11 分组 / 1 用户 / 1 Key / 0 unfinished migration，临时库随后删除。回滚镜像为
`silkroadai-portal-portal:rollback-model-cards-classifier-20261014-162626`。

最终镜像来自干净 Git 归档，构建上下文和镜像内均无 `.env*` 文件。线上核对结果：

- 源站与公网 `/models` 均为 200，`www` 登录页 200；假 API Key 为 401，API `/login` 和公网
  `/image-adapter/*` 为 404，两类入口的 CORS 预检为 204。
- Google / GitHub OAuth start 均为 302；没有执行真实 OAuth 回调登录。
- Portal → new-api `/api/status` 为 `200|true`；41 模型、69 价格和 85 个有效 migration 均保持不变，
  pending migration 为 0。
- 模型、价格、分组和 API Key 的完整行哈希与发布前备份一致；用户身份、角色、租户及访问凭据等不可变字段
  也一致。启动后的余额提醒任务仅刷新了 `balance_alert_last_sent_at`、`newapi_cached_at` 和 `updated_at`。
- 生产尚未配置 SMTP，因此启动日志存在两条既有 `balance-alert` 告警；除此以外无 error / fatal / failed。
- 生产 `.env` 和 Compose 文件哈希与备份一致，无进行中的价格发布、价格写入或分组退役任务。
- 公网页面实测 `Nano Banana 2` 为 Google / 图像，`wan-3.0` 为 Other / 视频。

本次没有发起收费模型调用、图片 / 视频生成、支付或真实 OAuth 登录。完整服务器证据保存在
`/opt/llmroute-releases/464865b/`。
