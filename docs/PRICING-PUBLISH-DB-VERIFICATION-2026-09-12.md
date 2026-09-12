# 定价发布真实隔离数据库验收（2026-09-12）

本轮仅在本机临时 Docker 容器开发验收，没有连接生产数据库、读取项目真实 `.env`、部署 Portal 或调用真实推理、支付及客户 Key 接口。

最终验证于北京时间 **2026-09-12 11:19:40–11:19:59** 完成：**3 files / 10 tests passed**。数据库为 PostgreSQL **16.15** 与 MySQL **8.4.11**，均使用新容器、回环随机端口、临时库和随机生成凭据。Portal 使用实际 Prisma client 和定价发布模块；new-api HTTP 接口是本机可控制的模拟服务，能够分别改变内存响应与真实 MySQL 数据。

| 项目                | 实际场景与结果                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 只读权限         | `SHOW GRANTS` 恰好为全局 `USAGE` 与 `SELECT ON newapi_fixture.options`；真实 Prisma SELECT 仅返回四项价格，ORM UPDATE 被 MySQL 拒绝，原值不变。                                              |
| 2. 核验前置条件     | 未配置持久化连接、API 与 MySQL 值不一致均拒绝预览；没有生成任务，也没有 PUT。                                                                                                                |
| 3. 目录事务回滚     | PostgreSQL trigger 在第二条 CatalogPrice INSERT 抛错，独立 sequence 证明已尝试两次写入；目录整批回滚，四条原价格不变。任务进入 retry_wait；解除故障后恢复为六条价格，远端 PUT 总数保持两次。 |
| 4. 假成功响应       | HTTP PUT 返回 200 且内存改变，但 MySQL 不落库时，目录不发布。待隔离库持久值追上目标后重试成功，没有追加 PUT。                                                                                |
| 5. 不同任务并发     | 两个不同模型同时入队，只有一个任务成功持久化并占用协调器；入队阶段没有远端写入。                                                                                                             |
| 6. 双 worker        | 两个 worker 并发执行，只有一次成功发布；最多一个 PUT 在途，共两次选项 PUT、两条新增目录价格。                                                                                                |
| 7. 未确认写入时崩溃 | 子进程完成第一项 MySQL 写入、HTTP 响应仍被扣留时真实 SIGKILL。新进程看到持久 in_flight journal 后进入 conflict；没有后续 PUT 或目录写入，取消被拒绝，协调器继续占用。                        |
| 8. 已确认写入后崩溃 | 两次 PUT 均已响应并持久记录 acknowledged、最终核验响应被扣留时真实 SIGKILL。目录事务回滚；新进程从已保存任务恢复成功，两次 PUT 没有重放。                                                    |
| 9. TLS 只读连接     | 使用仅为本机 fixture 签发的可信证书，实际只读模块成功读取四项价格；真实 ORM 写入仍被拒绝。                                                                                                   |
| 10. 固定 RSA 公钥   | 每次清除 MySQL 鉴权缓存后，正确固定服务端公钥成功、无关公钥失败、恢复正确公钥再次成功；全程 `allowPublicKeyRetrieval=false`。                                                                |

## Migration 与覆盖边界

隔离 PostgreSQL 从验收开始时 HEAD 的空 schema 初始化，再应用 `20260912040000_add_pricing_publications`，包含任务、协调器和独立写入 journal 三张表。**没有回放完整历史 migration 链或生产数据**，因此不替代发布前的生产备份恢复和增量 migration 验收。

HTTP new-api 是模拟服务，价格持久化使用真实 MySQL；这验证 Portal 对明确故障时序的处理，不等同于对真实 new-api 二进制、生产网络及账号权限的验收。开发中的用户界面、完整测试和生产构建由主任务另行记录。

## RSA 连接边界

`NEWAPI_PRICING_DATABASE_URL` 的 `?ssl=true` 优先使用校验服务端证书的 TLS。没有 TLS 时，可通过 `NEWAPI_PRICING_RSA_PUBLIC_KEY_FILE` 固定已核实的 MySQL 公共鉴权密钥；文件必须为绝对路径、普通文件、不超过 16 KiB，且只含一个 RSA PEM 公钥。兼容 MySQL 生成文件末尾的单个 NUL，其他不合法内容拒绝。不会从网络自动取得公钥。

固定 RSA 公钥保护鉴权过程，**不会加密后续 SQL 流量**，只能用于明确可信的私有 Docker 网络。生产配置需要只读挂载已核实的公钥及仅有 `SELECT options` 权限的独立账号。本轮没有配置生产账号、修改或重启生产 MySQL。

## 证据与清理

本机证据目录为 `/tmp/llmroute-pricing-persistence-20260912/integration/`：

- `final-test.log`：最终 10 项测试输出。
- `evidence.json`、`reader-evidence.json`、`rsa-evidence.json`：事务、权限、TLS 和公钥对照摘要。
- `integration.test.ts`、`reader-real.test.ts`、`reader-rsa.test.ts`、`worker.case.ts`：本轮实际隔离测试脚本。
- `cleanup.json`：北京时间 **11:22:02** 确认两个专用容器及其匿名卷均删除；临时连接凭据、容器 env 文件和 TLS 私钥均删除。日志扫描未发现临时数据库密码。

当前没有提交可一键复跑的隔离 harness：本轮脚本仍包含本机绝对路径及单独准备 TLS fixture 的步骤，不能当作通用测试入口。保留上述无凭据证据，后续如需 CI 集成，应先把数据库创建、证书准备及异常清理整合为仅允许创建新容器的独立入口，禁止复用既有数据库或读取项目 `.env`。
