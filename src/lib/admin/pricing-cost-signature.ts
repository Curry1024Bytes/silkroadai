import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdminPrincipal } from './auth';
import { canonicalSync } from './newapi-sync-plan';
import type { CostBatchContext } from './pricing-cost-publication-guard';
import { PricingPublishError } from './pricing-publish-lock';

/** The publication preview already contains an authenticated ten-minute expiry. */
export function signCostSelection(admin: AdminPrincipal, context: CostBatchContext, previewToken: string) {
    const secret = process.env.PORTAL_JWT_SECRET;
    if (!secret || secret.length < 32)
        throw new PricingPublishError('pricing_signing_unavailable', '定价签名配置不可用。', 503);
    return createHmac('sha256', secret)
        .update(
            canonicalSync({
                purpose: 'pricing-cost-selection-v1',
                actor: admin.user?.id ?? null,
                role: admin.role,
                tenant: admin.tenant_id,
                context,
                previewToken,
            }),
        )
        .digest('hex');
}

export function verifyCostSelection(
    admin: AdminPrincipal,
    context: CostBatchContext,
    previewToken: string,
    token: string,
) {
    const expected = signCostSelection(admin, context, previewToken);
    if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(expected)))
        throw new PricingPublishError('pricing_cost_preview_changed', '成本资料或选择已变化，请重新预览后再发布。');
}
