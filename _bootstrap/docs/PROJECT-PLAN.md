# Silk Road AI Portal — 项目改造路线图

> Fork 自 `touwaeriol/sub2apipay`(已归档),改造为 LiteLLM 客户层。
> 仓库:https://github.com/yexioy/silkroadai
> 目标域名:`portal.silkroadai.io`

---

## 项目定位

**LiteLLM 的客户层(Customer Portal)**:
- 客户在 portal 注册 / 登录 / 充值 / 拿 Key / 看用量
- portal 在背后调 LiteLLM Admin API 创建 Virtual Key、调 max_budget、查 spend
- LiteLLM 是后端模型路由,完全不动

**与现有系统的关系**:
- `api.silkroadai.io` (Sub2API) — 退到幕后,只服务 LiteLLM 内部转发
- `pay.silkroadai.io` (老 Sub2ApiPay) — 后续可下线
- `ai.silkroadai.io` (LiteLLM API) — 客户实际调用入口
- `portal.silkroadai.io` (新建) — 客户管理后台

---

## 三阶段计划(总工时:兼职 3-6 周)

### 阶段 1:项目脚手架 + 数据库(W1)

| Day | 任务 | 输出 |
|---|---|---|
| D1 | clone fork + 跑通项目重命名脚本 + 验证 dev server 启动 | `pnpm dev` 能跑起来 |
| D2 | 跑数据库 migration + 加 User、LiteLLMKey 表 | Prisma schema 完成 |
| D3 | 写 `src/lib/litellm/client.ts`(参考 bootstrap 文件) | 单元测试通过 |
| D4-5 | 替换 admin-auth.ts + user/route.ts 的 Sub2API 调用 | 老接口不再被引用 |
| D6-7 | 跑通"创建 portal 用户 → 在 LiteLLM 创建 user + key"端到端 | 一个 happy path |

### 阶段 2:用户系统 + 充值流程(W2-3)

| 任务 | 估时 |
|---|---|
| 注册流程 + 邮箱验证(复用 LiteLLM 的 SMTP 配置) | 2-3 天 |
| 登录 / 找回密码 / JWT session | 2 天 |
| 改 `src/lib/order/service.ts` paid handler:从 Sub2API addBalance 改为 LiteLLM `/key/update` | 2-3 天 |
| 充值后端到端测试(易支付沙箱 → portal → LiteLLM → 余额生效) | 1-2 天 |
| 客户后台:Key 管理页 / 余额页 / 用量页 | 3-4 天 |

### 阶段 3:运营 + 上线(W4-6)

| 任务 | 估时 |
|---|---|
| Sub2API 余额监控 cron + 告警 | 0.5 天 |
| 服务条款 / 隐私政策 / 退款政策(模板化) | 1 天 |
| 客户接入文档(curl / Python / Cursor / Claude Code 示例) | 2 天 |
| 部署到 VPS + Caddy 配置 portal.silkroadai.io | 1 天 |
| 灰度 5-10 个种子客户 | 持续迭代 |
| Sub2ApiPay 老站下线计划 | 1 天 |

---

## 数据库 schema 改动

### 新增表

#### `users` (Portal 自有用户表)
```sql
- id              UUID PK
- email           VARCHAR UNIQUE NOT NULL
- password_hash   VARCHAR (bcrypt)
- email_verified  BOOLEAN DEFAULT false
- email_verify_token VARCHAR (一次性,1 小时过期)
- reset_password_token VARCHAR
- reset_password_expires DATETIME
- nickname        VARCHAR
- avatar_url      VARCHAR
- last_login_at   DATETIME
- last_login_ip   VARCHAR
- locale          VARCHAR(10) DEFAULT 'zh-CN'
- status          ENUM('active','disabled','banned')
- litellm_user_id VARCHAR UNIQUE  ← 关联 LiteLLM 的 user
- created_at      DATETIME
- updated_at      DATETIME
```

