import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveAdmin } from '@/lib/admin/auth';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { discoverPricingGroupCatalog, listPricingGroups } from '@/lib/admin/pricing-group-catalog';
import { saveCostRules } from '@/lib/admin/pricing-cost-store';
import type { StoredPricingCostRule } from '@/lib/admin/pricing-cost-types';
import { pricingCostSelectionsSchema, resolvePricingCostSelection } from '@/lib/admin/pricing-cost-publication-guard';
import { previewPricingBatch, enqueuePricingBatch } from '@/lib/admin/pricing-publish';
import { signCostSelection, verifyCostSelection } from '@/lib/admin/pricing-cost-signature';
import { readCostBody, costErrorResponse } from '@/lib/admin/pricing-cost-http';
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import {
    pricingGroupSettingsSchema,
    pricingGroupDraftSchema,
    prepareGroupCostDrafts,
    assertGroupSavedSelection,
    groupScopeFromCatalog,
} from '@/lib/admin/pricing-group-workflow';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };
const identity = { group_id: z.string().uuid(), catalog_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) };
const bodySchema = z.discriminatedUnion('action', [
    z
        .object({
            action: z.literal('preview'),
            ...identity,
            settings: pricingGroupSettingsSchema,
            models: z.array(pricingGroupDraftSchema).min(1).max(30),
        })
        .strict(),
    z
        .object({
            action: z.literal('publish'),
            ...identity,
            selections: pricingCostSelectionsSchema,
            preview_token: z.string().min(1).max(200),
            selection_token: z.string().length(64),
        })
        .strict(),
]);

export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    try {
        const id = new URL(request.url).searchParams.get('group_id');
        return NextResponse.json(
            id
                ? { catalog: await discoverPricingGroupCatalog(admin, z.string().uuid().parse(id)) }
                : { groups: await listPricingGroups(admin) },
            { headers: noStore },
        );
    } catch (error) {
        return costErrorResponse(error);
    }
}

export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);
    let saved: StoredPricingCostRule[] | undefined;
    let savedFingerprint: string | undefined;
    try {
        const body = bodySchema.parse(await readCostBody(request));
        let catalog = await discoverPricingGroupCatalog(admin, body.group_id);
        if (catalog.fingerprint !== body.catalog_fingerprint)
            throw new PricingPublishError('pricing_group_stale', '该档次的模型或成本已变化，请重新加载后预览。');
        if (body.action === 'preview') {
            const drafts = prepareGroupCostDrafts(catalog, body.catalog_fingerprint, body.settings, body.models);
            saved = await saveCostRules(drafts, admin);
            catalog = await discoverPricingGroupCatalog(admin, body.group_id);
            savedFingerprint = catalog.fingerprint;
            const selections = saved.map((rule) => ({
                rule_id: rule.id,
                revision: rule.revision,
                ...(body.models.find((row) => row.model_id === rule.model_id)?.variant_key
                    ? { variant_key: body.models.find((row) => row.model_id === rule.model_id)!.variant_key }
                    : {}),
            }));
            assertGroupSavedSelection(catalog, selections);
            const selected = await resolvePricingCostSelection(
                prisma,
                selections,
                admin,
                groupScopeFromCatalog(catalog),
            );
            const preview = await previewPricingBatch(selected.inputs, admin, selected.context);
            return NextResponse.json(
                {
                    rules: saved,
                    selections,
                    preview,
                    cost_rows: selected.cost_rows,
                    selection_token: signCostSelection(admin, selected.context, preview.preview_token),
                    catalog_fingerprint: catalog.fingerprint,
                },
                { headers: noStore },
            );
        }
        assertGroupSavedSelection(catalog, body.selections);
        const selected = await resolvePricingCostSelection(
            prisma,
            body.selections,
            admin,
            groupScopeFromCatalog(catalog),
        );
        verifyCostSelection(admin, selected.context, body.preview_token, body.selection_token);
        const job = await enqueuePricingBatch(selected.inputs, body.preview_token, admin, selected.context);
        return NextResponse.json({ job }, { status: 202, headers: noStore });
    } catch (error) {
        const response = costErrorResponse(error);
        if (!saved) return response;
        const payload = await response.json();
        return NextResponse.json(
            {
                ...payload,
                rules: saved,
                ...(savedFingerprint ? { catalog_fingerprint: savedFingerprint } : {}),
                message: `成本草稿已保存，尚未发布。${payload.message ?? '暂时无法预览，请重新加载后重试。'}`,
            },
            { status: response.status, headers: noStore },
        );
    }
}
