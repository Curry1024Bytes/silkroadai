# P4b-v2 — 对账报表(零售 / 成本 / 毛利)

> `/admin/billing-shadow` 从「portal 零售 vs new-api quota」重做成「**零售 vs 成本 vs 毛利**」。
> ⚠️ **纯只读**:不扣费、不挡请求、不写库、不写 new-api、不碰客户余额。只读 `UsageRecord` + `CatalogPrice`。

## 为什么撤掉 new-api quota 基准

P4b-v1 拿「new-api 实扣 quota → ¥」当成本对账。operator 审后发现根本问题:**new-api 实扣 quota 不是成本** ——
它只是 new-api 自己的 `ModelRatio` 配置 × token(而且我们一直把**零售价** sync 进去 + 旧脚本留下一堆 stale 值)。
真实成本是上游渠道扣的,系统里对应的是 portal 目录自己录的 `CatalogPrice.cost_cny_per_1m`(P2.10 批量填充铺开)。
所以报表改用 **portal 目录的数 + 日志里唯一有用的 token 数**,**彻底撤掉 new-api ¥ 列**。

## 对账口径

`UsageRecord` 每条有 `input_tokens`/`output_tokens`(日志 token 数 = 计量 ground truth)、`cost_cny`(meter 时算的**零售**)、`model_slug`/`tier`/`matched`/`tenant_id`/`user_id`。

| 指标       | 算法                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 零售       | `Σ cost_cny`(仅 matched;UsageRecord.cost_cny 本就是零售)                                                          |
| 成本       | `Σ (cost_cny_per_1m × (input+output) tokens / 1e6)`,`cost_cny_per_1m` 取 (tenant,slug,tier) **当前** CatalogPrice |
| 毛利       | 零售 − 成本                                                                                                       |
| 毛利率     | 毛利 / 零售                                                                                                       |
| 成本覆盖率 | 有 `cost_cny_per_1m` 的 matched 记录数 / matched 记录数(没成本 → 毛利算不出,进「待补成本」清单)                   |

**new-api 日志只贡献 token 数**,不再有 quota/¥/差异列。

## 报表内容(`/admin/billing-shadow`)

时间窗沿用 `?period=7d|30d|all`(默认 30d)。

- **汇总卡**:零售总额 ¥ / 成本总额 ¥ / **毛利 ¥ + 毛利率%** / 成本覆盖率(+总调用数)。
- **按模型 × 档次**:每行 model / tier / 调用数 / 零售 ¥ / 成本 ¥ / **毛利 ¥ / 毛利率%** / 成本覆盖。按零售额降序。
    - **高亮**:毛利率 **< 20% 标黄、< 0(在亏钱)标红** —— operator 重点盯红行。没录成本的行 成本/毛利显 `—`。
- **待补成本清单**:有零售、`cost_cny_per_1m` 为空的 model×tier,列零售额 + 调用数(降序 = 去定价页补成本的优先级)。
- **按客户 / 按租户**:各自零售 / 成本 / 毛利 / 毛利率(每个客户、每个租户赚多少 —— 白标经济性)。

## 怎么读

- 零售 = 向客户收的(meter 时算)。成本 = 上游拿货(portal 目录录的)。毛利 = 两者差。**new-api 不参与**,token 数取自日志。
- 毛利率 < 20% 黄 / < 0 红 —— 盯红行。
- **毛利率在成本覆盖率<100% 时偏高**(部分调用还没录成本:零售算进分母、成本没算)—— 配合覆盖率卡 + 待补成本清单看,别只看头条毛利率。

## 已知近似(brief §4,代码注释 + 页面均标注)

- **成本单一字段**:`cost_cny_per_1m` 不分 input/output,按 (input+output) **总 token** 估算成本。拆 input/output 成本留后。
- **时间基准**:零售用 meter 时刻值(`UsageRecord.cost_cny`),成本用**当前** CatalogPrice;价格已永久化、无促销 → 差≈0。要完全一致需 meter 存成本快照,本期不做。
- **成本取最新版本**:按 (model,tier) 取 effective_from 最新一行的 `cost_cny_per_1m`;历史窗内若改过成本有轻微失真,可接受。

## 实现

- 纯聚合 `src/lib/billing/margin-report.ts` `computeMarginReport(rows, platformTenantId)`:roll up summary + byModel + byCustomer + byTenant + 待补成本(无 prisma/可单测)。
- `GET /api/admin/billing-shadow`:`groupBy(user_id, tenant_id, model_slug, tier, matched)` 拿 token + 零售 → join 当前成本价 Map(一次性查目录,避免 N+1,key=`JSON([tenant,slug,tier])`,`pickEffectivePrice` 取当前)→ `computeMarginReport` → 补 email/租户名。
- 守门沿用 **superadmin + tenantScope**(billing-shadow 仍在 `admin-platform-superadmin-lockdown` 守护清单)。

## 测试

- `margin-report.test.ts`:零售(Σmatched cost_cny)、成本(price×总token/1e6)、毛利、毛利率、成本覆盖率;无成本 → 待补成本 + 覆盖率正确;byCustomer/byTenant 毛利;null tenant→平台主体;空输入。
- `admin-billing-shadow-route.test.ts`:cost join(取最新版本价)、**撤掉 new-api 字段**(断言无 newapi/diff)、待补成本、email/租户名 join、tenantScope(usage+catalog 双查询都收敛)、period。
- `billing-shadow-report.test.tsx`:`<ShadowReport>` SSR —— 怎么读(new-api 不参与)、4 卡、亏损红/薄黄/无成本 `—`、待补成本、按租户(>1)、旧 new-api/差异口径已消失、中英文。

## 边界(死线)

纯只读;不做 P4c(真扣费 / 余额门 / 充值改写);成本不进 new-api 计费(纯 portal 毛利看板)。
