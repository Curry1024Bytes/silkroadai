import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import type { PricingModel } from '@newapi/features/pricing/types';
import type { TierPricing } from '@/lib/models/machine-catalog';
import type { OfficialModelContext, OfficialPricingPreview } from '@/lib/customer-pricing/types';
import { LocaleProvider } from '@/lib/i18n/client';
import { ModelTierPrices, PriceProvenanceNote } from '@/app/models/model-prices';
import { PlazaPriceDetails, PlazaPriceSummary } from '@/app/models/plaza-prices';
import {
    KeyPricingBadge,
    KeysList,
    TierSelect,
    type KeyRow,
    type TierOption,
} from '@/app/(authenticated)/keys/keys-list';
import { LegacyRateSnapshot, RateOverridesPanel } from '@/app/admin/(console)/customers/[id]/rate-overrides-panel';
import {
    OfficialPricingPanel,
    OfficialPricingPreviewTable,
    OfficialPricingRecoveryNotice,
    OfficialReferenceEditor,
    filterOfficialPricingModels,
    officialPricingSaveRequest,
    officialReferenceRequest,
    parseOfficialMultiplier,
} from '@/app/admin/(console)/customers/[id]/official-pricing-panel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const publicPrice: TierPricing = {
    input_cny_per_1m: 30,
    output_cny_per_1m: 60,
    per_image_cny: null,
    price_provenance: {
        source: 'pricing_cost_rule',
        official: 100,
        discount: 0.3,
        discountBasis: 'configured_pricing_cost_rule',
        verifiable: true,
    },
};

const exclusivePrice: TierPricing = {
    ...publicPrice,
    input_cny_per_1m: 20,
    output_cny_per_1m: 40,
    customer_pricing: {
        basis: 'official',
        multiplier: 0.2,
        scope: 'model',
        public_official_multiplier: 0.3,
        official_multiplier: 0.2,
    },
};

function model(price: TierPricing): PricingModel {
    return {
        id: 1,
        model_name: 'gpt-example',
        enable_groups: ['standard'],
        portal: {
            type: 'chat',
            tiers: [{ key: 'standard', label: '普通档', isDefault: true }],
            pricesByTier: { standard: price },
        },
    };
}

function preview(patch: Partial<OfficialPricingPreview> = {}): OfficialPricingPreview {
    return {
        version: 'verified-source-version',
        hash: 'server-preview-hash',
        draft: { tier_key: 'standard', model_id: 'model-a', official_multiplier: 0.2 },
        below_cost: false,
        has_increases: false,
        affected_keys: 1,
        blocked: [],
        warnings: [],
        cells: [
            {
                model_id: 'model-a',
                model_name: 'gpt-example',
                label: '输入',
                unit: 'million_tokens',
                official_cny: 100,
                cost_cny: 15,
                before_cny: 30,
                target_cny: 20,
                actual_cny: 20,
                margin: 0.25,
                rule_scope: 'model',
                official_multiplier: 0.2,
            },
        ],
        ...patch,
    };
}

