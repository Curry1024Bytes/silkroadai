import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantScope, tenantForInsert } from '@/lib/admin/tenant-scope';
import { getChannel, listChannels, type NewApiChannel } from '@/lib/newapi/client';
import { buildImportCandidates, type ChannelForImport } from '@/lib/newapi/import-catalog';

export const runtime = 'nodejs';

/**
 * POST /api/admin/models/import — 从 new-api 旗舰渠道一键导入「模型 + 价格」到目录。
 *
 * 两步用法(/admin/models 上的「从 new-api 导入」按钮):
 *   1. ?dryRun=true(默认)→ 只预览:返回渠道菜单 + 将导入什么(每个 model 的 slug /
 *      vendor / 算出的 ¥in/¥out / 是否图片需手填 / 是否已存在跳过),【不写库】。
 *   2. ?dryRun=false → 真导入:把 created+flagged 的模型在一个 $transaction 里建好
 *      (priced 的同时建 CatalogPrice;图片/无 ratio 的只建模型、价格留空待手填),失败整体回滚。
 *
 * 幂等:按 (tenant_id, slug) 对账,已存在的 slug 一律 skip(不覆盖 operator 可能已手改的价)。
 * 不回写 new-api(价格本来就是从 new-api 读的,sync 回去无意义)——只落 portal DB(brief §4)。
 */

// 默认旗舰渠道:Claude(2,sub2api Anthropic)/ ChatGPT(3,sub2api-openai)/
// Gemini 图片(17,nexaxis)。Gemini 文本渠道 id 未在 brief 钉死(探针见过 4/5),
// operator 在导入预览的渠道菜单里勾选即可 —— 故【不硬编码】成默认,而是做成可配置入参。
export const DEFAULT_FLAGSHIP_CHANNEL_IDS = [2, 3, 17];