#### `litellm_keys` (用户的 LiteLLM Virtual Key)
```sql
- id              UUID PK
- user_id         UUID FK → users.id
- litellm_key     VARCHAR UNIQUE  ← sk-xxx
- key_alias       VARCHAR  ← 用户给 key 起的备注
- max_budget      DECIMAL(12,4) ← 当前总额度(= sum_of_recharges)
- current_spend   DECIMAL(12,4) ← 缓存值,定期从 LiteLLM 拉
- last_synced_at  DATETIME ← 上次同步 spend 的时间
- models          TEXT[] ← 可访问模型列表(JSON 数组)
- status          ENUM('active','disabled','expired')
- created_at      DATETIME
- updated_at      DATETIME
```

#### `recharge_logs` (充值流水,审计用)
```sql
- id              UUID PK
- user_id         UUID FK → users.id
- order_id        VARCHAR FK → orders.id
- key_id          UUID FK → litellm_keys.id  ← 充到哪个 key
- amount          DECIMAL(12,4)
- balance_before  DECIMAL(12,4) ← max_budget 充值前
- balance_after   DECIMAL(12,4) ← max_budget 充值后
- created_at      DATETIME
```

### 修改现有表

#### `orders` (基本保留,加 user 关联)
```sql
+ user_id        UUID FK → users.id  ← 新加,替代之前的 user_id (int) Sub2API 字段
- user_id (int)   ← 删除,不再关联 Sub2API
- ...其他字段保留
```

#### `channels` 表
- 可以保留,改造为"模型类别"(如开源 vs 闭源)
- 或者直接删除,改用 LiteLLM 的 model_access_groups

---

## 关键技术 gotcha 速查

| # | gotcha | 解决 |
|---|---|---|
| 1 | LiteLLM `/key/update` 的 max_budget 是**替换**不是**增加** | Portal 维护 `recharge_logs`,每次充值算 `newMax = SUM(amount)` 然后 PUT |
| 2 | LiteLLM 缓存 key state 60 秒 | 充值后立刻调一次 `/key/info` 强制刷新 |
| 3 | 流式请求会小额超支(几 cents) | UI 显示余额 `clamp(0, max - spend)` |
| 4 | spend 单调递增,不会因充值清零 | `余额 = max_budget - spend`,公式不变 |
| 5 | 退款让 max_budget < spend → key 被锁 | 政策:退款时同步 reset_spend(0)+ 重算 max_budget |
| 6 | 时区:LiteLLM 全部 UTC | Portal 客户端时间转 UTC 再查 spend logs |
| 7 | Sub2API admin key 没有"无限额度" | 设最大可允许额度 + cron 监控 + 微信告警 |

---

## 部署架构(最终)

```
                      portal.silkroadai.io ─┐
                                            ↓
                     Caddy (silkroadai.io) ─┤
                                            ↓
                          /opt/silkroad-portal/
                          ├─ docker-compose.yml
                          │   ├─ silkroad-portal  (Next.js,端口 3002)
                          │   └─ portal-db        (PostgreSQL,内网)
                          └─ .env

                          调 LiteLLM Admin API  →  http://litellm:4000
                          (容器间通信走 docker network litellm_default)
```

注意:portal 和 litellm 两个服务必须**在同一个 docker network 里**,这样 portal 可以用 `http://litellm:4000` 调用而不用走外网。

---

## 上线前检查清单

```
□ 数据库每日备份 cron 在跑
□ 服务条款 / 隐私政策 / 退款政策上线
□ 易支付沙箱端到端测试通过
□ Sub2API 余额监控告警正常
□ 客户接入文档完成
□ Logo + favicon 全套品牌化(已完成)
□ HTTPS 证书自动续期(Caddy 已配)
□ 错误监控(Sentry 或 BetterStack 免费档)
□ portal 容器异常自动重启策略(restart: unless-stopped)
□ LiteLLM master key 已更换(待办)
□ 第一批种子客户名单(5-10 人)
```

---

**版本**: 1.0
**生成时间**: 2026-05-01
**生成方式**: Cowork 自动生成,基于 Sub2ApiPay 源码侦察 + LiteLLM Admin API 接口梳理
