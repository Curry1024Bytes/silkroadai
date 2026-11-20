# 模型重新上架恢复管理列表显示

2026-11-19 完成排查和线上数据修复；2026-11-20 09:01（北京时间）代码已上线。

## 问题与修复

模型管理默认过滤 `archived=true`。目录同步将停用模型重新上架时只更新
`enabled` 和渠道映射，遗留归档标记使其继续从管理列表隐藏。归档功能上线时归档数量为零；
现有记录不足以确定这批模型最初归档的具体操作者及原因。

- 目录同步在 `enabled=false → true` 时同时清除旧归档；预览明确显示取消归档。
- 手动请求启用模型时，若未明确指定归档状态，同样取消归档。
- 已在售模型的主动归档、未能重新上架的停用模型继续保留原归档状态。
- 归档状态纳入同步预览签名；状态变化后旧预览失效。取消归档与上架、目录价格写入同事务提交或回滚。
- 无数据库 migration、环境变量、new-api 源码或计费规则变更。

## 验证

新增 9 项回归，覆盖重新上架、手动启用、主动归档保留、价格缺失、价格写入失败回滚、
其他租户不受影响和旧预览拒绝。定向 100/100；全量非 smoke 测试为
416 files / 6507 passed / 1 既有 skipped。类型、格式、生产构建通过；lint 为 0 error / 102 既有 warnings。
本机构建使用不可连接的占位数据库及 new-api 地址，未进行收费调用。

## 线上存量修复

先备份 Portal 数据库及生产环境，再对平台租户、明确列出的 10 个已启用且映射渠道 20 的
Claude 模型执行一个事务：只取消归档并更新时间，其他模型字段逐项核对不变。
另写 `model_archive_repair` 管理审计；6 个停用 Claude 模型继续归档。

接口验收：`q=claude` 默认列表返回 10 个启用、未归档模型；`q=claude&archived=true`
返回 6 个停用、已归档模型，均为 HTTP 200。

- 备份：`/opt/backups/silkroadai-portal/releases/model-unarchive-20261119-175308/`。
- 证据：`/opt/llmroute-releases/model-unarchive-20261119-175308/evidence/claude-archive-repair.json`。
- 数据库 gzip 校验通过；备份及证据目录 0700、文件 0600。

## 代码发布与验收

- 应用源 `2f10e4fce420a54ca188f8d4d4ae71ef00d23103`，构建配置 `58a1a69f`；
  CI `44500894317` 通过，原生 amd64 构建 `44500894417` 第 2 次运行通过。
  第 1 次运行在 prod 祖先校验处停止，按流程快进 prod 后重跑，未切换生产。
- 运行镜像 `silkroadai-portal-portal:release-2f10e4fc`，engine ID
  `sha256:7f5bcdafa981235c20830b8d1e8f2e9aac7047ba931b4d119fbfb4a364902be2`。
  ZIP SHA256、源码 revision、linux/amd64、18 层 RootFS 与归档配置均核对一致。
- 先在回环 13002 启动关闭调度器的临时实例，管理接口及页面验收通过后仅切换 Nginx 上游端口；
  再替换主实例，验收通过后将 Nginx 原文件逐字节恢复并排空、删除临时实例。
  主实例启动于北京时间 2026-11-20 09:01:38；切换期间 42 次源站登录探测全部成功，
  这是采样结果，不代表连续公网可用率测量。
- 主实例与临时实例均验证默认 Claude 列表 10 条、归档列表 6 条及修复代码存在；
  7 项公网页面、API 鉴权及内部路径隔离检查通过。Portal restart 0；
  new-api、两套 PostgreSQL、Redis 的身份及启动时间不变。
- 无新 migration，94 applied、0 unfinished；切换前后模型、价格历史及档次表指纹不变，
  主实例环境不变。保留回滚标签 `rollback-model-unarchive-20261119`，无需恢复数据库。
- 启动观察到一次已有的 customer-provisioning worker 事务启动超时告警；归档修复未修改该 worker。
  队列核对为 `completed=1`、无待处理任务；不将本次记录写为日志零错误。
- 发布完成后另备份 `portal-after-rollout-20261120-090500.sql.gz`；原始及发布后数据库备份均已
  在 Mac `~/Backups/LLmRoute/portal/model-unarchive-20261119-175308/` 保存并验证 gzip/SHA256。
  上传 ZIP、大 TAR、临时下载凭据已删除，镜像、校验元数据、发布脚本和证据保留。

最终证据为同一发布目录下的 `evidence/final-verification.json`、`origin-probe.json` 和
`database-{before,after}-rollout.json`。后续纯文档提交不重建运行镜像。
