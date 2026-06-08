/**
 * P4b-v2 — 对账报表的纯聚合(零售 / 成本 / 毛利)。无 prisma / 无 I/O,可单测。
 *
 * 口径(brief §1,撤掉 new-api quota 基准):
 *   - 零售  = Σ cost_cny(仅 matched;UsageRecord.cost_cny 本就是 meter 时算的零售)。
 *   - 成本  = Σ (cost_cny_per_1m × (input+output) tokens / 1e6),cost_cny_per_1m 由路由 join
 *            当前 CatalogPrice 取(每行已解析进 `costPricePer1m`,null = 该 model×tier 还没录成本)。
 *   - 毛利  = 零售 − 成本;毛利率 = 毛利 / 零售。
 *   - 成本覆盖率 = 有成本价的 matched 记录数 / matched 记录数。
 *
 * 已知近似(brief §4 —— 同样写进路由注释 + 页面"怎么读"块,不藏):
 *   - 成本单一字段:cost_cny_per_1m 不分 input/output,这里按 (input+output) 总 token 估算。
 *   - 时间基准:零售用 meter 时刻值,成本用【当前】成本价;价格稳定时差≈0(已永久化定价)。
 *   - 成本取最新版本:按 (model,tier) 取 effective_from 最新一行的 cost_cny_per_1m。
 *
 * 头条毛利率在成本覆盖率<100% 时偏高(部分调用还没录成本,零售算进分母、成本没算)——
 * 由「成本覆盖率」卡 + 「待补成本」清单 + 下钻行的 cost-missing("—")显式暴露,不静默。
 */

/** 一条聚合输入 = groupBy(user, tenant, model, tier, matched) 的一格,成本价已由路由解析。 */
export interface MarginRow {
    user_id: string;
    tenant_id: string | null;
    model_slug: string;
    tier: string;
    matched: boolean;
    records: number;
    retailCny: number; // Σ cost_cny(该格)
    tokens: number; // Σ (input_tokens + output_tokens)(该格)
    costPricePer1m: number | null; // 当前 CatalogPrice 成本价;null = 没录成本
}

interface Acc {
    records: number; // 全部调用(含 unmatched)
    matchedRecords: number;
    costCoveredRecords: number;
    retailCny: number; // matched-only
    costCny: number; // 仅有成本价的 matched
}

export interface MarginMoney {
    records: number;
    matchedRecords: number;
    costCoveredRecords: number;
    retailCny: number;
    costCny: number;
    marginCny: number;
    marginRate: number | null; // null = 无零售
    costCoverage: number | null; // null = 无 matched
}

export interface MarginModelRow extends MarginMoney {
    model_slug: string;
    tier: string;
    hasCost: boolean; // 该 (model,tier) 至少有成本价(否则成本/毛利在 UI 显 "—")
}
export interface MarginCustomerRow extends MarginMoney {
    user_id: string;
}
export interface MarginTenantRow extends MarginMoney {
    tenant_id: string;
}
export interface CostMissingRow {
    model_slug: string;
    tier: string;
    retailCny: number;
    records: number; // matched 记录数
}

export interface MarginReport {
    summary: MarginMoney;
    byModel: MarginModelRow[];
    byCustomer: MarginCustomerRow[];
    byTenant: MarginTenantRow[];
    costMissing: CostMissingRow[];
}

function blank(): Acc {
    return { records: 0, matchedRecords: 0, costCoveredRecords: 0, retailCny: 0, costCny: 0 };
}

function add(a: Acc, row: MarginRow, cost: number, covered: boolean): void {
    a.records += row.records;
    if (!row.matched) return;
    a.matchedRecords += row.records;
    a.retailCny += row.retailCny;
    if (covered) {
        a.costCny += cost;
        a.costCoveredRecords += row.records;
    }
}

function finalize(a: Acc): MarginMoney {
    const marginCny = a.retailCny - a.costCny;
    return {
        records: a.records,
        matchedRecords: a.matchedRecords,
        costCoveredRecords: a.costCoveredRecords,
        retailCny: a.retailCny,
        costCny: a.costCny,
        marginCny,
        marginRate: a.retailCny > 0 ? marginCny / a.retailCny : null,
        costCoverage: a.matchedRecords > 0 ? a.costCoveredRecords / a.matchedRecords : null,
    };
}

/**
 * 把聚合行 roll up 成 summary + byModel + byCustomer + byTenant + 待补成本。
 * `platformTenantId` 用于把 tenant_id=null 归并到平台主体(与 meter / catalog 的 tenant 对齐)。
 */
export function computeMarginReport(rows: MarginRow[], platformTenantId: string): MarginReport {
    const summary = blank();
    const byModelAcc = new Map<string, Acc & { model_slug: string; tier: string }>();
    const byUserAcc = new Map<string, Acc & { user_id: string }>();
    const byTenantAcc = new Map<string, Acc & { tenant_id: string }>();

    for (const row of rows) {
        const covered = row.matched && row.costPricePer1m != null;
        const cost = covered ? (row.costPricePer1m as number) * (row.tokens / 1_000_000) : 0;
        const tenantKey = row.tenant_id ?? platformTenantId;
        const modelKey = JSON.stringify([row.model_slug, row.tier]);

        add(summary, row, cost, covered);

        let m = byModelAcc.get(modelKey);
        if (!m) {
            m = Object.assign(blank(), { model_slug: row.model_slug, tier: row.tier });
            byModelAcc.set(modelKey, m);
        }
        add(m, row, cost, covered);

        let u = byUserAcc.get(row.user_id);
        if (!u) {
            u = Object.assign(blank(), { user_id: row.user_id });
            byUserAcc.set(row.user_id, u);
        }
        add(u, row, cost, covered);

        let tn = byTenantAcc.get(tenantKey);
        if (!tn) {
            tn = Object.assign(blank(), { tenant_id: tenantKey });
            byTenantAcc.set(tenantKey, tn);
        }
        add(tn, row, cost, covered);
    }

    const byModel: MarginModelRow[] = [...byModelAcc.values()]
        .map((m) => ({
            model_slug: m.model_slug,
            tier: m.tier,
            hasCost: m.costCoveredRecords > 0,
            ...finalize(m),
        }))
        .sort((a, b) => b.retailCny - a.retailCny);

    const byCustomer: MarginCustomerRow[] = [...byUserAcc.values()]
        .map((u) => ({ user_id: u.user_id, ...finalize(u) }))
        .sort((a, b) => b.retailCny - a.retailCny);

    const byTenant: MarginTenantRow[] = [...byTenantAcc.values()]
        .map((tn) => ({ tenant_id: tn.tenant_id, ...finalize(tn) }))
        .sort((a, b) => b.retailCny - a.retailCny);

    // 待补成本:有 matched 零售但完全没成本价的 (model,tier) —— 去定价页补成本的优先级(按零售降序)。
    const costMissing: CostMissingRow[] = byModel
        .filter((m) => m.matchedRecords > 0 && m.costCoveredRecords === 0)
        .map((m) => ({ model_slug: m.model_slug, tier: m.tier, retailCny: m.retailCny, records: m.matchedRecords }))
        .sort((a, b) => b.retailCny - a.retailCny);

    return { summary: finalize(summary), byModel, byCustomer, byTenant, costMissing };
}
