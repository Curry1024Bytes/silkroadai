# LLmRoute Portal 部署现状（2026-11-23）

## 当前问题

**部署状态：Portal 容器启动失败，502 错误**

### 失败原因

- PostgreSQL 迁移失败：`20260903090000_reconcile_catalog_tier_topology`
- 错误代码：P3009（Prisma 检测到失败的迁移，拒绝继续应用新迁移）
- 失败时间：2026-11-23 05:41:49.651879 UTC

### 容器状态

```
silkroadai-portal-app-1   llmroute-portal:fe24720c... Up 1 second   (unhealthy, 一直重启)
silkroadai-portal-db-1    postgres:16-alpine        Up 15 seconds (healthy)
```

---

## 服务器环境

**VPS 信息：**

- IP: `103.240.199.146`
- SSH 别名: `llmroute-prod`
- 系统: CentOS Stream 9
- 项目路径: `/opt/silkroadai-portal`

**磁盘使用情况：**

- **系统盘** `/dev/vda1` (50GB)：已用 43GB，剩余 7.5GB (86%)
    - `/opt/llmroute-releases` 占用 12GB（历史发布产物 + 备份）
    - `/var/lib/docker` 占用 3.7GB
- **数据盘** `/dev/vdb1` (50GB)：已用 8.4GB，剩余 39GB (19%)
    - 挂载点：`/data`
    - 承载：Portal PostgreSQL 卷、new-api PostgreSQL 卷

---

## 当前部署产物

**目标 commit:** `fe24720c1f9396b54f618a4de2ff40f36f093fea`

- **修复内容：**
    1. 定价参考选择器现在只匹配精确模型名（不再包含 Fast/Mini 变体）
    2. catalog-sync 验证测试修复以匹配 safeParse 行为

**Docker 镜像：**

- 名称: `llmroute-portal:fe24720c1f9396b54f618a4de2ff40f36f093fea`
- Image ID: `sha256:ddc522e94e9b15b8c215771bc6d3fda892363019d5bc066059303050bccaa549`
- 大小: 4.09GB
- 状态: 已加载到 VPS

**备份位置：**

- 路径: `/opt/llmroute-releases/fe24720c1f9396b54f618a4de2ff40f36f093fea/backup-20261123-130737/`
- 内容:
    - `.env`（已备份）
    - `silkroadai_portal.sql.gz`（PostgreSQL 数据库备份，已压缩并验证）

---

## Docker Compose 配置问题

**当前 `docker-compose.yml` 存在的问题：**

```yaml
app:
    build: . # ⚠️ 这会触发本地重新构建，而不是使用预构建的镜像
    image: llmroute-portal:fe24720c...
```

**实际行为：**

- 即使已有预构建镜像，`docker compose up -d app` 仍会触发本地构建
- 本地构建在 4GB RAM 的 VPS 上非常慢（180+ 秒）且易失败
- `DOCKER_BUILDKIT=0` 也无法阻止构建

**正确方式（需修改）：**

```yaml
app:
    image: llmroute-portal:fe24720c...
    # 移除 build: . 行
```

---

## 数据库迁移失败详情

**失败的迁移文件：**
`prisma/migrations/20260903090000_reconcile_catalog_tier_topology/migration.sql`

**迁移内容（4 个主要操作）：**

1. 清理 `catalog_models.upstream_map`（移除无效的档次映射）
2. 禁用没有路由的 ghost 产品（`enabled = FALSE` where `upstream_map = '{}'`）
3. 修复 8 个旧的图片用量记录（shadow-meter rows）
4. 添加数据库约束：
    - `channel_groups_enabled_requires_channels`（启用的档次必须有渠道）
    - 唯一索引：每租户只能有一个启用的默认档次
    - 唯一索引：每租户的 `newapi_group` 在启用档次中不能重复

**数据库中的失败记录：**

```sql
SELECT * FROM _prisma_migrations WHERE migration_name LIKE '%reconcile_catalog%';
```

结果：

- `started_at`: 2026-11-23 05:41:49.651879+00
- `finished_at`: NULL
- `rolled_back_at`: NULL
- `applied_steps_count`: 0

---

## 可能的原因分析

### 1. 数据库状态不明

- 是否是全新数据库（94 个迁移全部要跑）？
- 还是从旧服务器还原的数据库（只需增量迁移）？

### 2. 数据约束冲突

