import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AdminPrincipal } from '@/lib/admin/auth';
import type { ChannelGroupRetirementPreview } from '@/lib/admin/channel-group-retirement-types';

const resolveAdmin = vi.fn();
const channels = vi.fn();
const options = vi.fn();
const guard = vi.fn();
const transaction = vi.fn();
const keyReads = vi.fn();
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...args: unknown[]) => resolveAdmin(...args) }));
vi.mock('@/lib/newapi/client', () => ({
    listChannelsForCatalogSync: (...args: unknown[]) => channels(...args),
    getCatalogSyncOptions: (...args: unknown[]) => options(...args),
}));
vi.mock('@/lib/admin/pricing-publish-lock', async () => ({
    ...(await vi.importActual<typeof import('@/lib/admin/pricing-publish-lock')>('@/lib/admin/pricing-publish-lock')),
    assertPricingCatalogWritable: (...args: unknown[]) => guard(...args),
}));
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';

const TENANT = 'tenant-1';
const date = new Date('2026-09-15T04:00:00Z');
const groupFixture = {
    id: 'old',
    tenant_id: TENANT,
    key: 'old-tier',
    display_name: 'Old tier',
    newapi_group: 'Old upstream',
    enabled: true,
    is_default: false,
    tier_level: 1,
    newapi_channel_ids: [6],
    updated_at: date,
};
const defaultFixture = {
    ...groupFixture,
    id: 'keep',
    key: 'keep-tier',
    display_name: 'Keep tier',
    newapi_group: 'Keep upstream',
    is_default: true,
    newapi_channel_ids: [5],
};
const modelFixture = {
    id: 'm1',
    tenant_id: TENANT,
    slug: 'gpt-shared',
    display_name: 'GPT shared',
    enabled: true,
    upstream_map: {
        'old-tier': { channel_id: 6, upstream_model: 'gpt-old' },
        'keep-tier': { channel_id: 5, upstream_model: 'gpt-keep', preserved_extension: true },
    },
    updated_at: date,
};
type Group = typeof groupFixture;
type Model = Omit<typeof modelFixture, 'upstream_map'> & { upstream_map: Record<string, unknown> };
type Key = {
    id: string;
    user_id: string;
    newapi_token_id: number;
    tier: string;
    status: string;
    user: { tenant_id: string };
    newapi_token_value: string;
};
type State = {
    groups: Group[];
    models: Model[];
    keys: Key[];
    prices: object[];
    costs: object[];
    audit: object[];
    users: object[];
    multipliers: object[];
};
let state: State;
let writes: string[];
let failAt: number;
const admin: AdminPrincipal = { role: 'superadmin', user: null, tenant_id: null, viaBreakGlass: true };
type Where = { id?: string; tenant_id?: string | null; enabled?: boolean; is_default?: boolean; updated_at?: Date };
function matches(row: Group | Model, where: Where) {
    return Object.entries(where).every(([key, value]) =>
        key === 'updated_at'
            ? row.updated_at.getTime() === (value as Date).getTime()
            : row[key as keyof typeof row] === value,
    );
}
function dbFor(view: State) {
    const mutate = (kind: string) => {
        writes.push(kind);
        if (writes.length === failAt) throw new Error('SECRET-DB-FAILURE');
    };
    const update = <T extends Group | Model>(
        rows: T[],
        kind: string,
        { where, data }: { where: Where; data: Partial<T> },
    ) => {
        mutate(kind);
        const row = rows.find((item) => matches(item, where));
        if (!row) throw Object.assign(new Error('changed'), { code: 'P2025' });
        Object.assign(row, data, { updated_at: new Date(date.getTime() + writes.length) });
        // Simulate the production immediate unique partial index.
        if (view.groups.filter((g) => g.enabled && g.is_default && g.tenant_id === TENANT).length > 1)
            throw new Error('default unique index violation');
        return Promise.resolve(row);
    };
    return {
        channelGroup: {
            findFirst: async ({ where }: { where: Where }) => view.groups.find((row) => matches(row, where)) ?? null,
            findMany: async ({ where }: { where: Where }) => view.groups.filter((row) => matches(row, where)),
            update: (args: { where: Where; data: Partial<Group> }) => update(view.groups, 'group.update', args),
            updateMany: async ({ where, data }: { where: Where; data: Partial<Group> }) => {
                mutate('group.updateMany');
                const rows = view.groups.filter((row) => matches(row, where));
                rows.forEach((row) => Object.assign(row, data));
                return { count: rows.length };
            },
            delete: async ({ where }: { where: Where }) => {
                mutate('group.delete');
                const index = view.groups.findIndex((row) => matches(row, where));
                if (index < 0) throw Object.assign(new Error('changed'), { code: 'P2025' });
                return view.groups.splice(index, 1)[0];
            },
        },
        catalogModel: {
            findMany: async ({ where }: { where: Where }) => view.models.filter((row) => matches(row, where)),
            update: (args: { where: Where; data: Partial<Model> }) => update(view.models, 'model.update', args),
        },
        newApiToken: {
            findMany: async (args: {
                where: { tier: string; user: { tenant_id: string | null } };
                select: Record<string, boolean>;
            }) => {
                keyReads(args);
                return view.keys
                    .filter((row) => row.tier === args.where.tier && row.user.tenant_id === args.where.user.tenant_id)
                    .map(({ id, user_id, newapi_token_id, tier, status }) => ({
                        id,
                        user_id,
                        newapi_token_id,
                        tier,
                        status,
                    }));
            },
        },
    };
}
vi.mock('@/lib/db', () => ({
    prisma: {
        channelGroup: {
            findFirst: (...args: Parameters<ReturnType<typeof dbFor>['channelGroup']['findFirst']>) =>
                dbFor(state).channelGroup.findFirst(...args),
            findMany: (...args: Parameters<ReturnType<typeof dbFor>['channelGroup']['findMany']>) =>
                dbFor(state).channelGroup.findMany(...args),
        },
        catalogModel: {
            findMany: (...args: Parameters<ReturnType<typeof dbFor>['catalogModel']['findMany']>) =>
                dbFor(state).catalogModel.findMany(...args),
        },
        newApiToken: {
            findMany: (...args: Parameters<ReturnType<typeof dbFor>['newApiToken']['findMany']>) =>
                dbFor(state).newApiToken.findMany(...args),
        },
        $transaction: (...args: unknown[]) => transaction(...args),
    },
}));
import { POST } from '@/app/api/admin/channel-groups/[id]/retire/route';

