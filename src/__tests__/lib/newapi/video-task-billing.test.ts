/**
 * parseVideoTaskBilling —— 视频任务在「调用日志」里的计费明细。
 *
 * 样本取自生产 2026-11-24 的真实任务(脱敏:去掉 admin_info / root_info,保留计费字段):
 * Seedance 2.0 · 720p 无参考视频,客户专属 0.7 折 → 官方 ¥46 × 0.7 = ¥32.2 / 1M tokens。
 *   - 41698 预扣:预估 108000 tokens,quota 1738800 = ¥3.4776
 *   - 41699 结算:实际 108900 tokens,补扣 quota 14490,actual_quota 1753290 = ¥3.50658
 */
import { describe, expect, it } from 'vitest';
import { parseVideoTaskBilling } from '@/lib/newapi/log-display';

const EXPR =
    'dSgicmVzb2x1dGlvbiIpID09ICI0ODBwIiAmJiB1KCJ2aWRlb19pbnB1dCIpID09ICJub25lIiA/IHRpZXIoIjQ4MHDCt25vbmUiLCB1KCJ0b2tlbnMiKSAqIDMzLjEyIC8gMTAwMDAwMCkgOiB1KCJyZXNvbHV0aW9uIikgPT0gIjQ4MHAiICYmIHUoInZpZGVvX2lucHV0IikgPT0gInZpZGVvIiA/IHRpZXIoIjQ4MHDCt3ZpZGVvIiwgdSgidG9rZW5zIikgKiAyMC4xNiAvIDEwMDAwMDApIDogdSgicmVzb2x1dGlvbiIpID09ICI3MjBwIiAmJiB1KCJ2aWRlb19pbnB1dCIpID09ICJub25lIiA/IHRpZXIoIjcyMHDCt25vbmUiLCB1KCJ0b2tlbnMiKSAqIDMzLjEyIC8gMTAwMDAwMCkgOiB1KCJyZXNvbHV0aW9uIikgPT0gIjcyMHAiICYmIHUoInZpZGVvX2lucHV0IikgPT0gInZpZGVvIiA/IHRpZXIoIjcyMHDCt3ZpZGVvIiwgdSgidG9rZW5zIikgKiAyMC4xNiAvIDEwMDAwMDApIDogdSgicmVzb2x1dGlvbiIpID09ICIxMDgwcCIgJiYgdSgidmlkZW9faW5wdXQiKSA9PSAibm9uZSIgPyB0aWVyKCIxMDgwcMK3bm9uZSIsIHUoInRva2VucyIpICogMzYuNzIgLyAxMDAwMDAwKSA6IHUoInJlc29sdXRpb24iKSA9PSAiMTA4MHAiICYmIHUoInZpZGVvX2lucHV0IikgPT0gInZpZGVvIiA/IHRpZXIoIjEwODBwwrd2aWRlbyIsIHUoInRva2VucyIpICogMjIuMzIgLyAxMDAwMDAwKSA6IHUoInJlc29sdXRpb24iKSA9PSAiNGsiICYmIHUoInZpZGVvX2lucHV0IikgPT0gIm5vbmUiID8gdGllcigiNGvCt25vbmUiLCB1KCJ0b2tlbnMiKSAqIDE4LjcyIC8gMTAwMDAwMCkgOiB0aWVyKCI0a8K3dmlkZW8iLCB1KCJ0b2tlbnMiKSAqIDExLjUyIC8gMTAwMDAwMCk=';
const UNITS = { quotaPerUsd: 500000, quotaPerCny: 500000 };
const base = {
    billing_mode: 'tiered_expr',
    expr_b64: EXPR,
    group_ratio: 0.972222222223,
    is_task: true,
    matched_tier: '720p·none',
    model_price: 0,
    task_id: 'task_JqRJUdzRlzoCiXwVWYWrWs0Mclnv8hxY',
};

