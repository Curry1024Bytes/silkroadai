# 定价发布的未决写入恢复

本文是开发阶段的恢复设计和工具说明，不授权上线或修改生产配置。生产操作仍遵守 `deploy/部署与运维手册.md`，并由 operator 明确安排。

## 为什么回读价格还不够

每次价格 PUT 前，Portal 先在独立 PostgreSQL 事务里保存 `pricing_publish_writes` 的 `in_flight` 记录；收到明确成功响应后，再独立提交 `acknowledged`。主发布事务崩溃不会抹掉该记录。记录只保存任务、选项名称和请求哈希，不保存凭据或请求全文。

HTTP 超时、连接中断或进程崩溃后，旧请求可能仍在 new-api 服务端执行。即使管理 API 和 MySQL 此刻都显示旧值或目标值，也不能证明旧请求已经结束。迟到的整表 PUT 可能覆盖下一次发布。因此，只要存在 `in_flight`，任务就必须保留发布锁，不能自动补写、宣告成功或安全取消。

`acknowledged` 表示已收到明确成功响应；实际运行价格与持久价格仍须继续核验。`resolved` 仅表示 operator 已提供“旧管理请求全部结束”的人工确认，不能当作价格已生效。

## 人工恢复要求

1. 定位未决记录对应的 new-api 实例、发生时间和管理请求。由 operator 核实旧 Portal 发布执行者已经退出或确定不能继续发出请求，并确认 new-api 旧请求已完成或已终止，记录事件编号、排查依据与处理人。仅检查两处价格、检查当前没有请求或等待固定时间不算终态证据；暂停的旧进程以后仍可能醒来提交请求。
2. 如必须停止相关进程才能排除旧请求，需要另行评估线上影响并取得相应部署/维护授权。本工具不重启 new-api、不终止进程，也不自动修改其配置。
3. 先以只读模式列出未决 ID 和哈希，再逐条附带人工确认解除。禁止在 evidence 中填写 API Key、密码或数据库连接串。
4. 工具只把该条 journal 标为 `resolved`，记录确认人、说明和时间；它不会释放任务锁或安排重试。随后在定价页继续核验，由原任务重新读取两端状态。若价格出现第三种值或其他配置变化，仍会停止，不能强制覆盖。

在项目目录运行（已配置正确的 Portal 数据库连接；Node 的 `react-server` 条件用于加载服务端模块）：

```sh
NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/resolve-pricing-write.ts
```

默认只读，可追加 `--write-id <UUID>` 只看一条。以下命令会修改 Portal journal，只有 operator 完成上述终态核验并明确批准后才能执行：

```sh
NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/resolve-pricing-write.ts \
  --write-id <UUID> --apply --confirm-upstream-requests-ended \
  --operator '<处理人>' \
  --evidence '<事件编号、对应实例、旧请求结束的证据及核验时间>'
```

工具取得与发布器相同的协调行锁后才修改 journal；必须属于当前持锁任务，且仍是未决状态。它记录的是人工声明，不能自动证明该声明正确。已确认但仍无法排除迟到请求时，应保持阻塞。

## 数据库连接要求

发布事务持有一条 PostgreSQL 连接，journal 必须通过另一条连接独立提交。因此连接池至少需要两条可用连接，并应为正常 Portal 请求保留余量；不能使用单连接测试替身代替这一事务行为。当前 `src/lib/db.ts` 的 `PrismaPg` 使用默认连接池。若连接获取或 journal 提交失败，流程不能继续 PUT；独立事务使用 5 秒获取等待与 10 秒事务超时。

客户专属倍率的保存和停用也与发布协调行互斥，以避免改价过程中改变 `GroupGroupRatio`。这两个旧流程的本地读写需要连接池余量。存量 Key 迁移不修改全局价格选项，继续采用原有事务与补偿流程，不纳入新的 120 秒发布事务。

新的 durable journal 只覆盖本次定价发布任务的 `ModelRatio`、`CompletionRatio` 和 `ModelPrice` PUT。客户专属倍率仍沿用原有回读与补偿能力，新增互斥和 30 秒管理写入超时不意味着它也获得了同样的崩溃恢复保证；不要把两类操作混为一谈。
