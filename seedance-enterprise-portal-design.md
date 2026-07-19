# Seedance 大客户独立门户 — 设计 + 排期文档

> 2026-07-19 · 接续 session `aab76aff` 的可行性评估（60-70% 可复用），四个决策已由 operator 拍板。
> 状态：**设计稿，待 operator 审后开工**。

---

## 0. 一句话定位

给 seedance 大客户做一个**独立小门户**：独立 IP+端口（服务器现有空闲 IP）、独立 dashboard、自发 key、按 token 精确计费、素材库管理。核心两件事 = **转发**（客户请求 → 每客户独立上游 key → 火山方舟 token.xinhankr）+ **计费**（¥ 账本自扣）。

**彻底不碰 new-api**：不用 new-api token、不走 new-api 路由、不用 new-api quota —— 比现有 seedance-cn 渠道（还依赖 new-api 做余额/目录/key 后端）更干净。

---

## 1. 已拍板的决策（2026-07-19）

| # | 决策 | 结论 |
|---|------|------|
| ① | 客户 key 体系 | **自己发 key**（门户自建 key 表 + P4c ¥ 账本计费，不依赖 new-api） |
| ② | 上游 key 配置 | **每个大客户一把独立上游 key**。operator 确认（2026-07-19）：即使 xinhankr 不支持子 key，也可以开新账户拿新 key —— 本质仍是独立 key，决策成立 |
| ③ | 素材库范围 | **接上游素材 API**（operator 2026-07-19 终定，推翻中间的「门户侧 R2」方案）：xinhankr 网关深度兼容火山方舟素材库（`POST /api?Action=…`，契约见 §3.6），且**网关按 key 做归属隔离** —— 配合决策②每客户独立 key，素材隔离白送。火山「主体/角色/风格参考」多图生成需要素材组 ID，这是门户侧 R2 替代不了的（生成模型消费的是火山资产 ID）。素材接进生成的原生细节 operator 也尚未完全吃透 → P3 带一小步实测 |
| ④ | 推进方式 | 文档已审，operator 2026-07-19「干」→ **P1 开工**（branch→test→PR→merge→deploy→smoke 全流程） |
| ⑤ | 部署 IP | **128.241.232.23**（2026-07-19 服务器实测：.168 被 new-api-2 :4000 占用，.23/.34/.55/.204/.251 全空闲，取第一个） |
| ⑥ | 入口形态 | **裸 IP**（operator 拍板，不配子域名）。TLS：Caddy 在该 IP 起 site，HTTP :80 + `tls internal` 自签 :443 双开，客户按需选（自签需关证书校验） |

---

## 2. 总体架构

```
大客户 SDK/脚本（OpenAI 兼容视频 API）
        │  https://<独立入口>/v1/video/generations  (Bearer <门户自发 key>)
        ▼
┌─ 独立门户实例（同 portal 代码库，独立部署在空闲 IP:端口）─────────────┐
│                                                                      │
│  ① key 反查:enterprise key 表 → 客户 + 该客户的独立上游 key          │
│  ② 余额门:Account.balance_cny(P4c ¥ 账本)按估价拒 402              │
│  ③ 转发:复用 cn-adapter 翻译层(档位→分辨率/参考模式,参考媒体→R2)  │
│     ── 用【该客户的上游 key】直连 token.xinhankr(不再是全站单 key) │
│  ④ 落库:seedance_video_tasks(同表,标 portal_source)              │
│  ⑤ 轮询完成 → 真实 usage.completion_tokens → 幂等扣费              │
│     applyLedgerEntry(charge, ref=taskId) —— 只走 portal ¥ 账本,     │
│     没有 newapi 分支,没有 syncNewapiGate                            │
│                                                                      │
│  dashboard(独立外壳):余额/流水 · 日志 · key 管理 · 素材库          │
└──────────────────────────────────────────────────────────────────────┘
        │                                     │
        ▼                                     ▼
 火山方舟 token.xinhankr                主 portal 同一个 Postgres
 (每客户独立 key)                      (tenant_id 行级隔离,见 §3.1)
```

关键复用结论（都已在生产验证过）：

