# P4b — 影子计量对账报表(P4c 切换前的验证关)

> 升级 P4a 的 `/admin/billing-shadow` 观察页为**对账报表**:对比"portal 按我们定价算的成本"
> vs"new-api 实际扣的",看差多少、覆盖多少。
> ⚠️ **纯只读**:不扣费、不挡请求、不改 meter、不写 new-api、不碰客户余额。只读 `UsageRecord` 聚合。

## 对账口径

`UsageRecord` 每条有 `cost_cny`(portal 按生效 `CatalogPrice` 算的)、`newapi_quota`(new-api 实扣 raw quota)、
`matched`、`model_slug`/`tier`/tokens/`log_created_at`/`tenant_id`/`user_id`。

| 指标         | 算法                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| portal 成本  | `Σ cost_cny`,**仅 `matched=true`**(未配价记录 `cost_cny=0`,口径上排除)              |
| new-api 实扣 | `Σ newapi_quota`(全部记录)经 `quotaToCny` 折 ¥(走 `quota-units.ts`,不另写 FX)       |
| 差异         | portal 成本 − new-api 实扣(¥ 和 %)                                                  |
| 覆盖率       | `matched 记录数 / 总记录数`(`matched=false` = 还没配价 / 仅图片,算不出 portal 成本) |

**为什么差异里含覆盖缺口**:portal 成本只算 matched,new-api 实扣算全部。覆盖率低时,
未配价调用被 new-api 计费但 portal 记 0 → 差异自然偏大。所以「差异小」必须配「覆盖率高」才成立 ——
这正是 P4c 就绪判据(见下)。覆盖率到 100% 时,headline 差异 = 纯计量校准差异(口径对齐)。

## 报表内容(`/admin/billing-shadow`)

时间窗 `?period=7d|30d|all`(白名单,默认 **30d**)。

- **汇总卡**:portal 总成本 ¥ / new-api 实扣总 ¥ / 差异 ¥+% / 覆盖率(matched%)。覆盖率卡副行显示「其中未配价占实扣 ¥X」。
- **未配价高亮**:`matched=false` 聚合成 chips,每个带 model×tier·调用数·**该项占的 new-api 实扣 ¥**(按实扣降序 = operator 待配价优先级)。
- **按模型 × 档次**:每行 model/tier / 调用数 / **匹配率** / portal ¥ / new-api ¥ / **差异 ¥+%**。按调用量降序;`|差异%| > 10%` 的行标红;匹配率 <100% 标黄。
- **按租户**(仅 >1 租户时显示):superadmin 的跨租户视图;partner admin 经 `tenantScope` 自然只看自己一行。
- **按客户**:email / 调用数 / portal ¥ / new-api ¥ / 差异 ¥+%。

## 怎么读 / P4c 就绪判据

- **这是影子数据** —— portal 假设接管计费会怎么算,对比 new-api 现在实际怎么扣。未生效、不影响客户。
- **差异小 + 覆盖率高** → 计量管道可信,可考虑 P4c 切换。
- **差异大 / 覆盖率低** → 先给未定价模型配价、把 catalog 对齐 global,再继续观察。

## 守门 + 隔离

- `GET /api/admin/billing-shadow`:cookie + **superadmin**(P6b §0 平台级管理锁;`admin-platform-superadmin-lockdown` 静态守护测试强制此串)。nav 项 `superadminOnly`。
- `tenantScope(admin)` spread 进每个聚合 `where`:superadmin 看全部;partner admin(role=admin)只看自己租户。
  当前 gate 是 superadmin-only,partner 分支为**防御性接线**(单测以 partner principal 直接验证 where 被收敛),
  P6c partner 后台开放访问时即生效 —— 符合 brief §7「partner admin 只看自己租户,不看全平台对账」。

## 测试

- `src/__tests__/app/api/admin-billing-shadow-route.test.ts`:聚合算法(matched-only portal 成本、`quotaToCny` 实扣、差异、覆盖率、未配价实扣)、byModel 匹配率+差异+排序、byTenant join 名字+排序+null→平台主体、鉴权、tenantScope(superadmin vs partner)、period 白名单(默认 30d / all / 注入回退)。
- `src/__tests__/app/billing-shadow-report.test.tsx`:`<ShadowReport>` SSR smoke —— 解读说明、4 汇总卡(含覆盖率/未配价占比)、匹配率、大差异标红、未配价 chips 带实扣 ¥、按租户表(>1 才出)、中英文。

## 边界(死线)

纯只读 —— 不扣费、不挡请求、不改 P4a meter、不写 new-api、不碰余额、不做 P4c(余额账本 / 余额门 / 充值改写)。换算复用 `quota-units.ts`。
