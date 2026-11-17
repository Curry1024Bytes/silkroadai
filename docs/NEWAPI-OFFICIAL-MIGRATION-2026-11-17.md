# new-api 官方 rc.51 迁移记录（2026-11-17，已放流）

## 当前结论与记录边界

本次将生产二开 new-api 切换为固定版本的官方镜像，并在 Portal 补齐官方认证与接口能力兼容，不修改官方 new-api 源码。现有客户、密码、余额、推理 Key、日志和价格历史属于迁移保护对象。

**生产已于 2026-11-17 19:07:12（北京时间，UTC 11:07:12）正式放流。** 官方 rc.51、20 个客户与 1 个管理员的 PAT、Portal 官方兼容镜像均已安装；正式凭据验证、Portal HTTP 84/84、两库最终数据审计及 Astra 配置读回通过后，release 核对 `HTTP_ACCEPTANCE.json` 绑定的 6 份证据 SHA-256，撤除维护入口。放流后的 Mac curl 公网检查 **19/19** 通过，源站 Nginx 健康，两类 CORS 为 204；官方 new-api、Portal、两库和 Redis 均运行，restart count 与 OOM 均为 0。

本文汇总主任务及并行验证代理提供的执行结果，并核对仓库脚本和计费演练记录。下文区分隔离演练、生产内部验收及放流后的公网检查；本次没有发起收费模型请求。

## 固定版本与回滚基线

| 对象                                   | 固定值                                                                                                    | 状态                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 官方 new-api                           | `calciumion/new-api:v1.0.0-rc.51@sha256:d6effcdbc58175494765c0cc5954bdacb2300516eec79ba1a9c61f9b9fae7b49` | 已用于隔离演练及生产官方启动       |
| 原二开 new-api 回滚镜像                | `sha256:f468814239b28ee83479bb47422e2b1e39460f8c14f9e8c53b0e3628bd5fe673`                                 | 作为原运行镜像保留                 |
| Portal 源提交                          | `7a65f7b644b53b7ba2be039d3e7932f1716faae7`                                                                | 包含官方兼容及开户恢复修复         |
| Portal 发布 tag                        | `silkroadai-portal-portal:release-7a65f7b6`                                                               | 生产已启动并完成放流前 HTTP 验收   |
| Portal Docker engine / OCI manifest ID | `sha256:189f98f7e88ef5d55e04b58288d67d8e293d8be41983bae02a5fb6e012064e7c`                                 | 主任务提供的构建产物身份           |
| Portal archive Config ID               | `sha256:43d6f2d1864ba7b33ef743699b8aed851621a8c191db576d6fbee5ff0c54032c`                                 | 与上一项是不同层次的标识，不能混用 |

Portal 启动脚本要求镜像架构为 `amd64`，OCI revision 标签必须与上述完整源 SHA 一致；生产实际运行镜像及来源已通过 `cutover/portal-provenance.json` 核对，release 再次确认运行镜像与已验收镜像一致。旧 Portal 运行镜像由停机备份中的容器 inspect 和回滚 override 保留，不用新镜像覆盖回滚基线。

## 迁移范围和数据保护

迁移基线有 25 个 Portal 用户，其中 20 个 active、5 个 disabled。20 个活跃用户必须一对一映射到有效普通 new-api 用户（role 1）；管理员使用已配置的有效 root owner（role 100）。5 个禁用用户保持禁用，既有上游身份缺失也不自动重建，不为其签发 PAT。

本次允许的业务变化仅包括：

- 为 20 个活跃客户和 1 个 Portal 管理员签发限定 scopes 的 PAT；Portal 活跃用户的内部 `newapi_access_token` 与管理员环境凭据随之更新。
- Portal 显式设置 `NEWAPI_DISTRIBUTION=official`，采用已确认的官方接口能力。
- 审计过的 channel 13 从二开 type 65 转为官方 TaskPlugin type 61。
- 为 `gpt-6-astra` 增加显式计费模式及保价表达式，抵消官方缓存归一化变化。
- 官方程序执行其数据库升级；双库回滚必须恢复配对备份，不能只换回旧镜像。

