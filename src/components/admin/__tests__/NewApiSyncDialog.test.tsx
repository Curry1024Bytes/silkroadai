import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NewApiSyncDialog, {
    defaultSyncSelection,
    NewApiSyncPreviewList,
    NewApiSyncRequestError,
    requestNewApiSync,
    toggleSyncSelection,
} from '../NewApiSyncDialog';
import type { NewApiSyncItem, NewApiSyncPreview } from '@/lib/admin/newapi-sync-types';

const item = (id: string, overrides: Partial<NewApiSyncItem> = {}): NewApiSyncItem => ({
    id,
    kind: 'model',
    change: 'new',
    title: id,
    before: [],
    after: ['保存为停用候选'],
    notes: [],
    selectable: true,
    defaultSelected: true,
    canActivate: true,
    dependsOn: [],
    ...overrides,
});
const items = [
    item('new-group', { kind: 'group', title: '新档次' }),
    item('new-model', { title: '新模型', dependsOn: ['new-group'] }),
    item('new-price', { kind: 'price', canActivate: false, dependsOn: ['new-model'] }),
    item('changed-price', {
        kind: 'price',
        change: 'update',
        canActivate: false,
        defaultSelected: false,
        title: '价格变更',
        before: ['¥ 10 / 1M'],
        after: ['¥ 20 / 1M'],
    }),
    item('disabled-group', { kind: 'group', change: 'update', defaultSelected: false }),
    item('missing-price', {
        kind: 'price',
        change: 'missing',
        canActivate: false,
        selectable: false,
        title: '价格待核对',
    }),
];
const preview: NewApiSyncPreview = {
    preview_token: 'private-preview-token',
    items,
    warnings: [],
    unchanged: { groups: 2, models: 3, prices: 4 },
};

afterEach(() => vi.unstubAllGlobals());

describe('new-api sync choices', () => {
    it('defaults to importing new candidates and missing prices, without enabling or changing existing prices', () => {
        expect(defaultSyncSelection(items)).toEqual({
            selected: ['new-group', 'new-model', 'new-price'],
            activate: [],
        });
    });

    it('selects prerequisites across all three sections in one action', () => {
        expect(toggleSyncSelection(items, [], 'new-price')).toEqual(['new-group', 'new-model', 'new-price']);
    });

    it('removing a tier also removes the dependent model and price while preserving unrelated explicit choices', () => {
        expect(
            toggleSyncSelection(items, ['new-group', 'new-model', 'new-price', 'changed-price'], 'new-group'),
        ).toEqual(['changed-price']);
    });

    it('supports mutually dependent channel registration and model mapping updates', () => {
        const coupled = [item('tier', { dependsOn: ['model'] }), item('model', { dependsOn: ['tier'] })];
        expect(toggleSyncSelection(coupled, [], 'model')).toEqual(['tier', 'model']);
        expect(toggleSyncSelection(coupled, ['tier', 'model'], 'tier')).toEqual([]);
    });

    it('does not partially select a chain when a prerequisite is missing or unavailable', () => {
        for (const dependsOn of [
            ['new-group', 'missing'],
            ['new-group', 'missing-price'],
        ]) {
            expect(
                toggleSyncSelection([...items, item('blocked', { dependsOn })], ['changed-price'], 'blocked'),
            ).toEqual(['changed-price']);
        }
    });

    it('review-only rows cannot be selected even by a forged UI action', () => {
        expect(toggleSyncSelection(items, [], 'missing-price')).toEqual([]);
    });
});

describe('new-api sync preview rendering', () => {
    const render = (disabled = false) =>
        renderToStaticMarkup(
            <NewApiSyncPreviewList
                preview={preview}
                selection={defaultSyncSelection(items)}
                disabled={disabled}
                en={false}
                isDark={false}
                onToggle={() => {}}
                onActivate={() => {}}
            />,
        );

    it('shows price before/after and explains the direction of pricing sync', () => {
        const html = render();
        expect(html).toContain('¥ 10 / 1M');
        expect(html).toContain('¥ 20 / 1M');
        expect(html).toContain('此操作不修改 new-api 扣费');
        expect(html).toContain('将 new-api 当前价格读入 Portal 目录');
        expect(html).toContain('目录更新后');
        expect(html).toContain('/admin/pricing?lang=zh&amp;theme=light');
        expect(html).toContain('前往定价页核对缺失价格（新窗口）');
        expect(html).not.toContain('private-preview-token');
    });

    it.each([false, true])('makes the read direction explicit in the dialog title (dark=%s)', (isDark) => {
        const network = vi.fn().mockRejectedValue(new Error('SSR network is sealed'));
        vi.stubGlobal('fetch', network);
        const html = renderToStaticMarkup(
            <NewApiSyncDialog locale="zh" isDark={isDark} onClose={() => {}} onComplete={() => {}} />,
        );
        expect(html).toContain('从 new-api 更新目录');
        expect(html).toContain('此操作不会把价格发布到 new-api');
        expect(html).toContain('新增档次和模型默认保存为停用候选');
        expect(html).toContain('启用或上架需额外勾选');
        expect(html).not.toContain('>同步 new-api<');
        expect(network).not.toHaveBeenCalled();
    });

    it('uses labelled controls and keeps activation separate from selected import candidates', () => {
        const html = render();
        expect(html).toContain('aria-label="同时启用档次：新档次"');
        expect(html).toContain('aria-label="同时上架模型：新模型"');
        const controls = html.match(/<input[^>]+>/g) ?? [];
        expect(controls.filter((control) => control.includes('checked=""'))).toHaveLength(3);
        expect(
            controls
                .filter((control) => control.includes('aria-label='))
                .every((control) => !control.includes('checked=""')),
        ).toBe(true);
    });

    it('locks every selection during requests and marks review-only rows unavailable', () => {
        const controls = render(true).match(/<input[^>]+>/g) ?? [];
        expect(controls.length).toBeGreaterThan(0);
        expect(controls.every((control) => control.includes('disabled=""'))).toBe(true);
        expect(render()).toMatch(/<input[^>]*disabled=""[^>]*\/>[^<]*<span[^>]*>价格待核对/);
    });
});

describe('new-api sync requests', () => {
    it('loads a read-only preview with no selections or activation', async () => {
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

    it('submits only the explicitly selected changes with the reviewed version', async () => {
        const fetcher = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ dryRun: false, preview, applied: { groups: 1, models: 1, prices: 1 } }), {
                status: 200,
            }),
        );
        vi.stubGlobal('fetch', fetcher);
        const body = {
            preview_token: preview.preview_token,
            selected: ['new-group', 'new-model', 'new-price'],
            activate: [],
        };
        await requestNewApiSync(body, true, false);
        expect(fetcher).toHaveBeenCalledWith(
            '/api/admin/newapi-sync?dryRun=false',
            expect.objectContaining({ body: JSON.stringify(body) }),
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

    it('rejects malformed preview responses so they cannot be confirmed', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Unavailable</html>', { status: 200 })));
        await expect(requestNewApiSync({}, false, false)).rejects.toBeInstanceOf(NewApiSyncRequestError);
    });
});