describe('customer-facing official-price badges', () => {
    it('shows the final official multiplier and the standard reference without multiplying them in the UI', () => {
        const html = renderToString(<PriceProvenanceNote price={exclusivePrice} />);
        expect(html).toContain('专属倍率:0.2x');
        expect(html).not.toContain('您的专属价');
        expect(html).toContain('官方价 2 折');
        expect(html).toContain('标准售价：官方价 × 0.3');
        expect(html).toContain('此模型专属');
        expect(html).not.toContain('0.06');
        expect(html).not.toContain('标准价 × 0.2');
    });

    it('uses the same customer amount and visible badge in model cards and detailed prices', () => {
        const value = model(exclusivePrice);
        for (const html of [
            renderToString(<PlazaPriceSummary model={value} />),
            renderToString(<PlazaPriceDetails model={value} />),
            renderToString(<ModelTierPrices price={exclusivePrice} type="chat" />),
        ]) {
            expect(html).toContain('专属倍率:0.2x');
            expect(html).not.toContain('您的专属价');
            expect(html).toContain('¥20');
            expect(html).not.toContain('¥6');
            expect(html).not.toContain('采购成本');
        }
    });

    it('keeps legacy relative multipliers distinct while showing a verified final official multiplier', () => {
        const html = renderToString(
            <PriceProvenanceNote
                price={{
                    ...exclusivePrice,
                    customer_pricing: {
                        basis: 'public',
                        multiplier: 0.8,
                        scope: 'tier',
                        public_official_multiplier: 0.72,
                        official_multiplier: 0.576,
                    },
                }}
            />,
        );
        expect(html).toContain('标准价 × 0.8');
        expect(html).toContain('最终为官方价 × 0.576');
        expect(html).toContain('分组专属');
        expect(html).not.toContain('官方价 × 0.8');
    });

    it('does not invent an official discount for a legacy quote without a verified reference', () => {
        const html = renderToString(
            <PriceProvenanceNote
                price={{
                    ...publicPrice,
                    price_provenance: undefined,
                    customer_pricing: {
                        basis: 'public',
                        multiplier: 0.95,
                        scope: 'tier',
                        public_official_multiplier: null,
                        official_multiplier: null,
                    },
                }}
            />,
        );
        expect(html).toContain('标准价 × 0.95');
        expect(html).not.toContain('官方价');
    });

    it('keeps ordinary customers on the standard-price note, without an exclusive badge', () => {
        const html = renderToString(<PriceProvenanceNote price={publicPrice} />);
        expect(html).toContain('当前标准售价为 3 折');
        expect(html).not.toContain('专属');
        expect(renderToString(<PriceProvenanceNote price={null} />)).toBe('');
    });

    it('uses correct multiplier wording in English instead of treating Chinese 折 as an x multiplier', () => {
        const html = renderToString(
            <LocaleProvider locale="en">
                <PriceProvenanceNote price={exclusivePrice} />
            </LocaleProvider>,
        );
        expect(html).toContain('Exclusive multiplier: 0.2x');
        expect(html).toContain('20% of official price');
        expect(html).not.toContain('Exclusive multiplier: 2x');
    });
});

