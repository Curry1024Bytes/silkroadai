/**
 * GPU rental pricing data for /gpu landing page (W7 PR-P).
 *
 * Operator-editable: change a price range, lease term, or quantity
 * minimum here without touching components or running new tests.
 * The /gpu page imports `GPU_SKUS` and renders one `<PricingCard />`
 * per entry. Order in the array = display order on the page.
 *
 * Pricing convention
 * ------------------
 * `monthlyPriceCny.from` / `monthlyPriceCny.to` is the public range
 * we surface as "月 ¥X-Y 起". When `to` is null, the card renders as
 * "月 ¥X 起" (single-anchored). When BOTH `from` and `to` are null,
 * the card renders the literal string in `customLabel` (used for
 * the B300 "询价 / 预订" tier where we don't publish a price).
 *
 * The numbers here are operator-supplied LAUNCH-DAY ranges; they
 * MUST be edited before public marketing pushes. The launch-eve PR
 * intentionally seeds plausible round numbers so the page renders
 * with real values out of the gate.
 *
 * No CNY ↔ raw-quota conversion happens here — these are CNY rental
 * monthly fees, not API call ratios. Different unit, different system.
 */
import { SUPPORT_WECHAT } from '@/lib/public-config';

export type LeaseTerm = 'monthly' | 'quarterly' | 'yearly';

export interface GpuSku {
    /** Stable id for keys / anchors / future tracking. */
    id: string;
    /** Headline displayed on the card top (e.g. "H100 80GB SXM"). */
    name: string;
    /** GPU micro-architecture (e.g. "Hopper") for SEO + spec-conscious buyers. */
    architecture: string;
    /** Memory (e.g. "80GB HBM3"). */
    memory: string;
    /**
     * Monthly rental range in CNY. `from` = lowest tier, `to` = highest
     * (typically the bulk-discount floor). Set BOTH to null + provide
     * `customLabel` for "询价 / 预订" tiers we don't publish.
     */
    monthlyPriceCny: { from: number | null; to: number | null };
    /** Used when monthlyPriceCny.from + .to are both null. */
    customLabel?: string;
    /** Minimum lease term — "月起 / 季起 / 年起". */
    minLeaseTerm: LeaseTerm;
    /** Minimum quantity — "1 张起" / "8 张起" / "集群". */
    minQuantity: string;
    /**
     * Use-case chips shown below the price. Order = display order.
     * Pulled from a small whitelist so the design stays consistent.
     */
    useCases: GpuUseCase[];
    /** Highlight ribbon (optional) — e.g. "旗舰" / "新到货". */
    highlight?: string;
}

export type GpuUseCase = '训练' | '推理' | 'AI 创业' | '企业 R&D' | '内容生成';

export const GPU_SKUS: GpuSku[] = [
    {
        id: 'h100-80gb-sxm',
        name: 'H100 80GB SXM',
        architecture: 'NVIDIA Hopper',
        memory: '80GB HBM3',
        monthlyPriceCny: { from: 80_000, to: 120_000 },
        minLeaseTerm: 'monthly',
        minQuantity: '1 张起',
        useCases: ['训练', '推理', 'AI 创业'],
    },
    {
        id: 'h200-141gb-sxm',
        name: 'H200 141GB SXM',
        architecture: 'NVIDIA Hopper (升级款)',
        memory: '141GB HBM3e',
        monthlyPriceCny: { from: 120_000, to: 180_000 },
        minLeaseTerm: 'monthly',
        minQuantity: '8 张起(单节点)',
        useCases: ['训练', '推理', '企业 R&D'],
        highlight: '高显存 · 大模型推理首选',
    },
    {
        id: 'b300',
        name: 'B300',
        architecture: 'NVIDIA Blackwell',
        memory: '288GB HBM3e',
        monthlyPriceCny: { from: null, to: null },
        customLabel: '询价 / 预订',
        minLeaseTerm: 'quarterly',
        minQuantity: '集群(8 张+)',
        useCases: ['训练', '企业 R&D'],
        highlight: '旗舰 · 最新一代',
    },
];

/** Lease-term → display label. */
export const LEASE_TERM_LABEL: Record<LeaseTerm, string> = {
    monthly: '月起',
    quarterly: '季起',
    yearly: '年起',
};

/** 4-step 服务流程 — order = render order. Operator-editable. */
export interface ServiceStep {
    id: string;
    /** Step number (1-4). */
    n: number;
    title: string;
    body: string;
}

export const SERVICE_STEPS: ServiceStep[] = [
    {
        id: 'inquire',
        n: 1,
        title: '微信询价',
        body: '告诉我们用途 / 卡型号 / 起租期。',
    },
    {
        id: 'quote',
        n: 2,
        title: '方案对接',
        body: '顾问 1-2 个工作日内回报价 + 库存确认。',
    },
    {
        id: 'poc',
        n: 3,
        title: 'POC(可选)',
        body: '大规模订单可申请试用 / 试跑。',
    },
    {
        id: 'deploy',
        n: 4,
        title: '签约部署',
        body: '签约后 2-7 天交付,机房 / 远程 SSH / 容器化任选。',
    },
];

/** 资源优势 — 3 子点. Operator-editable. */
export interface Advantage {
    id: string;
    title: string;
    body: string;
}

export const ADVANTAGES: Advantage[] = [
    {
        id: 'compute-zones',
        title: '算力中心',
        body: '上海临港 / 甘肃 / 青海 / 新疆 多区域,对接"东数西算"国家算力枢纽。',
    },
    {
        id: 'volume-discount',
        title: '大批量 / 长期租赁优惠',
        body: '月 + / 季 + / 年 + 阶梯价,长期客户有专属合同价。',
    },
    {
        id: 'full-stack',
        title: '全栈服务',
        body: '卡时 + 操作系统 + 模型预装 + 售后(选配),开箱即用。',
    },
];

/** 适用客户 chips. Operator-editable. */
export const CUSTOMER_TYPES: string[] = [
    'AI 创业公司(模型训练 / fine-tune)',
    '企业 R&D 团队(私有化推理)',
    '学术 / 研究机构',
    '内容生成业务(视频 / 图像)',
];

/** Contact channels surfaced on the page. */
export const CONTACT = {
    wechat: SUPPORT_WECHAT,
    email: 'support@llmroute.club',
    overseasNote: '海外客户暂仅微信,后续开通 Discord 详询',
} as const;
