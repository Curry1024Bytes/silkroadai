/**
 * P2.10 — 按家族/档次批量填成本(乙案:成本 = 零售 × 拿货ratio/零售ratio)。
 *
 * 纯逻辑(无 server-only / 无 prisma / 无 I/O),可单测、也可被 'use client' 定价页 import。
 * 真正的 DB 查询 + 写新价版本行在 `POST /api/admin/pricing/batch-cost` 路由里,本模块只算。
 *
 * 公式(乙案,钉零售):
 *   fraction        = costRatio / retailRatio           # 成本占零售的比例(Claude 0.15/1.3 ≈ 0.1154)
 *   newCost(chat)   = input_cny_per_1m × fraction        # 钉【输入】零售价(与现有 opus-4-8 ¥0.75=¥6.5×0.1154 + 定价页 fmtMargin(input,cost) 一致)
 *   newCost(image)  = per_image_cny  × fraction
 *
 * 边界(brief §4/§7):只填有零售价的 (model,tier);无零售价跳过;不动零售价、不 sync new-api、
 * 成本钉单一字段(input/output 拆分成本留后)。写入走【新版本行】(保留历史),不是 UPDATE。
 */

import { deriveTierRows } from './pricing-tiers';

/** Decimal 字段从 JSON 可能是 string|number;统一成 number|null。 */
export function toNum(v: string | number | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** 四舍五入到 4 位小数(对齐 CatalogPrice.cost_cny_per_1m = Decimal(12,4))。 */
export function round4(n: number): number {
    return Math.round(n * 10000) / 10000;
}

/** 成本占零售的比例 = 拿货ratio / 零售ratio。 */
export function costFraction(costRatio: number, retailRatio: number): number {
    return costRatio / retailRatio;
}

export interface BatchPriceLike {
    tier: string;
    input_cny_per_1m: string | number | null;
    output_cny_per_1m: string | number | null;
    per_image_cny: string | number | null;
    cost_cny_per_1m: string | number | null;
}

export interface BatchModelLike {
    id: string;
    slug: string;
    display_name: string;
    modality: string | null;
    upstream_map: unknown;
    /** 该模型所有价行,effective_from DESC(每档第一行 = 当前价)。 */
    prices: BatchPriceLike[];
}

export interface BatchCostRow {
    model_id: string;
    slug: string;
    display_name: string;
    modality: string;
    tier: string;
    /** 算成本的零售基:chat→input、image→per_image。 */
    base: 'input' | 'per_image';
    /** 零售基的当前值(skip 时为 null)。 */
    retail: number | null;
    oldCost: number | null;
    newCost: number | null;
    /** true = 该 (model,tier) 无零售价,算不出成本 → 跳过(预览里标注)。 */
    skipped: boolean;
    /** 写新版本行时要复制的零售字段(仅 !skipped 时有值)。 */
    copy: {
        input_cny_per_1m: number | null;
        output_cny_per_1m: number | null;
        per_image_cny: number | null;
    } | null;
}

export interface BatchCostParams {
    costRatio: number;
    retailRatio: number;
    /** null/undefined = 该 vendor 所有档;否则只该档。 */
    tier?: string | null;
}

export interface BatchCostResult {
    fraction: number;
    rows: BatchCostRow[];
    affected: number; // !skipped(会写入)行数
    skipped: number; // 无零售价跳过的行数
}

/**
 * 给定一批模型(含各自版本化价)+ 拿货/零售 ratio[+ 档次],算出每个 (model,tier) 的新成本。
 * 不写库 —— 调用方(路由)拿 rows 做预览,或据 `copy`+`newCost` 插新版本行。
 */
export function computeBatchCost(models: BatchModelLike[], params: BatchCostParams): BatchCostResult {
    const fraction = costFraction(params.costRatio, params.retailRatio);
    const wantTier = params.tier ?? null;
    const rows: BatchCostRow[] = [];

    for (const model of models) {
        const modality = model.modality ?? 'chat';
        const isImage = modality === 'image';
        const base: 'input' | 'per_image' = isImage ? 'per_image' : 'input';

        // deriveTierRows = upstream_map 档 ∪ 已有价档,每档取当前价(复用定价页同一逻辑)。
        let tierRows = deriveTierRows(model);
        if (wantTier) tierRows = tierRows.filter((r) => r.tier === wantTier);

        for (const { tier, current } of tierRows) {
            const retail = current ? toNum(isImage ? current.per_image_cny : current.input_cny_per_1m) : null;

            // 无当前价 / 无零售基 / 零售 ≤ 0 → 算不出成本,跳过。
            if (!current || retail === null || retail <= 0) {
                rows.push({
                    model_id: model.id,
                    slug: model.slug,
                    display_name: model.display_name,
                    modality,
                    tier,
                    base,
                    retail: null,
                    oldCost: current ? toNum(current.cost_cny_per_1m) : null,
                    newCost: null,
                    skipped: true,
                    copy: null,
                });
                continue;
            }

            // 乘前除后顺序无所谓(都 round 到 4 位);用全精度 ratio 算,避免先 round fraction 的漂移。
            const newCost = round4((retail * params.costRatio) / params.retailRatio);
            rows.push({
                model_id: model.id,
                slug: model.slug,
                display_name: model.display_name,
                modality,
                tier,
                base,
                retail,
                oldCost: toNum(current.cost_cny_per_1m),
                newCost,
                skipped: false,
                copy: {
                    input_cny_per_1m: toNum(current.input_cny_per_1m),
                    output_cny_per_1m: toNum(current.output_cny_per_1m),
                    per_image_cny: toNum(current.per_image_cny),
                },
            });
        }
    }

    const affected = rows.filter((r) => !r.skipped).length;
    return { fraction, rows, affected, skipped: rows.length - affected };
}
