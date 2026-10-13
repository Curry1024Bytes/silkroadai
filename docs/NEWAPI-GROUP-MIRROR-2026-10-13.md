# new-api 分组镜像（2026-10-13）

Operator 明确要求分组增删、名称、用户可选状态和所属渠道全部跟随 new-api，Portal 默认组保留
「GPT特惠反代」。此前 Portal 的自动同步仅新增停用候选，并保留已删除分组，因此新部署仍显示
历史 migration 的 pool/default、official，以及已删除的 vip。

## 行为

- 设置 `NEWAPI_GROUP_SYNC_MODE=mirror` 后，仅平台租户启用镜像；其他租户和未设置的部署保留手动档次兼容模式。
- 从完整分页渠道、GroupRatio、UserUsableGroups 的并集读取分组。名称、用户可选状态、全部渠道归属跟随
  new-api；包括不可选、暂时无渠道、渠道停用和一渠道多分组等状态。`@` 隐藏标签沿用既有内部组语义。
- 管理页刷新立即对账，打开的页面每分钟更新；客户读取可选档次时最多缓存一分钟。来源不完整或失败时
  不提交局部同步，也不把失败误认为删除；客户建 Key 读取失败时拒绝使用未经核验的旧目录。
- 已删除分组标记为不在上游，不再出现在当前列表；内部 key、已有客户 Key、历史价格、账单全部保留。
  显示名更改不换 key；真实组名更改视为删除加新增，不猜测或迁移旧 Key。
- 当前默认组仍由 Portal 明确选择。若默认组被上游删除或改为不可选，新开户拒绝猜测替代组，管理页提示
  选择默认组；在 new-api 恢复该组或设置新默认后恢复。
- 新增两个字段 `upstream_present`、`upstream_synced_at`。验证过的上游镜像允许空渠道和共享渠道；
  手工档次原有空渠道/重复渠道限制保留。模型仍按明确的分组+渠道组合校验，不能从共享渠道猜档次。
- 在同一受发布锁保护的事务中，移除已不属于活动组的模型映射，无映射的模型软下架；价格和成本不变。
  目录/价格同步不得覆盖镜像分组的状态或全量渠道归属。
- 镜像模式的管理页移除分组新建、编辑、启停、替换渠道与删除操作，API 同样拒绝本地覆盖。
  默认分组选择保留。既有删除任务入口保留作审计，不会自动撤销任何 Key。

## 验证与部署准备

- 新增镜像来源完整性、增删/重新加入、真实改名、共享/空渠道、失败节流、事务锁、模型映射和管理 API 测试。
  既有手工模式安全回归没有反向修改；新增镜像模式是 operator 明确指定的独立行为。
- 定向 9 文件 / 201 项通过。类型检查、lint（0 error / 97 个既有 warning）、生产构建通过。
- 首轮完整 CI：347 文件通过 / 5 文件失败，5555 passed / 45 failed / 1 skipped。
  失败标签与同日 OAuth 修复的已核验基线逐项一致，没有新增失败；不能称为完整测试全过。
- 在生产 PostgreSQL 的独立临时 schema、单个回滚事务内验证增量 migration：镜像空渠道允许、手工空渠道
  拒绝，全部回滚；没有修改生产表。历史 migration 一律不改。
- 发布前备份 `/opt/backups/silkroadai-portal/releases/group-mirror-20261013-083829/`，包含环境、Compose、
  容器状态和通过 gzip 校验的数据库 dump（0600）。回滚镜像标签
  `silkroadai-portal-portal:rollback-groups-20261013-083829`。

生产只读确认：new-api 8 分组 / 8 渠道，Portal 11 个历史登记、1 用户、1 Key、0 模型、0 目录价格；
唯一客户 Key 属于「GPT特惠反代」。本次不会改 new-api 源码、分组、价格，也不发收费推理或支付请求。

## 上线与验收

应用提交 `b88c49cdfde230dbd4017cc896e1ebcf46d28055` 已从 dev fast-forward 到 prod 并推送。
最终完整 CI 与首轮计数一致，失败标签与同日已核验基线完全一致。实际发布前再次完成类型检查与生产构建。

新镜像先在隔离恢复库执行完整 forward migration，再用实际 Portal 同步代码读取生产 new-api 的只读
元数据：8 个当前分组、3 个归档组、唯一默认「GPT特惠反代」，原 Key 与价格均不变；第二次同步幂等。
隔离库和临时环境文件已删除。首次独立检查脚本遗漏必填公开站点 URL，在进入同步前被环境校验拒绝；
补齐检查环境后重新恢复隔离库，migration 和实际同步全部通过，无需修改应用代码。

2026-10-13 16:58:10（北京时间）切换 Portal，约 8.1 秒登录页可用。运行镜像为
`sha256:cd0311f0025e9e57e6cc287b4cb749be5ada578da1bbc1eff5d5507b62265ddd`。
服务器环境只新增 `NEWAPI_GROUP_SYNC_MODE=mirror`；现有 Compose 和 new-api 配置不变。
构建目录 `/opt/llmroute-releases/b88c49c/source` 来自干净 prod Git 归档，排除 `.env*`。

- 实际 `/api/admin/channel-groups` 返回 `source=newapi`，8 个分组逐一与 new-api 名称、用户可选状态、
  渠道归属比对一致；重复刷新数据无额外变化。default/official/vip 三个旧登记仅归档，没有撤销客户 Key。
- 85 个有效 migration 与镜像逐项 checksum 一致，0 pending；历史 rolled-back 记录未改。
- 唯一用户的 superadmin 身份保留；用短时会话验证 `/admin/channel-groups`、`/keys`、
  `/api/portal/keys` 都为 200，未登录的管理 API 为 401。会话仅留内存，45 秒后过期。
- 原有客户 Key 的非收费模型列表请求返回 200 / 4 模型；Key 的 id、tier、凭据前后相同。
  Portal 仍为 0 模型、0 目录价格，本次没有自动导入模型、发布价格、收费推理或支付。
- 回滚使用上述旧镜像、发布前 `.env` 和 `source-before.tar.gz`。新增 schema 为向后兼容字段，
  回滚应用时无需删除列或回滚历史数据；后续要继续手动管理档次，应先核对镜像登记和业务要求。
