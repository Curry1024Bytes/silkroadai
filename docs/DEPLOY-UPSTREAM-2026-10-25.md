# 2026-10-25 上游 55 提交发布结果

本轮已上线。北京时间 **15:51:55** 开始切换 Portal，**15:52:06** 首次探测到新镜像返回 200；
从首次失败样本到首次恢复样本为 **10.443 秒**。这次短暂切换与此前的主机失联是不同事件，
主机失联的恢复经过见 [生产恢复记录](PRODUCTION-RECOVERY-2026-10-25.md)。

## 版本与构建来源

- 上游目标为 `main@48f914ba`，合并范围 55 提交。逐提交变化、33 个冲突文件的三方语义取舍、
  验证边界和功能开关见 [同步报告](UPSTREAM-SYNC-2026-10-25.md)。
- 应用镜像源码：`5a0e613e0017fd4b35bc178c0b171f59510c1b55`，来自已验证的 prod 提交。
  发布时 prod 为 `8427ffe0`，其后续差异仅为工作流、文档、格式和测试超时修正；应用运行代码、
  Dockerfile、启动脚本、包/锁文件和 Portal Compose 与镜像源码一致。后续纯文档提交不重建镜像。
- GitHub 原生 Linux/amd64 构建 `40170169251` 成功；完整 CI `40171693271` 的 Test、Type Check、
  Lint、Format 全部通过。构建上下文由 Git archive 生成并排除 `.env*`，未传入生产凭据。
- 镜像经过原生 sharp 编解码、Prisma CLI、架构、各层环境文件扫描及传输前后 SHA256 校验。
  VPS 只加载镜像，没有再次运行 Next 编译。
- 镜像标签：`silkroadai-portal-portal:release-5a0e613e`。
- VPS manifest digest：
  `sha256:8cc5be5ce4ff0a877e994010e501e4e951c7e71cc9e41787437d2ee1692e8296`。
- 镜像配置 digest：
  `sha256:c05d9ac2c098b39b63e85065e704baef39683e0dd09308f8b08d94cd71fcea40`。
  构建端以配置 digest 显示 image ID，VPS 的 containerd 存储以 manifest digest 显示；已直接读取
  manifest/config 内容，校验两者关系、配置原始字节 SHA256 及全部 18 层的顺序摘要，不是仅比较标签。

## 隔离与生产验证

- 生产备份克隆库完成 **86→88** 条迁移。17 张关键表在增量迁移及 GET 验收前后内容保持，旧迁移
  checksum/历史记录保留，新增六个字段均为可空且旧行保持 NULL。旧镜像的 Prisma 客户端也能读取
  已迁移克隆库，为应用回退提供兼容性证据。
- 候选容器限制为 512 MiB 内存及 memory+swap、0.5 CPU，使用独立 JWT、克隆库，调度器关闭，
  只绑定回环端口。通过只读代理访问 new-api，只放行必要的 pricing/status/options GET；
  有写副作用的 GET `/api/user/token` 也被拒绝。未发生成、支付、邮件或后台改价请求。
- 候选真实 HTTP 验证覆盖：公开页面、客户工作台、匿名/普通用户管理员访问拒绝、过期/错误 issuer/
  失效版本会话拒绝、Key 所有权和脱敏、未知代理路径拒绝，以及完整报价。**41 个模型、69 份
  活动分组报价**与 Portal SQL 原始数据一致，含结构化阶梯/缓存/媒体价格。
- 生产现无用户专属倍率记录；这次克隆验证确认现有客户价与公共价一致，不冒称覆盖了生产不存在的
  专属价场景。其隔离、零倍率及失败关闭场景已在此前隔离真实 HTTP 和完整测试中验证。
- 正式生产仅执行两条新增可空列 migration。生产现为 88 applied、0 活动 unfinished，保留
  1 条既有 rolled-back 历史记录；原迁移名称、checksum、完成/回滚状态及记录数量保持。原查询仅按 migration_name
  排序，同名历史记录在插入新记录后返回顺序变化，审计改用保留重复数量的多重集合比较，未放宽内容校验。
- 正式发布前逐项比较 Compose 归一化配置，仅 `image`、`build.context` 和 `stop_grace_period`
  发生约定变化。环境变量、端口、卷、网络/网关优先级、启动方式和权限等保持一致。