describe('official-price editor confirmation contract', () => {
    it('filters 2.5 by the display name or model ID without matching 2.0 or 2.50', () => {
        const candidates = [
            { ...unconfirmedModel, model_id: '2.5-a', display_name: 'Doubao Seedance 2 5', model_name: 'seedance-2-5' },
            { ...unconfirmedModel, model_id: '2.5-b', display_name: 'Flash', model_name: 'seedance-2.5-flash' },
            { ...unconfirmedModel, model_id: '2.0', display_name: 'Doubao Seedance 2.0', model_name: 'seedance-2-0' },
            {
                ...unconfirmedModel,
                model_id: '2.50',
                display_name: 'Doubao Seedance 2.50',
                model_name: 'seedance-2-50',
            },
        ];
        expect(filterOfficialPricingModels(candidates, '2.5').map((model) => model.model_id)).toEqual([
            '2.5-a',
            '2.5-b',
        ]);
    });

    it('uses the checked model IDs from the server preview when confirming the multiplier', () => {
        const draft = { tier_key: 'sd', model_ids: ['2.5-a', '2.5-b'], official_multiplier: 0.7 };
        const request = officialPricingSaveRequest(preview({ draft }), { belowCost: false, increases: false });
        expect(request).toMatchObject({ ...draft, preview_hash: 'server-preview-hash' });
        expect(request).not.toHaveProperty('model_id');
    });

    it.each(['', '0', '-0.2', 'Infinity', 'NaN', '20%', '0.2x', '101'])(
        'does not turn %s into a valid price',
        (raw) => {
            expect(parseOfficialMultiplier(raw)).toBeNull();
        },
    );

    it('sends an absolute multiplier and the exact preview version/hash back to the server', () => {
        expect(parseOfficialMultiplier('0.2')).toBe(0.2);
        const request = officialPricingSaveRequest(preview(), { belowCost: false, increases: false });
        expect(request).toEqual({
            action: 'save',
            tier_key: 'standard',
            model_id: 'model-a',
            official_multiplier: 0.2,
            expected_version: 'verified-source-version',
            preview_hash: 'server-preview-hash',
            confirm_below_cost: false,
            confirm_increases: false,
        });
    });

    it('requires both acknowledgements when a change includes a loss and a price increase', () => {
        const draft = preview({ below_cost: true, has_increases: true });
        expect(() => officialPricingSaveRequest(draft, { belowCost: false, increases: true })).toThrow('采购成本');
        expect(() => officialPricingSaveRequest(draft, { belowCost: true, increases: false })).toThrow('涨价');
        expect(officialPricingSaveRequest(draft, { belowCost: true, increases: true }).official_multiplier).toBe(0.2);
    });

    it('cannot confirm a blocked preview even after the operator checks both acknowledgements', () => {
        expect(() =>
            officialPricingSaveRequest(preview({ blocked: ['官方基准未确认'] }), { belowCost: true, increases: true }),
        ).toThrow('无法发布');
    });

    it('preserves a removal as null rather than converting it to a free price or a group-wide edit', () => {
        const draft = preview({ draft: { tier_key: 'standard', model_id: 'model-a', official_multiplier: null } });
        expect(officialPricingSaveRequest(draft, { belowCost: false, increases: false })).toMatchObject({
            model_id: 'model-a',
            official_multiplier: null,
        });
    });

    it('shows all specifications for the selected model and only includes unchanged peers in a group preview', () => {
        const selected = { ...preview().cells[0], model_name: 'Seedance 2.5', label: '480p' };
        const draft = preview({
            cells: [
                selected,
                { ...selected, label: '720p' },
                {
                    ...selected,
                    model_id: 'model-b',
                    model_name: 'Seedance 2.0',
                    before_cny: 33.12,
                    target_cny: 33.12,
                    actual_cny: 33.12000000001,
                },
            ],
        });
        const modelHtml = renderToString(<OfficialPricingPreviewTable preview={draft} isDark={false} locale="zh" />);
        expect(modelHtml).toContain('Seedance 2.5');
        expect(modelHtml).toContain('480p');
        expect(modelHtml).toContain('720p');
        expect(modelHtml).not.toContain('Seedance 2.0');

        const groupPreview = {
            ...draft,
            draft: {
                tier_key: draft.draft.tier_key,
                official_multiplier: draft.draft.official_multiplier,
                model_id: null,
            },
        };
        const groupHtml = renderToString(
            <OfficialPricingPreviewTable preview={groupPreview} isDark={false} locale="zh" />,
        );
        expect(groupHtml).toContain('Seedance 2.0');
    });

    it('keeps peer price changes and below-cost rows visible during a model preview', () => {
        const selected = preview().cells[0];
        const draft = preview({
            below_cost: true,
            has_increases: true,
            cells: [
                selected,
                { ...selected, model_id: 'model-b', model_name: 'Price increase', actual_cny: 35 },
                { ...selected, model_id: 'model-c', model_name: 'Below cost', cost_cny: 35, actual_cny: 30 },
            ],
        });
        const html = renderToString(<OfficialPricingPreviewTable preview={draft} isDark={false} locale="zh" />);
        expect(html).toContain('Price increase');
        expect(html).toContain('Below cost');
        expect(html).toContain('同组其他型号有价格变动或低于采购成本时，也会列出。');
    });

    it('shows actual per-model loss and unknown cost instead of an optimistic group margin', () => {
        const draft = preview({
            below_cost: true,
            cells: [
                {
                    ...preview().cells[0],
                    model_name: 'Pro',
                    cost_cny: 65,
                    target_cny: 57.6,
                    actual_cny: 57.6,
                    margin: -0.1284722222,
                },
                {
                    ...preview().cells[0],
                    model_id: 'model-b',
                    model_name: 'Unknown-cost model',
                    cost_cny: null,
                    margin: null,
                },
            ],
        });
        const html = renderToString(<OfficialPricingPreviewTable preview={draft} isDark={false} locale="zh" />);
        expect(html).toContain('-12.85%');
        expect(html).toContain('¥65');
        expect(html).toContain('¥57.6');
        expect(html).toContain('未确认');
        expect(html).not.toContain('18.8%');
    });

    it('explains the absolute rule precedence before the customer context finishes loading', () => {
        const html = renderToString(<OfficialPricingPanel customerId="customer-a" isDark={false} locale="zh" />);
        expect(html).toContain('客户价格 = 官方价');
        expect(html).toContain('各规则不叠乘');
        expect(html).toContain('读取专属价格');
    });
});

