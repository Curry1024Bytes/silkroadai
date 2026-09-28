import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NewApiSyncDialog, {
    NewApiSyncChangeList,
    NewApiSyncRequestError,
    requestNewApiSync,
    syncSummaryText,
} from '../NewApiSyncDialog';
import type { NewApiSyncItem, NewApiSyncPreview, NewApiSyncSummary } from '@/lib/admin/newapi-sync-types';

const item = (id: string, overrides: Partial<NewApiSyncItem> = {}): NewApiSyncItem => ({
    id,
    kind: 'model',
    change: 'publish',
    title: id,
    before: ['状态：未上架'],
    after: ['状态：已上架'],
    ...overrides,
});
const items = [
    item('new-group', { kind: 'group', change: 'create', title: '新档次' }),
    item('published', { title: '新模型' }),
    item('removed', { change: 'unpublish', title: '旧模型' }),
    item('changed-price', {
        kind: 'price',
        change: 'update',
        title: '价格变更',
        before: ['¥ 10 / 1M'],
        after: ['¥ 20 / 1M'],
    }),
];
const summary: NewApiSyncSummary = {
    groups_created: 1,
    groups_updated: 0,
    models_published: 3,
    models_unpublished: 1,
    models_updated: 0,
    prices_updated: 2,
};
const preview: NewApiSyncPreview = {
    preview_token: 'private-preview-token',
    items,
    summary,
    warnings: [],
    blocked: null,
    unchanged: { groups: 2, models: 3, prices: 4 },
};

afterEach(() => vi.unstubAllGlobals());

describe('new-api sync summary', () => {
    it('summarises only the kinds of change that happen', () => {
        expect(syncSummaryText(summary, false)).toBe('将上架 3、下架 1、价格更新 2、档次新增 1');
        expect(syncSummaryText({ ...summary, models_published: 0, groups_created: 0 }, false)).toBe(
            '将下架 1、价格更新 2',
        );
    });

    it('reports when nothing changes', () => {
        const none = Object.fromEntries(Object.keys(summary).map((key) => [key, 0])) as unknown as NewApiSyncSummary;
        expect(syncSummaryText(none, false)).toBe('没有变化');
        expect(syncSummaryText(none, true)).toBe('No changes');
    });
});

describe('new-api sync change list', () => {
    const render = () => renderToStaticMarkup(<NewApiSyncChangeList items={items} en={false} isDark={false} />);

    it('keeps details collapsed behind a single summary', () => {
        const html = render();
        expect(html).toMatch(/^<details/);
        expect(html).not.toContain('open=""');
        expect(html).toContain('查看明细（4 项）');
    });

    it('shows before/after and the kind of each change, without any per-item controls', () => {
        const html = render();
        expect(html).toContain('¥ 10 / 1M');
        expect(html).toContain('¥ 20 / 1M');
        expect(html).toContain('档次 · 新增');
        expect(html).toContain('模型 · 上架');
        expect(html).toContain('模型 · 下架');
        expect(html).toContain('价格 · 更新');
        expect(html).not.toContain('<input');
        expect(html).not.toContain('private-preview-token');
    });
});

describe('new-api sync dialog', () => {
    it.each([false, true])('explains that the catalog follows new-api (dark=%s)', (isDark) => {
        const network = vi.fn().mockRejectedValue(new Error('SSR network is sealed'));
        vi.stubGlobal('fetch', network);
        const html = renderToStaticMarkup(
            <NewApiSyncDialog locale="zh" isDark={isDark} onClose={() => {}} onComplete={() => {}} />,
        );
        expect(html).toContain('从 new-api 更新目录');
        expect(html).toContain('让 Portal 目录与 new-api 保持一致');
        expect(html).toContain('此操作不会把价格发布到 new-api');
        expect(html).toContain('确认同步');
        expect(html).not.toContain('<input');
        expect(network).not.toHaveBeenCalled();
    });
});

describe('new-api sync requests', () => {
    it('loads a read-only preview', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify({ dryRun: true, preview }), { status: 200 }));
        vi.stubGlobal('fetch', fetcher);
        expect(await requestNewApiSync({}, false, false)).toMatchObject({ dryRun: true, preview });
        expect(fetcher).toHaveBeenCalledWith(
            '/api/admin/newapi-sync?dryRun=true',
            expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: '{}' }),
        );
    });

    it('confirms with only the reviewed preview token', async () => {
        const fetcher = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ dryRun: false, preview, applied: { groups: 1, models: 2, prices: 1 } }), {
                status: 200,
            }),
        );
        vi.stubGlobal('fetch', fetcher);
        await requestNewApiSync({ preview_token: preview.preview_token }, true, false);
        expect(fetcher).toHaveBeenCalledWith(
            '/api/admin/newapi-sync?dryRun=false',
            expect.objectContaining({ body: JSON.stringify({ preview_token: preview.preview_token }) }),
        );
    });

    it('surfaces expired previews with the server explanation and never retries apply automatically', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ message: '档次配置已变化，请重新预览。' }), { status: 409 }),
            );
        vi.stubGlobal('fetch', fetcher);
        await expect(requestNewApiSync({ preview_token: 'expired' }, true, false)).rejects.toMatchObject({
            status: 409,
            message: '档次配置已变化，请重新预览。',
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed or summary-less preview responses so they cannot be confirmed', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Unavailable</html>', { status: 200 })));
        await expect(requestNewApiSync({}, false, false)).rejects.toBeInstanceOf(NewApiSyncRequestError);
        const partial: Partial<NewApiSyncPreview> = { ...preview };
        delete partial.summary;
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValue(new Response(JSON.stringify({ dryRun: true, preview: partial }), { status: 200 })),
        );
        await expect(requestNewApiSync({}, false, false)).rejects.toBeInstanceOf(NewApiSyncRequestError);
    });
});
