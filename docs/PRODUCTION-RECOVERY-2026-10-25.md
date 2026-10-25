# 2026-10-25 生产构建期间失联与恢复

本文时间均为北京时间。恢复与上游新版发布是两件事：本次恢复后运行的仍是
`release-2445fe88`，并非候选应用 `5a0e613e`。新版发布结果另行记录。

## 经过与影响

- 55 个上游提交已集成并通过本地验证，候选提交为
  `5a0e613e0017fd4b35bc178c0b171f59510c1b55`。Mac 上的 amd64 仿真构建在 Next 编译时发生
  QEMU signal 11，随后尝试在生产主机使用独立 BuildKit 构建。
- 构建器设置了 1536 MiB 内存、4096 MiB memory+swap、1.5 CPU 配额；主机实际物理内存约
  3.46 GiB、Swap 4 GiB，构建前可用内存约 1.4–1.5 GiB。限制构建器并未保证业务可用性。
- 构建日志最后停在 Next 编译完成、执行 TypeScript 检查阶段。其间网站、API、SSH 命令均出现
  读超时，VNC 输入 root 后也无法继续登录。发生了实际服务中断，不能以“未切换镜像”视为无影响。
- 当时新镜像尚未切换，两条增量 migration 尚未执行，Nginx 候选规则尚未应用。
- 经 operator 授权，14:09:04 提交软重启，服务商记为成功，但 SSH/VNC/HTTP 未恢复。
  随后仅发送一次 VNC Ctrl-Alt-Del 软重启组合键，仍未恢复。
- operator 单独授权“允许一次硬重启，恢复后先检查数据”。14:20:14 提交唯一一次硬重启；
  SSH 恢复后核实实际系统启动时间为 14:20:52，且 boot ID 已变化。
- 14:22 左右确认本次临时构建器已停止，restart policy 改为 `no`。随后原站本机和公网登录
  均返回 200，公网 API 假 Key 返回预期 401。未重新提交收费生成或支付请求。

## 原服务与数据核验

- Portal 运行镜像仍为
  `sha256:7c84a05304cc75bbcd4f17d71e77fd0a5dbe61ccf32e79994a7ef4faf078f5f1`；原五个业务容器
  的 ID/镜像保持，启动时间因整机重启而变化。new-api 在数据库恢复期间有一次启动重试，随后 healthy。
- PostgreSQL 15 与 16 均完成 WAL redo 并接受连接，随后成功全量 `pg_dump`，两份 gzip 完整性
  校验通过。没有恢复旧备份覆盖数据库，没有删除数据库或 volume。
- 原生产环境文件摘要保持一致，主站 Nginx 与发布前备份字节相同，`nginx -t` 通过；
  视频维护 timer 为 active，最近维护服务结果为 success。
- migration 历史共 87 行：86 条已应用、1 条原有 rolled-back 历史记录；当前未完成且未回滚
  的记录为 0，所有历史条目与发布前一致。不得把旧 rolled-back 记录算成本次故障。
- 复用发布前同一份 invariant 脚本，模型 41、价格 93、分组 11、Portal Key 9、用户 3、
  用户专属倍率 0，内容摘要均一致；40 项计费选项摘要、内部适配器列表、未决发布/退役任务均一致。
- 对发布前与恢复后的两套数据库 dump，按 COPY 列定义及完整行摘要比较：new-api 的 46 张表中
  40 张完全一致；Portal 的 58 张表中 54 张完全一致。对其余表进一步按主键逐字段核验，结果如下。

| 差异                        | 核验结果                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------- |
| new-api `casbin_rule`       | 3 个旧 ID 被新 ID 替代；去除 ID 后，完整 `ptype,v0…v5` 权限语义多重集合完全相同       |
| new-api `tasks`             | 4 行只变更 `updated_at`；状态仍为 SUCCESS，任务内容、计费字段、私有数据与结果不变     |
| new-api `system_instances`  | 仅启动时间、心跳、更新时间和运行信息变化；实例标识未变                                |
| new-api `system_tasks`      | 新增 2 条成功的 model_update 任务，旧行未变、未丢失                                   |
| new-api `audit_logs`        | 新增 17 条 access_token 类访问审计，旧行未变、未丢失                                  |
| new-api `logs`              | 新增 156 条 type=5 错误日志，全部 quota=0；没有新增消费日志，旧行未变、未丢失         |
| Portal `request_logs`       | 新增 157 条：156 条 HTTP 400、1 条 HTTP 401；旧行未变、未丢失                         |
| Portal `usage_meter_cursor` | 只变更 `last_run_at`，消费游标没有推进                                                |
| Portal `users`              | 2 行仅 `newapi_cached_at`、`updated_at` 变化；余额、凭据、角色及授权等业务字段未变    |
| Portal `image_tasks`        | 原 17 条未变；恢复后的 14:25:17 新增一条任务，14:25:32 因超时终态 FAILURE；未自动重提 |

用户/余额、Key、渠道、计费选项、充值、订单和账本均与备份一致。上述结论针对比较快照及核验项，
不是所有真实推理供应商可用性的验收；恢复后新增失败任务亦不得写成成功生成。

## 备份、证据与未确认事项

- 发布前备份目录：`/opt/backups/silkroadai-portal/releases/upstream-20261025-044946/`。
  原 Portal 镜像已有回滚标签 `rollback-upstream-20261025-044946`。
- 恢复后完整 dump、只读审计脚本及比较结果放在该目录的 `recovery-20261025-1420/`；目录
  0700，含数据文件 0600。两套数据库分别在线导出，不宣称跨数据库原子快照。
- 本机脱敏证据在被 Git 忽略的 `outputs/upstream-sync-20261025/`：
  `hard-reboot-confirmed.png`、`invariants-after-recovery.json`、`recovery-data-comparison.json`、
  `recovery-newapi-delta.json`、`recovery-portal-delta.json`、`recovery-log-summary.json`。
- 上一 boot journal 没有持久化，现有系统消息中未找到对应的 OOM/hung-task/I/O 错误证据。
  构建与失联时间相关，但不能断言 OOM 或特定内核故障。恢复后的可用内存约 2.1 GiB，Swap 使用为 0。

## 后续发布约束

此 4 GB 生产主机不再执行重型应用编译。使用独立原生 Linux/amd64 环境从已验证的 `prod`
确定提交构建镜像；产物核验后，VPS 仅加载镜像，以明确镜像名和 `--no-build` 切换 Portal。

新增的 `.github/workflows/build-native-amd64.yml` 在受限 dev push 上构建固定的 `5a0e613e`：
构建上下文由 Git archive 产生并排除所有 `.env*`；不传生产凭据；执行原生 sharp/Prisma 检查、
镜像各层环境文件扫描，导出 Docker tar、源码 SHA、镜像 ID 和 SHA256 校验和。产物保留 1 天。
该工作流只负责构建，不自动部署；不使用历史上游的 DockerHub Release 流程。

后续必须完成候选镜像与生产备份克隆库验证，确认两条增量 migration、内部适配器公网隔离和
切换后生产不变量，再单独记录新版上线结果。
