# new-api 目录同步生产发布（2026-09-11 17:25）

operator 明确「上线！」后，已将验证通过的 `dev@c1d9501` fast-forward 到 `prod`，并从 prod
发布统一的 new-api 同步预览功能。模型管理与渠道分组共用入口，确认后在 Portal 保存所选变化。
本次仅上线功能，**没有在生产执行价格同步确认、上架新模型或修改 new-api 配置**。

## 发布结果

| 项目                 | 结果                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| 运行代码             | `c1d95016032415c0889df23f355215bcea689224`                                |
| 运行镜像             | `silkroadai-portal-portal:release-c1d9501`                                |
| 镜像 ID              | `sha256:9d61a61fcec28b1cfe6bdaf2fcc3f32cdb844aacbb91a32a7bddc053d7177d07` |
| 构建时间（北京时间） | 17:15:34–17:19:16，旧 Portal 持续运行                                     |
| 切换时间（北京时间） | 17:25:15–17:25:30                                                         |
| 可用性               | 26 次本机采样中 13 次失败，失败采样跨度 6.824 秒，约 7 秒后恢复           |
| Portal               | 目标镜像运行，restart count 0，启动日志无 error/fatal/failed              |
| 依赖服务             | PostgreSQL healthy；PostgreSQL/new-api/MySQL 的容器 ID 与启动时间未变     |
| 数据库               | 76 条 migration 均完成且 checksum 匹配，没有新增 migration                |
| 配置                 | `.env` 摘要不变；Nginx/Cloudflare 未改；Image 2.5 / Batch 继续关闭        |

后续文档提交仅保存发布记录，不重建运行镜像。`main` 未改，用户本机 `.env`、IDE 配置和未跟踪
需求文档均保留。切换前确认连续三次无 Portal 入站 established 连接，未结算视频及 Batch 任务为零。

## 备份与回滚

- 环境备份：`/opt/silkroadai-portal/.env.bak.sync-20260911-091532`，0600。
- 数据库备份：`/opt/backups/silkroadai-portal/releases/sync-20260911-091532/portal.sql.gz`，656630 字节、0600，`gzip -t` 通过。
- Nginx 归档及发布证据保存在同一 release 目录，目录 0700；归档为 0600 并通过完整性检查。
- 旧 Git：`86cb84ee9d48e99b553769e520be8293d1297555`；实际旧应用代码为 `e69f225`。
- 回滚镜像：`silkroadai-portal-portal:rollback-sync-20260911-091532`，ID 为 `sha256:1d607b258ab6826d8fafadcc6b6ac6e241650bec7ed79eed09103a3332cfafe1`。

使用 prod 的 Git 归档作为构建上下文，排除所有 `.env*`；公开 build args 仍从现有生产 Compose 读取。
新镜像的非 root 用户、migration 文件可读性、没有 `.env*` 文件和两个关闭开关均通过一次性容器检查。
最初 `npx prisma migrate status` 因 runner 未提供 CLI bin 链接而失败；按现有 `start.sh` 的方式定位
`prisma/build/index.js` 后执行只读 status 成功。原失败日志保留，没有修改镜像或 migration 历史。

本次无 schema 改动；紧急回退可使用已保存镜像，不应恢复覆盖生产库或删除已保存的目录/价格历史。
正常修复仍在 dev 完成验证，再 fast-forward 到 prod 发布。

## 真实 PostgreSQL 写入验收

切换前，将本次备份恢复到唯一临时数据库，并用**同一发布镜像**启动仅绑定回环地址的临时服务。
数据库 URL 仅替换库名，使用临时随机管理员令牌和 JWT secret，调度器关闭、Sentry 清空，直接启动
`node server.js`，不运行迁移启动脚本。new-api 只接受本功能的渠道/配置 GET 读取。

24 项检查全部通过：

- 恢复后的目录与生产快照一致：6 个档次、29 个模型、5 个价格版本。
- 真实 API 预览默认选择 30 项缺失价格，确认后完整追加，档次和模型均零改动。
- 临时 PostgreSQL trigger 在第二笔价格 INSERT 时故意报错；非事务序列值为 2，且事务后的目录
  摘要与执行前一致，证明第一笔已执行的写入也完整回滚。
- 移除 trigger 后同批确认成功，原有价格历史、成本、模型/档次启用状态与其他租户哨兵保持不变。
- 跨租户签名与旧预览重放均返回 409；再次预览已反映全部新增价格。
- 临时容器、数据库和含密环境文件均已删除；生产目录三表前后摘要一致。

首轮测试请求曾发生启动阶段连接重置；当时 Next.js 刚监听端口，尚未就绪。测试脚本补充只读预览
就绪等待后重跑通过，没有修改应用代码。两轮临时资源均完成清理。

证据为 release 目录中的 `isolated-sync-smoke.json`；本机副本为
`/tmp/llmroute-sync-release-20260911/isolated-smoke/evidence.json`。

## 生产只读业务验收

发布后 45 项检查通过：

- 新同步接口未授权为 401；管理员默认预览为 200；缺少预览的确认请求为 400，未进入写入阶段。
- 实际预览有 38 项变化/提示，其中默认选择 30 项补价，保留 5 项已有价格、6 个档次归属。
- 发布前后 `channel_groups`、`catalog_models`、`catalog_prices`、`newapi_tokens` 的内容摘要一致；
  仍为 6 个档次、29 个模型、5 个价格版本、20 个客户 Key 记录。
- 启用默认档、渠道唯一归属、活动模型映射、活动 Key 归档和 new-api 计费模式检查通过。
- 固定图片 1k/2k/4k 当前价仍为 ¥1 / ¥1.5 / ¥2。
- 12/12 活动用户的持久 token 非 JWT，`GET /api/user/self` 鉴权通过且用户 ID 匹配；未旋转 token。
- 管理员自己的现有客户 Key 经公网模型列表返回 200、11 个模型；普通 UA 和 Python-urllib UA
  均通过。本次没有把 UA 测试表述为所有官方 SDK 或真实模型推理验收。

生产没有执行带有效选择的 `dryRun=false` 同步确认，没有收费生成、支付或客户 Key 创建/删除。
浏览器交互沿用开发阶段桌面/手机验证；本次没有重复真实浏览器 OAuth 登录。

## 源站与公网验收

50 项全部通过：apex/www 的登录、模型、价格页面均为 200；API 假 Key 为 401，非 API 路径和
四类内部适配器在源站/公网均为 404；两类 CORS 为 204；Google/GitHub start 为 302 到官方域名。
web/API 日志均记录了测试路径且不含 query marker。

首轮检查有两项脚本误判：Gemini 返回 `Access-Control-Allow-Headers: *`。按既有无 Cookie、
`x-goog-api-key` 模式正确处理该通配符后，复核 50/50 通过；不能扩大解释为携带 Cookie 的任意
凭据模式。首次结果与修正后结果均已保留，没有为通过验收修改 CORS 或 Cloudflare 配置。

本机发布证据目录为 `/tmp/llmroute-sync-release-20260911/`。功能语义和使用说明见
[目录同步开发验收报告](NEWAPI-CATALOG-SYNC-2026-09-11.md)。
