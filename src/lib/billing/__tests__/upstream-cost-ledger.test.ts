import { describe, expect, it } from 'vitest';
import { parseUpstreamCostCsv, normalizeUpstreamCostInput } from '../upstream-cost-ledger';

const base = {
    upstream_route: 'gpt-pro-pool',
    upstream_amount: '0.040468',
    currency: 'usd',
    cny_per_unit: '2.5',
    cost_multiplier: '1',
    status: 'verified',
    upstream_request_id: 'up-1',
};

describe('upstream cost ledger validation', () => {
    it('calculates exact CNY cost from immutable snapshots', () => {
        const row = normalizeUpstreamCostInput(base);
        expect(row.currency).toBe('USD');
        expect(row.cost_cny.toString()).toBe('0.10117');
    });

    it('rejects an unlinked verified/estimated record', () => {
        expect(() => normalizeUpstreamCostInput({ ...base, upstream_request_id: null })).toThrow('请求关联 ID');
        expect(() => normalizeUpstreamCostInput({ ...base, status: 'estimated', upstream_request_id: null })).toThrow(
            '请求关联 ID',
        );
        expect(() =>
            normalizeUpstreamCostInput({ ...base, status: 'unmatched', upstream_request_id: null }),
        ).not.toThrow();
    });

    it('parses quoted commas/newlines and strips BOM', () => {
        const csv = `\ufeffnewapi_log_id,newapi_request_id,upstream_request_id,upstream_provider,upstream_route,upstream_model,upstream_amount,currency,cny_per_unit,cost_multiplier,status,evidence_hash,evidence_summary\n1,req-1,up-1,Acme,route,gpt-5,0.04,USD,2.5,1,verified,,"invoice row 1,\nchecked"\n`;
        const rows = parseUpstreamCostCsv(csv);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.value.evidence_summary).toBe('invoice row 1,\nchecked');
        expect(rows[0]?.line).toBe(2);
    });

    it('rejects missing/unknown columns and inconsistent row widths', () => {
        expect(() => parseUpstreamCostCsv('upstream_route\nroute\n')).toThrow('缺少列');
        const header =
            'newapi_log_id,newapi_request_id,upstream_request_id,upstream_provider,upstream_route,upstream_model,upstream_amount,currency,cny_per_unit,cost_multiplier,status,evidence_hash,evidence_summary';
        expect(() => parseUpstreamCostCsv(`${header},oops\n1,,,,route,,1,USD,2.5,1,unmatched,,\n`)).toThrow('未知列');
        expect(() => parseUpstreamCostCsv(`${header}\n1,2\n`)).toThrow('列数');
    });
});
