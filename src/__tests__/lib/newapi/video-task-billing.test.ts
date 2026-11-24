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

    const secondLog = (overrides: Record<string, unknown> = {}) => ({
        type: 2,
        quota: 600000,
        model_name: 'sd-2.5-480P-novideo',
        other: JSON.stringify({
            billing_mode: 'tiered_expr',
            is_task: true,
            task_id: 'task_sdExample123',
            matched_tier: 'base',
            expr_b64: btoa('tier("base", u("seconds") * 0.3)'),
            group_ratio: 1,
            request_path: '/v1/videos',
            usage_facts: { seconds: 4 },
            ...overrides,
        }),
    });

    it('SD特惠真实形态:秒数计费,不编造 tokens,保留历史单价', () => {
        expect(parseVideoTaskBilling(secondLog(), UNITS)).toMatchObject({
            phase: 'charge',
            billingUnit: 'seconds',
            seconds: 4,
            tokens: 0,
            unitCnyPerSecond: 0.3,
            unitCnyPer1M: null,
            resolution: '480p',
            videoInput: 'none',
            requestPath: '/v1/videos',
            preConsumedCny: null,
            actualCny: null,
        });
    });

    it('普通特惠 SKU 只推断分辨率,不能据此判定带参考视频', () => {
        const log = { ...secondLog(), model_name: 'sd-2.5-1080P' };
        expect(parseVideoTaskBilling(log, UNITS)).toMatchObject({ resolution: '1080p', videoInput: null });
        expect(parseVideoTaskBilling({ ...log, model_name: 'unfamiliar-video-model' }, UNITS)).toMatchObject({
            resolution: null,
            videoInput: null,
        });
    });

    it('按秒单价包含本条客户倍率,换算成 CNY 后必须与扣费对上', () => {
        const log = { ...secondLog({ group_ratio: 0.8 }), quota: 480000 };
        expect(parseVideoTaskBilling(log, UNITS)!.unitCnyPerSecond).toBe(0.24);
        expect(parseVideoTaskBilling(log, { ...UNITS, quotaPerCny: 100000 })!.unitCnyPerSecond).toBe(1.2);
        expect(parseVideoTaskBilling({ ...log, quota: 123 }, UNITS)!.unitCnyPerSecond).toBeNull();
    });

    it('按秒结算退款与补扣:公式使用实际总额,不能用差额作总价', () => {
        const refund = { ...secondLog({ pre_consumed_quota: 800000, actual_quota: 600000 }), type: 6, quota: 200000 };
        expect(parseVideoTaskBilling(refund, UNITS)).toMatchObject({
            phase: 'settle_refund',
            preConsumedCny: 1.6,
            actualCny: 1.2,
            unitCnyPerSecond: 0.3,
        });
        const extra = { ...secondLog({ pre_consumed_quota: 500000, actual_quota: 600000 }), quota: 100000 };
        expect(parseVideoTaskBilling(extra, UNITS)).toMatchObject({ phase: 'settle_extra', unitCnyPerSecond: 0.3 });
        expect(parseVideoTaskBilling({ ...extra, quota: 5 }, UNITS)!.unitCnyPerSecond).toBeNull();
    });

    it('统一字段只保留白名单,未知供应商同口径也可展示', () => {
        const log = secondLog({
            usage_facts: { seconds: '4', resolution: '720p', video_input: 'video', ratio: '16:9', key: 'secret' },
            admin_info: { key: 'secret' },
            root_info: { upstream_task_id: 'private' },
        });
        const video = parseVideoTaskBilling({ ...log, model_name: 'future-video-model' }, UNITS)!;
        expect(video).toMatchObject({ resolution: '720p', videoInput: 'video', ratio: '16:9', seconds: 4 });
        expect(JSON.stringify(video)).not.toMatch(
            /secret|private|upstream|admin_info|usage_facts|expr_b64|group_ratio/,
        );
    });

    it('缺字段或损坏数据降级,不让文本、图片、失败退款误入视频明细', () => {
        for (const usage_facts of [null, [], 'broken', { seconds: -1 }, { seconds: 0 }]) {
            expect(parseVideoTaskBilling(secondLog({ usage_facts }), UNITS)).toBeNull();
        }
        expect(parseVideoTaskBilling({ ...secondLog(), type: 5 }, UNITS)).toBeNull();
        expect(parseVideoTaskBilling({ ...secondLog(), type: 6 }, UNITS)).toBeNull();
        expect(parseVideoTaskBilling(secondLog({ is_task: false }), UNITS)).toBeNull();
        expect(parseVideoTaskBilling(secondLog({ request_path: '/v1/audio/speech' }), UNITS)).toBeNull();
        expect(parseVideoTaskBilling(secondLog({ request_path: '/v1/images/generations' }), UNITS)).toBeNull();
        expect(parseVideoTaskBilling(secondLog(), { ...UNITS, quotaPerCny: Infinity })).toBeNull();
        const unsafe = parseVideoTaskBilling(
            secondLog({
                request_path: undefined,
                usage_facts: { seconds: 4, resolution: '<script>', video_input: 'unknown', ratio: 'secret' },
            }),
            UNITS,
        )!;
        expect(unsafe).toMatchObject({ requestPath: null, resolution: '480p', ratio: null });
    });
});
