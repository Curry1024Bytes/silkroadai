import 'server-only';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { assertPricingCatalogWritable } from '@/lib/admin/pricing-publish-lock';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';
import { loadOfficialContext, publicOfficialView } from './context';
import { CustomerPricingError, officialBaseScale, roundPrice } from './math';

export const officialReferenceSchema = z.object({
    action: z.literal('reference'),
    tier_key: z.string().min(1).max(100),
    model_id: z.string().uuid(),
    currency: z.enum(['CNY', 'USD']),
    fx: z.number().finite().positive().max(1000),
    source_note: z.string().trim().min(2).max(1000),
    expected_version: z.string().min(1),
    cells: z
        .array(z.object({ key: z.string().min(1).max(100), price: z.number().finite().nonnegative().max(1000000) }))
        .min(1)
        .max(100),
});

export async function saveOfficialReference(
    userId: string,
    actorId: string | null,
    input: z.infer<typeof officialReferenceSchema>,
) {
    if (input.currency === 'CNY' && input.fx !== 1)
        throw new CustomerPricingError('reference_fx', '人民币官方价的换算比例应为 1。', 400);
    await prisma.$transaction(
        async (tx) => {
            await assertPricingCatalogWritable(tx);
            const ctx = await loadOfficialContext(userId, tx);
            if (ctx.version !== input.expected_version)
                throw new CustomerPricingError('reference_stale', '价格或规则已变化，请刷新后重新确认。');
            const model = ctx.tiers
                .find((t) => t.key === input.tier_key)
                ?.models.find((m) => m.model_id === input.model_id);
            if (!model?.cells.length || !model.shape)
                throw new CustomerPricingError('reference_unavailable', '无法读取该模型完整的实际计费档位。');
            const active = await tx.customerOfficialPriceRule.count({
                where: { tier_key: input.tier_key, model_key: { in: ['*', input.model_id] } },
            });
            if (active)
                throw new CustomerPricingError(
                    'reference_in_use',
                    '该官方基准正在用于客户专属价，不能直接覆盖。请先核对并撤销受影响的专属规则。',
                );
            const amounts = new Map(input.cells.map((c) => [c.key, roundPrice(c.price * input.fx)]));
            if (
                amounts.size !== input.cells.length ||
                amounts.size !== model.cells.length ||
                model.cells.some((c) => !amounts.has(c.key))
            )
                throw new CustomerPricingError('reference_cells', '官方基准必须完整覆盖当前模型的全部计费档位。', 400);
            const cells = model.cells.map((c) => ({ ...c, official_cny: amounts.get(c.key)! }));
            officialBaseScale(cells);
            const data = {
                tenant_id: ctx.user.tenant_id ?? PLATFORM_TENANT_ID,
                shape: model.shape,
                cells: cells.map((c) => ({ key: c.key, official_cny: c.official_cny })),
                source_currency: input.currency,
                source_fx: input.fx,
                source_note: input.source_note,
                confirmed_by: actorId,
            };
            await tx.customerOfficialReference.upsert({
                where: { model_id_tier_key: { model_id: input.model_id, tier_key: input.tier_key } },
                create: { ...data, model_id: input.model_id, tier_key: input.tier_key },
                update: { ...data, revision: { increment: 1 } },
            });
        },
        { timeout: 60000, maxWait: 5000 },
    );
    return publicOfficialView(await loadOfficialContext(userId));
}
