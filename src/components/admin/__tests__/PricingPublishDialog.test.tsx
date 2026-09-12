import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PricingPublishDialog, {
    pricingPublishInput,
    PricingPublishPreviewDetails,
    requestPricingPreview,
    requestPricingPublish,
} from '../PricingPublishDialog';
import { PricingPublishJobs, pricingPublishJobLabel, requestPricingJobAction } from '../PricingPublishJobs';
import type { PricingPublishInput, PricingPublishJob, PricingPublishPreview } from '@/lib/admin/pricing-publish-types';

const NOW = Date.parse('2026-09-12T08:00:00.000Z');
const input: PricingPublishInput = {
    model_id: 'model-1',
    tier: 'sale',
    input_cny_per_1m: 2,
    output_cny_per_1m: 6,
    per_image_cny: null,
    cost_cny_per_1m: 0.1,
};
const form = { tier: 'sale', input_cny_per_1m: '2', output_cny_per_1m: '6', per_image_cny: '', cost_cny_per_1m: '0.1' };
const preview: PricingPublishPreview = {
    preview_token: 'private-preview-token',
    expires_at: new Date(NOW + 600_000).toISOString(),
    upstream_model: 'gpt-test',
    basis: 'token',
    rows: [
        {
            model_id: 'model-1',
            model_name: 'GPT Test',
            tier: 'sale',
            group: 'Sale',
            before: { input_cny_per_1m: 1, output_cny_per_1m: 3, per_image_cny: null },
            after: { input_cny_per_1m: 2, output_cny_per_1m: 6, per_image_cny: null },
        },
        {
            model_id: 'model-2',
            model_name: 'GPT Alias',
            tier: 'pro',
            group: 'Pro',
            before: null,
            after: { input_cny_per_1m: 4, output_cny_per_1m: 12, per_image_cny: null },
        },
    ],
    warnings: ['两个档次共享模型基础价格。'],
};
const job: PricingPublishJob = {
    id: 'job-1',
    status: 'queued',
    message: '等待写入与核验',
    attempts: 0,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    next_attempt_at: null,
    upstream_model: 'gpt-test',
};
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('price publication form validation', () => {
    it('sends numeric amounts with null for empty fields', () => {
        expect(pricingPublishInput('model-1', form)).toEqual(input);
        expect(
            pricingPublishInput('model-1', {
                ...form,
                input_cny_per_1m: '0.1',
                output_cny_per_1m: '0',
                cost_cny_per_1m: '',
            }),
        ).toMatchObject({ input_cny_per_1m: 0.1, output_cny_per_1m: 0, cost_cny_per_1m: null });
    });
    it('allows only one complete billing basis', () => {
        expect(
            pricingPublishInput('model-1', {
                ...form,
                input_cny_per_1m: '',
                output_cny_per_1m: '',
                per_image_cny: '1.5',
            }),
        ).toMatchObject({ input_cny_per_1m: null, output_cny_per_1m: null, per_image_cny: 1.5 });
        for (const change of [
            { per_image_cny: '1.5' },
            { output_cny_per_1m: '' },
            { tier: '' },
            { input_cny_per_1m: '0' },
        ])
            expect(pricingPublishInput('model-1', { ...form, ...change })).toBeNull();
    });
    it.each(['-1', 'NaN', 'Infinity', 'invalid', '0.12345', '100000000'])(
        'rejects invalid prices and costs: %s',
        (value) => {
            expect(pricingPublishInput('model-1', { ...form, input_cny_per_1m: value })).toBeNull();
            expect(pricingPublishInput('model-1', { ...form, cost_cny_per_1m: value })).toBeNull();
        },
    );
});

