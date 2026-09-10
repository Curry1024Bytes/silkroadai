# 2026-09-10 CCMax 渠道编号迁移

北京时间 12:14，已通过 Portal 现有管理 API 完成 `ccmax稳定满血` 档次的渠道 `9 → 14` 引用迁移。12:15 复核：登记渠道仅 `[14]`，旧渠道引用为 0，10 个现有模型均引用 14，导入预览没有渠道读取错误。本次没有发布应用、重启容器、修改 new-api 渠道、执行真实导入或收费推理。

## 原因与处理范围

new-api 渠道 9 已不存在，`GET /api/channel/9` 返回 HTTP 200，但业务响应为 `success:false`、`record not found`。新的同名渠道 14 处于启用状态，仍属于 `CCMax稳定满血` 分组，包含迁移所需的全部上游型号。

operator 已在 Portal 把登记渠道保存为 `[9,14]`，随后尝试只保留 14 时遇到 `tier_in_use_by_enabled_models`。只读复核确认：10 个启用模型仍保存着旧渠道 9；登记新渠道本身不会自动改写模型的 `upstream_map`。现有后台校验因此拒绝移除 9。

本次范围固定为平台租户 `00000000-0000-0000-0000-000000000001`、档次 key `ccmax稳定满血`。以下模型只改该档映射中的 `channel_id`，保留各自 `upstream_model`：

- `claude-fable-5`
- `claude-haiku-4-5`
- `claude-haiku-4-5-20251001`
- `claude-opus-4-5-20251101`
- `claude-opus-4-6`
- `claude-opus-4-7`
- `claude-opus-4-8`
- `claude-opus-5`
- `claude-sonnet-4-6`
- `claude-sonnet-5`

渠道 13 的 new-api 分组为 `default`，未纳入本次迁移。渠道 14 额外提供的 `claude-fable-5-1` 没有因此新增为 Portal 目录模型。

## 备份与执行

生产备份目录：`/opt/backups/silkroadai-portal/channel-replacement-20260910-041150/`，权限 0700。

- `portal-before.sql.gz`：Portal PostgreSQL 完整备份，0600，654,018 字节，`gzip -t` 通过。
- SHA-256：`9991610748eaed82a625c8ec45ca172455065d79afe64113a98de780e075e97b`。
- `plan-before.json`：档次、10 个模型及其价格记录的变更前快照。
- `repair.mjs`：本次受限修复脚本；默认只检查，apply 模式要求登记值、租户、模型集合、目标渠道归属和型号覆盖全部匹配。
- `invariants.sql`、`invariants-before.json`、`verification-after.json`：价格与凭据摘要及执行后核验。

脚本在生产 Portal 容器内使用现有管理脚本鉴权头，凭据只来自进程环境，没有输出或保存到脚本。执行顺序：

1. 只读检查目标渠道 14 启用、分组匹配、无跨档登记冲突，且支持十个现有映射的上游型号。
2. 保持档次登记 `[9,14]`，通过 `PUT /api/admin/models/{id}` 逐项提交仅含 `upstream_map` 的更新。每项写入前检查并发变化，写入后回读并确认价格及其他模型字段完全一致；`updated_at` 正常更新。
3. 确认旧渠道引用清零，再通过 `PUT /api/admin/channel-groups/{id}` 提交 `newapi_channel_ids:[14]`。后台原有活动模型引用校验成功通过，其他档次字段保持一致。
4. 调用 `POST /api/admin/models/import?dryRun=true` 验证默认导入预览；未调用真实导入。

如果执行途中失败，保留有效的过渡登记 `[9,14]` 和已完成迁移，按快照检查后继续，不直接恢复覆盖整库。本次所有步骤均已成功。

## 验证与边界

- 旧渠道 9 的该档模型引用：0；渠道 14 的该档模型引用：10。
- 该档登记渠道：`[14]`；档次 key、显示名、`newapi_group`、启用状态保持原值。
- 默认导入预览选择 `[5,6,10,12,14]`，`channelErrors=[]`；14 已登记且默认选中。
- 全部 5 条 `CatalogPrice` 历史记录的内容摘要前后一致；本次未重算或补建价格。
- 该档两条客户 Key 记录（含非活动记录）的凭据、归属、模型限制等内容摘要前后一致。
- 管理员自己的现有活动 CCMax Key 请求公网 `GET /v1/models` 返回 200，共 11 个模型。Key 只在服务器进程内存和 curl stdin 使用。
- 公网模型列表可能来自 new-api 的当前型号清单；11 个型号可列出不等于全部已有 Portal 目录条目或已通过真实推理。
- 此次修复目录与渠道登记，不代表此前供应商 `No available accounts` 或客户端限制已经恢复；未发起收费推理。

操作完成后，关闭旧编辑弹窗并刷新后台，避免继续看到之前失败操作留下的错误提示。后续替换渠道应完成型号覆盖检查，再迁移登记和模型引用；不要通过删除模型来清除旧引用，以免级联删除价格历史。