迁移不改变客户密码、账户余额、现有推理 `sk-` Key、历史消费和 Portal 价格历史。Portal 启动后的余额告警调度器另为 2 个符合候选条件的用户刷新 `newapi_cached_at`，并由 Prisma 联动 `updated_at`；已逐字段确认仅这两列缓存元数据变化，余额缓存数值与其他业务字段完全一致。验收保留这些真实刷新记录，没有恢复旧时间戳掩盖差异。不新增模型路由逻辑，不直接向供应商发送模型请求。

## 备份、维护和双库恢复演练

私有证据根目录为 `/opt/new-api-migration/rc51-20261117-170139`。生产 new-api 使用 PostgreSQL 15，Portal 使用 PostgreSQL 16；本次以当前实际环境为准，不采用旧运维快照中的 MySQL 假设。

生产停机备份按以下边界执行：先确认无进行中的计费、生成、开户和发布任务；Nginx 阻止新公网请求并等待旧 worker 排空；停止 Portal，确认 new-api 监听端无直接连接后再停止 new-api。两应用停止后保存两库 dump、new-api 持久数据、环境及 Compose 配置、镜像身份和数据不变量。

`cutover/BACKUP_COMPLETE` 于 **2026-11-17 18:49:18（北京时间，UTC 10:49:18）** 完成。两个 dump 除目录检查外，还通过 `pg_restore --file=/dev/null` 完整解码；持久数据压缩包通过归档检查，文件有大小和 SHA-256 清单。22 个停机备份文件已复制到 Mac 的 `/Users/elon/Backups/LLmRoute/new-api/rc51-20261117-170139/cutover`，逐项 SHA 校验一致。放流后另将 105 个配置、迁移和验收证据文件打包保存至同级 `final/`，归档及解包后各文件的 SHA-256 / 大小均已校验，文件权限 0600、目录权限 0700。归档 SHA-256 为 `c8280b71bf3f1df27893a0be72c19f969d621e1ac5cb8395b81ed416ddc5edcb`。私有配置、dump 和凭据不纳入本报告。

隔离恢复已完成两组演练。演练数据库只接 Internal 网络，无发布端口；启动应用前清除供应商凭据，关闭背景渠道任务，未发模型请求。第二组演练先将两库恢复到独立 PostgreSQL 15/16 容器，运行官方升级与 Astra 安装，然后故意修改 new-api 余额及 Portal 内部凭据，再从配对备份完整恢复。验证结果为：

- 两库受保护数据均恢复一致，官方新增 `user_access_tokens` 表消失，原二开镜像重新启动成功。
- Portal 备份的 `users` COPY 数据与恢复后的新 dump 逐行比较，25 行完全相同，包含原内部凭据。
- 恢复操作只针对隔离克隆，没有将演练数据恢复到生产。

证据为 `rollback-rehearsal/result.json` 与 `rollback-rehearsal/credential-restore.json`。这证明备份能恢复，不能替代当前生产切换后的验收。

自动回滚仅允许在尚未放流时使用。放流前写入 `PORTAL_TRAFFIC_MAY_HAVE_STARTED`；之后必须先核对新增客户写入，禁止直接恢复旧库而丢失新数据。备份中断并恢复旧服务后会标记 `BACKUP_ABORTED`，该轮旧备份不可再复用。

最终证据异机校验完成后，已清理本任务专用的 6 个隔离容器、4 个独占匿名数据卷和 2 个内部网络。清理前确认资源精确归属、未被生产共用；清理后核对 5 个生产容器的 ID、镜像及启动时刻均未改变。生产配置、备份、旧镜像和演练证据保留。

## PAT 迁移和权限边界

客户 PAT 的 scopes 为：

```text
api_key:read api_key:reveal api_key:write profile:read
```

管理员 PAT 的 scopes 为：

```text
user:read user:write log:read channel:read channel:write option:read option:write profile:read
```

PAT 迁移先将完整恢复 manifest 原子写入私有目录，之后才写数据库。每 owner 事务加锁，计入过期记录后仍遵守官方每用户 20 条 PAT 上限；Portal 凭据用 CAS 更新，恢复或重跑不重复签发、不覆盖并发修改。PAT 以完整 token 的 SHA-256 入库，manifest、候选环境和恢复材料为 0600，目录为 0700；报告和日志不输出明文。

生产迁移要求 Portal 停止、维护和停机备份标记匹配且未放流。环境安装器核对源环境逐字节一致，最终只允许 `NEWAPI_ADMIN_TOKEN` 与 `NEWAPI_DISTRIBUTION=official` 两项变化；替换前再次核对文件 inode、内容、服务状态及迁移标记，用锁和原子重命名安装。

