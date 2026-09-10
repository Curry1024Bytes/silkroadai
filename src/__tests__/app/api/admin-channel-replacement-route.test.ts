import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const resolveAdmin = vi.fn();
const getChannel = vi.fn();
const listChannels = vi.fn();
const transaction = vi.fn();
const TENANT = '00000000-0000-0000-0000-000000000001';
const date = new Date('2026-09-10T04:00:00Z');
const groupFixture = {
    id: 'cg1',
    tenant_id: TENANT,
    key: 'ccmax',
    display_name: 'CCMax',
    newapi_group: 'CCMax',
    enabled: true,
    is_default: true,
    tier_level: 0,
    newapi_channel_ids: [9, 14],
    updated_at: date,
};
const modelFixture = {
    id: 'm1',
    tenant_id: TENANT,
    slug: 'customer-name',
    display_name: 'Claude',
    enabled: true,
    upstream_map: { ccmax: { channel_id: 9, upstream_model: 'claude-sonnet' } },
    updated_at: date,
};
type Group = typeof groupFixture;
type Model = Omit<typeof modelFixture, 'upstream_map'> & {
    upstream_map: Record<string, { channel_id: number; upstream_model: string }>;
};
type State = { groups: Group[]; models: Model[]; prices: object[]; keys: object[] };
let state: State;
let failWriteAt = 0;
let writes = 0;
let target = {
    id: 14,
    name: 'New CCMax',
    status: 1,
    group: 'CCMax',
    models: 'claude-sonnet',
    key: 'PRIVATE-UPSTREAM-KEY',
};

type Where = { id?: string; tenant_id?: string | null; enabled?: boolean; updated_at?: Date };
function matches(row: Group | Model, where: Where) {
    return Object.entries(where).every(([key, value]) =>
        key === 'updated_at'
            ? row.updated_at.getTime() === (value as Date).getTime()
            : row[key as keyof typeof row] === value,
    );
}
function dbFor(view: State) {
    const update = <T extends Group | Model>(rows: T[], { where, data }: { where: Where; data: Partial<T> }) => {
        writes++;
        if (writes === failWriteAt) throw new Error('injected write failure');
        const row = rows.find((item) => matches(item, where));
        if (!row) throw Object.assign(new Error('row changed'), { code: 'P2025' });
        Object.assign(row, data, { updated_at: new Date(date.getTime() + writes) });
        return Promise.resolve(row);
    };
    return {
        channelGroup: {
            findFirst: async ({ where }: { where: Where }) => view.groups.find((row) => matches(row, where)) ?? null,
            findMany: async ({ where }: { where: Where }) => view.groups.filter((row) => matches(row, where)),
            update: (args: { where: Where; data: Partial<Group> }) => update(view.groups, args),
        },
        catalogModel: {
            findMany: async ({ where }: { where: Where }) => view.models.filter((row) => matches(row, where)),
            update: (args: { where: Where; data: Partial<Model> }) => update(view.models, args),
        },
    };
}
vi.mock('@/lib/db', () => ({
    prisma: {
        channelGroup: {
            findFirst: (args: { where: Where }) => dbFor(state).channelGroup.findFirst(args),
            findMany: (args: { where: Where }) => dbFor(state).channelGroup.findMany(args),
        },
        catalogModel: { findMany: (args: { where: Where }) => dbFor(state).catalogModel.findMany(args) },
        $transaction: (...args: unknown[]) => transaction(...args),
    },
}));
vi.mock('@/lib/admin/auth', () => ({ resolveAdmin: (...args: unknown[]) => resolveAdmin(...args) }));
vi.mock('@/lib/newapi/client', () => ({
    getChannel: (...args: unknown[]) => getChannel(...args),
    listChannels: (...args: unknown[]) => listChannels(...args),
}));

import { GET, POST } from '@/app/api/admin/channel-groups/[id]/replace-channel/route';

const context = { params: Promise.resolve({ id: 'cg1' }) };
function request(body?: object, apply = false) {
    return new NextRequest(`https://x/api/admin/channel-groups/cg1/replace-channel?dryRun=${!apply}`, {
        method: body ? 'POST' : 'GET',
        ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
    });
}
const selection = { source_channel_id: 9, target_channel_id: 14 };
async function preview() {
    const response = await POST(request(selection), context);
    expect(response.status).toBe(200);
    return (await response.json()).preview;
}
async function apply(token: string) {
    return POST(request({ ...selection, preview_token: token }, true), context);
}