- 使用 `--no-deps --no-build --pull never -t 630 portal` 只切换 Portal；new-api、两套 PostgreSQL、
  Redis 的容器 ID、镜像和启动时间与发布前完全相同，视频维护 timer 保持运行。
- Portal restart count 0、OOMKilled=false。模型/价格/分组/用户/Key、计费选项和未决业务任务
  摘要与发布前保持一致。3 个存量用户的持久 opaque token 均通过真实 `/api/user/self` 身份核对；
  一枚存量客户 Key 的公网 `/v1/models` 返回 200，列出其权限内 4 个模型。
- 公网 15 项检查通过：apex/www 登录、模型广场、价格页、假 Key 401、API 非白名单 404、内部
  适配器隔离、Google/GitHub OAuth 入口 302、两类 CORS 预检。报价响应为 `private, no-store`，
  Cloudflare 为 DYNAMIC。Gemini 原有通配头以浏览器实际 credentials-omit 请求验收，能读取假 Key
  的预期 401；没有把含 Cookie 的凭据模式写成已验收。
- 实际浏览器显示新版模型广场、41 个模型及原人民币分组报价，未发现浏览器 error/warn。
  本轮没有执行真实 OAuth 登录、充值或收费模型生成，不宣称所有供应商推理可用性已经重新验收。

## 备份与回退

- 最新发布前备份：`/opt/backups/silkroadai-portal/releases/upstream-final-20261025-073943/`，
  包含两库 dump、两份环境配置、旧 Compose/发布覆盖文件和 Nginx 配置。目录 0700，含数据文件
  0600，gzip 与 SHA256 验证通过；两份 dump 是独立在线快照，不是跨库原子快照。
- 同一套备份已复制至 operator Mac 的
  `~/Backups/LLmRoute/portal/releases/upstream-final-20261025-073943/`，再次验证 checksum、gzip
  和 0700/0600 权限。合并前 Git bundle/工作区归档及远端恢复标签继续保留。
- 旧应用为 `release-2445fe88`，镜像
  `sha256:7c84a05304cc75bbcd4f17d71e77fd0a5dbe61ccf32e79994a7ef4faf078f5f1`；新增回退标签
  `silkroadai-portal-portal:rollback-upstream-final-20261025-073943` 已核对指向该镜像。
- 当前回退应用可沿用旧配置，保留新增可空列。回退前仍须核查未决定价/撤销任务及后续是否启用了
  新回调能力，不能为回退代码恢复整库并覆盖切换后的交易。

```bash
docker compose --project-directory /opt/silkroadai-portal \
  --env-file /opt/silkroadai-portal/.env -p silkroadai-portal \
  -f /opt/silkroadai-portal/docker-compose.prod.yml \
  -f /opt/llmroute-releases/2445fe88/release.json \
  up -d --no-deps --no-build --pull never -t 630 portal
```

## 后续操作边界

- 服务器的 `/opt/silkroadai-portal` 是历史归档工作目录，不是 Git checkout。prod 源码在
  `/opt/llmroute-portal-source.git`；当前 Portal 使用
  `/opt/llmroute-releases/5a0e613e/source/docker-compose.prod.yml` 与同目录上级的 `release.json`，
  project directory 仍为 `/opt/silkroadai-portal`，以确保原环境文件和持久卷路径不变。
- Nginx 只新增主站 `/gemini-adapter/` 的公网 404，配置测试与源站/公网检查通过。
- Batch、Image 2.5 内部入口、有限 Key 配额、Enterprise callback/reconcile、Gemini 内部适配器
  继续默认关闭；没有擅自启用供应商、改价或修改 new-api 后端。
- 候选容器、临时克隆库及候选凭据已清理，只读代理已停止。故障构建器保持 stopped/restart=no，
  构建日志和缓存状态暂留取证，没有全局 prune 或删除业务卷。
- 脱敏证据与上线截图在本机被 Git 忽略的 `outputs/upstream-sync-20261025/`；服务器发布结果在
  `/opt/llmroute-releases/5a0e613e/deployment-result.json`。真实环境、数据库 dump 和成本材料不提交 Git。