describe('unfinished customer-price publications', () => {
    it('offers recovery for a saved unfinished change and explains that commit status is checked first', () => {
        const html = renderToString(
            <OfficialPricingRecoveryNotice
                view={{
                    version: 'v1',
                    tiers: [],
                    rules: [],
                    pending_changes: [{ id: 'change-a', tier_key: 'SD官转', status: 'failed' }],
                }}
                isDark={false}
                locale="zh"
                busy={false}
                onRecover={() => {}}
            />,
        );
        expect(html).toContain('有未完成的定价发布');
        expect(html).toContain('检查发布是否已提交');
        expect(html).toContain('尚未提交时');
        expect(html).toContain('核验并恢复');
        expect(html).toContain('change-a');
        expect(html).toContain('SD官转');
    });

    it('disables another recovery while a publication operation is running', () => {
        const html = renderToString(
            <OfficialPricingRecoveryNotice
                view={{
                    version: 'v1',
                    tiers: [],
                    rules: [],
                    pending_changes: [{ id: 'change-a', tier_key: 'SD官转', status: 'applying' }],
                }}
                isDark
                locale="en"
                busy
                onRecover={() => {}}
            />,
        );
        expect(html).toContain('disabled=""');
        expect(html).toContain('Recovering…');
    });

    it('keeps the recovery controls hidden when there are no unfinished records', () => {
        expect(
            renderToString(
                <OfficialPricingRecoveryNotice
                    view={{ version: 'v1', tiers: [], rules: [] }}
                    isDark={false}
                    locale="zh"
                    busy={false}
                    onRecover={() => {}}
                />,
            ),
        ).toBe('');
    });
});

const unconfirmedModel: OfficialModelContext = {
    model_id: 'model-a',
    model_name: 'gpt-example',
    display_name: 'GPT Example',
    tier_key: 'standard',
    public_group: 'standard',
    public_ratio: 1,
    current_ratio: 1,
    source_channel_ids: [13],
    reference_revision: null,
    reference_source: null,
    reference_available: false,
    unavailable_reason: '官方基准未确认',
    shape: 'token',
    cells: [
        {
            key: 'input',
            label: '输入',
            unit: 'million_tokens',
            official_cny: 0,
            public_cny: 30,
            base_cny: 30,
            cost_cny: null,
        },
        {
            key: 'output',
            label: '输出',
            unit: 'million_tokens',
            official_cny: 0,
            public_cny: 60,
            base_cny: 60,
            cost_cny: null,
        },
    ],
    public_official_multiplier: null,
    current_official_multiplier: null,
    current_rule_scope: null,
};

describe('official reference confirmation', () => {
    it('does not prefill public prices as confirmed official prices', () => {
        const html = renderToString(
            <OfficialReferenceEditor
                model={unconfirmedModel}
                isDark={false}
                locale="zh"
                busy={false}
                onConfirm={() => {}}
                onCancel={() => {}}
            />,
        );
        expect(html).toContain('公开售价不会自动当成官方价填入');
        expect(html).toContain('来源及核对日期');
        expect(html).toContain('确认以上官方基准并保存');
        expect(html).not.toContain('value="30"');
        expect(html).not.toContain('value="60"');
        expect(html).not.toContain('value="0"');
    });

    it('requires an explicit USD exchange rate and retains entered USD prices for the server conversion', () => {
        const draft = {
            currency: 'USD' as const,
            fx: '',
            source: '官方价目表 2026-11-19',
            prices: { input: '2', output: '10' },
        };
        expect(() => officialReferenceRequest(unconfirmedModel, 'snapshot', draft)).toThrow('每 1 美元');
        expect(officialReferenceRequest(unconfirmedModel, 'snapshot', { ...draft, fx: '7.2' })).toEqual({
            action: 'reference',
            tier_key: 'standard',
            model_id: 'model-a',
            currency: 'USD',
            fx: 7.2,
            source_note: '官方价目表 2026-11-19',
            cells: [
                { key: 'input', price: 2 },
                { key: 'output', price: 10 },
            ],
            expected_version: 'snapshot',
        });
    });

    it('fixes CNY conversion to one, requires all reference cells, and preserves a real zero', () => {
        const draft = {
            currency: 'CNY' as const,
            fx: '7.2',
            source: '已核对官方价',
            prices: { input: '0', output: '10' },
        };
        expect(officialReferenceRequest(unconfirmedModel, 'snapshot', draft)).toMatchObject({
            fx: 1,
            cells: [
                { key: 'input', price: 0 },
                { key: 'output', price: 10 },
            ],
        });
        expect(() =>
            officialReferenceRequest(unconfirmedModel, 'snapshot', { ...draft, prices: { input: '0' } }),
        ).toThrow('输出');
        expect(() => officialReferenceRequest(unconfirmedModel, 'snapshot', { ...draft, source: ' ' })).toThrow('来源');
    });
});

