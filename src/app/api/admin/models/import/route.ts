import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope, tenantForInsert } from '@/lib/admin/tenant-scope';
import { getChannel, getOption, listChannels, type NewApiChannel } from '@/lib/newapi/client';
import { buildImportCandidates, type ChannelForImport, type ImportCandidate } from '@/lib/newapi/import-catalog';
import {
    ChannelGroupTopologyError,
    loadChannelGroupTopology,
    topologyErrorPayload,
} from '@/lib/channel-group-topology';

export const runtime = 'nodejs';

/**
 * POST /api/admin/models/import — 从 new-api 旗舰渠道一键导入「模型 + 价格」到目录。
 *
 * P2.8 任意档次感知:按【所有 enabled ChannelGroup 的登记渠道表】判定每个渠道喂哪个档 ——
 * 渠道必须被且只被一个 enabled ChannelGroup 登记。未登记、重复登记、无唯一默认档
 * 都直接失败,绝不回退或虚构 pool/default 档次。
 *
 * 数据形态:一个 slug → 1 条 CatalogModel(upstream_map 按档填 {pool:…, official:…})
 * + 每档一条 CatalogPrice。同一模型从 pool 渠道 + official 渠道分别导入 → 自动合并
 * 成「一个模型两档价」。
 *
 * 两步用法(/admin/models「从 new-api 导入」按钮):
 *   1. ?dryRun=true(默认)→ 只预览:渠道菜单(标 tier)+ 每个 (model,tier) 将 created /
 *      skipped(价已存在)/ flagged(图片/无 ratio 需手填),【不写库】。
 *   2. ?dryRun=false → 真导入:$transaction 内建/合并模型 + 建缺失档的价,失败整体回滚。
 *
 * 幂等:per (slug, tier)。模型按 slug:不存在→建;已存在→merge upstream_map[tier],
 * 并清理同一渠道在旧 tier 下的残留映射(渠道改档后不再虚构两行)。
 * 价按 (model, tier):不存在→建;已存在→skip(不覆盖 operator 手改的价)。
 * 不回写 new-api;只读 GET 渠道 + 只读 ChannelGroup 判档(brief §2/§3)。
 */

const bodySchema = z.object({
    channel_ids: z.array(z.number().int().positive()).min(1).max(50).optional(),
});

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

type UpstreamEntry = { channel_id: number; upstream_model: string };
type UpstreamMap = Record<string, UpstreamEntry>;

/** Json 列 → upstream_map 对象(防 null/数组)。 */
function asUpstreamMap(v: unknown): UpstreamMap {
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ...(v as UpstreamMap) };
    return {};
}

/** getChannel 全量对象 + 该渠道判定出的档次(+ 该档组倍率,GR 原生语义)→ 推导所需子集。 */
function toChannelForImport(ch: NewApiChannel, tier: string, groupRatio: number | null): ChannelForImport {
    return {
        id: ch.id,
        name: typeof ch.name === 'string' ? ch.name : null,
        models: typeof ch.models === 'string' ? ch.models : '',
        model_ratio: (ch.model_ratio as ChannelForImport['model_ratio']) ?? null,
        completion_ratio: (ch.completion_ratio as ChannelForImport['completion_ratio']) ?? null,
        tier,
        group_ratio: groupRatio,
    };
}

