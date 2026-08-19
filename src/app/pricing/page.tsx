/**
 * Public /pricing page — the model price sheet, read live from the catalog
 * (catalog_models / catalog_prices), grouped VENDOR-first like /models.
 *
 * Single source of truth: operators change prices in /admin/pricing (or the
 * catalog import wizard); this page re-reads the same versioned catalog rows
 * the billing meter uses (`effective_from ≤ now`, newest per tier), so what
 * customers see here can never drift from what they are charged — the drift
 * class the hand-written landing PRICING_ROWS suffered from (W7→2026-07 audit).
 *
 * Public access (NOT under (authenticated)); the landing page has linked
 * /pricing since W8 (dead until this page). ISR revalidate=60 mirrors /models.
 *
 * Rendering rules:
 *  - only enabled catalog models with ≥1 current price on an ENABLED tier
 *    (ChannelGroup.enabled) — retired tiers vanish without catalog surgery;
 *  - HIDDEN_MODELS (same denylist as /models & chat picker) are skipped —
 *    models slated for removal don't get a public price;
 *  - tier labels come from ChannelGroup.display_name, ordered by tier_level.
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { BackButton } from '@/components/BackButton';
import { Logo } from '@/components/brand/Logo';
import { FormError } from '@/components/ui/FormError';
import { prisma } from '@/lib/db';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { categorizeByVendor, HIDDEN_MODELS, VENDOR_META, VENDOR_ORDER, type VendorName } from '@/lib/models/categorize';
import { getCurrentUser } from '@/lib/auth/session';
import { getOption } from '@/lib/newapi/client';
import { listUserTierMultipliers } from '@/lib/newapi/user-tier-multiplier';

export const revalidate = 60;
export const metadata = {
    title: '模型价格 — LLmRoute',
    description:
        'LLmRoute 模型价格总表:Claude / GPT / Gemini 等按百万 token 计费,生图模型按张计费,全部人民币标价,按档次(号池 / 官方稳定 / 专属)分列。',
};

async function getPricingUserId(): Promise<string | undefined> {
    try {
        const h = await headers();
        const user = await getCurrentUser(
            new NextRequest('http://internal/pricing', { headers: { cookie: h.get('cookie') ?? '' } }),
        );
        return user?.id;
    } catch {
        // Unit renders and static tooling have no request scope; public
        // pricing simply falls back to the public GroupRatio in that case.
        return undefined;
    }
}

interface PriceCell {
    tierKey: string;
    tierLabel: string;
    inputCny: number | null;
    outputCny: number | null;
    perImageCny: number | null;
    publicMultiplier: number | null;
    effectiveMultiplier: number | null;
}

interface ModelBlock {
    slug: string;
    displayName: string;
    rows: PriceCell[];
}

interface VendorBlock {
    vendor: VendorName;
    models: ModelBlock[];
}

/** ¥6.0000 → "6"、¥2.0571 → "2.0571" — Decimal(12,4) 无浮点噪声,trim 即可。 */
function fmtCny(n: number): string {
    return n.toFixed(4).replace(/\.?0+$/, '');
}

async function getGroupRatioSafe(): Promise<string | null> {
    try {
        return await getOption('GroupRatio');
    } catch (err) {
        console.warn('[pricing] public GroupRatio lookup failed:', err);
        return null;
    }
}

