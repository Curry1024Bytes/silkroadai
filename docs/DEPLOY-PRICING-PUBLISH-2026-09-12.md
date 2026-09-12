# 定价发布生产上线（2026-09-12）

operator 明确批准“配置只读连接、备份迁移上线、只读验收”后，已发布 `prod@becf7f5`。
本轮没有提交真实价格发布、修改 new-api 价格、模型路由、客户 Key 或计费模式。实际扣费继续由 new-api 执行。

## 发布结果

| 项目     | 结果                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- |
| 应用代码 | `becf7f52078b8695f3ee5f61baf10107fc15bdd6`，含 `7375300` 定价发布与 rc.23 兼容修正             |
| 运行镜像 | `silkroadai-portal-portal:release-becf7f5`                                                     |
| 镜像 ID  | `sha256:2ed8a61106fdb59b05bd5b6c1e5c3c96e19917f4fbc1d77a5df5a46dbc794015`                      |
| 构建时间 | 北京时间 12:50:19–12:54:05，旧 Portal 持续运行                                                 |
| 切换时间 | 北京时间 12:57:53–12:58:08                                                                     |
| 可用性   | 25 次本机采样，13 次失败，失败采样跨度 7.623 秒；首次失败至首次恢复 200 为 8.925 秒（约 9 秒） |
| Portal   | 目标镜像运行，restart count 0，发布后日志无 error/fatal/failed                                 |
| 数据库   | 77 条 migration applied，0 unfinished / 0 rolled back，全部 checksum 匹配                      |
| 依赖服务 | PostgreSQL healthy；PostgreSQL/new-api/MySQL 容器 ID、镜像及启动时间未变                       |
| 业务数据 | 29 模型、35 价格版本、6 档次、20 Key 记录，四表内容摘要与发布前一致                            |
| 发布状态 | jobs=0、writes=0、active_job_id 为空；空闲调度器已创建 coordinator 行                          |

开发验证为完整测试 `304 files / 4063 passed / 1 既有 skipped`，typecheck、生产构建、格式检查通过，lint 0 error / 93 个既有 warnings。GitHub Actions 本轮查询未返回运行记录，不宣称远端 CI 已通过。

`main` 未改。代码先在 dev 验证，再 fast-forward 到 prod；生产只拉 prod。后续文档提交仅保存记录，不重建运行镜像。本机 `.env`、IDE 配置和用户原有未跟踪需求文档保留。

## 配置、备份和回滚

发布目录为 `/opt/backups/silkroadai-portal/releases/pricing-20260912-034121/`，目录 0700，证据和备份文件 0600。

- 环境备份：`/opt/silkroadai-portal/.env.bak.pricing-20260912-034121`，0600。
- PostgreSQL 备份：发布目录的 `portal.sql.gz` 与迁移前新取的 `portal-pre-migrate.sql.gz`，各 655975 字节，gzip 完整性通过；首次备份已实际恢复到临时隔离库并应用增量 migration。
- new-api 价格/分组/相关计费选项保存为 `newapi-pricing-before.json`；Nginx 配置另有归档。没有备份或修改 new-api 业务数据表。
- 原 Git 为 `82a3212`，实际原应用为 `c1d9501`；旧镜像保留为 `silkroadai-portal-portal:rollback-pricing-20260912-034121`，ID 为 `sha256:9d61a61fcec28b1cfe6bdaf2fcc3f32cdb844aacbb91a32a7bddc053d7177d07`。

生产新增 `portal_pricing_ro@172.18.%` MySQL 账号，权限严格为全局 `USAGE` 加 `SELECT ON new_api.options`。实际读取四项价格成功，读取其他业务表被拒绝；没有执行 UPDATE 拒绝探针。账号密码随机生成，只进入服务器受保护的 `.env`，没有输出或提交。

生产 `.env` 仅追加 `NEWAPI_PRICING_DATABASE_URL` 和 `NEWAPI_PRICING_RSA_PUBLIC_KEY_FILE`；原内容逐字保留。Portal 通过既有私有 Docker 网络访问 `new-api-mysql`，没有开放新端口。MySQL 原自动生成证书没有可验证的主机名，本轮未改证书或重启 MySQL，采用服务器可信路径取得的固定 RSA 公钥，禁止自动获取公钥。**RSA 只保护鉴权交换，查询传输不是 TLS**；此配置仅限现有可信 Docker 内网。

公钥挂载来源为 `/opt/silkroadai-portal/deploy/runtime/newapi-pricing/mysql-public-key.pem`，目录 0755 / 文件 0644，以只读方式挂载到 `/app/newapi-pricing`；镜像 uid 1001 读取成功。公钥 SHA-256 为 `b8298707be8955920c3b0b66b2ee8f6ffda6d3f66c3cc9bd678ed948514cbc23`。没有取得或复制 MySQL 私钥。

