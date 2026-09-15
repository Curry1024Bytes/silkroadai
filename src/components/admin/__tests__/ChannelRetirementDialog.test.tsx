import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ChannelRetirementDialog, {
    ChannelRetirementPreviewDetails,
    ChannelRetirementRequestError,
    channelRetirementSuccessText,
    createChannelRetirementSession,
    requestChannelRetirement,
} from '../ChannelRetirementDialog';
import type {
    ChannelGroupRetirementPreview,
    ChannelGroupRetirementResult,
} from '@/lib/admin/channel-group-retirement-types';

function preview(overrides: Partial<ChannelGroupRetirementPreview> = {}): ChannelGroupRetirementPreview {
    return {
        group: {
            id: 'group-sale',
            key: 'sale',
            display_name: 'GPT 特惠',
            newapi_group: 'GPT-Sale',
            is_default: false,
            enabled: true,
        },
        models: [
            {
                id: 'shared',
                slug: 'gpt-shared',
                display_name: '共享模型',
                was_enabled: true,
                will_disable: false,
                remaining_tiers: ['企业级'],
            },
            {
                id: 'only',
                slug: 'gpt-only',
                display_name: '本档独有模型',
                was_enabled: true,
                will_disable: true,
                remaining_tiers: [],
            },
            {
                id: 'off',
                slug: 'gpt-off',
                display_name: '已下架模型',
                was_enabled: false,
                will_disable: false,
                remaining_tiers: [],
            },
        ],
        existing_keys: { active: 2, total: 3 },
        default_candidates: [],
        replacement_default_id: null,
        upstream: { status: 'missing', message: 'new-api 已移除该配置。' },
        issues: [],
        canApply: true,
        preview_token: 'reviewed-token',
        ...overrides,
    };
}
const result: ChannelGroupRetirementResult = {
    group_key: 'sale',
    group_name: 'GPT 特惠',
    updated_models: 3,
    disabled_models: 1,
    existing_keys: { active: 2, total: 3 },
    replacement_default_name: null,
};
function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), { status });
}
function deferred() {
    let resolve!: (value: Response) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<Response>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
afterEach(() => vi.unstubAllGlobals());

describe('retirement requests and ordered user actions', () => {
    it('loads impact without applying anything, then submits the exact reviewed token and default', async () => {
        const reviewed = preview({ replacement_default_id: 'group-pro' });
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ preview: reviewed }))
            .mockResolvedValueOnce(json({ success: true, result }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession('group-sale', false);
        expect(await session.apply()).toBeNull();
        expect(network).not.toHaveBeenCalled();
        await session.start();
        expect(network).toHaveBeenCalledTimes(1);
        expect(network.mock.calls[0][0]).toBe('/api/admin/channel-groups/group-sale/retire');
        expect(network.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
        expect(JSON.parse(network.mock.calls[0][1].body)).toEqual({ action: 'preview', replacement_default_id: null });
        expect(session.getState()).toMatchObject({ replacementDefaultId: 'group-pro', loading: false });
        expect(await session.apply()).toEqual(result);
        expect(JSON.parse(network.mock.calls[1][1].body)).toEqual({
            action: 'apply',
            replacement_default_id: 'group-pro',
            preview_token: 'reviewed-token',
        });
        expect(session.getState().preview).toBeNull();
    });

    it('invalidates the old confirmation immediately when changing the default and ignores an out-of-order preview', async () => {
        const second = deferred();
        const third = deferred();
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ preview: preview() }))
            .mockReturnValueOnce(second.promise)
            .mockReturnValueOnce(third.promise);
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession('group-sale', false);
        await session.start();
        const firstChange = session.refresh('group-a');
        expect(session.getState()).toMatchObject({ preview: null, replacementDefaultId: 'group-a', loading: true });
        expect(await session.apply()).toBeNull();
        const latestChange = session.refresh('group-b');
        expect(network.mock.calls[1][1].signal.aborted).toBe(true);
        third.resolve(json({ preview: preview({ replacement_default_id: 'group-b', preview_token: 'token-b' }) }));
        await latestChange;
        second.resolve(json({ preview: preview({ replacement_default_id: 'group-a', preview_token: 'token-a' }) }));
        await firstChange;
        expect(session.getState()).toMatchObject({
            replacementDefaultId: 'group-b',
            preview: { preview_token: 'token-b' },
            loading: false,
            error: '',
        });
        expect(network).toHaveBeenCalledTimes(3);
    });

    it('does not let a late failed request erase the newer preview or show an obsolete error', async () => {
        const old = deferred();
        const network = vi
            .fn()
            .mockReturnValueOnce(old.promise)
            .mockResolvedValueOnce(json({ preview: preview({ preview_token: 'new' }) }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession('group-sale', false);
        const oldLoad = session.start();
        await session.refresh('new-default');
        old.reject(new Error('Old failure'));
        await oldLoad;
        expect(session.getState()).toMatchObject({ error: '', preview: { preview_token: 'new' }, loading: false });
    });

    it('allows only one apply and prevents a default change while deleting', async () => {
        const applyResponse = deferred();
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ preview: preview() }))
            .mockReturnValueOnce(applyResponse.promise);
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession('group-sale', false);
        await session.start();
        const apply = session.apply();
        expect(session.getState().applying).toBe(true);
        expect(await session.apply()).toBeNull();
        await session.refresh('different');
        expect(network).toHaveBeenCalledTimes(2);
        applyResponse.resolve(json({ success: true, result }));
        expect(await apply).toEqual(result);
        expect(session.getState().applying).toBe(false);
    });

    it.each(['preview_stale', 'preview_expired'])(
        'refreshes %s but requires another explicit confirmation',
        async (code) => {
            const network = vi
                .fn()
                .mockResolvedValueOnce(json({ preview: preview() }))
                .mockResolvedValueOnce(json({ error: code, message: '配置已变化，请重新核对。' }, 409))
                .mockResolvedValueOnce(json({ preview: preview({ preview_token: 'latest-token' }) }))
                .mockResolvedValueOnce(json({ success: true, result }));
            vi.stubGlobal('fetch', network);
            const session = createChannelRetirementSession('group-sale', false);
            await session.start();
            expect(await session.apply()).toBeNull();
            expect(network.mock.calls.map((call) => JSON.parse(call[1].body).action)).toEqual([
                'preview',
                'apply',
                'preview',
            ]);
            expect(session.getState()).toMatchObject({
                error: '配置已变化，请重新核对。',
                preview: { preview_token: 'latest-token' },
                loading: false,
                applying: false,
            });
            await session.apply();
            expect(JSON.parse(network.mock.calls[3][1].body).preview_token).toBe('latest-token');
        },
    );

    it('retains failure information and requires a new preview after an unknown apply result', async () => {
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ preview: preview() }))
            .mockRejectedValueOnce(new Error('网络断开'))
            .mockResolvedValueOnce(json({ preview: preview({ preview_token: 'retried-preview' }) }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession('group-sale', false);
        await session.start();
        expect(await session.apply()).toBeNull();
        expect(session.getState()).toMatchObject({
            preview: null,
            applying: false,
            error: '网络断开',
            displayedPreview: { group: { id: 'group-sale' } },
        });
        expect(await session.apply()).toBeNull();
        expect(network).toHaveBeenCalledTimes(2);
        await session.refresh();
        expect(session.getState()).toMatchObject({ error: '', preview: { preview_token: 'retried-preview' } });
    });

    it('keeps blocked impact visible without permitting apply', async () => {
        const blocked = preview({
            canApply: false,
            issues: [{ code: 'pricing_busy', message: '请先完成价格发布任务。' }],
        });
        const network = vi.fn().mockResolvedValue(json({ preview: blocked }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession('group-sale', false);
        await session.start();
        expect(session.getState().displayedPreview).toEqual(blocked);
        expect(await session.apply()).toBeNull();
        expect(network).toHaveBeenCalledTimes(1);
    });

    it('aborts a disposed preview and safely supports the React strict effect restart', async () => {
        const old = deferred();
        const network = vi
            .fn()
            .mockReturnValueOnce(old.promise)
            .mockResolvedValueOnce(json({ preview: preview({ preview_token: 'remounted' }) }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession('group-sale', false);
        const oldLoad = session.start();
        session.dispose();
        expect(network.mock.calls[0][1].signal.aborted).toBe(true);
        await session.start();
        old.resolve(json({ preview: preview({ preview_token: 'obsolete' }) }));
        await oldLoad;
        expect(session.getState().preview?.preview_token).toBe('remounted');
    });

    it('validates responses and presents an expired session without exposing raw server content', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValueOnce(new Response('<html>proxy</html>'))
                .mockResolvedValueOnce(json({ preview: { canApply: true } }))
                .mockResolvedValueOnce(json({ error: 'auth', message: 'internal' }, 401)),
        );
        await expect(requestChannelRetirement('group-sale', { action: 'preview' }, false)).rejects.toBeInstanceOf(
            ChannelRetirementRequestError,
        );
        await expect(requestChannelRetirement('group-sale', { action: 'preview' }, false)).rejects.toMatchObject({
            code: 'invalid_response',
        });
        await expect(requestChannelRetirement('group-sale', { action: 'preview' }, false)).rejects.toMatchObject({
            status: 401,
            message: '登录已过期，请重新登录。',
        });
    });
});

