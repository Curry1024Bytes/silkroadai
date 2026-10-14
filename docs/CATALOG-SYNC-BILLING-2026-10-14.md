# 目录同步计费规则修复（2026-10-14）

Operator 要求先修复，再由其一次性同步目录。本次只发布 Portal 兼容修复，不应用生产目录同步，
不修改 new-api 源码、渠道、基础价或分组倍率，也不发起收费调用。

## 原因与修改

此前目录同步仅读取 ModelRatio / CompletionRatio / ModelPrice / GroupRatio，生产预览因此只识别
18 个模型、38 项分组价格，遗漏 30 项表达式或媒体价格，另有 1 项视频单位不匹配。

- 同一只读来源快照增加计费模式、表达式、图片分辨率价、任务计价、限时折扣、渠道表达式标记与
  CacheRatio / CreateCacheRatio；全部经过白名单过滤，预览签名包括新增规则，来源变更后须重新预览。
- 完整保存 token 阶梯边界和缓存价，包括 GPT 预设中包裹比较条件与分支的括号。复用有长度、深度、
  精度限制的解析器，不执行表达式，不回写表达式。图片 token 表达式保留文本、图片及各自缓存价。
- 图片保留 1K / 2K / 4K 全部价格；视频保留按秒 / 按次单位、默认价和各分辨率价。
  MiniMax-H3 每日北京时间 22:00–08:00 的半价规则一并保存和展示。
- 使用现有 CatalogPrice.billing_details JSON，无 migration。结构化媒体价的旧 scalar 字段留空，
  避免把最低分辨率价当作统一价格、把每秒价显示为每张价；客户专属倍率作用于每项单价。
- 新同步、模型目录、公开价格页、机器目录和管理价格总览共用验证后的规则。重复预览幂等，
  仅规则变化也会生成新价格版本，历史价格和成本保留。
- 旧基础价编辑器对分辨率 / 视频任务 / 图片 token 规则只读，提示在 new-api 修改后同步，避免
  被普通输入输出价覆盖。未知表达式、渠道专属表达式或无效单位继续明确拒绝，不能回退到旧 scalar 价。

## 验证

增加真实 GPT 括号表达式、完整阶梯与缓存、图片 token 精度、媒体单位、时段折扣、专属倍率、
前台 SSR、数据库保存后幂等和预览失效等回归；现有安全测试保持原断言。
server-only 清单加入新服务端读取模块，继续禁止客户端引入服务端配置。

生产只读价格与渠道快照的本地预演为 41 个模型 / 69 项价格、0 warning、无阻断。
没有从公开网上补价或猜测缺失价格，金额均来自 new-api 当前配置及既有换算。

完整 CI 为 348 文件通过 / 5 文件失败，5585 passed / 45 failed / 1 skipped。失败标签及重复次数与
修复前基线逐项一致，无新增失败；不能称为完整测试全过。既有失败属于视频适配器、旧品牌域名、
Key 别名 UI，本次不修改那些实现或弱化对应断言。类型检查、生产构建、改动文件格式检查通过；
lint 0 error / 97 个既有 warning。生产快照解析得到 45 项完整 token 规则、21 项媒体规则、3 项
图片 token 规则。

## 回滚限制

本次不自动应用生产目录，发布时目录仍为空，可以直接切回旧镜像。用户随后同步了 media /
component_token 元数据后，旧镜像无法读取这些新模式；届时优先修复前进，或先制定保留价格历史的
兼容回滚方案，不能盲目切回旧应用。

## 隔离验证与发布

应用提交 `ec2af2435a3e95021dd1e5107d20d4e471e0e89d` 已从 dev fast-forward 到 prod 并推送。
发布前备份为 `/opt/backups/silkroadai-portal/releases/catalog-billing-20261014-015259/`：包含
0600 环境、Compose、容器配置、源码归档和经 gzip 校验的 PostgreSQL dump；目录权限 0700。
旧镜像保留为 `silkroadai-portal-portal:rollback-catalog-20261014-015259`。

新镜像来自干净 prod Git 归档，构建上下文排除全部 `.env*`，公开 build args 沿用生产 Compose。
临时数据库 `portal_catalog_check_20261014` 从生产备份恢复；85 migrations 无 pending。
实际同步代码在该库执行预览和确认，结果为 0 分组改动 / 41 模型 / 69 价格，第二次预览无变更；
69 项价格总览全部核对为 ok，浏览目录和机器目录各 41 模型，原 Key 与 new-api options 校验摘要不变。
检查脚本强制限制 new-api 请求只能为元数据 GET；实际只有 `/api/option/` 与 `/api/channel/`。
首次检查因 standalone 镜像没有顶层 zod 包入口而在加载脚本阶段中止，随后把该依赖打包进检查脚本，
重新恢复隔离库后全流程通过；应用代码和镜像没有因此修改。隔离库与临时环境文件已删除。

2026-10-14 10:04:58（北京时间）切换 Portal，约 9.14 秒登录页恢复；restart count 为 0。
运行镜像 `sha256:dfd3d4f2798aaaa69837d247583daabda02555caededa60489f4c401d738a314`。
PostgreSQL、new-api、new-api PostgreSQL、Redis 的容器身份和启动时间均未改变。

线上实际 `POST /api/admin/newapi-sync?dryRun=true` 返回 41 模型 / 69 价格，warnings 为空、blocked
为 null；预览包含所有分辨率、秒/次单位、272,000 阶梯边界、缓存价及跨午夜折扣。未执行生产确认同步。
18 项登录页、公开目录/价格、管理页、Key 页面、鉴权和 API 隔离检查通过；原客户 Key 的非收费
`/v1/models` 返回 200 / 4 模型。管理员短时验证会话仅保留在内存，45 秒过期。

生产仍为 0 CatalogModel / 0 CatalogPrice；new-api options、Portal 用户身份、`.env`、Compose
前后校验一致。Key 的凭据、档次、状态和额度与发布前备份逐列一致；访问 Key 页面正常刷新了
`cached_used_at` 与 `updated_at`，没有创建、撤销或替换 Key。85 个有效 migration checksum 与镜像
逐一一致、0 unfinished，历史 rolled-back 行保持原样。发布后日志无 error/fatal/failed。

没有执行收费推理、视频/图片生成、真实支付或真实 OAuth 浏览器登录；本次验收结论限于目录同步、
展示和既有非收费访问链路。服务器证据保存在 `/opt/llmroute-releases/ec2af24/`。