以下认证结果均已在隔离克隆完成：

| 场景                                                | 已确认结果                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20 客户的 self / Key list / groups                  | 60 次 GET 成功，owner、username、role 1 对应一致                                                                                                     |
| 管理员 self 及管理读取                              | 6 次 GET 成功                                                                                                                                        |
| 客户访问管理员接口                                  | 20 个客户均返回 403                                                                                                                                  |
| 既有推理 Key                                        | 81 条原值保持不变，不输出 Key 内容                                                                                                                   |
| 幂等、CAS 冲突、PAT 上限、插入后故障恢复及 rollback | 均通过，未重复创建 PAT，冲突未覆盖既有值                                                                                                             |
| 临时 Key CRUD                                       | 显式模式创建、读取、改名和删除成功，零额度、短效、带 IP 和不存在模型限制，无活跃残留                                                                 |
| Key reveal 故障注入                                 | finally 清理成功，无临时活跃 Key 遗留                                                                                                                |
| 旧管理 token 退休                                   | 仅克隆将 `LegacyAccessTokenRetireAt` 设为过去并重启；20 个旧客户 token 和 1 个旧管理员 token 均 401 / `ACCESS_TOKEN_LEGACY_RETIRED`，新 PAT 继续通过 |

**生产没有为该演练强制退休旧 token。** 克隆中的退休结果证明新凭据独立可用，不能写成生产旧凭据已全部撤销。

正式生产迁移已完成：20 个客户和 1 个管理员的 PAT 均成功安装，5 个禁用用户未签发。环境逐字节核对仅 `NEWAPI_ADMIN_TOKEN` 与 `NEWAPI_DISTRIBUTION` 变化。随后使用新 PAT 完成 20 客户共 60 次 GET、20 个普通 role 1 身份核对、20 次管理员接口 403，以及管理员 6 次 GET；81 条既有上游推理 Key 原值保持不变。正式凭据验收不创建临时 Key、非 GET 调用为 0；后续单独的 Portal HTTP 验收才执行一次临时 Key CRUD。

默认凭据验收不变更推理 Key，模型请求数为 0；官方 GET 可更新自身 PAT 的 last-used 或审计元数据。显式临时 Key 模式有 4 次非 GET 操作，创建/删除各 1 条，模型请求仍为 0。成功标记绑定迁移 run ID、manifest 和源环境 SHA-256、官方版本、完整计数与时间，失效或不完整的标记不能用于放流。

## Portal 官方兼容与开户恢复

官方模式由 `NEWAPI_DISTRIBUTION=official` 显式启用。官方缺少 fork 的分组用户倍率专用接口，Portal 在官方模式返回空覆盖列表；默认 fork 模式保留原接口和失败即停止的语义，不通过吞掉任意 404 伪造兼容。

新开户使用官方认证链路：用户登录后完成 password step-up，再获取限定 scopes 的 PAT，不能把登录 JWT 当长期管理凭据。旧二开和官方 CreateUser 都可能忽略 email，提交 `7a65f7b6` 允许长用户名、空 email 的队列恢复，但必须用稳定队列密码登录并确认 id、username 和普通 role 一致；非空错误 email、无法证明身份或旧短用户名空 email 的情况仍拒绝接管。

克隆 HTTP 新开户及 Key CRUD通过。真实 Portal `provisionNewCustomerResumable` bundle 在创建用户后注入首次 login `TypeError`，重试恢复同一上游身份；PAT 只回调一次，默认 Key 恰好 1 个且 `unlimited_quota`，预算仍由用户额度控制。

Portal 离线完整 CI 为 **400 files / 6210 passed / 1 skipped**，typecheck、format 通过，lint 为 **0 error / 102 个既有 warning**。`verify_portal.py` 的隔离工具测试 11 项通过，其中含 8 项本机 HTTP 场景；生产另完成 HTTP **84/84**，覆盖公开页面、会话鉴权、模型目录、客户 Key 列表与 CRUD、管理员列表及 dashboard。

生产原有 95 条 Portal Key 和 81 条上游 Key 均保留。HTTP 验收新增上下游各 1 条同属测试用户的临时 Key；Portal 行已 `disabled`，上游行已软删除，测试 Key 的 `used_quota=0`、活跃残留为 0。两库最终审计由 `final_acceptance.py` 只读执行：new-api 7 张、Portal 21 张受保护表通过；25 个 Portal 用户与停机 dump 逐字段比较，仅 20 个授权 PAT 和前述 2 人的缓存时间戳变化，其余字段完全一致。