const estimate = {
    type: 2,
    quota: 1738800,
    other: JSON.stringify({ ...base, usage_facts: { resolution: '720p', tokens: 108000, video_input: 'none' } }),
};
const settlement = {
    type: 2,
    quota: 14490,
    other: JSON.stringify({
        ...base,
        actual_quota: 1753290,
        pre_consumed_quota: 1738800,
        usage_facts: { resolution: '720p', tokens: 108900, video_input: 'none' },
    }),
};

describe('parseVideoTaskBilling', () => {
    it('预扣行:预估 tokens × 单价 = 本行金额', () => {
        const v = parseVideoTaskBilling(estimate, UNITS)!;
        expect(v.phase).toBe('estimate');
        expect(v.tokens).toBe(108000);
        expect(v.unitCnyPer1M).toBe(32.2);
        expect((v.tokens * v.unitCnyPer1M!) / 1e6).toBeCloseTo(3.4776, 10);
        expect(v.preConsumedCny).toBeNull();
        expect(v.taskId).toBe('task_JqRJUdzRlzoCiXwVWYWrWs0Mclnv8hxY');
        expect(v.resolution).toBe('720p');
        expect(v.videoInput).toBe('none');
    });

    it('结算补扣行:带出预扣与实际总额,单价复算等于实际总额', () => {
        const v = parseVideoTaskBilling(settlement, UNITS)!;
        expect(v.phase).toBe('settle_extra');
        expect(v.tokens).toBe(108900);
        expect(v.unitCnyPer1M).toBe(32.2);
        expect(v.preConsumedCny).toBeCloseTo(3.4776, 10);
        expect(v.actualCny).toBeCloseTo(3.50658, 10);
    });

    it('结算退还行(type=6)', () => {
        const refund = {
            type: 6,
            quota: 101430,
            other: JSON.stringify({
                ...base,
                actual_quota: 1637370,
                pre_consumed_quota: 1738800,
                usage_facts: { resolution: '720p', tokens: 101700, video_input: 'none' },
            }),
        };
        const v = parseVideoTaskBilling(refund, UNITS)!;
        expect(v.phase).toBe('settle_refund');
        expect(v.unitCnyPer1M).toBe(32.2);
        expect(v.actualCny).toBeCloseTo(3.27474, 10);
    });

    it('单价复算对不上实际 quota 时不给单价', () => {
        const tampered = { ...estimate, quota: 1800000 };
        const v = parseVideoTaskBilling(tampered, UNITS)!;
        expect(v.unitCnyPer1M).toBeNull();
        expect(v.tokens).toBe(108000);
    });

    it('缺表达式或命中档位时不给单价', () => {
        const other = JSON.parse(estimate.other) as Record<string, unknown>;
        delete other.expr_b64;
        expect(parseVideoTaskBilling({ ...estimate, other: JSON.stringify(other) }, UNITS)!.unitCnyPer1M).toBeNull();
    });

    it('非视频任务、无 tokens、失败退款 → null', () => {
        expect(parseVideoTaskBilling({ type: 2, quota: 1, other: '{"model_price":-1}' }, UNITS)).toBeNull();
        expect(parseVideoTaskBilling({ type: 2, quota: 1, other: 'not json' }, UNITS)).toBeNull();
        expect(
            parseVideoTaskBilling(
                { type: 2, quota: 1, other: JSON.stringify({ ...base, usage_facts: { resolution: '720p' } }) },
                UNITS,
            ),
        ).toBeNull();
        // 失败退款:type=6 但没有预扣/实际
        expect(parseVideoTaskBilling({ ...estimate, type: 6 }, UNITS)).toBeNull();
    });

    it('task_id 格式不对就不出参', () => {
        const other = { ...JSON.parse(estimate.other), task_id: 'task_<script>' };
        expect(parseVideoTaskBilling({ ...estimate, other: JSON.stringify(other) }, UNITS)!.taskId).toBeNull();
    });
    it.each(['null', '[]', 'true', '42', '"text"'])(
        'ignores non-object log metadata without breaking the log page: %s',
        (other) => {
            expect(parseVideoTaskBilling({ type: 2, quota: 1, other }, UNITS)).toBeNull();
        },
    );
});