function countModels(models: unknown): number {
    if (typeof models !== 'string') return 0;
    return models
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean).length;
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    // dryRun 默认 true:必须显式 ?dryRun=false 才真写库(误调永不破坏数据)。
    const dryRun = new URL(request.url).searchParams.get('dryRun') !== 'false';

    // body 可空(用默认渠道集)。给了就校验。
    let body: unknown = {};
    try {
        body = await request.json();
    } catch {
        body = {};
    }
    const parsed = bodySchema.safeParse(body ?? {});
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const tenant_id = tenantForInsert(admin);
    let topology;
    try {
        topology = await loadChannelGroupTopology(tenant_id);
    } catch (error) {
        if (error instanceof ChannelGroupTopologyError) {
            return NextResponse.json(topologyErrorPayload(error), { status: 409 });
        }
        throw error;
    }
    const groups = topology.groups;
    const registeredChannelIds = [...topology.channelOwner.keys()].sort((a, b) => a - b);
    const channelIds = parsed.data.channel_ids ? Array.from(new Set(parsed.data.channel_ids)) : registeredChannelIds;
    const unregistered = channelIds.filter((id) => !topology.channelOwner.has(id));
    if (unregistered.length > 0) {
        return NextResponse.json(
            {
                error: 'channel_group_topology_invalid',
                message: `所选渠道未归属任何启用档次: ${unregistered.join(', ')}`,
                issues: unregistered.map((channel_id) => ({
                    code: 'unregistered_channel',
                    channel_id,
                })),
            },
            { status: 409 },
        );
    }
    // GR 原生语义(2026-07-20):档次 → 组倍率(¥ = mr × CHAT_FX × GR)。GroupRatio option
    // 读一次,best-effort —— 读不到 → 全部 null → chat 模型按 unpriced 留手填,不反推错价。
    let groupRatioDict: Record<string, number> = {};
    try {
        const raw = await getOption('GroupRatio');
        groupRatioDict = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
        groupRatioDict = {};
    }
    const tierRatioByKey = new Map<string, number | null>();
    for (const g of groups) {
        const r = groupRatioDict[g.newapi_group];
        tierRatioByKey.set(g.key, typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : null);
    }
    const tierRatio = (tier: string): number | null => tierRatioByKey.get(tier) ?? null;
    const defaultTier = topology.defaultGroup.key;
    const channelTier = (id: number): string | null => topology.channelOwner.get(id) ?? null;

    // ── 渠道菜单(best-effort):列出所有渠道 + 各自档次,让 operator 看到/挑选。
    //    失败不阻塞导入 —— 真正的导入按 id 逐个 getChannel。 ──
    let menu: {
        id: number;
        name: string | null;
        type: number | null;
        model_count: number;
        selected: boolean;
        tier: string | null;
    }[] = [];
    try {
        const all = await listChannels();
        menu = all.map((c) => ({
            id: c.id,
            name: typeof c.name === 'string' ? c.name : null,
            type: typeof c.type === 'number' ? c.type : null,
            model_count: countModels(c.models),
            selected: channelIds.includes(c.id),
            tier: channelTier(c.id),
        }));
    } catch {
        menu = [];
    }

    // ── 逐个拉回选中渠道的权威全量对象(只读 GET,不 PUT)+ 按档包装。单个失败只记录。 ──
    const channels: ChannelForImport[] = [];
    const channelErrors: { channel_id: number; error: string }[] = [];
    for (const id of channelIds) {
        try {
            const tier = channelTier(id)!; // selected ids were validated above
            channels.push(toChannelForImport(await getChannel(id), tier, tierRatio(tier)));
        } catch (e) {
            channelErrors.push({ channel_id: id, error: errMsg(e) });
        }
    }

    const candidates = buildImportCandidates(channels);

    // ── 现有目录对账(per (slug,tier) 幂等)。带 upstream_map + 各档已有价 tier。 ──
    const existingModels = await prisma.catalogModel.findMany({
        where: { ...tenantScope(admin) },
        select: { id: true, slug: true, sort_order: true, upstream_map: true, prices: { select: { tier: true } } },
    });
    const bySlug = new Map<
        string,
        { id: string; sort_order: number; upstream_map: UpstreamMap; priceTiers: Set<string> }
    >();
    let maxSort = 0;
    for (const m of existingModels) {
        maxSort = Math.max(maxSort, m.sort_order ?? 0);
        bySlug.set(m.slug, {
            id: m.id,
            sort_order: m.sort_order ?? 0,
            upstream_map: asUpstreamMap(m.upstream_map),
            priceTiers: new Set(m.prices.map((p) => p.tier)),
        });
    }

    // ── 按 slug 分组候选(同 slug 的 pool/official 候选聚到一起 → 一个模型多档)。 ──
    const slugOrder: string[] = [];
    const candidatesBySlug = new Map<string, ImportCandidate[]>();
    for (const c of candidates) {
        if (!candidatesBySlug.has(c.slug)) {
            candidatesBySlug.set(c.slug, []);
            slugOrder.push(c.slug);
        }
        candidatesBySlug.get(c.slug)!.push(c);
    }

    // 结果桶(per (slug, tier))。
    const created: Array<{
        slug: string;
        display_name: string;
        vendor: string;
        modality: string;
        tier: string;
        channel_id: number;
        input_cny_per_1m: number | null;
        output_cny_per_1m: number | null;
        ratio_defaulted: boolean;
    }> = [];
    const skipped: Array<{ slug: string; tier: string; reason: string }> = [];
    const flagged: Array<{
        slug: string;
        display_name: string;
        vendor: string;
        modality: string;
        tier: string;
        channel_id: number;
        reason: string;
    }> = [];

    // 写计划:每个 slug 一项(create 或 merge model)+ 该 slug 下要建的价。
    type PlanItem = {
        slug: string;
        existingId: string | null;
        display_name: string;
        vendor: string;
        modality: 'chat' | 'image';
        sort_order: number;
        upstreamMap: UpstreamMap;
        upstreamMapChanged: boolean;
        pricesToCreate: { tier: string; input: number | null; output: number | null }[];
    };
    const plan: PlanItem[] = [];
    let sort = maxSort;

    for (const slug of slugOrder) {
        const cands = candidatesBySlug.get(slug)!;
        const existing = bySlug.get(slug) ?? null;
        const first = cands[0];

        // 合并 upstream_map:从现有开始,叠加本次每档的映射。一个 new-api 渠道
        // 在当前 ChannelGroup 配置下只属于一档;如果渠道从 catch-all(pool)
        // 调整到显式档次,同步删掉该渠道在旧档次的残留映射。
        const upstreamMap: UpstreamMap = existing ? { ...existing.upstream_map } : {};
        let upstreamMapChanged = existing === null; // 新模型必写
        for (const c of cands) {
            for (const [oldTier, oldEntry] of Object.entries(upstreamMap)) {
                if (oldTier !== c.tier && oldEntry.channel_id === c.channel_id) {
                    delete upstreamMap[oldTier];
                    upstreamMapChanged = true;
                }
            }
            const prev = upstreamMap[c.tier];
            if (!prev || prev.channel_id !== c.channel_id || prev.upstream_model !== c.upstream_model) {
                upstreamMap[c.tier] = { channel_id: c.channel_id, upstream_model: c.upstream_model };
                upstreamMapChanged = true;
            }
        }

        let sortOrder: number;
        if (existing) {
            sortOrder = existing.sort_order;
        } else {
            sort += 1;
            sortOrder = sort;
        }

        const pricesToCreate: { tier: string; input: number | null; output: number | null }[] = [];
        for (const c of cands) {
            const priceExists = existing?.priceTiers.has(c.tier) ?? false;
            if (priceExists) {
                // 价已存在 → 不覆盖 operator 手改的价。
                skipped.push({ slug, tier: c.tier, reason: 'price_exists' });
                continue;
            }
            if (c.price_status === 'priced') {
                created.push({
                    slug,
                    display_name: c.display_name,
                    vendor: c.vendor,
                    modality: c.modality,
                    tier: c.tier,
                    channel_id: c.channel_id,
                    input_cny_per_1m: c.input_cny_per_1m,
                    output_cny_per_1m: c.output_cny_per_1m,
                    ratio_defaulted: c.ratio_defaulted,
                });
                pricesToCreate.push({ tier: c.tier, input: c.input_cny_per_1m, output: c.output_cny_per_1m });
            } else {
                // 图片 / 无 ratio:建/合并模型,价留空待 operator 在 /admin/pricing 手填。
                flagged.push({
                    slug,
                    display_name: c.display_name,
                    vendor: c.vendor,
                    modality: c.modality,
                    tier: c.tier,
                    channel_id: c.channel_id,
                    reason: c.price_status === 'image' ? 'image_model_manual_price' : 'no_model_ratio_manual_price',
                });
            }
        }

        plan.push({
            slug,
            existingId: existing?.id ?? null,
            display_name: first.display_name,
            vendor: first.vendor,
            modality: first.modality,
            sort_order: sortOrder,
            upstreamMap,
            upstreamMapChanged,
            pricesToCreate,
        });
    }

    // ── 真导入:一个 $transaction 包住建/合并模型 + 建价,失败整体回滚(brief §2/§3)。 ──
    if (!dryRun) {
        const hasWork = plan.some((p) => p.existingId === null || p.upstreamMapChanged || p.pricesToCreate.length > 0);
        if (hasWork) {
            await prisma.$transaction(async (tx) => {
                for (const p of plan) {
                    let modelId = p.existingId;
                    if (modelId === null) {
                        const m = await tx.catalogModel.create({
                            data: {
                                tenant_id,
                                slug: p.slug,
                                display_name: p.display_name,
                                vendor: p.vendor,
                                modality: p.modality,
                                enabled: true,
                                sort_order: p.sort_order,
                                upstream_map: p.upstreamMap as Prisma.InputJsonValue,
                            },
                        });
                        modelId = m.id;
                    } else if (p.upstreamMapChanged) {
                        await tx.catalogModel.update({
                            where: { id: modelId },
                            data: { upstream_map: p.upstreamMap as Prisma.InputJsonValue },
                        });
                    }
                    for (const pr of p.pricesToCreate) {
                        await tx.catalogPrice.create({
                            data: {
                                model_id: modelId,
                                tier: pr.tier,
                                input_cny_per_1m: pr.input,
                                output_cny_per_1m: pr.output,
                                created_by: admin.user?.id ?? null,
                            },
                        });
                    }
                }
            });
        }
    }

    return NextResponse.json({
        dryRun,
        selectedChannelIds: channelIds,
        defaultTier,
        channels: menu,
        channelErrors,
        created,
        skipped,
        flagged,
        summary: { created: created.length, skipped: skipped.length, flagged: flagged.length },
    });
}