function request(body: unknown) {
    return new NextRequest('https://llmroute.club/api/admin/channel-groups/old/retire', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
}
const context = { params: Promise.resolve({ id: 'old' }) };
async function preview(replacement_default_id?: string | null): Promise<ChannelGroupRetirementPreview> {
    const response = await POST(request({ action: 'preview', replacement_default_id }), context);
    expect(response.status).toBe(200);
    return (await response.json()).preview;
}
async function apply(plan: ChannelGroupRetirementPreview, extra = {}) {
    return POST(
        request({
            action: 'apply',
            preview_token: plan.preview_token,
            replacement_default_id: plan.replacement_default_id,
            ...extra,
        }),
        context,
    );
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PORTAL_JWT_SECRET', 'retirement-test-secret-with-more-than-32-characters');
    writes = [];
    failAt = 0;
    state = {
        groups: structuredClone([groupFixture, defaultFixture]),
        models: [
            structuredClone(modelFixture),
            {
                ...structuredClone(modelFixture),
                id: 'm2',
                slug: 'gpt-only',
                upstream_map: { 'old-tier': { channel_id: 6, upstream_model: 'gpt-only' } },
            },
            {
                ...structuredClone(modelFixture),
                id: 'm3',
                slug: 'disabled-only',
                enabled: false,
                upstream_map: { 'old-tier': { channel_id: 6, upstream_model: 'disabled' } },
            },
        ],
        keys: [
            {
                id: 'key1',
                user_id: 'user1',
                newapi_token_id: 22,
                tier: 'old-tier',
                status: 'active',
                user: { tenant_id: TENANT },
                newapi_token_value: 'CUSTOMER-SECRET',
            },
        ],
        prices: [{ id: 'history1', tier: 'old-tier', amount: 1 }],
        costs: [{ id: 'cost1', tier: 'old-tier', revision: 8 }],
        audit: [{ id: 'old-audit' }],
        users: [{ id: 'user1', allowed_tier_keys: ['old-tier'] }],
        multipliers: [{ id: 'multiplier1', newapi_billing_group: 'Old upstream', enabled: true, ratio: 0.9 }],
    };
    resolveAdmin.mockResolvedValue(admin);
    channels.mockResolvedValue([]);
    options.mockResolvedValue({ UserUsableGroups: '{}', GroupRatio: '{}' });
    guard.mockResolvedValue(undefined);
    transaction.mockImplementation(async (fn: (tx: ReturnType<typeof dbFor>) => Promise<unknown>) => {
        const draft = structuredClone(state);
        const result = await fn(dbFor(draft));
        state = draft;
        return result;
    });
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
});