async function loadPricingSheet(userId?: string): Promise<{ vendors: VendorBlock[]; modelCount: number }> {
    const [models, groups, groupRatioRaw, overrides] = await Promise.all([
        prisma.catalogModel.findMany({
            // 锁平台主体 —— slug 仅在 tenant 内唯一,与 machine-catalog / billing meter 同标准。
            where: { enabled: true, tenant_id: PLATFORM_TENANT_ID },
            include: {
                // 只取已生效的价,降序 → 每 tier 首条 = 现行价(与计费 pickEffectivePrice 同口径)。
                prices: {
                    where: { effective_from: { lte: new Date() } },
                    orderBy: { effective_from: 'desc' },
                },
            },
            orderBy: [{ sort_order: 'asc' }, { slug: 'asc' }],
        }),
        prisma.channelGroup.findMany({
            where: { enabled: true, tenant_id: PLATFORM_TENANT_ID },
            orderBy: [{ tier_level: 'asc' }, { key: 'asc' }],
        }),
        getGroupRatioSafe(),
        userId
            ? listUserTierMultipliers(userId).catch((err) => {
                  console.warn(`[pricing] dedicated multiplier lookup failed for user ${userId}:`, err);
                  return [];
              })
            : Promise.resolve([]),
    ]);

    let groupRatios: Record<string, number> = {};
    try {
        const parsed = groupRatioRaw ? JSON.parse(groupRatioRaw) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            groupRatios = Object.fromEntries(
                Object.entries(parsed).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
            ) as Record<string, number>;
        }
    } catch {
        // Public pricing remains usable when the upstream option is malformed.
    }
    const overridesByGroup = new Map(
        overrides.map((override) => [override.newapi_billing_group, Number(override.multiplier)]),
    );
    const groupByTier = new Map(groups.map((group) => [group.key, group.newapi_group]));

    const tierLabel = new Map<string, string>();
    const tierRank = new Map<string, number>();
    groups.forEach((g, i) => {
        tierLabel.set(g.key, g.display_name);
        tierRank.set(g.key, i);
    });

    const byVendor = new Map<VendorName, ModelBlock[]>();
    let modelCount = 0;
    for (const m of models) {
        if (HIDDEN_MODELS.has(m.slug)) continue;
        const seen = new Set<string>();
        const rows: PriceCell[] = [];
        for (const p of m.prices) {
            if (seen.has(p.tier)) continue; // 降序首条 = 现行价
            seen.add(p.tier);
            if (!tierLabel.has(p.tier)) continue; // 档次已停用 → 不挂公开价
            rows.push({
                tierKey: p.tier,
                tierLabel: tierLabel.get(p.tier)!,
                inputCny: p.input_cny_per_1m == null ? null : Number(p.input_cny_per_1m),
                outputCny: p.output_cny_per_1m == null ? null : Number(p.output_cny_per_1m),
                perImageCny: p.per_image_cny == null ? null : Number(p.per_image_cny),
                publicMultiplier: groupRatios[groupByTier.get(p.tier) ?? ''] ?? null,
                effectiveMultiplier:
                    overridesByGroup.get(groupByTier.get(p.tier) ?? '') ??
                    groupRatios[groupByTier.get(p.tier) ?? ''] ??
                    null,
            });
        }
        if (rows.length === 0) continue; // 无任何可展示价 → 不上表
        rows.sort((a, b) => tierRank.get(a.tierKey)! - tierRank.get(b.tierKey)!);
        const vendor = categorizeByVendor(m.slug);
        if (!byVendor.has(vendor)) byVendor.set(vendor, []);
        byVendor.get(vendor)!.push({ slug: m.slug, displayName: m.display_name, rows });
        modelCount += 1;
    }

    const vendors: VendorBlock[] = VENDOR_ORDER.filter((v) => byVendor.has(v)).map((v) => ({
        vendor: v,
        models: byVendor.get(v)!,
    }));
    return { vendors, modelCount };
}

