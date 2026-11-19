import { describe, expect, it } from 'vitest';
import { compileOfficialRatio, flattenBase, officialMultiplierOf, selectOfficialRule } from '../math';
import type { OfficialModelContext } from '../types';

function model(official: number[], base: number[]): OfficialModelContext {
    return {
        model_id: 'm',
        model_name: 'm',
        display_name: '模型',
        tier_key: 'sd',
        public_group: 'SD',
        public_ratio: 1,
        source_channel_ids: [13],
        reference_revision: '1',
        reference_source: '已确认报价',
        reference_available: true,
        unavailable_reason: null,
        shape: 'video',
        public_official_multiplier: 0.72,
        current_official_multiplier: 0.72,
        current_ratio: 1,
        current_rule_scope: null,
        cells: official.map((n, i) => ({
            key: String(i),
            label: String(i),
            unit: 'million_tokens',
            official_cny: n,
            public_cny: base[i],
            base_cny: base[i],
            cost_cny: n * 0.65,
        })),
    };
}

describe('absolute official customer pricing', () => {
    it('charges official ×0.2 rather than public ×0.2, and holds that price after public repricing', () => {
        const a = model([100, 200], [30, 60]);
        const b = model([100, 200], [40, 80]);
        const ra = compileOfficialRatio(a, 0.2),
            rb = compileOfficialRatio(b, 0.2);
        expect(a.cells[0].base_cny * ra).toBeCloseTo(20, 8);
        expect(b.cells[0].base_cny * rb).toBeCloseTo(20, 8);
        expect(a.cells[0].base_cny * ra).not.toBe(6);
    });
    it('model rule wins over customer tier and neither factor stacks', () => {
        const rules = [
            { id: 'a', tier_key: 'sd', model_id: null, official_multiplier: 0.2, revision: 1 },
            { id: 'b', tier_key: 'sd', model_id: 'm', official_multiplier: 0.15, revision: 1 },
        ];
        expect(selectOfficialRule(rules, 'sd', 'm')?.official_multiplier).toBe(0.15);
        expect(selectOfficialRule(rules, 'sd', 'other')?.official_multiplier).toBe(0.2);
        expect(selectOfficialRule(rules, 'kiro', 'm')).toBeNull();
    });
    it('verifies every video resolution/reference rate rather than the representative cell', () => {
        const sd = model([46, 28, 46, 28, 51, 31, 26, 16], [33.12, 20.16, 33.12, 20.16, 36.72, 22.32, 18.72, 11.52]);
        const ratio = compileOfficialRatio(sd, 0.68);
        for (const c of sd.cells) expect(c.base_cny * ratio).toBeCloseTo(c.official_cny * 0.68, 8);
        expect(officialMultiplierOf(sd.cells, 0.8)).toBeCloseTo(0.576, 10);
        expect(() => compileOfficialRatio(model([37, 22], [20.355, 12.105]), 0.5)).toThrow('比例不一致');
    });
    it('refuses a missing official reference and invalid factors', () => {
        const m = model([100], [30]);
        expect(() => compileOfficialRatio({ ...m, reference_available: false }, 0.2)).toThrow('官方基准');
        for (const invalid of [0, -1, NaN, Infinity, 101]) expect(() => compileOfficialRatio(m, invalid)).toThrow();
    });
    it('checks caches and context tiers as well as input/output', () => {
        const flat = flattenBase({ mode: 'token', input: 2, output: 10, cache_read: 0.2, cache_write: null }, 1);
        expect(flat.cells.map((c) => c.key)).toEqual([
            '0:input',
            '0:output',
            '0:cache_read',
            '0:cache_write',
            '0:cache_write_1h',
            '0:cache_write_12h',
        ]);
        expect(flat.cells.find((c) => c.key === '0:cache_write_1h')?.amount).toBe(4);
        const tiers = flattenBase(
            {
                mode: 'tiered',
                tiers: [
                    {
                        max_input_tokens: 128000,
                        max_inclusive: true,
                        rates: { input: 2, output: 10, cache_read: 0.2, cache_write: null, cache_write_1h: null },
                    },
                    {
                        max_input_tokens: null,
                        max_inclusive: false,
                        rates: { input: 4, output: 20, cache_read: 0.4, cache_write: null, cache_write_1h: null },
                    },
                ],
            },
            1,
        );
        expect(tiers.cells).toHaveLength(6);
        expect(tiers.cells[3].key).toBe('1:input');
    });
});