describe('retirement impact and confirmation content', () => {
    function render(reviewed = preview(), isDark = false, disabled = false) {
        return renderToStaticMarkup(
            <ChannelRetirementPreviewDetails
                preview={reviewed}
                replacementDefaultId={reviewed.replacement_default_id}
                isDark={isDark}
                en={false}
                disabled={disabled}
                onDefaultChange={() => {}}
            />,
        );
    }
    it.each([false, true])(
        'shows affected counts, retained tiers, unlisting and the actual key warning in both themes (dark=%s)',
        (isDark) => {
            const html = render(preview(), isDark);
            expect(html).toContain('清理 3 个模型的本档关联，其中 1 个没有其他档次关联的模型将自动下架');
            expect(html).toContain('保留档次：企业级');
            expect(html).toContain('维持已下架');
            expect(html).toContain('模型记录、价格历史、成本规则及其历史、用量记录均保留');
            expect(html).toContain('本档记录了 3 个已有 Key，其中 2 个仍为启用状态');
            expect(html).toContain('不会撤销或迁移这些 Key');
            expect(html).toContain('它们可能已无法调用');
            expect(html).toContain('客户不能再选择此档新建 Key');
            expect(html).toContain('Portal 目录也不再展示本档模型');
            expect(html).toContain('客户档次权限和倍率配置保留');
            expect(html).not.toContain('reviewed-token');
            expect(html).not.toContain('<select');
        },
    );

    it.each(['missing', 'present', 'unknown'] as const)(
        'explains the %s upstream state without claiming the operation deletes upstream',
        (status) => {
            const html = render(preview({ upstream: { status, message: '状态说明' } }));
            expect(html).toContain(
                status === 'missing'
                    ? 'new-api 未发现该分组或引用关系'
                    : status === 'present'
                      ? 'new-api 仍有对应分组或渠道'
                      : '暂时无法确认 new-api 状态',
            );
            expect(html).toContain('状态说明');
            if (status !== 'missing') expect(html).toContain('仍可清理 Portal；此操作不会删除或停用 new-api 中的配置');
        },
    );

    it('shows the sole replacement automatically and asks for a choice only when multiple defaults are available', () => {
        const one = preview({
            group: { ...preview().group, is_default: true },
            default_candidates: [{ id: 'pro', key: 'pro', display_name: '企业级' }],
            replacement_default_id: 'pro',
        });
        expect(render(one)).toContain('默认档次将自动改为：');
        expect(render(one)).not.toContain('<select');
        const two = {
            ...one,
            default_candidates: [...one.default_candidates, { id: 'other', key: 'other', display_name: '其他档' }],
        };
        expect(render(two)).toContain('删除后的默认档次');
        expect(render(two)).toMatch(/<option value="pro" selected="">企业级/);
        expect(render(two, false, true)).toMatch(/<select disabled=""/);
    });

    it('reports exact deletion counts and default reassignment without promising keys still work', () => {
        expect(channelRetirementSuccessText({ ...result, replacement_default_name: '企业级' }, false)).toBe(
            '已从 Portal 删除「GPT 特惠」，清理 3 个模型的本档关联，下架 1 个没有其他档次关联的模型。历史记录已保留，已有 Key 未撤销。默认档次已改为「企业级」。',
        );
        expect(channelRetirementSuccessText(result, true)).toContain('existing keys were not revoked');
    });

    it('opens as a labelled confirmation with no SSR network request and no enabled destructive action before preview', () => {
        const network = vi.fn();
        vi.stubGlobal('fetch', network);
        const html = renderToStaticMarkup(
            <ChannelRetirementDialog
                groupId="group-sale"
                locale="zh"
                isDark={false}
                onClose={() => {}}
                onComplete={() => {}}
            />,
        );
        expect(html).toContain('aria-labelledby="retirement-title"');
        expect(html).toContain('无需逐个编辑模型');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认删除并清理关联/);
        expect(network).not.toHaveBeenCalled();
    });
});