beforeEach(() => {
    vi.clearAllMocks();
    failWriteAt = 0;
    writes = 0;
    state = {
        groups: [structuredClone(groupFixture)],
        models: [
            structuredClone(modelFixture),
            { ...structuredClone(modelFixture), id: 'm2', slug: 'disabled-model', enabled: false },
        ],
        prices: [{ id: 'price-history-1', amount: 2, tier: 'ccmax' }],
        keys: [{ id: 'key1', tier: 'ccmax', value: 'CUSTOMER-KEY' }],
    };
    target = {
        id: 14,
        name: 'New CCMax',
        status: 1,
        group: 'CCMax',
        models: 'claude-sonnet',
        key: 'PRIVATE-UPSTREAM-KEY',
    };
    resolveAdmin.mockResolvedValue({ role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true });
    getChannel.mockImplementation(async () => ({ ...target }));
    listChannels.mockImplementation(async () => [{ ...target }]);
    transaction.mockImplementation(async (fn: (tx: ReturnType<typeof dbFor>) => Promise<unknown>) => {
        // Transactional fixture: publish staged changes only on successful commit.
        const draft = structuredClone(state);
        const result = await fn(dbFor(draft));
        state = draft;
        return result;
    });
});

describe('channel replacement — authenticated preview and atomic apply', () => {
    it('requires superadmin before reading channel metadata or writing', async () => {
        resolveAdmin.mockResolvedValue(null);
        expect((await GET(request(), context)).status).toBe(401);
        expect((await POST(request(selection), context)).status).toBe(401);
        expect(resolveAdmin).toHaveBeenCalledWith(expect.anything(), 'superadmin');
        expect(getChannel).not.toHaveBeenCalled();
        expect(listChannels).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
    });

    it('lists missing original IDs from the registry and never exposes upstream credentials', async () => {
        const response = await GET(request(), context);
        const body = await response.json();
        expect(body.group.newapi_channel_ids).toEqual([9, 14]);
        expect(body.channels).toHaveLength(1);
        expect(body.channels[0]).toMatchObject({ id: 14, groups: ['CCMax'], owner: 'ccmax' });
        expect(JSON.stringify(body)).not.toContain('PRIVATE-UPSTREAM-KEY');
        expect(JSON.stringify(body)).not.toContain('CUSTOMER-KEY');
    });

    it('previews the deleted-9 → 14 incident without reading 9, using upstream names and including disabled models', async () => {
        const before = structuredClone(state);
        const plan = await preview();
        expect(plan.canApply).toBe(true);
        expect(plan.next_channel_ids).toEqual([14]);
        expect(plan.models).toHaveLength(2);
        expect(plan.models[0]).toMatchObject({
            slug: 'customer-name',
            upstream_model: 'claude-sonnet',
            supported: true,
        });
        expect(getChannel).toHaveBeenCalledExactlyOnceWith(14);
        expect(transaction).not.toHaveBeenCalled();
        expect(state).toEqual(before);
    });

    it('atomically updates every reference and the registry, preserving other tiers, prices and keys', async () => {
        state.groups.push({
            ...groupFixture,
            id: 'cg2',
            key: 'other',
            newapi_group: 'other',
            is_default: false,
            newapi_channel_ids: [5],
        });
        state.models[0].upstream_map.other = { channel_id: 5, upstream_model: 'other-model' };
        const before = structuredClone(state);
        const plan = await preview();
        const response = await apply(plan.preview_token);
        expect(response.status).toBe(200);
        expect(state.groups[0].newapi_channel_ids).toEqual([14]);
        expect(state.models.map((model) => model.upstream_map.ccmax.channel_id)).toEqual([14, 14]);
        expect(state.models[0].upstream_map.other).toEqual(before.models[0].upstream_map.other);
        for (const model of state.models) {
            const original = before.models.find((item) => item.id === model.id)!;
            expect(model).toEqual({
                ...original,
                updated_at: expect.any(Date),
                upstream_map: { ...original.upstream_map, ccmax: { ...original.upstream_map.ccmax, channel_id: 14 } },
            });
        }
        expect(state.prices).toEqual(before.prices);
        expect(state.keys).toEqual(before.keys);
        expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
            isolationLevel: 'Serializable',
            timeout: 15000,
        });
        expect((await response.json()).dryRun).toBe(false);
    });

    it.each([2, 3])('rolls back all changes if write %i fails (model or final registry)', async (write) => {
        const token = (await preview()).preview_token;
        const before = structuredClone(state);
        failWriteAt = write;
        const response = await apply(token);
        expect(response.status).toBe(500);
        expect(state).toEqual(before);
        expect((await response.json()).error).toBe('replacement_failed');
    });

    it.each(['model', 'registry', 'new-reference', 'target'] as const)(
        'requires a fresh preview after a %s change',
        async (change) => {
            const token = (await preview()).preview_token;
            if (change === 'model') state.models[0].display_name = 'Edited elsewhere';
            if (change === 'registry') state.groups[0].newapi_channel_ids.push(15);
            if (change === 'new-reference') state.models.push({ ...structuredClone(modelFixture), id: 'm3' });
            if (change === 'target') target.models += ',additional-model';
            const before = structuredClone(state);
            const response = await apply(token);
            expect(response.status).toBe(409);
            expect((await response.json()).error).toBe('preview_stale');
            expect(writes).toBe(0);
            expect(state).toEqual(before);
        },
    );

    it.each([
        { patch: { status: 2 }, code: 'target_disabled' },
        { patch: { group: 'default' }, code: 'group_mismatch' },
        { patch: { models: 'customer-name' }, code: 'missing_models' },
    ])('blocks incompatible target: $code', async ({ patch, code }) => {
        Object.assign(target, patch);
        const plan = await preview();
        expect(plan.canApply).toBe(false);
        expect(plan.issues).toContainEqual(expect.objectContaining({ code }));
        expect((await apply(plan.preview_token)).status).toBe(409);
        expect(writes).toBe(0);
    });

    it('rejects a channel owned by another enabled tier', async () => {
        state.groups[0].newapi_channel_ids = [9];
        state.groups.push({
            ...groupFixture,
            id: 'cg2',
            key: 'other',
            newapi_group: 'other',
            is_default: false,
            newapi_channel_ids: [14],
        });
        const plan = await preview();
        expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'channel_already_assigned' }));
        expect(plan.canApply).toBe(false);
    });

    it('allows one of multiple exact groups but never treats default as a wildcard', async () => {
        target.group = 'default, CCMax, other';
        expect((await preview()).canApply).toBe(true);
        target.group = 'default';
        expect((await preview()).canApply).toBe(false);
    });

    it('cannot replace an unregistered source or reapply a completed plan', async () => {
        const token = (await preview()).preview_token;
        expect((await apply(token)).status).toBe(200);
        const before = structuredClone(state);
        expect((await apply(token)).status).toBe(409);
        expect(state).toEqual(before);
        expect((await preview()).issues).toContainEqual(expect.objectContaining({ code: 'source_not_registered' }));
    });

    it('rejects apply without a preview and rejects malformed selection', async () => {
        expect((await POST(request(selection, true), context)).status).toBe(400);
        expect((await POST(request({ source_channel_id: -1, target_channel_id: 14 }), context)).status).toBe(400);
        expect(transaction).not.toHaveBeenCalled();
    });

    it('handles a missing target without revealing the new-api error payload', async () => {
        getChannel.mockRejectedValue(new Error('secret detail'));
        const response = await POST(request(selection), context);
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain('secret detail');
        expect(transaction).not.toHaveBeenCalled();
    });

    it('isolates model/registry migration to the selected group tenant', async () => {
        state.groups.push({ ...groupFixture, id: 'foreign-group', tenant_id: 'other-tenant' });
        state.models.push({ ...structuredClone(modelFixture), id: 'foreign-model', tenant_id: 'other-tenant' });
        const token = (await preview()).preview_token;
        expect((await apply(token)).status).toBe(200);
        expect(state.models.find((model) => model.id === 'foreign-model')?.upstream_map.ccmax.channel_id).toBe(9);
        expect(state.groups.find((group) => group.id === 'foreign-group')?.newapi_channel_ids).toEqual([9, 14]);
        resolveAdmin.mockResolvedValue({ role: 'superadmin', tenant_id: 'other-tenant', user: null });
        expect((await POST(request(selection), context)).status).toBe(200); // superadmin scope is global by contract
    });

    it('returns a retryable preview conflict on transaction serialization failure', async () => {
        const token = (await preview()).preview_token;
        transaction.mockRejectedValue(Object.assign(new Error('serialization'), { code: 'P2034' }));
        const response = await apply(token);
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe('preview_stale');
    });
});
