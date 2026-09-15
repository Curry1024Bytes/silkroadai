import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { Prisma, PricingCostRule } from '@prisma/client';
import type { AdminPrincipal } from '@/lib/admin/auth';
import type { PricingCostConfig } from '@/lib/admin/pricing-cost-types';

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: mocks.transaction } }));
import {
    saveCostRules,
    costMapping,
    type CostModel,
    type CostGroup,
    type CostDb,
} from '@/lib/admin/pricing-cost-store';
import {
    costPublicationInput,
    resolvePricingCostSelection,
    assertPricingCostContext,
} from '@/lib/admin/pricing-cost-publication-guard';
import { signCostSelection, verifyCostSelection } from '@/lib/admin/pricing-cost-signature';

const MODEL = '11111111-1111-4111-8111-111111111111';
const RULE = '22222222-2222-4222-8222-222222222222';
const ADMIN: AdminPrincipal = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const quote = (): PricingCostConfig => ({
    version: 1,
    basis: 'token',
    currency: 'credits',
    credits_per_cny: 5,
    upstream_multiplier: 0.5,
    markup_percent: 20,
    source_note: 'supplier reference',
    token_rates: { input: 10, output: 50, cache_read: null, cache_write: null },
    variants: [],
});
const model = (): CostModel => ({
    id: MODEL,
    tenant_id: 'tenant-a',
    enabled: true,
    slug: 'text-model',
    modality: 'chat',
    upstream_map: { standard: { channel_id: 14, upstream_model: 'text-model' } },
});
const groups = (): CostGroup[] => [
    {
        key: 'standard',
        tenant_id: 'tenant-a',
        newapi_group: 'group',
        newapi_channel_ids: [14],
        enabled: true,
        is_default: true,
        tier_level: 1,
    },
];
const rule = (): PricingCostRule => ({
    id: RULE,
    model_id: MODEL,
    tier: 'standard',
    channel_id: 14,
    upstream_model: 'text-model',
    config: quote() as unknown as Prisma.JsonValue,
    revision: 1,
    created_by: null,
    updated_by: null,
    created_at: new Date(),
    updated_at: new Date(),
});
type Store = {
    model: CostModel;
    groups: CostGroup[];
    rules: PricingCostRule[];
    revisions: unknown[];
    active: string | null;
};
let store: Store;

function txFor(data: Store) {
    return {
        pricingPublishCoordinator: { upsert: async () => ({ active_job_id: data.active }) },
        catalogModel: {
            findFirst: async ({ where }: { where: { id: string; tenant_id?: string } }) =>
                where.id === data.model.id && (!where.tenant_id || where.tenant_id === data.model.tenant_id)
                    ? data.model
                    : null,
        },
        channelGroup: { findMany: async () => data.groups },
        pricingCostRule: {
            findUnique: async ({ where }: { where: { model_id_tier: { model_id: string; tier: string } } }) =>
                data.rules.find(
                    (row) => row.model_id === where.model_id_tier.model_id && row.tier === where.model_id_tier.tier,
                ) ?? null,
            findMany: async ({ where }: { where: { id: { in: string[] }; model?: { tenant_id?: string } } }) =>
                data.rules
                    .filter(
                        (row) =>
                            where.id.in.includes(row.id) &&
                            (!where.model?.tenant_id || where.model.tenant_id === data.model.tenant_id),
                    )
                    .map((row) => ({ ...row, model: data.model })),
            create: async ({ data: value }: { data: Partial<PricingCostRule> }) => {
                const saved = { ...rule(), ...value };
                data.rules.push(saved);
                return saved;
            },
            update: async ({
                where,
                data: value,
            }: {
                where: { id: string };
                data: { revision: { increment: number } } & Partial<Omit<PricingCostRule, 'revision'>>;
            }) => {
                const saved = data.rules.find((row) => row.id === where.id)!;
                Object.assign(saved, { ...value, revision: saved.revision + value.revision.increment });
                return saved;
            },
        },
        pricingCostRuleRevision: {
            create: async ({ data: value }: { data: unknown }) => {
                data.revisions.push(value);
                return value;
            },
        },
    } as unknown as Prisma.TransactionClient;
}