| 能力 | 复用来源 | 改动量 |
|---|---|---|
| 上游翻译/参考媒体→R2/提交轮询/火山直链 | `src/lib/seedance/cn-adapter.ts` | 小：key 从 env 单值改为按客户传参（§3.3） |
| 按 token 费率 + 成本计算 + 幂等扣费 | `src/lib/seedance/cn-billing.ts` | 小：砍 newapi 分支，加费率覆盖（§3.4） |
| ¥ 账本（余额/charge/(kind,ref) 幂等） | `src/lib/billing/ledger.ts` + `Account`/`LedgerEntry` | 零改动，直接用 |
| 任务落库/计费真相 | `SeedanceVideoTask` 表 | 微：加来源标记列 |
| 请求日志 | `RequestLog` 表（数据存储线①） | 零改动 |
| 登录鉴权 / 多租户 | portal auth + `tenant_id`（P1 白标） | 零改动 |
| dashboard 组件 | 主 portal 余额/用量/key 页 | 中：新外壳 + 数据接线（§3.5） |

---

## 3. 模块设计

### 3.1 部署形态：同代码库、第二个 compose service（推荐）

**不起新 repo**。同一个 Docker 镜像，`docker-compose.prod.yml` 加第二个 service（如 `seedance-portal`），env 区分：

```yaml
seedance-portal:
  image: <同 portal 镜像>
  environment:
    - PORTAL_FLAVOR=seedance-enterprise   # 门户形态开关
    - APP_PORT=3003
    - DATABASE_URL=<同主库>               # 数据靠 tenant_id 行级隔离
  ports:
    - "<空闲IP>:<对外端口>:3003"
```

- **代码零漂移**：cn-adapter / cn-billing / ledger 改一处两边生效，不用维护两份。
- **数据隔离**：建一个专属租户（`tenant_id = seedance-enterprise` 那行 Tenant），所有大客户 User/Account/key/任务都挂它。P1 白标的 tenantScope 机制现成。不单独起第二个 Postgres —— 单独库意味着双份 migration/备份/连接池，隔离收益却和行级一样（都是我们自己的代码在查）。
- **形态开关**：`PORTAL_FLAVOR=seedance-enterprise` 时 middleware 只放行门户自己的页面/端点（`/v1/video/*`、`/enterprise/*` dashboard、登录），其余主站页面一律 404 —— 大客户看不到主站任何东西。
- **防火墙**：⚠️ 服务器 docker 端口有 DOCKER-USER DROP 门（post-DNAT gating），开新端口必须在 `/etc/iptables/docker-user.rules` 加 scoped conntrack ACCEPT，`ufw allow` 单独不生效（第二 new-api :4000 开通时踩过）。

**TLS（决策⑥已定：裸 IP）**：Caddy 给 `128.241.232.23` 起独立 site：`http://128.241.232.23`（:80 纯 HTTP）+ `https://128.241.232.23`（:443 `tls internal` 自签）双开，客户按需选（HTTPS 需关证书校验 / 信任自签根）。客户文档写清两种接法。

### 3.2 独立 key 体系（新表 ×2）

```prisma
// 门户自发的客户 key(与 new-api 无关)
model EnterpriseKey {
  id         String   @id @default(uuid()) @db.Uuid
  tenant_id  String   @db.Uuid
  user_id    String   @db.Uuid          // 挂主 User 表(大客户也走注册/登录)
  key_hash   String   @unique           // sha256(key)。明文只在创建时返回一次,不落库
  key_prefix String                     // "sk-ent-xxxx…" 前 12 字符,列表页展示用
  name       String
  status     String   @default("active") // active | disabled
  created_at DateTime @default(now())
  last_used_at DateTime?
  @@index([user_id])
}

// 每客户 → 独立上游 key 映射(决策②)
model EnterpriseUpstreamKey {
  id            String  @id @default(uuid()) @db.Uuid
  user_id       String  @unique @db.Uuid   // 一客户一把
  upstream_key_enc String                  // AES-256-GCM 加密存(镜像 user_oss_configs 的做法)
  note          String?                    // 对账备注(上游侧 key 名等)
  created_at    DateTime @default(now())
}
```

- key 形态 `sk-ent-<32 hex>`，**只存 hash**（比主站 NewApiToken 存明文更严 —— 新体系没历史包袱，按最佳实践来）。创建时明文返回一次 + dashboard 提示自行保存。
- 上游 key 加密 env 用新变量 `ENTERPRISE_UPSTREAM_ENC_KEY`（不复用 `PORTAL_OSS_ENC_KEY`，密钥职责分开；同样投产后不可换，进 1Password）。
- 鉴权路径：`Bearer sk-ent-…` → sha256 → `EnterpriseKey` → user + status 门 → `EnterpriseUpstreamKey` 解密出该客户的上游 key。全程不碰 new-api。
- 大客户开户：主站注册流跑不通（provisionNewCustomer 会去 new-api 建号）——门户形态下注册走**精简流**：只建 User + Account + 专属租户挂载，跳过 new-api provisioning。大客户数量少，也可以先做成 admin 手工开户（脚本/admin 页），自助注册后置。