export default async function PricingPage() {
    let sheet: Awaited<ReturnType<typeof loadPricingSheet>> | null = null;
    let fetchErr = false;
    try {
        sheet = await loadPricingSheet(await getPricingUserId());
    } catch (err) {
        // 与 /models 同哲学:DB 抖动不炸公开页,渲染 chrome + 错误横幅。
        fetchErr = true;
        console.warn('[pricing] loadPricingSheet failed:', err);
    }

    return (
        <main className="min-h-screen bg-paper px-4 py-8">
            <div className="max-w-5xl mx-auto">
                <header className="mb-6 flex flex-col gap-3">
                    <BackButton className="inline-flex items-center gap-1 text-xs text-muted-ink hover:text-brand-accent transition-colors duration-150 ease-brand no-underline w-fit cursor-pointer border-0 bg-transparent p-0">
                        <span aria-hidden="true">←</span>
                        <span>返回</span>
                    </BackButton>
                    <div className="flex items-center gap-3">
                        <Logo variant="primary-flat" size={28} />
                        <p className="m-0 text-xs text-minor-ink">One route. Every model.</p>
                    </div>
                    <h1 className="m-0 text-3xl font-semibold text-navy">模型价格</h1>
                    <p className="m-0 text-sm text-muted-ink leading-relaxed max-w-3xl">
                        全部为人民币标价:对话模型按 <strong className="text-navy">¥ / 百万 token</strong>(输入 /
                        输出分列)计费,生图模型按 <strong className="text-navy">¥ / 张</strong> 计费。
                        同一模型的不同「档次」对应不同上游线路(号池 / 官方稳定 / 专属等),在{' '}
                        <Link href="/keys" className="text-navy underline">
                            密钥管理
                        </Link>{' '}
                        创建 API Key 时选择。价格数据与计费系统同源实时读取;完整模型清单见{' '}
                        <Link href="/models" className="text-navy underline">
                            /models
                        </Link>
                        。
                    </p>
                </header>

                {fetchErr || !sheet ? (
                    <FormError severity="banner">当前无法获取价格表,请稍后重试。</FormError>
                ) : (
                    <div className="flex flex-col gap-10">
                        {sheet.vendors.map((vb) => (
                            <VendorPriceSection key={vb.vendor} block={vb} />
                        ))}
                        <p className="m-0 text-xs text-minor-ink leading-relaxed">
                            共 {sheet.modelCount} 个已标价模型。部分长尾模型(开源系 / 视频等)未列入本表,
                            以实际用量账单为准;如需批量或企业价,请联系我们。
                        </p>
                    </div>
                )}
            </div>
        </main>
    );
}

function VendorPriceSection({ block }: { block: VendorBlock }) {
    const meta = VENDOR_META[block.vendor];
    return (
        <section>
            <header className="flex items-center gap-3 mb-4 pb-3 border-b border-brand-border">
                <span
                    aria-hidden="true"
                    className="flex items-center justify-center w-10 h-10 rounded-xl bg-navy text-paper font-semibold text-lg shrink-0"
                >
                    {meta.initial}
                </span>
                <div className="min-w-0">
                    <h2 className="m-0 text-xl font-semibold text-navy leading-tight">{block.vendor}</h2>
                    {meta.zh && <p className="m-0 text-xs text-minor-ink">{meta.zh}</p>}
                </div>
                <span className="ml-auto shrink-0 text-xs font-medium text-muted-ink bg-paper-muted border border-brand-border rounded-full px-2.5 py-1">
                    {block.models.length} 个模型
                </span>
            </header>

            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-muted-ink border-b border-brand-border">
                            <th className="py-2 pr-4 font-semibold">模型</th>
                            <th className="py-2 pr-4 font-semibold">档次</th>
                            <th className="py-2 pr-4 font-semibold text-right">输入 ¥/1M</th>
                            <th className="py-2 pr-4 font-semibold text-right">输出 ¥/1M</th>
                            <th className="py-2 font-semibold text-right">生图 ¥/张</th>
                            <th className="py-2 pl-4 font-semibold text-right">有效倍率</th>
                        </tr>
                    </thead>
                    <tbody>
                        {block.models.map((m) =>
                            m.rows.map((row, i) => (
                                <tr key={`${m.slug}:${row.tierKey}`} className="border-b border-brand-border/60">
                                    {i === 0 && (
                                        <td className="py-2.5 pr-4 align-top" rowSpan={m.rows.length}>
                                            <div className="font-medium text-navy">{m.displayName}</div>
                                            <code className="text-xs text-minor-ink">{m.slug}</code>
                                        </td>
                                    )}
                                    <td className="py-2.5 pr-4 text-muted-ink">{row.tierLabel}</td>
                                    <td className="py-2.5 pr-4 text-right text-navy tabular-nums">
                                        {row.inputCny != null ? `¥${fmtCny(row.inputCny)}` : '—'}
                                    </td>
                                    <td className="py-2.5 pr-4 text-right text-navy tabular-nums">
                                        {row.outputCny != null ? `¥${fmtCny(row.outputCny)}` : '—'}
                                    </td>
                                    <td className="py-2.5 text-right text-navy tabular-nums">
                                        {row.perImageCny != null ? `¥${fmtCny(row.perImageCny)}` : '—'}
                                    </td>
                                    <td className="py-2.5 pl-4 text-right text-navy tabular-nums">
                                        {row.effectiveMultiplier != null ? `${row.effectiveMultiplier}x` : '—'}
                                    </td>
                                </tr>
                            )),
                        )}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
