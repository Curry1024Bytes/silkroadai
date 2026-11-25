import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoBillingDetail } from '@/app/(authenticated)/logs/video-billing-detail';
import { LocaleProvider } from '@/lib/i18n/client';
import type { LogRow } from '@/app/api/portal/logs/route';

const row: LogRow = {
    id: 1,
    createdAt: 1795535359,
    model: 'doubao-seedance-2-5-260628',
    tokenName: 'test-video',
    requestId: 'request123',
    useTimeMs: 0,
    promptTokens: 0,
    completionTokens: 58245,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    perImageBilled: false,
    quota: 499338,
    costCny: 0.998676,
    type: 2,
    refundKind: null,
    content: '',
    video: {
        taskId: 'task_example123',
        phase: 'settle_extra',
        billingUnit: 'tokens',
        tokens: 58245,
        seconds: null,
        resolution: '480p',
        videoInput: 'none',
        ratio: null,
        requestPath: null,
        unitCnyPer1M: 50.4,
        unitCnyPerSecond: null,
        preConsumedCny: 1.936872,
        actualCny: 2.935548,
        elapsedSec: 311,
    },
};
const render = (r: LogRow, en = false) =>
    renderToStaticMarkup(
        <LocaleProvider locale={en ? 'en' : 'zh'}>
            <VideoBillingDetail row={r} />
        </LocaleProvider>,
    );

describe('unified video billing detail', () => {
    it('官转展示实际总额、补扣记录、任务信息及客户单价,去掉来源字样', () => {
        const html = render(row);
        for (const value of [
            '任务信息',
            '计费依据',
            '实际消费',
            '补扣金额',
            '¥2.935548',
            '¥0.998676',
            '¥1.936872',
            '58,245',
            '¥50.4',
            '1,000,000',
            'task_example123',
            '5m 11s',
        ]) {
            expect(html).toContain(value);
        }
        expect(html).not.toMatch(/上游实际返回|reported by the provider/);
        expect(html).toContain('aria-label="复制任务 ID"');
        expect(html).toContain('aria-label="复制Request ID"');
    });

    const secondsRow: LogRow = {
        ...row,
        model: 'sd-2.5',
        costCny: 1.2,
        video: {
            ...row.video!,
            phase: 'charge',
            billingUnit: 'seconds',
            seconds: 4,
            tokens: 0,
            unitCnyPer1M: null,
            unitCnyPerSecond: 0.3,
            preConsumedCny: null,
            actualCny: null,
            videoInput: null,
            elapsedSec: null,
        },
    };
    it('SD特惠展示秒数公式,未记录的参考状态明确标注,不伪造 tokens 或生成耗时', () => {
        const html = render(secondsRow);
        for (const value of ['按秒计费', '计费时长', '4 秒', '¥0.3 / 秒', '4 秒 × ¥0.3 = ¥1.20', '未记录']) {
            expect(html).toContain(value);
        }
        expect(html).not.toMatch(/1,000,000|计费 tokens|提交时预估|生成耗时|有参考视频|预扣金额/);
    });

    it('SD特惠显示请求画幅和包含排队的任务耗时,不冒充供应商生成耗时', () => {
        const enriched = { ...secondsRow, video: { ...secondsRow.video!, ratio: '16:9', elapsedSec: 207 } };
        const html = render(enriched);
        expect(html).toContain('请求画幅');
        expect(html).toContain('16:9');
        expect(html).toContain('任务耗时（含排队）');
        expect(html).toContain('3m 27s');
        expect(html).not.toContain('生成耗时');
        const english = render(enriched, true);
        expect(english).toContain('Requested aspect ratio');
        expect(english).toContain('Task duration (including queueing)');
        expect(english).not.toMatch(/[\u4e00-\u9fff]/);
    });

    it('退款行清楚区分任务实际消费和本条退还金额', () => {
        const html = render({
            ...row,
            type: 6,
            costCny: -0.5,
            video: { ...row.video!, phase: 'settle_refund', preConsumedCny: 3.435548 },
        });
        expect(html).toContain('退还金额');
        expect(html).toContain('¥2.935548');
        expect(html).toContain('¥0.50');
        expect(html).not.toContain('补扣金额');
    });

    it('预扣保留预估提示,单价核验失败不展示公式', () => {
        const html = render({
            ...row,
            video: { ...row.video!, phase: 'estimate', unitCnyPer1M: null, preConsumedCny: null, actualCny: null },
        });
        expect(html).toContain('提交时预估');
        expect(html).toContain('费用以账单金额为准');
        expect(html).not.toContain('1,000,000');
    });

    it('两类视频明细都完整支持英文', () => {
        for (const r of [row, secondsRow]) {
            const html = render(r, true);
            expect(html).toContain('Task information');
            expect(html).toContain('Billing basis');
            expect(html).not.toMatch(/[\u4e00-\u9fff]|reported by the provider/);
        }
    });
});
