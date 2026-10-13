# Google OAuth 开户失败修复（2026-10-13）

## 故障与根因

生产服务器为 `103.240.199.146`，Portal 位于 `/opt/silkroadai-portal`。
Google 登录最早出现过连接超时，后续 Google token/JWKS 连接检查已恢复。用户再次登录后，
2026-10-13 14:49:21（北京时间）Portal 日志明确记录开户阶段失败：
`GET /api/user/token` 返回 HTTP 403、`SECURITY_PROOF_REQUIRED`、`需要安全验证`。
此时 Google 身份验证已经通过；失败发生在创建 new-api 用户后的持久访问令牌签发。
协调开户流程已删除失败产生的孤立 new-api 用户，没有把短期 JWT 写入 Portal。

当前 new-api-custom-full 要求签发持久令牌前完成 `access_token.generate` 安全验证。
原 Portal 直接以登录 JWT 调用 `/api/user/token`，未处理这个新增要求。

## 修复范围

应用提交：`dde2a18d711872a38bdaefcf93d4870103f3a637`，在 dev 验证后 fast-forward 到 prod。

- 仅当签发明确返回 403 / `SECURITY_PROOF_REQUIRED` 时，读取该操作支持的验证方式。
- 仅在上游允许普通密码验证时，使用刚生成的新客户密码完成 `/api/verify`。
- 校验返回 proof 的用途、验证方式与有效期；把它放在单次令牌签发请求的
  `X-Security-Proof` 请求头中，再尝试一次。
- 持久令牌不得为空、等于登录凭据或为 JWT。网络结果不明时不自动重签；验证失败不记录密码回显。
- 旧版 Cookie 与不要求 proof 的 JWT 换取持久令牌流程保持兼容。
- 没有修改 new-api 源码、保护策略、计费倍率、渠道、数据库 schema 或环境变量。

用户此前指定新用户使用「GPT特惠反代」，已通过 Portal 管理接口登记唯一启用默认档：
`gpt-b059e58649` / new-api group `GPT特惠反代` / channel 2。
这与 new-api 原生用户的 `default` 字段不同。分组变更备份位于
`/opt/backups/portal-group-default/20261013-142759/`；没有修改该组售价倍率 0.12。

## 验证

- 登录/开户相关 6 个测试文件共 75 项通过，其中新增 21 项安全验证兼容回归。
  原 `provision-login-session.test.ts` 未修改。
- 类型检查、生产构建与改动文件格式检查通过；lint 0 error / 97 个既有 warning。
- 完整非 smoke 测试：346 files passed / 5 files failed，5525 passed / 45 failed / 1 skipped。
  **不能将此结果称为完整测试全过。** 在未修改的 `61d8204a` Git 归档中重跑这五个文件，
  同样得到 45 failed / 157 passed；失败名称逐项一致，没有新增失败。
  既有失败涉及旧视频适配器 mock、旧资源域名期望及已变化的 Key 别名编辑界面，未为本次发布修改断言。
  全量归档基线另有临时目录下生成文件/运行路径相关失败，未拿它冒充完全相同的全量环境。
- 在生产 new-api 用独立随机临时账号复现 403，再按真实安全验证流程签发持久令牌、
  创建并读取「GPT特惠反代」无限额 Key；重复使用 proof 被拒绝。
  注销短期 JWT 后，该 JWT 鉴权 401，持久令牌仍能鉴权 200。
- 将实际修复后的 `provisionNewCustomer` 打包到服务器执行，开户、默认 Key、持久令牌鉴权均通过。
  所有临时账号/Key 均已清理，没有发起收费模型调用。
- 生产现有源码与修复前提交的 1081 个应用/Prisma/依赖及构建文件逐项 SHA-256 对比全部一致。
  生产 Compose 含独立网络设置，发布继续使用现有配置，未用仓库模板覆盖。

## 发布记录

发布前备份：`/opt/backups/silkroadai-portal/releases/oauth-proof-20261013-070659/`。
包含权限受限的环境/Compose/Nginx 备份与通过 `gzip -t` 的 Portal PostgreSQL dump。
构建前已核对回滚标签 `silkroadai-portal-portal:rollback-oauth-20261013-070659` 指向旧镜像
`sha256:d45d68a3dd5a680298c4e34e4751e6298b6135ab4b7f087f71742c3b96a96627`。

构建使用 prod 的干净 Git 归档，排除全部 `.env*`，上下文位于
`/opt/llmroute-releases/dde2a18/source`。原生产服务继续运行，构建结果单独标记
`silkroadai-portal-portal:release-dde2a18`。

2026-10-13 15:16:53（北京时间）已切换 Portal，容器启动后约 8 秒登录页可用。
实际运行镜像为
`sha256:64cbfeb3c2543240be0f9601df0475a84626e49bd0ce5f7a818dd3eff3ac6e0b`，restart count 0。
PostgreSQL、new-api、new-api PostgreSQL 和 Redis 的启动时间均未变化。

- 生产数据库 84 条有效已应用 migration 与本次源码逐项 checksum 一致，0 pending。
  历史表共 85 行，其中 topology migration 曾有一条 rolled-back 记录；它对应的成功记录已存在，
  本次未修改历史记录或执行任何新 migration。
- 新镜像以非 root 身份检查 Prisma 可读、根目录无 `.env*`、编译产物包含安全验证修复，均通过。
- 主站源站、apex 与 www 登录页 200；Google/GitHub start 分别 302 到官方域名。
- API 假 Key 401；API `/login` 与主站内部适配器地址均 404；Nginx 配置检查通过。
- 启动日志没有开户失败/error/fatal，显示无 pending migration。
- 切换后再次在新容器运行真实 Portal 开户 helper，持久令牌鉴权与默认分组 Key 创建通过；临时资源已清理。
- `/opt/deploy-state/portal-source.sha256` 已记录实际部署的 prod SHA。

以上不等于用户真实 Google 浏览器登录已验收；已请用户重新登录确认。