describe('one-step Portal group retirement', () => {
    it('requires superadmin and locates the selected tenant before any source reads', async () => {
        resolveAdmin.mockResolvedValue(null);
        expect((await POST(request({ action: 'preview' }), context)).status).toBe(401);
        expect(resolveAdmin).toHaveBeenCalledWith(expect.anything(), 'superadmin');
        expect(channels).not.toHaveBeenCalled();
        expect(keyReads).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
    });
    it('returns 404 before source reads when the selected group is absent', async () => {
        state.groups = [defaultFixture];
        expect((await POST(request({ action: 'preview' }), context)).status).toBe(404);
        expect(channels).not.toHaveBeenCalled();
        expect(options).not.toHaveBeenCalled();
    });
    it.each([{}, { action: 'delete' }, { action: 'apply' }, { action: 'preview', delete_keys: true }])(
        'rejects incomplete or extra action fields',
        async (body) => {
            expect((await POST(request(body), context)).status).toBe(400);
            expect(channels).not.toHaveBeenCalled();
            expect(transaction).not.toHaveBeenCalled();
        },
    );
    it('previews all affected models without writes or reading credentials', async () => {
        const before = structuredClone(state);
        const plan = await preview();
        expect(plan.canApply).toBe(true);
        expect(plan.models).toEqual([
            expect.objectContaining({
                id: 'm1',
                was_enabled: true,
                will_disable: false,
                remaining_tiers: ['keep-tier'],
            }),
            expect.objectContaining({ id: 'm2', was_enabled: true, will_disable: true, remaining_tiers: [] }),
            expect.objectContaining({ id: 'm3', was_enabled: false, will_disable: false, remaining_tiers: [] }),
        ]);
        expect(plan.existing_keys).toEqual({ active: 1, total: 1 });
        expect(plan.upstream.status).toBe('missing');
        expect(writes).toEqual([]);
        expect(transaction).not.toHaveBeenCalled();
        expect(state).toEqual(before);
        expect(keyReads.mock.calls[0][0].select).not.toHaveProperty('newapi_token_value');
        expect(JSON.stringify(plan)).not.toContain('CUSTOMER-SECRET');
    });
    it('removes only this tier, automatically unlists models without routes, and keeps histories and keys', async () => {
        const before = structuredClone(state);
        const result = await apply(await preview());
        expect(result.status).toBe(200);
        expect((await result.json()).result).toMatchObject({
            updated_models: 3,
            disabled_models: 1,
            existing_keys: { active: 1, total: 1 },
        });
        expect(state.groups).toEqual([before.groups[1]]);
        expect(state.models).toHaveLength(3);
        expect(state.models[0].upstream_map).toEqual({ 'keep-tier': modelFixture.upstream_map['keep-tier'] });
        expect(state.models.map((row) => row.enabled)).toEqual([true, false, false]);
        expect(state.models[1].upstream_map).toEqual({});
        expect(state.models[2].upstream_map).toEqual({});
        expect(state.prices).toEqual(before.prices);
        expect(state.costs).toEqual(before.costs);
        expect(state.keys).toEqual(before.keys);
        expect(state.audit).toEqual(before.audit);
        expect(state.users).toEqual(before.users);
        expect(state.multipliers).toEqual(before.multipliers);
        expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
            isolationLevel: 'Serializable',
            timeout: 15000,
        });
        expect(guard).toHaveBeenCalledOnce();
    });
    it('cleans old tier keys even in malformed disabled references without disturbing other fields', async () => {
        state.models[2].upstream_map = { 'old-tier': null, dormant: { custom: 1 } };
        expect((await apply(await preview())).status).toBe(200);
        expect(state.models[2].upstream_map).toEqual({ dormant: { custom: 1 } });
        expect(state.models[2].enabled).toBe(false);
    });
    it('selects the sole legal replacement default and respects the immediate unique index', async () => {
        state.groups[0].is_default = true;
        state.groups[1].is_default = false;
        const plan = await preview();
        expect(plan.replacement_default_id).toBe('keep');
        expect(plan.canApply).toBe(true);
        const response = await apply(plan);
        expect(response.status).toBe(200);
        expect((await response.json()).result.replacement_default_name).toBe('Keep tier');
        expect(state.groups[0].is_default).toBe(true);
        expect(writes.indexOf('group.delete')).toBeLessThan(writes.indexOf('group.update'));
    });
    it('requires an explicit replacement when multiple legal default candidates exist', async () => {
        state.groups[0].is_default = true;
        state.groups[1].is_default = false;
        state.groups.push({
            ...defaultFixture,
            id: 'other',
            key: 'other-tier',
            newapi_group: 'other',
            newapi_channel_ids: [8],
            is_default: false,
        });
        const plan = await preview();
        expect(plan.canApply).toBe(false);
        expect(plan.issues[0].code).toBe('replacement_default_required');
        expect((await apply(plan)).status).toBe(409);
        expect(writes).toHaveLength(0);
        const selected = await preview('other');
        expect(selected.canApply).toBe(true);
        expect((await apply(selected)).status).toBe(200);
        expect(state.groups.find((row) => row.id === 'other')?.is_default).toBe(true);
    });
    it('blocks deleting the last default instead of leaving an unusable topology', async () => {
        state.groups = [{ ...groupFixture, is_default: true }];
        state.models = [state.models[1]];
        const plan = await preview();
        expect(plan.canApply).toBe(false);
        expect(plan.issues[0].code).toBe('replacement_default_unavailable');
        expect((await apply(plan)).status).toBe(409);
        expect(writes).toHaveLength(0);
    });
    it('rejects a disabled or foreign default replacement without changing the chosen default', async () => {
        state.groups[0].is_default = true;
        state.groups[1].is_default = false;
        state.groups.push({ ...defaultFixture, id: 'foreign-default', tenant_id: 'tenant-2' });
        const plan = await preview('foreign-default');
        expect(plan.canApply).toBe(false);
        expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'replacement_default_invalid' }));
        expect((await apply(plan)).status).toBe(409);
        expect(writes).toHaveLength(0);
        const legitimate = await preview('keep');
        state.groups[1].enabled = false;
        const response = await apply(legitimate);
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('preview_stale');
        expect(writes).toHaveLength(0);
    });
    it('does not silently repair unrelated invalid enabled mappings', async () => {
        state.models[0].upstream_map['keep-tier'] = { channel_id: 999, upstream_model: 'broken' };
        const plan = await preview();
        expect(plan.canApply).toBe(false);
        expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'invalid_model_mapping' }));
        expect((await apply(plan)).status).toBe(409);
        expect(writes).toHaveLength(0);
    });
    it('scopes model cleanup, candidate selection and key counts to the selected tenant', async () => {
        const before = structuredClone(state);
        state.models.push({ ...modelFixture, id: 'other-model', tenant_id: 'tenant-2' });
        state.groups.push({ ...groupFixture, id: 'other-group', tenant_id: 'tenant-2', is_default: true });
        state.keys.push({ ...state.keys[0], id: 'other-key', user_id: 'other-user', user: { tenant_id: 'tenant-2' } });
        const otherBefore = structuredClone([state.models[3], state.groups[2], state.keys[1]]);
        const plan = await preview();
        expect(plan.models).toHaveLength(3);
        expect(plan.existing_keys).toEqual({ active: 1, total: 1 });
        expect(plan.default_candidates.map((row) => row.id)).toEqual(['keep']);
        expect((await apply(plan)).status).toBe(200);
        expect([state.models[3], state.groups[1], state.keys[1]]).toEqual(otherBefore);
        expect(state.keys[0]).toEqual(before.keys[0]);
        for (const [args] of keyReads.mock.calls)
            expect(args.where).toEqual({ tier: 'old-tier', user: { tenant_id: TENANT } });
    });
    it.each(['present', 'unknown'] as const)(
        'keeps %s upstream status as a warning, never writes to new-api',
        async (status) => {
            if (status === 'present')
                options.mockResolvedValue({ UserUsableGroups: '{"Old upstream":"@hidden"}', GroupRatio: '{}' });
            else channels.mockRejectedValue(new Error('PRIVATE-CONNECTION-FAILURE'));
            const plan = await preview();
            expect(plan.upstream.status).toBe(status);
            expect(plan.canApply).toBe(true);
            expect((await apply(plan)).status).toBe(200);
            expect(channels).toHaveBeenCalledTimes(2);
            expect(options).toHaveBeenCalledTimes(2);
        },
    );
    it('does not access the network inside the mutation transaction', async () => {
        const plan = await preview();
        transaction.mockImplementation(async (fn: (tx: ReturnType<typeof dbFor>) => Promise<unknown>) => {
            channels.mockImplementation(() => {
                throw new Error('network during transaction');
            });
            options.mockImplementation(() => {
                throw new Error('network during transaction');
            });
            return fn(dbFor(structuredClone(state)));
        });
        expect((await apply(plan)).status).toBe(200);
    });
    it('respects an active pricing publication before any model or group writes', async () => {
        const plan = await preview();
        guard.mockRejectedValue(new PricingPublishError('pricing_publish_busy', '价格发布中'));
        expect((await apply(plan)).status).toBe(409);
        expect(writes).toHaveLength(0);
    });
    it.each(['model', 'group', 'new-reference', 'key-id', 'key-state', 'upstream', 'updated-at'] as const)(
        'requires a fresh preview after %s changes, including equal counts',
        async (kind) => {
            const plan = await preview();
            if (kind === 'model') state.models[0].display_name = 'changed';
            if (kind === 'group') state.groups[0].newapi_channel_ids = [7];
            if (kind === 'new-reference') state.models.push({ ...modelFixture, id: 'new-model' });
            if (kind === 'key-id') state.keys[0].id = 'different-key';
            if (kind === 'key-state') state.keys[0].status = 'disabled';
            if (kind === 'upstream')
                options.mockResolvedValue({ UserUsableGroups: '{"Old upstream":"exists"}', GroupRatio: '{}' });
            if (kind === 'updated-at') state.groups[0].updated_at = new Date(date.getTime() + 1000);
            const before = structuredClone(state);
            const response = await apply(plan);
            expect(response.status).toBe(409);
            expect((await response.json()).error).toBe('preview_stale');
            expect(writes).toHaveLength(0);
            expect(state).toEqual(before);
        },
    );
    it('detects a group rename during the source read before issuing a misleading preview', async () => {
        options.mockImplementation(async () => {
            state.groups[0].newapi_group = 'Renamed';
            return { UserUsableGroups: '{}', GroupRatio: '{}' };
        });
        const response = await POST(request({ action: 'preview' }), context);
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('preview_stale');
    });
    it.each(['actor', 'tenant', 'tamper', 'role', 'breakGlass'] as const)(
        'rejects a preview token after %s substitution',
        async (kind) => {
            const plan = await preview();
            if (kind === 'actor') resolveAdmin.mockResolvedValue({ ...admin, user: { id: 'other-admin' } });
            if (kind === 'tenant') resolveAdmin.mockResolvedValue({ ...admin, tenant_id: 'other-tenant' });
            if (kind === 'role') resolveAdmin.mockResolvedValue({ ...admin, role: 'admin', tenant_id: TENANT });
            if (kind === 'breakGlass') resolveAdmin.mockResolvedValue({ ...admin, viaBreakGlass: false });
            const response = await apply(plan, kind === 'tamper' ? { preview_token: plan.preview_token + 'X' } : {});
            expect(response.status).toBe(400);
            expect((await response.json()).error).toBe('preview_invalid');
            expect(writes).toHaveLength(0);
        },
    );
    it('expires the signed preview after ten minutes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(date);
        const plan = await preview();
        vi.setSystemTime(new Date(date.getTime() + 600_000));
        const response = await apply(plan);
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('preview_expired');
        expect(writes).toHaveLength(0);
    });
    it('fails closed when the preview signing secret is unavailable', async () => {
        vi.stubEnv('PORTAL_JWT_SECRET', '');
        const response = await POST(request({ action: 'preview' }), context);
        expect(response.status).toBe(503);
        expect((await response.json()).error).toBe('retirement_unavailable');
        expect(writes).toHaveLength(0);
    });
    it.each([1, 2, 3, 4, 5, 6])('rolls back every model/default change when mutation %i fails', async (at) => {
        state.groups[0].is_default = true;
        state.groups[1].is_default = false;
        const plan = await preview();
        const before = structuredClone(state);
        failAt = at;
        const response = await apply(plan);
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe('retirement_failed');
        expect(JSON.stringify(body)).not.toContain('SECRET');
        expect(state).toEqual(before);
    });
    it('maps serialization conflicts to a new-preview response', async () => {
        const plan = await preview();
        transaction.mockRejectedValue(Object.assign(new Error('serialization'), { code: 'P2034' }));
        const response = await apply(plan);
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('preview_stale');
        expect(writes).toHaveLength(0);
    });
    it('cannot replay a committed deletion', async () => {
        const plan = await preview();
        expect((await apply(plan)).status).toBe(200);
        const before = structuredClone(state);
        expect((await apply(plan)).status).toBe(404);
        expect(state).toEqual(before);
    });
});