两名用户均已核对满足启动余额告警候选条件（active、有关联上游用户、提醒阈值大于 0、未在 24 小时提醒冷却中），且刷新时间不早于本次 Portal 启动、`updated_at` 与 `newapi_cached_at` 相差小于 1 分钟。smoke 的客户列表、dashboard、模型目录及 Key CRUD 本身不写 `users`。生产 Portal migration 为 **93 applied / 0 unfinished / 1 条历史 rolled back**；历史回滚记录保留，未将它误报为本次迁移失败。

## Astra 保价和视频渠道兼容

完整计算矩阵见 [计费演练报告](NEWAPI-BILLING-REHEARSAL-2026-11-17.md)。`gpt-6-astra` 原先依赖二开内置表达式，官方新增独立 `cc12h`，直接换镜像或只复制原表达式都会改变部分缓存写入价格。显式安装以下表达式，继续按旧费率合计短期与 12h 缓存写入：

```text
len <= 272000 ? tier("standard", p * 10 + c * 50 + cr * 1 + (cc + cc12h) * 12.5) : tier("long_context", p * 20 + c * 75 + cr * 2 + (cc + cc12h) * 25)
```

同时设置 `billing_setting.billing_mode["gpt-6-astra"]="tiered_expr"`。安装仅在事务内合并 Astra entry，保留四条视频模式及表达式，遇到不同的现有 Astra override 会拒绝。120 组相同 usage JSON 经两版原始归一化、表达式和 quota 转换，保价候选的 cost、quota、tier 全部一致，并有独立 Decimal 核对。克隆已安装、重启并读回确认五条表达式齐全，四视频原值保留。

四条现有视频表达式的 176 组直接 usage 向量旧版和官方一致。官方插件的能力限制与缺省预扣存在变化：fast/mini 拒绝不支持的分辨率，2.5 部分缺省请求按更长上限预扣；旧 `pending`/`processing` 状态词与官方插件也有差异。该离线结果不能证明真实供应商的状态词、终态 usage 或最终账单已通过。

克隆 channel 13 从 type 65 转为官方 type 61 后，capability、模型映射与任务兼容检查通过。生产官方启动及最终验收均已通过 new-api 受保护表检查，channel 13 的预期 type 转换纳入例外核对；Astra 配置已独立读回通过，并在 release 放流前再次验证。以上配置、计算和数据检查仍不代表真实供应商生成与结算已验收。

## 生产阶段记录

| 阶段                                   | 已确认状态                                              | 时间或证据                                                                    |
| -------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 公网维护 gate、请求排空、停止两应用    | 已完成；维护已于 release 撤除                           | `cutover/MAINTENANCE_ACTIVE` 及 release 状态                                  |
| 双库停机备份及持久数据、配置、镜像基线 | 已完成并校验                                            | 2026-11-17 18:49:18 北京时间 / 10:49:18 UTC                                   |
| Mac 离机副本                           | 22 文件 SHA 一致，0600 / 0700 已核对                    | `/Users/elon/Backups/LLmRoute/new-api/rc51-20261117-170139/cutover`           |
| 固定官方镜像启动与版本检查             | 已完成，rc.51                                           | 2026-11-17 18:52:19 北京时间 / 10:52:19 UTC                                   |
| new-api 迁移后数据不变量               | 7 张受保护表通过                                        | `cutover/newapi-invariants.json` 基线及执行结果                               |
| 正式客户与管理员 PAT 迁移              | 20 客户 + 1 管理员完成                                  | `cutover/credential-migration/manifest.json` complete                         |
| 安装管理员环境及 official 模式         | 仅 token / distribution 两项变化                        | `cutover/environment-installation.json`                                       |
| 20 客户及管理员正式 HTTP / 权限验收    | 60 客户 GET、20 role 1、20 admin 403、管理员 6 GET 通过 | `cutover/credential-verification.json`                                        |
| Portal 镜像来源核对与启动              | 已通过，内部入口 ready                                  | 2026-11-17 18:54:46 北京时间 / 10:54:46 UTC；`cutover/portal-provenance.json` |
| Astra 与 channel 13 生产检查           | Astra 独立读回及数据审计通过                            | `cutover/data-acceptance.json`                                                |
| Portal HTTP 与临时 Key 清理            | 84/84，清理完成、无活跃残留                             | `cutover/portal-verification.json`                                            |
| 最终两库及用户逐字段审计               | new-api 7 表 / Portal 21 表通过                         | `cutover/data-acceptance.json`                                                |
| 汇总验收与证据哈希                     | 6 份证据 SHA-256 在放流前核对通过                       | `cutover/HTTP_ACCEPTANCE.json`                                                |
| 撤除维护、正式放流                     | 已完成，状态 official-released                          | 2026-11-17 19:07:12 北京时间 / 11:07:12 UTC                                   |
| 公网发布后检查                         | Mac curl 19/19 通过，源站健康                           | 主任务公网与源站检查记录                                                      |