describe('read-only legacy pricing records', () => {
    it('keeps the old multiplier as a record without rendering editing, migration or the wrong group margin', () => {
        const html = renderToString(
            <LegacyRateSnapshot
                tier={{
                    key: 'sd',
                    display_name: 'SD官转',
                    public_multiplier: 1,
                    effective_multiplier: 0.8,
                    purchase_rate: 0.65,
                }}
                override={{ id: 'old-rule', tier_key: 'sd', multiplier: 0.8, synced_at: '2026-11-19T03:44:50Z' }}
                isDark={false}
                locale="zh"
            />,
        );
        expect(html).toContain('保留的旧版倍率');
        expect(html).toContain('0.8x');
        expect(html).not.toContain('18.8');
        expect(html).not.toContain('毛利');
        expect(html).not.toContain('进货率');
        expect(html).not.toContain('<input');
        expect(html).not.toContain('<button');
    });

    it('makes read-only mode explicit while the record is loading, without changing the default old component contract', () => {
        const locked = renderToString(
            <RateOverridesPanel customerId="customer-a" isDark={false} locale="zh" readOnly />,
        );
        const original = renderToString(<RateOverridesPanel customerId="customer-a" isDark={false} locale="zh" />);
        expect(locked).toContain('此处只读');
        expect(locked).toContain('不会迁移任何 Key');
        expect(original).toContain('专属计费设置');
        expect(original).not.toContain('此处只读');
    });
});

describe('official-price badges on API keys', () => {
    const tier: TierOption = {
        key: 'sd',
        display_name: 'SD官转',
        description: null,
        is_default: true,
        newapi_group: 'SD官转',
        ratio: 0.277777777778,
        special: true,
        official_pricing: { multiplier: 0.2, model_overrides: 1 },
    };

    it('shows official-price meaning in the group picker instead of a native internal ratio', () => {
        const html = renderToString(<TierSelect tiers={[tier]} value="sd" onChange={() => {}} />);
        expect(html).toContain('专属倍率:0.2x');
        expect(html).toContain('部分模型单独定价');
        expect(html).not.toContain('0.277777');
    });

    it('marks individual model rules without inventing a single official multiplier for the whole group', () => {
        const html = renderToString(
            <KeyPricingBadge ratio={123.456} official={{ multiplier: null, model_overrides: 1 }} />,
        );
        expect(html).toContain('模型专属定价');
        expect(html).toContain('部分模型单独定价');
        expect(html).not.toContain('123.456');
        expect(html).not.toContain('官方价 ×');
    });

    it('shows the official badge on existing keys in both responsive list layouts', () => {
        const row: KeyRow = {
            id: 'key-a',
            key_alias: 'SD Key',
            masked_key: 'sk-test****abcd',
            created_at: '2026-11-19T03:00:00Z',
            used_quota: 0,
            usedCny: 0,
            last_used_at: null,
            tier: 'sd',
            effective_ratio: 0.277777777778,
            official_pricing: tier.official_pricing,
        };
        const html = renderToString(<KeysList initialRows={[row]} tiers={[tier]} />);
        expect((html.match(/专属倍率:0\.2x/g) ?? []).length).toBeGreaterThanOrEqual(2);
        expect(html).not.toContain('0.277777');
    });

    it('shows a visible warning when the exclusive multiplier could not be verified', () => {
        const html = renderToString(<KeysList initialRows={[]} officialPricingUnavailable />);
        expect(html).toContain('role="alert"');
        expect(html).toContain('专属倍率信息暂时无法核实');

        const enHtml = renderToString(
            <LocaleProvider locale="en">
                <KeysList initialRows={[]} officialPricingUnavailable />
            </LocaleProvider>,
        );
        expect(enHtml).toContain('Your exclusive multiplier could not be verified');
    });

    it('retains the old ratio badge when there is no official-price rule and supports English official badges', () => {
        expect(renderToString(<KeyPricingBadge ratio={0.8} special />)).toContain('专属倍率:0.8x');
        const html = renderToString(
            <LocaleProvider locale="en">
                <KeyPricingBadge ratio={1} official={{ multiplier: 0.2, model_overrides: 0 }} />
            </LocaleProvider>,
        );
        expect(html).toContain('Exclusive multiplier: 0.2x');
        expect(html).not.toContain('1x');
    });
});
