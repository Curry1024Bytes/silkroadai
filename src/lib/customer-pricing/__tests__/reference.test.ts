import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficialContext } from '../context';

const m = vi.hoisted(() => ({
    transaction: vi.fn(),
    lock: vi.fn(),
    context: vi.fn(),
    count: vi.fn(),
    upsert: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: m.transaction } }));
vi.mock('@/lib/admin/pricing-publish-lock', () => ({ assertPricingCatalogWritable: m.lock }));
vi.mock('../context', () => ({
    loadOfficialContext: m.context,
    publicOfficialView: (ctx: OfficialContext) => ({ version: ctx.version, tiers: ctx.tiers, rules: ctx.rules }),
}));

import { officialReferenceSchema, saveOfficialReference } from '../reference';

const MODEL = '11111111-1111-4111-8111-111111111111';
const tx = { customerOfficialPriceRule: { count: m.count }, customerOfficialReference: { upsert: m.upsert } };

function context(): OfficialContext {
    return {
        version: 'v1',
        user: { id: 'customer-a', tenant_id: 'tenant-a', newapi_user_id: 7, newapi_access_token: null },
        rules: [],
        options: {},
        channels: [],
        bindings: [],
        registry: [],
        model_states: {},
        tiers: [
            {
                key: 'gpt',
                display_name: 'GPT',
                public_group: 'GPT',
                public_ratio: 0.3,
                legacy_multiplier: null,
                binding_status: null,
                models: [
                    {
                        model_id: MODEL,
                        model_name: 'gpt-example',
                        display_name: 'GPT Example',
                        tier_key: 'gpt',
                        public_group: 'GPT',
                        public_ratio: 0.3,
                        current_ratio: 0.3,
                        source_channel_ids: [13],
                        reference_revision: null,
                        reference_source: null,
                        reference_available: false,
                        unavailable_reason: '缺少官方基准',
                        shape: 'confirmed-runtime-shape',
                        public_official_multiplier: null,
                        current_official_multiplier: null,
                        current_rule_scope: null,
                        cells: [
                            {
                                key: 'input',
                                label: '输入',
                                unit: 'million_tokens',
                                official_cny: 0,
                                public_cny: 0.6,
                                base_cny: 2,
                                cost_cny: null,
                            },
                            {
                                key: 'output',
                                label: '输出',
                                unit: 'million_tokens',
                                official_cny: 0,
                                public_cny: 3,
                                base_cny: 10,
                                cost_cny: null,
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

const input = () =>
    officialReferenceSchema.parse({
        action: 'reference',
        tier_key: 'gpt',
        model_id: MODEL,
        currency: 'CNY',
        fx: 1,
        source_note: '官方价目表，2026-11-19 核对',
        expected_version: 'v1',
        cells: [
            { key: 'input', price: 2 },
            { key: 'output', price: 10 },
        ],
    });

beforeEach(() => {
    vi.clearAllMocks();
    m.transaction.mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    m.lock.mockResolvedValue(undefined);
    m.context.mockImplementation(async () => context());
    m.count.mockResolvedValue(0);
    m.upsert.mockResolvedValue({ id: 'reference-a' });
});

describe('explicit official reference confirmation', () => {
    it('preserves original currency, source and confirmation actor while storing CNY prices', async () => {
        await saveOfficialReference('customer-a', 'admin-a', { ...input(), currency: 'USD', fx: 7.2 });
        expect(m.lock).toHaveBeenCalledWith(tx);
        expect(m.context).toHaveBeenCalledWith('customer-a', tx);
        expect(m.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { model_id_tier_key: { model_id: MODEL, tier_key: 'gpt' } },
                create: expect.objectContaining({
                    tenant_id: 'tenant-a',
                    model_id: MODEL,
                    tier_key: 'gpt',
                    shape: 'confirmed-runtime-shape',
                    source_currency: 'USD',
                    source_fx: 7.2,
                    confirmed_by: 'admin-a',
                    source_note: '官方价目表，2026-11-19 核对',
                    cells: [
                        { key: 'input', official_cny: 14.4 },
                        { key: 'output', official_cny: 72 },
                    ],
                }),
                update: expect.objectContaining({ revision: { increment: 1 } }),
            }),
        );
    });

    it('rejects applying a foreign-exchange multiplier to a CNY reference', async () => {
        await expect(saveOfficialReference('customer-a', 'admin-a', { ...input(), fx: 7.2 })).rejects.toMatchObject({
            code: 'reference_fx',
        });
        expect(m.transaction).not.toHaveBeenCalled();
        expect(m.upsert).not.toHaveBeenCalled();
    });

    it.each([
        { currency: 'EUR' },
        { fx: 0 },
        { fx: -1 },
        { source_note: '' },
        { source_note: '  ' },
        { expected_version: '' },
    ])('does not accept an unconfirmed currency, rate or source: %o', (patch) => {
        expect(officialReferenceSchema.safeParse({ ...input(), ...patch }).success).toBe(false);
    });

    it('refuses a stale quote rather than reusing official rates against changed price components', async () => {
        m.context.mockResolvedValue({ ...context(), version: 'v2' });
        await expect(saveOfficialReference('customer-a', null, input())).rejects.toMatchObject({
            code: 'reference_stale',
        });
        expect(m.upsert).not.toHaveBeenCalled();
    });

    it('refuses an in-use official reference before any replacement is persisted', async () => {
        m.count.mockResolvedValue(1);
        await expect(saveOfficialReference('customer-a', null, input())).rejects.toMatchObject({
            code: 'reference_in_use',
        });
        expect(m.upsert).not.toHaveBeenCalled();
    });

    it.each(
        [
            [{ key: 'input', price: 2 }],
            [
                { key: 'input', price: 2 },
                { key: 'input', price: 10 },
            ],
            [
                { key: 'input', price: 2 },
                { key: 'other-model-output', price: 10 },
            ],
            [
                { key: 'input', price: 2 },
                { key: 'output', price: 10 },
                { key: 'extra', price: 1 },
            ],
        ].map((cells) => ({ cells })),
    )('requires exact complete and unique runtime price keys: $cells', async ({ cells }) => {
        await expect(saveOfficialReference('customer-a', null, { ...input(), cells })).rejects.toMatchObject({
            code: 'reference_cells',
        });
        expect(m.upsert).not.toHaveBeenCalled();
    });

    it('rejects non-proportional component prices instead of pretending a single group factor can implement them', async () => {
        await expect(
            saveOfficialReference('customer-a', null, {
                ...input(),
                cells: [
                    { key: 'input', price: 2 },
                    { key: 'output', price: 12 },
                ],
            }),
        ).rejects.toMatchObject({ code: 'nonproportional_reference' });
        expect(m.upsert).not.toHaveBeenCalled();
    });

    it('rejects a missing model, empty quote or missing runtime shape', async () => {
        for (const patch of [
            { tiers: [] },
            {
                ...context(),
                tiers: [{ ...context().tiers[0], models: [{ ...context().tiers[0].models[0], cells: [] }] }],
            },
            {
                ...context(),
                tiers: [{ ...context().tiers[0], models: [{ ...context().tiers[0].models[0], shape: '' }] }],
            },
        ]) {
            m.context.mockResolvedValue({ ...context(), ...patch });
            await expect(saveOfficialReference('customer-a', null, input())).rejects.toMatchObject({
                code: 'reference_unavailable',
            });
        }
        expect(m.upsert).not.toHaveBeenCalled();
    });

    it('returns only the public reference view after storage, without customer credentials or raw channel options', async () => {
        const result = await saveOfficialReference('customer-a', null, input());
        expect(Object.keys(result).sort()).toEqual(['rules', 'tiers', 'version']);
        expect(result).not.toHaveProperty('user');
        expect(result).not.toHaveProperty('options');
        expect(result).not.toHaveProperty('channels');
    });
});