迁移可能失败在以下场景：

- **多个默认档次：** 如果数据库中存在多个 `enabled = TRUE` 且 `is_default = TRUE` 的 `channel_groups` 行，新的唯一索引会冲突
- **启用档次无渠道：** 如果存在 `enabled = TRUE` 但 `newapi_channel_ids` 为空的档次，新的 CHECK 约束会失败
- **重复的 newapi_group：** 同一租户下有多个启用档次使用相同的 `newapi_group` 值

### 3. 部署流程问题

- 备份了数据库，但**没有还原**就启动了新容器
- 新容器创建了全新的 PostgreSQL 卷（`silkroadai-portal_pgdata: Created`）
- Portal 启动时面对空数据库，尝试从头应用 94 个迁移
- 在第 X 个迁移时失败（需要查日志确定具体是哪一步）

---

## 下一步操作建议

### 方案 A：修复数据并重试迁移

1. 连接数据库，检查冲突数据：

    ```sql
    -- 检查是否有多个启用的默认档次
    SELECT tenant_id, COUNT(*)
    FROM channel_groups
    WHERE enabled = TRUE AND is_default = TRUE
    GROUP BY tenant_id
    HAVING COUNT(*) > 1;

    -- 检查是否有启用但无渠道的档次
    SELECT * FROM channel_groups
    WHERE enabled = TRUE
    AND (newapi_channel_ids IS NULL OR cardinality(newapi_channel_ids) = 0);

    -- 检查是否有重复的 newapi_group
    SELECT tenant_id, newapi_group, COUNT(*)
    FROM channel_groups
    WHERE enabled = TRUE
    GROUP BY tenant_id, newapi_group
    HAVING COUNT(*) > 1;
    ```

2. 修复冲突数据
3. 标记失败迁移为 rolled back：
    ```bash
    npx prisma migrate resolve --rolled-back 20260903090000_reconcile_catalog_tier_topology
    ```
4. 重新应用迁移：
    ```bash
    npx prisma migrate deploy
    ```

### 方案 B：还原备份数据库（如果应该保留旧数据）

1. 停止容器
2. 还原备份：
    ```bash
    gunzip -c /opt/llmroute-releases/.../silkroadai_portal.sql.gz | \
    docker compose exec -T db psql -U silkroadai-portal silkroadai-portal
    ```
3. 重启 Portal
4. 增量迁移会自动应用

### 方案 C：跳过失败的迁移（临时方案，不推荐）

1. 标记为 rolled back
2. 重启 Portal
3. 手动验证数据完整性

---

## 磁盘优化建议

**推荐方案：迁移发布产物到数据盘**

```bash
# 1. 移动到数据盘
mv /opt/llmroute-releases /data/

# 2. 建立软链接
ln -s /data/llmroute-releases /opt/llmroute-releases

# 3. 验证
ls -lh /opt/llmroute-releases
```

**效果：**

- 系统盘立即释放 12GB
- 使用率从 86% 降到 62%
- 风险最低（纯文件移动 + 软链接）
- 可快速回滚

---

## 验证清单（部署成功后）

1. **容器状态：**

    ```bash
    docker compose ps
    # 期望：app-1 和 db-1 都是 healthy/running
    ```

2. **迁移完成：**

    ```bash
    docker compose logs app | grep "migrations"
    # 期望：看到 "94 migrations found" 和成功日志
    ```

3. **公网可访问：**

    ```bash
    curl -I https://llmroute.club/
    # 期望：200 或 302，不是 502
    ```

4. **定价选择器修复验证：**
    - 访问 https://llmroute.club/admin/pricing
    - 检查模型参考选择器是否只显示精确匹配（无 Fast/Mini 变体）

5. **Portal 日志无错误：**
    ```bash
    docker compose logs app | grep -i "error\|invalid"
    # 期望：没有 "Invalid tiered pricing details" 错误
    ```

---

## 相关文件

- **项目文档：** `/Users/elon/work/code/ai/silkroadai/CLAUDE.md`
- **部署手册：** `deploy/部署与运维手册.md`
- **失败的迁移：** `prisma/migrations/20260903090000_reconcile_catalog_tier_topology/migration.sql`
- **备份位置：** `/opt/llmroute-releases/fe24720c.../backup-20261123-130737/`

---

**生成时间：** 2026-11-23 13:30 CST  
**操作员：** 等待决策