公网 19 项检查包含 apex / www 登录页 200、API 域名 `/login` 404、假 Key `/v1/models` 401，以及主站 / www / API 三域下实际部署的 `/image-adapter`、`/image-adapter25`、`/gemini-adapter`、`/minimax-adapter`、`/seedream-adapter` 五类内部入口全部 404。源站及 API 两类 CORS 预检均 204。VPS 使用 Python urllib 访问部分非 API 公网路径时遇到 Cloudflare 客户端拦截 403；Mac curl 的真实公网访问正常，该差异作为客户端边界保留，不将它误报为 Portal 故障或宣称所有 HTTP 客户端均已通过。

## 验证边界和证据索引

本次已列演练的模型收费调用数为 **0**。临时 Key 操作和 PAT 获取属于管理接口验证，不能代替真实模型生成、真实供应商结算、支付回调或完整浏览器登录验收。也未据此宣布未来视频独立文件服务已实现。

永久仓库内的执行入口为 `deploy/newapi-official/`，计费细节记录在同目录日期的计费演练报告。私有执行证据按以下路径保存，不复制其凭据或 API 响应正文到仓库：

| 相对私有根目录的路径                             | 用途                                        |
| ------------------------------------------------ | ------------------------------------------- |
| `backup-online/`                                 | 隔离演练所用原始在线备份                    |
| `rehearsal/credential-http.json`                 | 客户、管理员与权限、普通 Key CRUD           |
| `rehearsal/credential-recovery.json`             | 幂等、CAS、上限、故障恢复及 rollback        |
| `rehearsal/credential-legacy-retired.json`       | 仅克隆的旧 token 退休与新 PAT 独立可用性    |
| `rehearsal/credential-new-customer.json`         | 官方 HTTP 新开户认证链路                    |
| `rehearsal/credential-portal-provision.json`     | 真实 Portal bundle 故障后恢复开户           |
| `rehearsal/credential-invariants.json`           | 原账户、推理 Key、消费及 Portal 字段保护    |
| `rehearsal/credential-verification.json`         | 默认不变更 Key 的新版凭据验收               |
| `rehearsal/credential-verification-crud.json`    | 显式临时 Key CRUD及清理                     |
| `rehearsal/credential-verification-cleanup.json` | reveal 故障后的自动清理                     |
| `rollback-rehearsal/result.json`                 | 第二组双库升级、改写、恢复与旧镜像重启      |
| `rollback-rehearsal/credential-restore.json`     | 25 个 Portal 用户原凭据逐行恢复比较         |
| `cutover/credential-verification.json`           | 生产 PAT、普通身份、管理读取与权限隔离      |
| `cutover/portal-provenance.json`                 | 生产 Portal 镜像身份与源提交                |
| `cutover/portal-verification.json`               | 生产 Portal HTTP 84/84 与临时 Key 清理      |
| `cutover/data-acceptance.json`                   | 生产两库不变量、逐字段用户审计及 Astra 读回 |
| `cutover/HTTP_ACCEPTANCE.json`                   | 绑定 6 份证据 SHA-256 的放流前汇总验收      |
| `cutover/`                                       | 生产停机备份、迁移状态及最终验收            |

**生产迁移、正式放流、公网发布后检查及最终证据离机校验均已完成。** 本报告确认的是固定官方版本、管理接口、内部 Portal HTTP、公网入口、数据保护与配置保价验收，不扩展为真实收费模型、支付、完整浏览器登录或视频文件服务验收。