beforeEach(() => {
    store = { model: model(), groups: groups(), rules: [], revisions: [], active: null };
    mocks.transaction.mockImplementation(async (run: (tx: Prisma.TransactionClient) => unknown) => {
        const draft = structuredClone(store);
        const result = await run(txFor(draft));
        store = draft;
        return result;
    });
    vi.stubEnv('PORTAL_JWT_SECRET', 'local-test-only-cost-quote-signature-secret');
});
afterEach(() => vi.unstubAllEnvs());

describe('saved cost quotes and publication protection', () => {
    it('stores purchasing terms and an immutable version without writing retail or upstream state', async () => {
        const [saved] = await saveCostRules(
            [{ model_id: MODEL, tier: 'standard', expected_revision: null, config: quote() }],
            ADMIN,
        );
        expect(saved).toMatchObject({ revision: 1, channel_id: 14, mapping_current: true, config: quote() });
        expect(store.revisions).toHaveLength(1);
        await saveCostRules(
            [{ model_id: MODEL, tier: 'standard', expected_revision: 1, config: { ...quote(), markup_percent: 30 } }],
            ADMIN,
        );
        expect(store.rules[0].revision).toBe(2);
        expect(store.revisions).toHaveLength(2);
        expect(store.revisions[0]).toMatchObject({ revision: 1, config: { markup_percent: 20 } });
    });

    it('rejects stale saves and duplicate create rather than overwriting the current quote', async () => {
        store.rules = [rule()];
        await expect(
            saveCostRules([{ model_id: MODEL, tier: 'standard', expected_revision: null, config: quote() }], ADMIN),
        ).rejects.toMatchObject({ code: 'pricing_cost_revision' });
        expect(store.rules[0].revision).toBe(1);
        expect(store.revisions).toHaveLength(0);
    });

    it('rolls back the whole bulk save when a later row no longer exists', async () => {
        await expect(
            saveCostRules(
                [
                    { model_id: MODEL, tier: 'standard', expected_revision: null, config: quote() },
                    {
                        model_id: '33333333-3333-4333-8333-333333333333',
                        tier: 'standard',
                        expected_revision: null,
                        config: quote(),
                    },
                ],
                ADMIN,
            ),
        ).rejects.toMatchObject({ code: 'model_not_found' });
        expect(store.rules).toHaveLength(0);
        expect(store.revisions).toHaveLength(0);
    });

    it('blocks draft changes while any publication or unresolved write owns the coordinator', async () => {
        store.active = 'uncertain-job';
        await expect(
            saveCostRules([{ model_id: MODEL, tier: 'standard', expected_revision: null, config: quote() }], ADMIN),
        ).rejects.toMatchObject({ code: 'pricing_publish_busy' });
        expect(store.rules).toHaveLength(0);
    });

    it('requires exact active channel ownership and rejects foreign tenant saves', async () => {
        expect(() =>
            costMapping(
                { ...model(), upstream_map: { standard: { channel_id: 9, upstream_model: 'text-model' } } },
                'standard',
                groups(),
            ),
        ).toThrow();
        await expect(
            saveCostRules([{ model_id: MODEL, tier: 'standard', expected_revision: null, config: quote() }], {
                ...ADMIN,
                role: 'admin',
                tenant_id: 'tenant-b',
            }),
        ).rejects.toMatchObject({ code: 'model_not_found' });
    });

    it('derives retail on the server and stops a queued context after revision, mapping or amount tampering', async () => {
        store.rules = [rule()];
        const db = txFor(store) as CostDb;
        const selected = await resolvePricingCostSelection(db, [{ rule_id: RULE, revision: 1 }], ADMIN);
        expect(selected.inputs[0]).toMatchObject({
            input_cny_per_1m: 1.2,
            output_cny_per_1m: 6,
            cost_cny_per_1m: null,
        });
        await expect(assertPricingCostContext(db, selected.inputs, selected.context)).resolves.toBeUndefined();
        await expect(
            assertPricingCostContext(db, [{ ...selected.inputs[0], input_cny_per_1m: 0.1 }], selected.context),
        ).rejects.toMatchObject({ code: 'pricing_cost_changed' });
        store.rules[0].revision++;
        await expect(assertPricingCostContext(db, selected.inputs, selected.context)).rejects.toMatchObject({
            code: 'pricing_cost_revision',
        });
        store.rules[0].revision--;
        store.model.upstream_map = { standard: { channel_id: 14, upstream_model: 'different-supplier-model' } };
        await expect(assertPricingCostContext(db, selected.inputs, selected.context)).rejects.toMatchObject({
            code: 'pricing_cost_mapping_changed',
        });
    });

    it('binds the confirmation token to the quote fingerprint, admin and exact publication preview', () => {
        const context = { selections: [{ rule_id: RULE, revision: 1 }], fingerprint: 'quote-a' };
        const signed = signCostSelection(ADMIN, context, 'publication-preview');
        expect(() => verifyCostSelection(ADMIN, context, 'publication-preview', signed)).not.toThrow();
        expect(() =>
            verifyCostSelection(ADMIN, { ...context, fingerprint: 'quote-b' }, 'publication-preview', signed),
        ).toThrow();
        expect(() => verifyCostSelection(ADMIN, context, 'different-preview', signed)).toThrow();
        expect(() =>
            verifyCostSelection({ ...ADMIN, tenant_id: 'tenant-b' }, context, 'publication-preview', signed),
        ).toThrow();
        expect(() => verifyCostSelection(ADMIN, context, 'publication-preview', 'short')).toThrow();
    });

    it('never silently omits configured cache pricing from a publication', () => {
        expect(() =>
            costPublicationInput(model(), 'standard', {
                ...quote(),
                token_rates: { ...quote().token_rates, cache_read: 1 },
            }),
        ).toThrow(/缓存/);
    });

    it('publishes only the matching standalone image resolution, with one ordinary per-image unit', () => {
        const image = { ...model(), slug: 'gpt-image-2-2k', modality: 'image' };
        const config: PricingCostConfig = {
            ...quote(),
            basis: 'image',
            token_rates: { input: null, output: null, cache_read: null, cache_write: null },
            variants: [
                {
                    key: '2k',
                    label: '2K',
                    resolution: '2k',
                    audio: 'any',
                    reference_video: 'any',
                    price: 10,
                    minimum_units: 1,
                    step_units: 1,
                },
            ],
        };
        expect(costPublicationInput(image, 'standard', config, '2k').input).toMatchObject({
            pricing_mode: 'fixed_image',
            per_image_cny: 1.2,
        });
        expect(() =>
            costPublicationInput(
                image,
                'standard',
                { ...config, variants: [{ ...config.variants[0], resolution: '4k' }] },
                '2k',
            ),
        ).toThrow(/2K/);
        expect(() =>
            costPublicationInput(
                image,
                'standard',
                { ...config, variants: [{ ...config.variants[0], minimum_units: 2 }] },
                '2k',
            ),
        ).toThrow(/每张/);
        expect(() =>
            costPublicationInput({ ...image, slug: 'native-multi-resolution' }, 'standard', config, '2k'),
        ).toThrow(/分辨率/);
    });

    it('keeps unsupported video quotes saveable but rejects their actual price publication', async () => {
        store.model.modality = 'video';
        const config: PricingCostConfig = {
            ...quote(),
            basis: 'video',
            token_rates: { input: null, output: null, cache_read: null, cache_write: null },
            variants: [
                {
                    key: 'hd',
                    label: '720P 含声音',
                    resolution: '720p',
                    audio: 'audio',
                    reference_video: 'without',
                    price: 2,
                    minimum_units: 5,
                    step_units: 1,
                },
            ],
        };
        const [saved] = await saveCostRules(
            [{ model_id: MODEL, tier: 'standard', expected_revision: null, config }],
            ADMIN,
        );
        expect(saved.config.basis).toBe('video');
        expect(() => costPublicationInput(store.model, 'standard', config, 'hd')).toThrow(/视频/);
    });
});