describe('price publication preview and job requests', () => {
    it('preview sends no publish request and keeps an independent input snapshot across the await', async () => {
        let respond!: (value: Response) => void;
        const fetcher = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    respond = resolve;
                }),
        );
        vi.stubGlobal('fetch', fetcher);
        const editable = { ...input };
        const pending = requestPricingPreview(editable);
        editable.input_cny_per_1m = 999;
        respond(new Response(JSON.stringify({ preview })));
        const prepared = await pending;
        expect(prepared.input).toEqual(input);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledWith(
            '/api/admin/pricing',
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
                body: JSON.stringify({ action: 'preview', ...input }),
            }),
        );
    });
    it('confirmation publishes the exact reviewed input and token, then returns a pending server job', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job }), { status: 202 }));
        vi.stubGlobal('fetch', fetcher);
        expect(await requestPricingPublish({ input: { ...input }, preview })).toEqual(job);
        expect(fetcher).toHaveBeenCalledWith(
            '/api/admin/pricing',
            expect.objectContaining({
                body: JSON.stringify({ action: 'publish', preview_token: preview.preview_token, ...input }),
            }),
        );
        expect(pricingPublishJobLabel(job.status)).toBe('待发布');
    });
    it('an expired preview cannot be published or sent to the server', async () => {
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        vi.advanceTimersByTime(600_001);
        await expect(requestPricingPublish({ input, preview })).rejects.toMatchObject({
            code: 'preview_stale',
            status: 409,
        });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('preserves a rejected publication message so the form can require a new preview', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: 'preview_stale', message: '上游价格已改变，请重新预览。' }), {
                    status: 409,
                }),
            ),
        );
        await expect(requestPricingPublish({ input, preview })).rejects.toMatchObject({
            code: 'preview_stale',
            message: '上游价格已改变，请重新预览。',
        });
    });
    it('does not interpret a legacy immediate-save response as a publication task', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(new Response(JSON.stringify({ price: {}, sync: { ok: true } }), { status: 200 })),
        );
        await expect(requestPricingPublish({ input, preview })).rejects.toThrow('Invalid publication response');
    });
    it('retry acts on the saved job rather than repeating the old resync endpoint', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify({ job: { ...job, status: 'retry_wait' } })));
        vi.stubGlobal('fetch', fetcher);
        expect((await requestPricingJobAction('job/1', 'retry')).status).toBe('retry_wait');
        expect(fetcher).toHaveBeenCalledWith(
            '/api/admin/pricing/publish/job%2F1',
            expect.objectContaining({ body: JSON.stringify({ action: 'retry' }) }),
        );
    });
    it('shows rejected cancellation without pretending the task was cancelled', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: 'cancel_unsafe', message: '上游已写入，当前不能取消。' }), {
                    status: 409,
                }),
            ),
        );
        await expect(requestPricingJobAction(job.id, 'cancel')).rejects.toThrow('上游已写入，当前不能取消。');
    });
});

describe('price publication UI', () => {
    it('shows every shared tier and its before/after amounts without displaying the signed token', () => {
        const html = renderToStaticMarkup(<PricingPublishPreviewDetails preview={preview} en={false} isDark={false} />);
        for (const value of [
            'GPT Test',
            'GPT Alias',
            'sale',
            'pro',
            '¥1',
            '¥2',
            '¥6',
            '¥12',
            '基础价格由各档次共享',
            '实际扣费由 new-api 执行',
        ])
            expect(html).toContain(value);
        expect(html).not.toContain('private-preview-token');
        expect(html).toContain('预览有效至');
    });
    it('requires a specific tier before previewing a model-level publication', () => {
        const html = renderToStaticMarkup(
            <PricingPublishDialog
                model={{ id: 'model-1', display_name: 'GPT', slug: 'gpt-test' }}
                tiers={[{ tier: 'sale', current: input }]}
                en={false}
                isDark={false}
                onClose={() => {}}
                onSubmitted={() => {}}
                onUncertain={() => {}}
            />,
        );
        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="true"');
        expect(html).toContain('发布价格到 new-api');
        expect(html).toContain('请选择档次');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>预览发布<\/button>/);
        expect(html).not.toContain('确认发布');
    });
    it('opens a per-tier edit with an enabled Preview button and no immediate Save button', () => {
        const html = renderToStaticMarkup(
            <PricingPublishDialog
                model={{ id: 'model-1', display_name: 'GPT', slug: 'gpt-test' }}
                tiers={[{ tier: 'sale', current: input }]}
                initialTier="sale"
                en={false}
                isDark={true}
                onClose={() => {}}
                onSubmitted={() => {}}
                onUncertain={() => {}}
            />,
        );
        expect(html).toMatch(/<button(?![^>]*disabled=)[^>]*>预览发布<\/button>/);
        expect(html).not.toContain('>保存<');
        expect(html).toContain('确认前不会改价');
    });
    it.each(['queued', 'retry_wait', 'conflict', 'failed', 'cancelled'] as const)(
        'never calls status %s effective',
        (status) => {
            expect(pricingPublishJobLabel(status)).not.toBe('已生效');
            expect(pricingPublishJobLabel(status, true)).not.toBe('Effective');
        },
    );
    it('renders saved jobs, pending checks and a failed cancellation in the task panel', () => {
        const jobs = [
            job,
            {
                ...job,
                id: 'job-2',
                status: 'retry_wait' as const,
                attempts: 2,
                next_attempt_at: new Date(NOW + 30_000).toISOString(),
            },
            { ...job, id: 'job-3', status: 'succeeded' as const },
        ];
        const html = renderToStaticMarkup(
            <PricingPublishJobs
                jobs={jobs}
                en={false}
                isDark={false}
                busyId={null}
                error="上游已写入，当前不能取消。"
                onAction={() => {}}
            />,
        );
        for (const text of [
            '等待重试 · 待核验',
            '已生效',
            '下次核验',
            '上游已写入，当前不能取消。',
            '刷新页面不会丢失',
        ])
            expect(html).toContain(text);
        expect(html.match(/>申请取消<\/button>/g)).toHaveLength(2);
        expect(html.match(/>重新核验 \/ 重试<\/button>/g)).toHaveLength(1);
    });
});