### 3.3 转发（复用 cn-adapter，参数化上游 key）

现状：`cn-adapter.ts` 上游 key 读全站单值 env `SEEDANCE_XHK_KEY`。改法：

- 提交/轮询/内容三个核心函数加 `upstreamKey: string` 参数；现有 seedance-cn 渠道调用点传 env 值（行为不变，现有测试全部照跑），门户调用点传客户独立 key。
- 档位模型名（`seedance2.0-pro-{720p,1080p,4k}[-ref]` ×6）、参考模式门控、参考媒体→R2、火山直链返回：**原样复用，零改动**。
- 门户入口路由：`/v1/video/generations`（POST 提交 / GET {id} 轮询），OpenAI 视频规范对齐 —— 客户侧和现在 seedance-cn 的调用方式完全一致，迁移零成本。

### 3.4 计费（复用 cn-billing，砍 newapi 分支 + 费率覆盖）

- `computeCostCny` / `estimateCostCny` / 费率表：直接复用（720p ¥39.1 / 1080p ¥43.35 / 4k ¥22.1 每 1M token 无视频档；含视频 ¥23.8 / ¥26.35 / ¥13.6）。
- 扣费：`chargeSeedanceVideoTask` 的门户版只走 portal 分支 —— CAS 抢占 `billed=false→true` + `applyLedgerEntry(charge, ref=taskId)`（`(kind,ref)` unique 二级幂等）。**没有** newapi override、没有 `syncNewapiGate`、没有「扣款失败不回滚」的 newapi 非幂等顾虑（账本 charge 本身幂等，但保持同一保守语义，少一条特例）。
- 余额门：提交前 `estimateCostCny`（参考视频 1.5× 缓冲）对 `Account.balance_cny` 把关，不足 402。
- **大客户议价**：加可选的 per-customer 费率覆盖表（`EnterpriseRateOverride`: user_id + resolution + has_video → cny_per_m），查不到走默认表。大客户谈价是大概率事件，P1 就把表建好，UI 后置（admin 手工 upsert 即可）。
- `SeedanceVideoTask` 加一列 `source String @default("newapi-channel")`（门户写 `enterprise-portal`），dashboard/对账按来源分得开；主站 `unionSeedanceUsage` 聚合按 user 过滤天然不串（不同租户不同 user）。

### 3.5 独立 dashboard（四页 + 登录）

路由挂 `/enterprise/*`（PORTAL_FLAVOR 开关下即门户唯一 UI），复用主 portal 的 auth session、布局组件和表格组件：

| 页 | 内容 | 数据源（全部现成） |
|---|---|---|
| 余额/计费 | 余额大卡 + 流水表（每笔视频的 token 数、费率档、¥）| `Account` + `LedgerEntry`（ref=taskId 可 join 回任务行） |
| 日志 | 视频任务列表（时间/模型档/时长/状态/token/¥）+ 请求日志 | `SeedanceVideoTask` + `RequestLog` |
| Key 管理 | 列表/创建（明文一次性展示）/禁用 | `EnterpriseKey` |
| 素材库 | 见 §3.6（P3，按 P0 实测结果定型） | 上游素材 API 代理 |

充值：P1 先 admin 手工入账（`applyLedgerEntry(recharge)` 走现成 break-glass 思路 + 备注打款流水号）——大客户是对公/大额转账，本来就不走易支付小额网关。在线充值后置。

### 3.6 素材库（P3）— 上游素材 API 代理（2026-07-19 operator 终定）

xinhankr 网关**深度兼容火山方舟素材库**，契约已从网关文档拿全：

- **Base**：`POST https://token.xinhankr.com/api?Action=<action>&Version=2024-01-01&ns=asset_manager`，JSON body，`Authorization: Bearer <上游 key>`。
- **Actions 白名单**：`CreateAsset`（把云存储 URL 注册为火山资产,AssetType image|video,返 `Result.Id = asset-…`,Status active|processing|failed）/ `GetAsset` / `UpdateAsset` / `DeleteAsset`（云端+网关归属记录同步删）/ `ListAssets` / `CreateAssetGroup`（多图「主体/角色/风格参考」生成需要素材组 ID,返 `group-…`）/ `GetAssetGroup` / `UpdateAssetGroup` / `DeleteAssetGroup` / `ListAssetGroups`。
- **隔离**：网关按 key 做归属校验（非 admin 只能操作自己 key 建的资产,越权 403）—— 配合决策②每客户独立上游 key，**素材隔离白送**（回到最初评估的判断）。

