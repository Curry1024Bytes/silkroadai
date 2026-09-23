# 共享模型分组定价发布记录（2026-09-23）

## 发布范围

- 生产此前运行 `00b22c9`。本次把 `3bc21fd` 与 `797b77d` 发布到 VPS；`db9c003` 仅补充 9 月 20 日上游发布核验记录。
- `3bc21fd` 修正分组报价的精度核验，并让预览按选中分组的倍率展示实际售价。
- `797b77d` 允许同一个模型属于多个分组。模型基础价由 new-api 多组共享，因此给其中一组定价时只写所选组的 `GroupRatio`，不改共享基础倍率或基础价；预览会校验并展示该组的实际单价。
- 无数据库 migration、环境变量、依赖、Nginx 或 Cloudflare 变更。没有发布生产价格，也没有运行收费模型请求。

## 验证与部署

- `pnpm test:ci`：342 个测试文件，5336 passed、1 skipped。
- `pnpm typecheck` 与生产构建通过；`pnpm lint` 为 0 errors、96 warnings。
- 全仓 `pnpm format:check` 仍被 6 个既有文件阻断；本次涉及的 3 个源码文件通过 Prettier 检查。
- 运行源码为 `prod@797b77d`，镜像为 `sha256:6a0c9529797924b8cfb4ac9d7e5b18be1aa1e260b51472d17787f5d2da5f6eb9`，标签 `silkroadai-portal-portal:release-797b77d`。
- 发布前 `.env` 备份 `/opt/silkroadai-portal/.env.bak.20260923-090309` 和 PostgreSQL 备份 `/opt/backups/silkroadai-portal/portal-20260923-010309.sql.gz` 均为 0600；数据库备份 `gzip -t` 通过。
- 数据库保持 80 applied、0 pending、0 rolled back。Portal restart count 为 0；PostgreSQL 与 new-api 未重启。Portal→new-api 返回 200，主站登录页返回 200，API 假 Key 返回 401，Nginx active 且配置有效；未登录访问 `/admin/pricing` 返回预期认证跳转 307。

## 回滚镜像核验

- 9 月 20 日发布记录确认升级前运行源码为 `00b22c9`、镜像 digest 为 `sha256:b6942a52474d41aa5d9dc7984579b4873e5a30a66cf01fb78babfff1f210fe8e`。本次发布时 VPS 已无该镜像，也没有停用的旧 Portal 容器，故不能把原 digest 直接重新打标签。
- 已从干净 Git 归档 `00b22c9` 单独重建镜像，并把 `silkroadai-portal-portal:rollback-20260923-090309` 指向新 digest `sha256:e0cc57cdb22cba3ffb9a9385dd156d564555753509f8b9416e15f2a1e91b5499`。这是源码版本对应的重建镜像，不是原 `b6942a…` 镜像的字节级副本。
- 重建前后运行容器和 `release-797b77d` 均保持 `sha256:6a0c952…`，没有切换服务。此次无 migration 且没有生产价格写入；若需回滚应用，只回退 Portal 镜像，不恢复数据库备份。
