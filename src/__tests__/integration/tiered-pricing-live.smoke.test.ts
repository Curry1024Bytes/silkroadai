/** Opt-in, synthetic isolated PostgreSQL + official new-api rc.23 only. */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { POST as save, GET as list } from '@/app/api/admin/pricing/cost-rules/route';
import { POST as publish } from '@/app/api/admin/pricing/cost-rules/publish/route';
import { runPricingPublisherOnce } from '@/lib/admin/pricing-publish';
import { getPricingRuntimeModels } from '@/lib/newapi/client';
import { readPersistedTieredPricingOptions } from '@/lib/newapi/persisted-pricing';
import { EXPRESSION_KEY } from '@/lib/admin/pricing-tiered-plan';

const enabled = process.env.LLMROUTE_TIERED_INTEGRATION === 'yes';
const TENANT = '77777777-7777-4777-8777-777777770001';
const MODEL = '77777777-7777-4777-8777-777777770002';
const config = {
    version: 1,
    basis: 'token',
    currency: 'credits',
    credits_per_cny: 10,
    upstream_multiplier: 1.3,
    retail_multiplier: 1.6,
    markup_percent: 0,
    source_note: 'Synthetic isolated live verification',
    token_rates: { input: 5, output: 30, cache_read: 0.5, cache_write: null },
    variants: [],
};
const request = (body?: unknown) =>
    new NextRequest('http://localhost/api/admin/pricing/cost-rules', {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Admin-Token': process.env.ADMIN_TOKEN!, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

describe.skipIf(!enabled)('real isolated tiered publication lifecycle', () => {
    it('saves through routes, confirms a no-op and two actual expression publications, preserving cache and tiers', async () => {
        // Never reuse local or production connection settings accidentally.
        expect(new URL(process.env.DATABASE_URL!).hostname).toBe('127.0.0.1');
        expect(new URL(process.env.DATABASE_URL!).pathname).toBe('/llmroute_tiered_0916');
        expect(process.env.NEWAPI_BASE_URL).toBe('http://127.0.0.1:18092');
        expect(new URL(process.env.NEWAPI_PRICING_DATABASE_URL!).pathname).toBe('/newapi_fixture');
        expect(await prisma.catalogModel.count()).toBe(0);
        await prisma.tenant.create({ data: { id: TENANT, slug: 'tiered-fixture', brand_name: 'Tiered fixture' } });
        await prisma.channelGroup.create({
            data: {
                tenant_id: TENANT,
                key: 'enterprise',
                display_name: 'Enterprise fixture',
                newapi_group: 'enterprise',
                enabled: true,
                is_default: true,
                newapi_channel_ids: [1],
            },
        });
        await prisma.catalogModel.create({
            data: {
                id: MODEL,
                tenant_id: TENANT,
                slug: 'gpt-5.5',
                display_name: 'GPT 5.5 fixture',
                vendor: 'openai',
                enabled: true,
                upstream_map: { enterprise: { channel_id: 1, upstream_model: 'gpt-5.5' } },
            },
        });
        await prisma.catalogPrice.create({
            data: {
                model_id: MODEL,
                tier: 'enterprise',
                input_cny_per_1m: 0.8,
                output_cny_per_1m: 4.8,
                cost_cny_per_1m: 0.65,
            },
        });
        const initial = await getPricingRuntimeModels(['gpt-5.5']);
        const report: unknown[] = [];
        let revision: number | null = null;
        for (const multiplier of [1.6, 1.8, 1.6]) {
            const savedResponse = await save(
                request({
                    model_id: MODEL,
                    tier: 'enterprise',
                    expected_revision: revision,
                    config: { ...config, retail_multiplier: multiplier },
                }),
            );
            const saved = await savedResponse.json();
            expect(saved, JSON.stringify(saved)).toHaveProperty('rule.id');
            expect(savedResponse.status).toBe(200);
            revision = saved.rule.revision;
            const capabilities = await (await list(request())).json();
            expect(capabilities.capabilities).toContainEqual(
                expect.objectContaining({ model_id: MODEL, publishable: true, publication_mode: 'tiered_token' }),
            );
            const selections = [{ rule_id: saved.rule.id, revision }];
            const previewResponse = await publish(request({ action: 'preview', selections }));
            const preview = await previewResponse.json();
            expect(preview, JSON.stringify(preview)).toHaveProperty('preview.publication_mode', 'tiered_token');
            expect(previewResponse.status).toBe(200);
            expect(preview.preview.rows[0].after_details.tiers).toHaveLength(2);
            expect(preview.preview.rows[0].after_details.tiers[0].max_input_tokens).toBe(272000);
            expect(preview.preview.rows[0].after_details.tiers[0].rates.cache_read).toBeCloseTo(multiplier * 0.05, 12);
            expect(preview.preview.rows[0].after_details.tiers[1].rates.output).toBeCloseTo(multiplier * 4.5, 12);
            if (revision === 1) expect(preview.preview.unchanged).toBe(true);
            const confirmation = {
                action: 'publish',
                selections,
                preview_token: preview.preview.preview_token,
                selection_token: preview.selection_token,
            };
            const acceptedResponse = await publish(request(confirmation));
            const accepted = await acceptedResponse.json();
            expect(accepted, JSON.stringify(accepted)).toHaveProperty('job.id');
            expect(acceptedResponse.status).toBe(202);
            const duplicate = await (await publish(request(confirmation))).json();
            expect(duplicate.job.id).toBe(accepted.job.id);
            const result = await runPricingPublisherOnce();
            expect(result, JSON.stringify(result)).toMatchObject({ id: accepted.job.id, status: 'succeeded' });
            const row = await prisma.catalogPrice.findFirstOrThrow({
                where: { model_id: MODEL },
                orderBy: { effective_from: 'desc' },
            });
            expect(row.billing_details).toEqual(preview.preview.rows[0].after_details);
            expect(Number(row.cost_cny_per_1m)).toBe(0.65);
            expect(await prisma.pricingPublishWrite.count()).toBe(revision! - 1);
            const disk = await readPersistedTieredPricingOptions();
            const runtime = await getPricingRuntimeModels(['gpt-5.5']);
            expect(runtime.models[0].billing_expr).toBe(JSON.parse(disk[EXPRESSION_KEY])['gpt-5.5']);
            expect(runtime.group_ratio).toEqual(initial.group_ratio);
            report.push({
                revision,
                multiplier,
                job_status: result?.status,
                unchanged: preview.preview.unchanged,
                details: row.billing_details,
                customer_overrides: preview.preview.customer_overrides,
            });
        }
        expect((await getPricingRuntimeModels(['gpt-5.5'])).models[0].billing_expr).toBe(
            initial.models[0].billing_expr,
        );
        expect(await prisma.pricingPublishJob.count({ where: { status: 'succeeded' } })).toBe(3);
        expect(await prisma.pricingPublishWrite.count({ where: { status: 'in_flight' } })).toBe(0);
        expect(
            (await prisma.pricingPublishCoordinator.findUniqueOrThrow({ where: { id: 'newapi' } })).active_job_id,
        ).toBeNull();
        writeFileSync(
            '/tmp/llmroute-tiered-pricing-qa/evidence/portal-live-lifecycle.json',
            JSON.stringify(
                {
                    success: true,
                    real_postgres: true,
                    real_newapi: true,
                    pricing_jobs: 3,
                    expression_writes: 2,
                    original_expression_restored: true,
                    report,
                },
                null,
                2,
            ),
            { mode: 0o600 },
        );
        await prisma.$disconnect();
    }, 120_000);
});