const bodySchema = z.object({
    channel_ids: z.array(z.number().int().positive()).max(50).optional(),
});

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** getChannel 全量对象 → 推导所需子集。 */
function toChannelForImport(ch: NewApiChannel): ChannelForImport {
    return {
        id: ch.id,
        name: typeof ch.name === 'string' ? ch.name : null,
        models: typeof ch.models === 'string' ? ch.models : '',
        model_ratio: (ch.model_ratio as ChannelForImport['model_ratio']) ?? null,
        completion_ratio: (ch.completion_ratio as ChannelForImport['completion_ratio']) ?? null,
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
    const admin = await resolveAdmin(request, 'admin');
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
    const channelIds =
        parsed.data.channel_ids && parsed.data.channel_ids.length > 0
            ? Array.from(new Set(parsed.data.channel_ids))
            : DEFAULT_FLAGSHIP_CHANNEL_IDS;

    // ── 渠道菜单(best-effort):列出所有渠道让 operator 看到/挑选(含未在默认集里的
    //    Gemini 文本渠道)。失败不阻塞导入 —— 真正的导入按 id 逐个 getChannel。 ──
    let menu: { id: number; name: string | null; type: number | null; model_count: number; selected: boolean }[] = [];
    try {
        const all = await listChannels();
        menu = all.map((c) => ({
            id: c.id,
            name: typeof c.name === 'string' ? c.name : null,
            type: typeof c.type === 'number' ? c.type : null,
            model_count: countModels(c.models),
            selected: channelIds.includes(c.id),
        }));
    } catch {
        menu = [];
    }

    // ── 逐个拉回选中渠道的权威全量对象(只读 GET,不 PUT)。单个失败只记录,不中断。 ──
    const channels: NewApiChannel[] = [];
    const channelErrors: { channel_id: number; error: string }[] = [];
    for (const id of channelIds) {
        try {
            channels.push(await getChannel(id));
        } catch (e) {
            channelErrors.push({ channel_id: id, error: errMsg(e) });
        }
    }

    const candidates = buildImportCandidates(channels.map(toChannelForImport));

    // ── 与本租户现有目录对账(幂等)+ 计算 sort_order 起点。 ──
    const tenant_id = tenantForInsert(admin);
    const existing = await prisma.catalogModel.findMany({
        where: { ...tenantScope(admin) },
        select: { slug: true, sort_order: true },
    });
    const existingSlugs = new Set(existing.map((m) => m.slug));
    const maxSort = existing.reduce((acc, r) => Math.max(acc, r.sort_order ?? 0), 0);

    const created: Array<{
        slug: string;
        display_name: string;
        vendor: string;
        modality: string;
        channel_id: number;
        channel_name: string | null;
        input_cny_per_1m: number | null;
        output_cny_per_1m: number | null;
        ratio_defaulted: boolean;
    }> = [];
    const skipped: Array<{ slug: string; reason: string }> = [];
    const flagged: Array<{
        slug: string;
        display_name: string;
        vendor: string;
        modality: string;
        channel_id: number;
        channel_name: string | null;
        reason: string;
    }> = [];

    // 待写入的项(dryRun 时不写,只用于预览计数)。makePrice = 是否同时建 CatalogPrice。
    const toWrite: Array<{
        slug: string;
        display_name: string;
        vendor: string;
        modality: 'chat' | 'image';
        channel_id: number;
        upstream_model: string;
        sort_order: number;
        makePrice: boolean;
        input_cny_per_1m: number | null;
        output_cny_per_1m: number | null;
    }> = [];

    let sort = maxSort;
    for (const c of candidates) {
        if (existingSlugs.has(c.slug)) {
            skipped.push({ slug: c.slug, reason: 'already_exists' });
            continue;
        }
        sort += 1;
        const common = {
            slug: c.slug,
            display_name: c.display_name,
            vendor: c.vendor,
            modality: c.modality,
            channel_id: c.channel_id,
            upstream_model: c.upstream_model,
            sort_order: sort,
            input_cny_per_1m: c.input_cny_per_1m,
            output_cny_per_1m: c.output_cny_per_1m,
        };

        if (c.price_status === 'priced') {
            created.push({
                slug: c.slug,
                display_name: c.display_name,
                vendor: c.vendor,
                modality: c.modality,
                channel_id: c.channel_id,
                channel_name: c.channel_name,
                input_cny_per_1m: c.input_cny_per_1m,
                output_cny_per_1m: c.output_cny_per_1m,
                ratio_defaulted: c.ratio_defaulted,
            });
            toWrite.push({ ...common, makePrice: true });
        } else {
            flagged.push({
                slug: c.slug,
                display_name: c.display_name,
                vendor: c.vendor,
                modality: c.modality,
                channel_id: c.channel_id,
                channel_name: c.channel_name,
                reason: c.price_status === 'image' ? 'image_model_manual_price' : 'no_model_ratio_manual_price',
            });
            // 图片 / 无 ratio:只建模型,价格留空待 operator 在 /admin/pricing 手填。
            toWrite.push({ ...common, makePrice: false });
        }
    }

    // ── 真导入:一个 $transaction 包住所有 create,失败整体回滚(brief §4)。 ──
    if (!dryRun && toWrite.length > 0) {
        await prisma.$transaction(async (tx) => {
            for (const w of toWrite) {
                const model = await tx.catalogModel.create({
                    data: {
                        tenant_id,
                        slug: w.slug,
                        display_name: w.display_name,
                        vendor: w.vendor,
                        modality: w.modality,
                        enabled: true,
                        sort_order: w.sort_order,
                        upstream_map: { default: { channel_id: w.channel_id, upstream_model: w.upstream_model } },
                    },
                });
                if (w.makePrice) {
                    await tx.catalogPrice.create({
                        data: {
                            model_id: model.id,
                            tier: 'default',
                            input_cny_per_1m: w.input_cny_per_1m,
                            output_cny_per_1m: w.output_cny_per_1m,
                            created_by: admin.user?.id ?? null,
                        },
                    });
                }
            }
        });
    }

    return NextResponse.json({
        dryRun,
        selectedChannelIds: channelIds,
        channels: menu,
        channelErrors,
        created,
        skipped,
        flagged,
        summary: { created: created.length, skipped: skipped.length, flagged: flagged.length },
    });
}
