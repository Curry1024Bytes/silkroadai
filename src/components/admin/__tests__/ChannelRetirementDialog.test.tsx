import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ChannelRetirementDialog, {
    ChannelRetirementPreviewDetails,
    ChannelRetirementRequestError,
    ChannelRetirementJobProgress,
    ChannelRetirementTasksDialog,
    channelRetirementSuccessText,
    createChannelRetirementSession,
    requestChannelRetirement,
    requestRetirementTasks,
    shouldAutomaticallyResumeRetirement,
} from '../ChannelRetirementDialog';
import type {
    ChannelGroupRetirementPreview,
    ChannelGroupRetirementResult,
    ChannelGroupRetirementJobView,
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
        revocation: {
            keys: [
                {
                    id: 'key-a',
                    label: '客户 A 的 Key',
                    user_id: 'customer-a',
                    status: 'ready',
                    actual_group: 'GPT-Sale',
                    message: '归属匹配，待撤销。',
                },
                {
                    id: 'key-b',
                    label: '客户 B 的 Key',
                    user_id: 'customer-b',
                    status: 'missing',
                    actual_group: null,
                    message: 'new-api 已不存在。',
                },
            ],
            customers: 2,
            expected_group: 'GPT-Sale',
            orphaned: false,
        },
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
    revoked_keys: 1,
    already_absent_keys: 1,
};
function job(overrides: Partial<ChannelGroupRetirementJobView> = {}): ChannelGroupRetirementJobView {
    return {
        id: 'saved-job',
        tenant_id: null,
        group_key: 'sale',
        group_name: 'GPT 特惠',
        newapi_group: 'GPT-Sale',
        orphaned: false,
        status: 'queued',
        message: '任务已保存，等待处理。',
        summary: { total: 2, confirmed: 0, pending: 2, failed: 0, revoked: 0, already_absent: 0 },
        keys: [
            { id: 'key-a', label: '客户 A 的 Key', user_id: 'customer-a', status: 'pending', message: '' },
            { id: 'key-b', label: '客户 B 的 Key', user_id: 'customer-b', status: 'pending', message: '' },
        ],
        canResume: true,
        canStop: true,
        created_at: '2026-09-15T10:00:00Z',
        updated_at: '2026-09-15T10:00:00Z',
        result: null,
        ...overrides,
    };
}
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
            .mockResolvedValueOnce(json({ job: job() }, 202));
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
        expect(await session.apply()).toEqual(job());
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
        applyResponse.resolve(json({ job: job() }, 202));
        expect(await apply).toEqual(job());
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
                .mockResolvedValueOnce(json({ job: job() }, 202));
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

    it('requires finding the saved task after an unknown start result instead of starting again', async () => {
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
        expect(session.getState()).toMatchObject({ error: '网络断开', preview: null, startUncertain: true });
        expect(network).toHaveBeenCalledTimes(2);
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

describe('persisted key revocation tasks and recovery', () => {
    it('reopens a saved task using a read only GET, then resumes only that task', async () => {
        const done = job({
            status: 'succeeded',
            canResume: false,
            result,
            summary: { total: 2, confirmed: 2, pending: 0, failed: 0, revoked: 1, already_absent: 1 },
        });
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ job: job() }))
            .mockResolvedValueOnce(json({ job: done }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession({ kind: 'job', jobId: 'saved-job' }, false);
        await session.start();
        expect(network.mock.calls[0][0]).toBe('/api/admin/channel-group-retirement-jobs/saved-job');
        expect(network.mock.calls[0][1]).toMatchObject({ method: 'GET' });
        expect(network.mock.calls[0][1].body).toBeUndefined();
        expect(shouldAutomaticallyResumeRetirement(session.getState())).toBe(true);
        expect(await session.resume()).toEqual(done);
        expect(network.mock.calls[1][0]).toBe('/api/admin/channel-group-retirement-jobs/saved-job');
        expect(network.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{"action":"resume"}' });
        expect(shouldAutomaticallyResumeRetirement(session.getState())).toBe(false);
        expect(await session.resume()).toBeNull();
        expect(network).toHaveBeenCalledTimes(2);
    });

    it('stops automatic processing at needs_attention and explicitly retries the same saved job', async () => {
        const attention = job({
            status: 'needs_attention',
            message: '一个 Key 未核实。',
            summary: { total: 2, confirmed: 1, pending: 0, failed: 1, revoked: 1, already_absent: 0 },
        });
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ job: attention }))
            .mockResolvedValueOnce(json({ job: job({ status: 'running' }) }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession({ kind: 'job', jobId: 'saved-job' }, false);
        await session.start();
        expect(shouldAutomaticallyResumeRetirement(session.getState())).toBe(false);
        expect(network).toHaveBeenCalledTimes(1);
        await session.resume();
        expect(network.mock.calls[1][0]).toBe('/api/admin/channel-group-retirement-jobs/saved-job');
        expect(shouldAutomaticallyResumeRetirement(session.getState())).toBe(true);
    });

    it('uses only GET to reconcile an unknown resume result and does not automatically revoke again', async () => {
        const recovered = job({
            status: 'running',
            summary: { total: 2, confirmed: 1, pending: 1, failed: 0, revoked: 1, already_absent: 0 },
        });
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ job: job() }))
            .mockRejectedValueOnce(new Error('连接断开'))
            .mockResolvedValueOnce(json({ job: recovered }))
            .mockResolvedValueOnce(json({ job: recovered }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession({ kind: 'job', jobId: 'saved-job' }, false);
        await session.start();
        expect(await session.resume()).toBeNull();
        expect(network.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'POST', 'GET']);
        expect(session.getState().job?.summary.confirmed).toBe(1);
        expect(session.getState().error).toContain('部分 Key 可能已经撤销');
        expect(shouldAutomaticallyResumeRetirement(session.getState())).toBe(false);
        await session.loadJob();
        expect(session.getState().error).toBe('');
        expect(shouldAutomaticallyResumeRetirement(session.getState())).toBe(false);
        expect(network.mock.calls.map((call) => call[1].method)).toEqual(['GET', 'POST', 'GET', 'GET']);
    });

    it('locks concurrent resume and status reads while a revocation request is outstanding', async () => {
        const pending = deferred();
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ job: job() }))
            .mockReturnValueOnce(pending.promise);
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession({ kind: 'job', jobId: 'saved-job' }, false);
        await session.start();
        const first = session.resume();
        expect(await session.resume()).toBeNull();
        await session.loadJob();
        expect(shouldAutomaticallyResumeRetirement(session.getState())).toBe(false);
        expect(network).toHaveBeenCalledTimes(2);
        pending.resolve(json({ job: job({ status: 'running' }) }));
        await first;
    });

    it('fetches the task and orphan inventory without any write', async () => {
        const inventory = {
            jobs: [job()],
            orphan_groups: [{ tenant_id: null, tier_key: 'old-sale', key_count: 2, active_key_count: 1 }],
        };
        const network = vi.fn().mockResolvedValueOnce(json(inventory));
        vi.stubGlobal('fetch', network);
        expect(await requestRetirementTasks(false)).toEqual(inventory);
        expect(network).toHaveBeenCalledWith(
            '/api/admin/channel-group-retirement-jobs',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('requires an explicit original group for leftover keys and clears the review when it changes', async () => {
        const reviewed = preview({
            group: { ...preview().group, id: 'orphan:old-sale', key: 'old-sale' },
            models: [],
            revocation: { ...preview().revocation!, orphaned: true },
        });
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ preview: reviewed }))
            .mockResolvedValueOnce(json({ job: job({ orphaned: true }) }, 202));
        vi.stubGlobal('fetch', network);
        const target = { kind: 'orphan' as const, tenantId: 'tenant-one', tierKey: 'old-sale' };
        const session = createChannelRetirementSession(target, false);
        await session.start();
        expect(network).not.toHaveBeenCalled();
        await session.refresh();
        expect(session.getState().error).toContain('准确 new-api group');
        expect(network).not.toHaveBeenCalled();
        session.setNewapiGroup('Original Sale');
        await session.refresh();
        expect(network.mock.calls[0][0]).toBe('/api/admin/channel-group-retirement-jobs');
        expect(JSON.parse(network.mock.calls[0][1].body)).toEqual({
            action: 'preview',
            tenant_id: 'tenant-one',
            tier_key: 'old-sale',
            newapi_group: 'Original Sale',
        });
        session.setNewapiGroup('Another Group');
        expect(session.getState().preview).toBeNull();
        expect(await session.apply()).toBeNull();
        expect(network).toHaveBeenCalledTimes(1);
    });

    it('never authorizes the former Portal-only preview as a key revocation confirmation', async () => {
        const network = vi.fn().mockResolvedValueOnce(json({ preview: preview({ revocation: undefined }) }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession('group-sale', false);
        await session.start();
        expect(session.getState().preview).toBeNull();
        expect(await session.apply()).toBeNull();
        expect(network).toHaveBeenCalledTimes(1);
    });

    it('stops only when the saved task says it is safe and never pretends to undo confirmed revocations', async () => {
        const attention = job({
            status: 'needs_attention',
            summary: { total: 2, confirmed: 1, pending: 0, failed: 1, revoked: 1, already_absent: 0 },
        });
        const stopped = { ...attention, status: 'cancelled' as const, canResume: false, canStop: false };
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ job: attention }))
            .mockResolvedValueOnce(json({ job: stopped }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession({ kind: 'job', jobId: 'saved-job' }, false);
        await session.start();
        expect(await session.stop()).toEqual(stopped);
        expect(network.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{"action":"stop"}' });
        expect(session.getState().job?.summary.revoked).toBe(1);
        expect(shouldAutomaticallyResumeRetirement(session.getState())).toBe(false);
        expect(await session.stop()).toBeNull();
        expect(await session.resume()).toBeNull();
        expect(network).toHaveBeenCalledTimes(2);
    });

    it('does not send stop while a key deletion result is still uncertain', async () => {
        const network = vi
            .fn()
            .mockResolvedValueOnce(json({ job: job({ status: 'needs_attention', canStop: false }) }));
        vi.stubGlobal('fetch', network);
        const session = createChannelRetirementSession({ kind: 'job', jobId: 'saved-job' }, false);
        await session.start();
        expect(await session.stop()).toBeNull();
        expect(network).toHaveBeenCalledTimes(1);
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
            expect(html).toContain('在 new-api 撤销本档所属的 2 个 Key');
            expect(html).toContain('Key 历史记录保留');
            expect(html).toContain('客户余额不变');
            expect(html).toContain('已经撤销的 Key 不会恢复');
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
            if (status !== 'missing')
                expect(html).toContain('本次清理不会删除 new-api 渠道；确认后将撤销属于本档的 Key');
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
            '已完成「GPT 特惠」分组清理：本次撤销 1 个 Key，另有 1 个原已失效或不存在；清理 3 个模型的本档关联，下架 1 个没有其他档次关联的模型。历史记录保留，客户余额不变。默认档次已改为「企业级」。',
        );
        expect(channelRetirementSuccessText(result, true)).toContain('keys revoked now');
    });

    it('opens as a labelled confirmation with no SSR network request and no enabled destructive action before preview', () => {
        const network = vi.fn();
        vi.stubGlobal('fetch', network);
        const html = renderToStaticMarkup(
            <ChannelRetirementDialog
                target={{ kind: 'group', groupId: 'group-sale' }}
                locale="zh"
                isDark={false}
                onClose={() => {}}
                onComplete={() => {}}
                onOpenTasks={() => {}}
            />,
        );
        expect(html).toContain('aria-labelledby="retirement-title"');
        expect(html).toContain('先在 new-api 撤销本档所属 Key');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认删除分组并撤销所属 Key/);
        expect(network).not.toHaveBeenCalled();
    });

    it.each([false, true])('renders durable task progress and partial revocation honestly (dark=%s)', (isDark) => {
        const current = job({
            status: 'needs_attention',
            summary: { total: 2, confirmed: 1, pending: 0, failed: 1, revoked: 1, already_absent: 0 },
            keys: [
                { ...job().keys[0], status: 'confirmed', message: '已核实。' },
                { ...job().keys[1], status: 'blocked', message: '归属不匹配，未撤销。' },
            ],
        });
        const html = renderToStaticMarkup(<ChannelRetirementJobProgress job={current} isDark={isDark} en={false} />);
        expect(html).toContain('删除任务进度');
        expect(html).toContain('1 / 2');
        expect(html).toContain('归属不匹配，未撤销');
        expect(html).toContain('已撤销的 Key 不会恢复');
        expect(html).toContain('客户余额保持不变');
        expect(html).toContain('保存任务：saved-job');
        expect(html).not.toContain('回滚');
    });

    it('task history renders without starting a deletion or revocation request', () => {
        const network = vi.fn();
        vi.stubGlobal('fetch', network);
        const html = renderToStaticMarkup(
            <ChannelRetirementTasksDialog locale="zh" isDark={false} onClose={() => {}} onOpen={() => {}} />,
        );
        expect(html).toContain('删除任务与遗留 Key');
        expect(html).toContain('需要先预览，再确认清理');
        expect(network).not.toHaveBeenCalled();
    });
});