镜像从 prod 的干净 Git 归档构建，排除所有 `.env*` 和运行时信任材料。Linux 镜像 Node 22.23.2，实际预览验证了打包后的只读 Prisma client、MariaDB adapter 与 MySQL runtime 可用。新增 migration 仅创建三张发布表；没有对只读 MySQL schema 执行迁移。Image 2.5 / Batch 继续关闭，Nginx/Cloudflare 未改。

回滚应用不会恢复已改变的远端价格。今后回滚前必须核实没有活动发布任务或 `in_flight` journal，并排除旧执行者/旧请求继续写入；不能直接用旧全表快照覆盖或恢复生产数据库。三张新表保留。处理说明见 [未决写入恢复](PRICING-PUBLISH-UNCERTAIN-WRITES.md)。

## 切换前真实验收与发现的问题

将生产备份恢复到唯一命名临时 PostgreSQL 数据库，使用**同一候选 Linux 镜像**运行迁移及临时 Portal。仅调真实 rc.23 / MySQL 的读取接口和 Portal `action=preview`；调度器关闭，无有效 publish 请求。

第一份 `7375300` 镜像的迁移、恢复摘要与运行权限均通过，但真实预览发现该 rc.23 不支持两个新版可选配置项，故拒绝预览并阻止切换。按实际镜像 revision `0ab0202` 的官方源码完成窄兼容修正；核心四项双读没有降级。原因、源代码链接和回归记录见 [开发报告](PRICING-PUBLISH-2026-09-12.md)。

修正后，自动选择的 GPT 5.5 被现有 `tiered_expr` 规则正确拒绝，compact 候选被渠道检查拒绝；没有为通过验收放松保护。改选已核实普通计费的 `kimi-k3 / kimi`，最终 **13 项验收全部通过**：恢复前后摘要一致、76→77 migration、全部 checksum、非 root 运行、公钥读取、真实四项双读与预览、无任务/写入日志、隔离及生产目录不变。临时容器、数据库和含密环境文件均已清理，三个尝试的证据分别保留。

期间一次 SSH 会话中断，复核生产仍正常。重建控制连接后本机 3000 转发曾缺失，完整测试的 smoke 前置检查据实失败；恢复转发后全部重跑通过。该异常没有引发生产切换或价格写入。

## 发布后只读验收

- 生产 Kimi 预览返回 200；真实管理员 API 与 MySQL 的 ModelRatio、CompletionRatio、ModelPrice、GroupRatio 四项规范化对象一致。前后全部相关 new-api 选项、Portal 目录和 Key 表摘要不变，jobs/writes 均为零。
- 12/12 活动用户持久令牌均非 JWT，`GET /api/user/self` 鉴权成功且 ID 匹配。未调用令牌轮换接口。
- 管理员自己的一个现有 Key，普通 UA 与 Python-urllib UA 的公网 `/v1/models` 均为 200，返回相同 4 个模型。metadata 有效，3 个可匹配目录价格全部一致；没有创建/删除 Key 或收费推理。
- 全部用户仍为 `billing_mode=newapi`，全局也为 new-api 计费。动态档次的默认、渠道归属、模型映射和活动 Key 归档异常计数均为零。
- 三档固定图片目录价与 new-api 实际倍率换算均为 ¥1 / ¥1.5 / ¥2，未改动。
- 50 项源站/公网检查完成：首轮 45/50，本机 5 项 API 请求超时；本机对同一批请求定向复查 5/5 通过并保留初始结果。没有为通过检查修改 Nginx/Cloudflare。两类 CORS 正常、内部适配器公网 404、OAuth start 跳转与 query 日志脱敏正常。Gemini 通配头仍仅按无 Cookie 模式验收。

真实改价、收费生成、支付与真实浏览器 OAuth 登录没有在本轮执行。首次真实改价仍需 operator 指定模型、档次和金额；四个 GPT 主型号（5.4、5.5、5.6-sol、5.6-terra）现用阶梯计费（见 `newapi-pricing-before.json` 的 `billing_setting.billing_mode`），不能通过通用普通价格表覆盖。两项倍率 PUT 不原子的短暂混价限制仍存在。

主要证据为发布目录的 `isolated-check.json`、`production-preview.json`、`production-business.json`、`production-verification.json`、`availability.json`；本机脱敏副本与网络初始/复核结果位于 `/tmp/llmroute-pricing-release-20260912/`。
