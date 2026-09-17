import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import PricingReferencePicker, {
    createPricingReferenceLookup,
    PricingReferenceResult,
} from '../PricingReferencePicker';

const result = {
    source_label: 'LiteLLM CDN',
    fetched_at: '2026-09-16T08:00:00.000Z',
    models: [
        {
            model: 'test-model',
            inputUsdPer1m: 5,
            outputUsdPer1m: 30,
            cacheReadUsdPer1m: 0.5,
            cacheWrite5mUsdPer1m: null,
            cacheWrite1hUsdPer1m: null,
        },
    ],
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function findButton(node: ReactNode): { disabled: boolean; onClick: () => void } | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const button = findButton(child);
            if (button) return button;
        }
    }
    if (isValidElement<{ disabled: boolean; onClick: () => void; children: ReactNode }>(node)) {
        if (node.type === 'button') return node.props;
        return findButton(node.props.children);
    }
    return null;
}

describe('pricing reference lookup lifecycle', () => {
    it('looks up a narrow encoded model query without mutating any pricing endpoint', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
        const onResult = vi.fn();
        const onError = vi.fn();
        await createPricingReferenceLookup(fetcher).search(' provider/test-model ', onResult, onError);
        expect(fetcher).toHaveBeenCalledWith('/api/admin/pricing-calculator/official-prices?q=provider%2Ftest-model', {
            cache: 'no-store',
            signal: expect.any(AbortSignal),
        });
        expect(onResult).toHaveBeenCalledWith(result);
        expect(onError).not.toHaveBeenCalled();
    });

    it('ignores the old result even when fetch ignores the abort and resolves after a newer search', async () => {
        const first = deferred<Response>();
        const second = deferred<Response>();
        const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const lookup = createPricingReferenceLookup(fetcher);
        const oldResult = vi.fn();
        const newResult = vi.fn();
        const onError = vi.fn();
        const oldSearch = lookup.search('old-model', oldResult, onError);
        const newSearch = lookup.search('new-model', newResult, onError);
        expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
        second.resolve(new Response(JSON.stringify(result)));
        await newSearch;
        first.resolve(new Response(JSON.stringify(result)));
        await oldSearch;
        expect(newResult).toHaveBeenCalledOnce();
        expect(oldResult).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    it('delivers neither data nor errors after cancellation for an edited query or changed model', async () => {
        for (const response of [new Response(JSON.stringify(result)), new Response('', { status: 503 })]) {
            const pending = deferred<Response>();
            const lookup = createPricingReferenceLookup(vi.fn().mockReturnValue(pending.promise));
            const onResult = vi.fn();
            const onError = vi.fn();
            const search = lookup.search('old-model', onResult, onError);
            lookup.cancel();
            pending.resolve(response);
            await search;
            expect(onResult).not.toHaveBeenCalled();
            expect(onError).not.toHaveBeenCalled();
        }
    });

    it('rejects malformed prices and does not manufacture missing cache values', async () => {
        const malformed = { ...result, models: [{ ...result.models[0], cacheWrite5mUsdPer1m: undefined }] };
        const onResult = vi.fn();
        const onError = vi.fn();
        await createPricingReferenceLookup(vi.fn().mockResolvedValue(new Response(JSON.stringify(malformed)))).search(
            'test-model',
            onResult,
            onError,
        );
        expect(onResult).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledOnce();
    });
});

describe('reference price application requires explicit credit semantics', () => {
    const props = {
        result,
        selectedModel: 'test-model',
        confirmed: false,
        disabled: false,
        en: false,
        inputClass: 'input',
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
    };

    it('does not query or apply a price automatically and clearly identifies the source and units', () => {
        const onApply = vi.fn();
        const html = renderToStaticMarkup(
            <PricingReferencePicker modelSlug="test-model" en={false} isDark={false} onApply={onApply} />,
        );
        expect(html).toContain('value="test-model"');
        expect(html).toContain('LiteLLM 基础参考价');
        expect(html).toContain('美元／百万 token');
        expect(html).toContain('确认上游使用这组基础价格后即可填入');
        expect(onApply).not.toHaveBeenCalled();
    });

    it('does not apply USD numbers before confirming how the upstream credits are billed', () => {
        const onApply = vi.fn();
        const button = findButton(PricingReferenceResult({ ...props, onApply }));
        expect(button?.disabled).toBe(true);
        button?.onClick();
        expect(onApply).not.toHaveBeenCalled();
        const html = renderToStaticMarkup(<PricingReferenceResult {...props} onApply={onApply} />);
        expect(html).toContain('$1 参考价对应 1 额度');
        expect(html).toContain('覆盖当前基础价');
        expect(html).toContain('未提供');
        expect(html).not.toContain('$0 / 1M');
        expect(html).toContain('2026/9/16 16:00:00');
        expect(html).toContain('（北京时间）');
        expect(html).not.toContain(result.fetched_at);
    });

    it('labels English timestamps as Beijing time rather than using the browser timezone', () => {
        const html = renderToStaticMarkup(<PricingReferenceResult {...props} en onApply={vi.fn()} />);
        expect(html).toContain('16/09/2026, 16:00:00');
        expect(html).toContain('(Beijing)');
        expect(html).not.toContain(result.fetched_at);
    });

    it('applies only the chosen basic rates with source provenance after confirmation', () => {
        const onApply = vi.fn();
        const button = findButton(PricingReferenceResult({ ...props, confirmed: true, onApply }));
        expect(button?.disabled).toBe(false);
        button?.onClick();
        expect(onApply).toHaveBeenCalledExactlyOnceWith({
            model: 'test-model',
            input: 5,
            output: 30,
            cache_read: 0.5,
            cache_write: null,
            cache_write_1h: null,
            sourceLabel: result.source_label,
            fetchedAt: result.fetched_at,
        });
    });

    it('blocks applying prices while the parent pricing form is disabled', () => {
        const onApply = vi.fn();
        const button = findButton(PricingReferenceResult({ ...props, confirmed: true, disabled: true, onApply }));
        expect(button?.disabled).toBe(true);
        button?.onClick();
        expect(onApply).not.toHaveBeenCalled();
    });

    it('keeps ordinary and hourly cache-write quotes distinct, including an explicit zero', () => {
        const onApply = vi.fn();
        const hourly = {
            ...result,
            models: [{ ...result.models[0], cacheWrite5mUsdPer1m: 6.25, cacheWrite1hUsdPer1m: 0 }],
        };
        const button = findButton(PricingReferenceResult({ ...props, result: hourly, confirmed: true, onApply }));
        button?.onClick();
        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ cache_write: 6.25, cache_write_1h: 0 }));
        const html = renderToStaticMarkup(<PricingReferenceResult {...props} result={hourly} onApply={onApply} />);
        expect(html).toContain('缓存写入 · 1 小时');
        expect(html).toContain('$0');
    });

    it('provides no apply action for a stale selection or an empty search result', () => {
        const onApply = vi.fn();
        expect(
            findButton(PricingReferenceResult({ ...props, selectedModel: 'missing', confirmed: true, onApply })),
        ).toBeNull();
        expect(
            findButton(
                PricingReferenceResult({ ...props, result: { ...result, models: [] }, confirmed: true, onApply }),
            ),
        ).toBeNull();
        expect(onApply).not.toHaveBeenCalled();
    });
});