门户侧做**薄代理**：对客户暴露同形接口（门户裸 IP 上 `POST /api?Action=…`），客户用自己的 `sk-ent-` key → 门户换成该客户的上游 key 转发,Action 按白名单过滤。客户文档可直接对齐网关文档,零学习成本。

**为什么不做门户侧 R2 素材库**（推翻 2026-07-19 早间的中间方案）：火山「主体/角色/风格参考」多图生成消费的是**火山资产/素材组 ID**（`CreateAsset` 注册 + `CreateAssetGroup` 打组），不是裸 URL —— 这层语义 R2 门户库替代不了。operator 明确要接上游。

**P3 内嵌一小步实测**（原 P0 的残留,~¥5）：素材/素材组 ID 如何被**生成请求**引用（哪个字段、走 OpenAI 兼容路径还是原生路径）——火山官方文档（console.volcengine.com/ark 82379/2333565）+ 网关行为实测为准,operator 也尚未完全吃透官方素材库逻辑,实测结论写回本节。

- **注**：`CreateAsset` 吃「已在云存储上的 URL」→ 客户本地文件上传仍需先落我们 R2 拿公网 URL 再注册。P3 顺带做一个「上传→R2→自动 CreateAsset」的便捷端点 + dashboard 素材库页。

---

## 4. ~~P0 实测方案~~ — 已取消（2026-07-19）

原 P0 的两个验证目标都不再需要：

1. **素材接进生成** —— §3.6 改为门户侧 R2 素材库，走 cn-adapter 生产已验证的 http 直链机制，无上游未知；
2. **上游多 key** —— operator 确认可行（子 key 或开新账户均可），无需实测/商务前置。

唯一残留验证：拿到第二把上游 key/账户后，P1 部署时顺带 smoke 一条（确认新 key 行为与现 key 一致 + 各自「余额<¥5」门独立），成本 ~¥1，并入 P1 上线标准。

---

## 5. 分期排期（每期独立上线）

| 期 | 内容 | 工时估计 | 上线标准 |
|---|---|---|---|
| **P1 骨架** | 新表 ×3（EnterpriseKey / EnterpriseUpstreamKey / RateOverride）+ migration；key 鉴权中间层；cn-adapter 参数化;门户版扣费;`/v1/video/*` 入口;PORTAL_FLAVOR 开关 + compose 第二 service + 防火墙(128.241.232.23)/TLS;admin 手工开户+入账脚本;新上游 key smoke（~¥1） | **3-4 天** | 第一个大客户可用真 key 提交视频、精确扣费、admin 可入账 |
| **P2 dashboard** | 登录 + 四页外壳(素材库页占位)+ 数据接线 | **2-3 天** | 客户自助看余额/流水/日志、管 key |
| **P3 素材库** | 上游素材代理(§3.6):`/api?Action=…` 白名单薄代理 + 上传→R2→CreateAsset 便捷端点 + 素材库页 + 素材接进生成实测(~¥5) | **2-4 天** | 客户自助管素材(并按实测结论用于生成) |

**合计约 7-10 个工作天**（P0 取消后较原估 8-11.5 天缩短）。P1 完成即可接第一个大客户（dashboard 未上线期间 admin 代查），P2/P3 增量上。

每期照常走：feat 分支 → vitest/tsc/lint/prettier 四门 → PR → merge → 手动 VPS 部署 → 生产 smoke。新 migration 按 W9 D3 惯例先 temp-DB 验证再 prod `migrate deploy`。

---

## 6. 开放问题

**已解决（2026-07-19）**：

| # | 问题 | 结论 |
|---|---|---|
| Q2 | 上游多 key | ✅ operator 确认：子 key 或开新账户均可，本质独立 key，决策②成立。各账户「余额<¥5」门天然独立（多账户时）；P1 部署时用新 key smoke 一条确认行为一致 |
| Q3 | 空闲 IP | ✅ **128.241.232.23**（服务器实测 .168 被 new-api-2 占，.23/.34/.55/.204/.251 空闲，取 .23）。对外端口建议 443（走 Caddy）或与 operator 定 |

| Q1 | 入口形态 | ✅ operator 拍板：**裸 IP**（128.241.232.23,HTTP :80 + 自签 HTTPS :443 双开,见 §3.1） |
| Q4 | 默认费率 | ✅ 默认执行：= 现 seedance-cn 挂牌(×0.85),议价走 RateOverride 按客户覆盖 |
| Q5 | 开户方式 | ✅ 默认执行：P1 admin 手工开户/入账先行,自助注册后置 |

**全部问题已关闭,P1 开工（2026-07-19）。**
