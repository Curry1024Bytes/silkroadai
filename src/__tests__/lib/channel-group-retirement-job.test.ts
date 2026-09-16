import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminPrincipal } from '@/lib/admin/auth';
const remote = vi.hoisted(() => ({
    source: vi.fn(),
    inspect: vi.fn(),
    revoke: vi.fn(),
    absent: vi.fn(),
    discover: vi.fn(),
    absentStored: vi.fn(),
    guard: vi.fn(),
    mutex: vi.fn(),
}));
vi.mock('@/lib/admin/channel-group-retirement-source', () => ({ readChannelGroupRetirementSource: remote.source }));
vi.mock('@/lib/newapi/token-revocation', async () => ({
    ...(await vi.importActual<typeof import('@/lib/newapi/token-revocation')>('@/lib/newapi/token-revocation')),
    inspectCustomerTokenForRevocation: remote.inspect,
    revokeVerifiedCustomerToken: remote.revoke,
    confirmPreviouslyAbsentCustomerToken: remote.absent,
    inspectStoredCustomerToken: remote.discover,
    confirmAbsentStoredCustomerToken: remote.absentStored,
}));
vi.mock('@/lib/admin/pricing-publish-lock', async () => ({
    ...(await vi.importActual<typeof import('@/lib/admin/pricing-publish-lock')>('@/lib/admin/pricing-publish-lock')),
    assertPricingCatalogWritable: remote.guard,
    lockPricingPublisher: remote.mutex,
}));
type Row = Record<string, unknown>;
type Table =
    'channelGroup' | 'catalogModel' | 'newApiToken' | 'channelGroupRetirementJob' | 'channelGroupRetirementKey';
type State = Record<Table, Row[]>;
let state: State;
let transactions = 0;
let failTransaction = 0;
let nextId = 0;
let transactional = false;
const date = new Date('2026-09-16T01:00:00Z');
const PLATFORM = '00000000-0000-0000-0000-000000000001';
const tenant = 'tenant-a';
const asRow = (value: unknown) => value as Row;
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'OR') return (value as Row[]).some((filter) => matches(row, filter));
        const actual = row[key];
        if (value instanceof Date) return actual instanceof Date && actual.getTime() === value.getTime();
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const filter = asRow(value);
            if ('not' in filter) return actual !== filter.not;
            if ('in' in filter) return (filter.in as unknown[]).includes(actual);
            if ('notIn' in filter) return !(filter.notIn as unknown[]).includes(actual);
            return actual != null && matches(asRow(actual), filter);
        }
        return actual === value;
    });
}
function dbFor(view: State) {
    return Object.fromEntries(
        Object.entries(view).map(([name, rows]) => {
            const get = (where: Row = {}) => rows.filter((row) => matches(row, where));
            const update = ({ where, data }: { where: Row; data: Row }) => {
                const row = get(where)[0];
                if (!row) throw Object.assign(new Error('missing'), { code: 'P2025' });
                for (const [key, value] of Object.entries(data)) {
                    row[key] =
                        value && typeof value === 'object' && 'increment' in value
                            ? Number(row[key] ?? 0) + Number(value.increment)
                            : value;
                }
                row.updated_at = new Date();
                return row;
            };
            const create = ({ data }: { data: Row }) => {
                const row = {
                    id: `generated-${++nextId}`,
                    created_at: new Date(),
                    updated_at: new Date(),
                    runner_token: null,
                    lease_until: null,
                    result: null,
                    attempts: 0,
                    delete_started_at: null,
                    confirmed_at: null,
                    verified_remote: null,
                    ...data,
                };
                rows.push(row);
                return row;
            };
            return [
                name,
                {
                    findFirst: async ({ where }: { where?: Row } = {}) => get(where)[0] ?? null,
                    findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Row | Row[] } = {}) => {
                        const result = [...get(where)];
                        const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
                        return result.sort((a, b) => {
                            for (const item of order)
                                for (const [field, direction] of Object.entries(item)) {
                                    const left = a[field] as string | number;
                                    const right = b[field] as string | number;
                                    if (left !== right)
                                        return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1);
                                }
                            return 0;
                        });
                    },
                    create: async (args: { data: Row }) => create(args),
                    createMany: async ({ data }: { data: Row[] }) => {
                        data.forEach((entry) => create({ data: entry }));
                        return { count: data.length };
                    },
                    update: async (args: { where: Row; data: Row }) => update(args),
                    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                        const found = get(where);
                        found.forEach((row) => update({ where: { id: row.id }, data }));
                        return { count: found.length };
                    },
                    delete: async ({ where }: { where: Row }) => {
                        const row = get(where)[0];
                        if (!row) throw new Error('missing');
                        rows.splice(rows.indexOf(row), 1);
                        return row;
                    },
                },
            ];
        }),
    );
}
vi.mock('@/lib/db', () => ({
    prisma: new Proxy(
        {},
        {
            get: (_target, property) => {
                if (property === '$transaction')
                    return async (fn: (tx: ReturnType<typeof dbFor>) => Promise<unknown>) => {
                        transactions++;
                        if (transactions === failTransaction) throw new Error('PRIVATE-DB-ERROR');
                        const draft = structuredClone(state);
                        transactional = true;
                        try {
                            const result = await fn(dbFor(draft));
                            state = draft;
                            return result;
                        } finally {
                            transactional = false;
                        }
                    };
                return dbFor(state)[String(property)];
            },
        },
    ),
}));
import {
    previewRetirementJob,
    previewOrphanRetirementJob,
    startRetirementJob,
    resumeRetirementJob,
    getRetirementJob,
    listRetirementJobs,
    stopRetirementJob,
} from '@/lib/admin/channel-group-retirement-job';
import { TokenRevocationError } from '@/lib/newapi/token-revocation';
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';
const admin: AdminPrincipal = { role: 'superadmin', tenant_id: null, user: null, viaBreakGlass: true };
const selection = { groupId: 'old', tenantId: tenant, tierKey: 'old-tier', newapiGroup: 'Old group' };
const key = () => state.newApiToken.find((row) => row.id === 'key-old')!;
const job = () => state.channelGroupRetirementJob[0];
const item = () => state.channelGroupRetirementKey[0];
const metadata = { id: 71, user_id: 11, group: 'Old group', status: 1 };
async function start() {
    const preview = await previewRetirementJob(selection, admin);
    expect(preview.canApply).toBe(true);
    return startRetirementJob(selection, admin, preview.preview_token);
}
beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(date);
    vi.stubEnv('PORTAL_JWT_SECRET', 'test-retirement-long-signing-secret-more-than-32');
    transactions = 0;
    failTransaction = 0;
    nextId = 0;
    transactional = false;
    const group = {
        id: 'old',
        tenant_id: tenant,
        key: 'old-tier',
        display_name: 'Old',
        newapi_group: 'Old group',
        newapi_channel_ids: [6],
        is_default: false,
        enabled: true,
        tier_level: 1,
        updated_at: date,
    };
    state = {
        channelGroup: [
            group,
            {
                ...group,
                id: 'keep',
                key: 'keep-tier',
                display_name: 'Keep',
                newapi_group: 'Keep group',
                newapi_channel_ids: [5],
                is_default: true,
            },
        ],
        catalogModel: [
            {
                id: 'shared',
                tenant_id: tenant,
                slug: 'shared',
                display_name: 'Shared',
                enabled: true,
                upstream_map: {
                    'old-tier': { channel_id: 6, upstream_model: 'gpt' },
                    'keep-tier': { channel_id: 5, upstream_model: 'gpt' },
                },
                updated_at: date,
            },
            {
                id: 'only',
                tenant_id: tenant,
                slug: 'only',
                display_name: 'Only',
                enabled: true,
                upstream_map: { 'old-tier': { channel_id: 6, upstream_model: 'gpt' } },
                updated_at: date,
            },
        ],
        newApiToken: [
            {
                id: 'key-old',
                user_id: 'customer',
                newapi_token_id: 71,
                newapi_token_value: 'sk-PRIVATE-CREDENTIAL',
                key_alias: 'Customer key',
                tier: 'old-tier',
                status: 'active',
                user: {
                    id: 'customer',
                    tenant_id: tenant,
                    newapi_user_id: 11,
                    newapi_access_token: 'PRIVATE-OWNER-TOKEN',
                    allowed_tier_keys: ['old-tier'],
                },
            },
            {
                id: 'key-other',
                user_id: 'other',
                newapi_token_id: 72,
                newapi_token_value: 'sk-OTHER',
                key_alias: 'Other',
                tier: 'old-tier',
                status: 'active',
                user: { id: 'other', tenant_id: 'tenant-b', newapi_user_id: 12, newapi_access_token: 'OTHER-OWNER' },
            },
        ],
        channelGroupRetirementJob: [],
        channelGroupRetirementKey: [],
    };
    remote.source.mockResolvedValue({
        group_name: 'Old group',
        upstream: { status: 'missing', message: 'source' },
        snapshot: {},
    });
    remote.inspect.mockImplementation(async () => {
        expect(transactional).toBe(false);
        return { state: 'present', token: metadata };
    });
    remote.absent.mockResolvedValue({ state: 'already_absent' });
    remote.discover.mockImplementation(async (_auth, target) => {
        expect(transactional).toBe(false);
        return { state: 'present', token: { ...metadata, id: target.tokenId, user_id: target.ownerId } };
    });
    remote.absentStored.mockImplementation(async () => {
        expect(transactional).toBe(false);
        return { state: 'already_absent' };
    });
    remote.revoke.mockImplementation(async (_auth, _target, _verified, _credential, beforeDelete) => {
        expect(transactional).toBe(false);
        await beforeDelete();
        return { state: 'revoked', confirmation: 'deleted', deleteAcknowledged: true };
    });
    remote.guard.mockResolvedValue(undefined);
    remote.mutex.mockResolvedValue(undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('durable customer Key revocation retirement jobs', () => {
    function addLegacyPlatformKey() {
        const legacy = structuredClone(key());
        legacy.id = 'key-null';
        legacy.user_id = 'legacy-customer';
        legacy.newapi_token_id = 73;
        legacy.newapi_token_value = 'sk-LEGACY-CREDENTIAL';
        legacy.user = { ...asRow(legacy.user), id: 'legacy-customer', tenant_id: null, newapi_user_id: 23 };
        state.newApiToken.push(legacy);
        return legacy;
    }

    function makePlatformSelection() {
        for (const group of state.channelGroup) group.tenant_id = PLATFORM;
        for (const model of state.catalogModel) model.tenant_id = PLATFORM;
        asRow(key().user).tenant_id = PLATFORM;
        remote.inspect.mockImplementation(async (_auth, target) => ({
            state: 'present',
            token: { ...metadata, id: target.tokenId, user_id: target.ownerId, group: target.group },
        }));
        return { ...selection, tenantId: PLATFORM };
    }

    it('includes legacy null customer keys in platform preview, execution and final counts without crossing tenants', async () => {
        const platformSelection = makePlatformSelection();
        addLegacyPlatformKey();
        const foreignModel = { ...structuredClone(state.catalogModel[0]), id: 'foreign-model', tenant_id: 'tenant-b' };
        state.catalogModel.push(foreignModel);
        const preview = await previewRetirementJob(platformSelection, admin);
        expect(preview.existing_keys).toEqual({ total: 2, active: 2 });
        expect(preview.revocation?.keys.map((entry) => entry.id)).toEqual(['key-null', 'key-old']);
        const created = await startRetirementJob(platformSelection, admin, preview.preview_token);
        await resumeRetirementJob(created.id, admin);
        await resumeRetirementJob(created.id, admin);
        const done = await resumeRetirementJob(created.id, admin);
        expect(done.status).toBe('succeeded');
        expect(done.result?.existing_keys).toEqual({ total: 2, active: 2 });
        expect(done.result?.revoked_keys).toBe(2);
        expect(state.newApiToken.find((row) => row.id === 'key-null')?.status).toBe('disabled');
        expect(state.newApiToken.find((row) => row.id === 'key-other')?.status).toBe('active');
        expect(state.catalogModel.find((row) => row.id === 'foreign-model')).toEqual(foreignModel);
    });

    it('does not merge historical null customers into a non-platform tenant retirement', async () => {
        addLegacyPlatformKey();
        const created = await start();
        expect(created.summary.total).toBe(1);
        await resumeRetirementJob(created.id, admin);
        await resumeRetirementJob(created.id, admin);
        expect(state.newApiToken.find((row) => row.id === 'key-null')?.status).toBe('active');
        expect(state.newApiToken.find((row) => row.id === 'key-other')?.status).toBe('active');
    });

    it('recognizes canonical platform registration when listing legacy null user keys', async () => {
        makePlatformSelection();
        addLegacyPlatformKey();
        const listed = await listRetirementJobs({ ...admin, role: 'admin', tenant_id: PLATFORM });
        expect(listed.orphan_groups).toEqual([]);
    });

    it('cannot declare an orphan null tier when the same platform tier is still registered', async () => {
        makePlatformSelection();
        addLegacyPlatformKey();
        await expect(
            previewRetirementJob({ ...selection, groupId: null, tenantId: null }, admin),
        ).rejects.toMatchObject({ code: 'group_exists' });
        expect(remote.inspect).not.toHaveBeenCalled();
    });

    it('blocks a legacy null orphan from targeting a different canonical platform group', async () => {
        makePlatformSelection();
        addLegacyPlatformKey();
        state.channelGroup = state.channelGroup.filter((row) => row.id !== 'old');
        await expect(
            previewRetirementJob({ ...selection, groupId: null, tenantId: null, newapiGroup: 'Keep group' }, admin),
        ).rejects.toMatchObject({ code: 'group_claimed_by_other_tier' });
        expect(remote.inspect).not.toHaveBeenCalled();
    });

    it('coalesces only platform orphan rows and allows the platform admin to read a historical null job', async () => {
        makePlatformSelection();
        addLegacyPlatformKey();
        state.channelGroup = state.channelGroup.filter((row) => row.id !== 'old');
        const platformAdmin: AdminPrincipal = { ...admin, role: 'admin', tenant_id: PLATFORM };
        const listed = await listRetirementJobs(platformAdmin);
        expect(listed.orphan_groups).toEqual([
            { tenant_id: PLATFORM, tier_key: 'old-tier', key_count: 2, active_key_count: 2 },
        ]);
        const orphan = { ...selection, groupId: null, tenantId: null };
        const preview = await previewRetirementJob(orphan, platformAdmin);
        const created = await startRetirementJob(orphan, platformAdmin, preview.preview_token);
        expect((await getRetirementJob(created.id, platformAdmin)).id).toBe(created.id);
        await expect(getRetirementJob(created.id, { ...platformAdmin, tenant_id: 'tenant-b' })).rejects.toMatchObject({
            code: 'job_not_found',
        });
    });
    it('rejects actor and selection substitution even after a task was already created', async () => {
        const preview = await previewRetirementJob(selection, admin);
        await startRetirementJob(selection, admin, preview.preview_token);
        await expect(
            startRetirementJob(selection, { ...admin, viaBreakGlass: false }, preview.preview_token),
        ).rejects.toMatchObject({ code: 'preview_invalid' });
        await expect(
            startRetirementJob({ ...selection, tierKey: 'other' }, admin, preview.preview_token),
        ).rejects.toMatchObject({ code: 'preview_invalid' });
        expect(state.channelGroupRetirementJob).toHaveLength(1);
    });

    it('fresh previews do not silently reuse a cancelled task even in the same clock tick', async () => {
        const first = await start();
        await stopRetirementJob(first.id, admin);
        const second = await start();
        expect(second.id).not.toBe(first.id);
        expect(second.status).toBe('queued');
    });

    it('includes a key created after preview as stale instead of silently missing its revocation', async () => {
        const preview = await previewRetirementJob(selection, admin);
        state.newApiToken.push({ ...structuredClone(key()), id: 'key-new', newapi_token_id: 99 });
        await expect(startRetirementJob(selection, admin, preview.preview_token)).rejects.toMatchObject({
            code: 'preview_stale',
        });
        expect(state.channelGroupRetirementJob).toHaveLength(0);
        expect(remote.revoke).not.toHaveBeenCalled();
    });

    it('zero-key retirement finalizes locally without any remote DELETE', async () => {
        state.newApiToken = state.newApiToken.filter((row) => row.id !== 'key-old');
        const created = await start();
        expect((await resumeRetirementJob(created.id, admin)).status).toBe('succeeded');
        expect(state.channelGroup).toHaveLength(1);
        expect(remote.revoke).not.toHaveBeenCalled();
    });

    it('keeps the last default group and its keys when there is no valid replacement', async () => {
        state.channelGroup = state.channelGroup.filter((row) => row.id === 'old');
        state.channelGroup[0].is_default = true;
        const preview = await previewRetirementJob(selection, admin);
        expect(preview.canApply).toBe(false);
        await expect(startRetirementJob(selection, admin, preview.preview_token)).rejects.toMatchObject({
            code: 'retirement_blocked',
        });
        expect(remote.revoke).not.toHaveBeenCalled();
    });
    it('previews without writes and never leaks raw customer credentials', async () => {
        const preview = await previewRetirementJob(selection, admin);
        expect(preview.revocation?.keys).toHaveLength(1);
        expect(preview.revocation?.keys[0].status).toBe('ready');
        expect(JSON.stringify(preview)).not.toMatch(/PRIVATE|sk-/);
        expect(remote.revoke).not.toHaveBeenCalled();
        expect(transactions).toBe(0);
    });
    it.each(['present', 'unknown'])(
        'source %s is a warning while independent token ownership is verified',
        async (status) => {
            remote.source.mockResolvedValue({
                group_name: 'Old group',
                upstream: { status, message: 'RAW-SECRET' },
                snapshot: {},
            });
            const preview = await previewRetirementJob(selection, admin);
            expect(preview.canApply).toBe(true);
            expect(preview.upstream.status).toBe(status);
            expect(JSON.stringify(preview)).not.toContain('RAW-SECRET');
        },
    );
    it('blocks incorrect remote group before creating any task', async () => {
        remote.inspect.mockRejectedValue(new TokenRevocationError('group_mismatch', 'inspect', false));
        const preview = await previewRetirementJob(selection, admin);
        expect(preview.canApply).toBe(false);
        expect(preview.revocation?.keys[0].status).toBe('blocked');
        await expect(startRetirementJob(selection, admin, preview.preview_token)).rejects.toMatchObject({
            code: 'retirement_blocked',
        });
        expect(state.channelGroupRetirementJob).toHaveLength(0);
        expect(remote.revoke).not.toHaveBeenCalled();
    });
    it('durably stores only safe identity evidence and hashes before any DELETE', async () => {
        const created = await start();
        expect(created.status).toBe('queued');
        expect(created.summary.total).toBe(1);
        expect(item().verified_remote).toEqual(metadata);
        expect(item().ownership_evidence).toBe('remote_verified');
        expect(item().delete_started_at).toBeNull();
        expect(JSON.stringify(job())).not.toMatch(/PRIVATE|sk-/);
        expect(JSON.stringify(item())).not.toMatch(/PRIVATE|sk-/);
        expect(remote.revoke).not.toHaveBeenCalled();
    });
    it('resumes one key, confirms remote invalidation, then atomically cleans only the selected tenant', async () => {
        const created = await start();
        const originalUser = structuredClone(key().user);
        const first = await resumeRetirementJob(created.id, admin);
        expect(first.summary).toMatchObject({ revoked: 1, already_absent: 0, confirmed: 1 });
        expect(key().status).toBe('disabled');
        expect(key().user).toEqual(originalUser);
        expect(state.newApiToken[1].status).toBe('active');
        expect(state.channelGroup).toHaveLength(2);
        const finished = await resumeRetirementJob(created.id, admin);
        expect(finished.status).toBe('succeeded');
        expect(finished.result?.existing_keys).toEqual({ total: 1, active: 1 });
        expect(state.channelGroup.map((row) => row.id)).toEqual(['keep']);
        expect(state.catalogModel.find((row) => row.id === 'only')?.enabled).toBe(false);
        expect(state.catalogModel.find((row) => row.id === 'shared')?.upstream_map).toEqual({
            'keep-tier': { channel_id: 5, upstream_model: 'gpt' },
        });
        await resumeRetirementJob(created.id, admin);
        expect(remote.revoke).toHaveBeenCalledTimes(1);
    });
    it('uses the existing customer binding for previously absent/disabled keys, separately counted', async () => {
        key().status = 'disabled';
        remote.inspect.mockResolvedValue({ state: 'missing', scope: 'authenticated_owner' });
        const created = await start();
        expect(item().ownership_evidence).toBe('portal_stored_link');
        const finishedKey = await resumeRetirementJob(created.id, admin);
        expect(finishedKey.summary).toMatchObject({ already_absent: 1, revoked: 0 });
        expect(remote.absent).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ tokenId: 71 }),
            expect.objectContaining({ kind: 'portal_stored_link', apiKey: 'sk-PRIVATE-CREDENTIAL' }),
        );
        expect(remote.revoke).not.toHaveBeenCalled();
    });
    it('counts another actor deleting after preview as already absent when no job DELETE was sent', async () => {
        const created = await start();
        remote.revoke.mockResolvedValue({
            state: 'revoked',
            confirmation: 'already_missing',
            deleteAcknowledged: false,
        });
        const result = await resumeRetirementJob(created.id, admin);
        expect(result.summary).toMatchObject({ already_absent: 1, revoked: 0 });
    });
    it('keeps local key and catalogue intact when cache still accepts the credential', async () => {
        const created = await start();
        remote.revoke.mockImplementationOnce(async (_a, _t, _v, _k, beforeDelete) => {
            await beforeDelete();
            throw new TokenRevocationError('credential_still_accepted', 'verify', true);
        });
        const result = await resumeRetirementJob(created.id, admin);
        expect(result.status).toBe('needs_attention');
        expect(result.canStop).toBe(false);
        expect(key().status).toBe('active');
        expect(state.channelGroup).toHaveLength(2);
        expect(result.keys[0].message).toContain('缓存');
        await expect(stopRetirementJob(created.id, admin)).rejects.toMatchObject({ code: 'delete_result_unconfirmed' });
    });
    it('retries an uncertain remote write without losing the original durable deletion evidence', async () => {
        const created = await start();
        remote.revoke.mockImplementationOnce(async (_a, _t, _v, _k, beforeDelete) => {
            await beforeDelete();
            throw new TokenRevocationError('remote_unavailable', 'verify', true);
        });
        await resumeRetirementJob(created.id, admin);
        remote.revoke.mockResolvedValueOnce({
            state: 'revoked',
            confirmation: 'already_missing',
            deleteAcknowledged: false,
        });
        const result = await resumeRetirementJob(created.id, admin);
        expect(result.summary).toMatchObject({ revoked: 1, already_absent: 0 });
        expect(item().attempts).toBe(2);
    });
    it('survives database failure after a remote deletion and resumes from the stored intent', async () => {
        const created = await start();
        failTransaction = transactions + 3;
        const failed = await resumeRetirementJob(created.id, admin);
        expect(failed.status).toBe('needs_attention');
        expect(key().status).toBe('active');
        expect(item().delete_started_at).not.toBeNull();
        remote.revoke.mockResolvedValueOnce({
            state: 'revoked',
            confirmation: 'already_missing',
            deleteAcknowledged: false,
        });
        expect((await resumeRetirementJob(created.id, admin)).summary.revoked).toBe(1);
    });
    it('does not send DELETE after local credential identity changed', async () => {
        const created = await start();
        key().newapi_token_value = 'sk-REPLACED';
        const result = await resumeRetirementJob(created.id, admin);
        expect(result.status).toBe('needs_attention');
        expect(result.canStop).toBe(true);
        expect(remote.revoke).not.toHaveBeenCalled();
    });
    it('rejects inconsistent durable per-key ownership evidence before remote writes', async () => {
        const created = await start();
        item().expected_group = 'Other group';
        expect((await resumeRetirementJob(created.id, admin)).status).toBe('needs_attention');
        expect(remote.revoke).not.toHaveBeenCalled();
    });
    it('prevents expired workers from recording or sending DELETE', async () => {
        const created = await start();
        remote.revoke.mockImplementationOnce(async (_a, _t, _v, _k, beforeDelete) => {
            vi.setSystemTime(new Date(date.getTime() + 65_000));
            await beforeDelete();
            throw new Error('must never reach DELETE');
        });
        const result = await resumeRetirementJob(created.id, admin);
        expect(result.status).toBe('needs_attention');
        expect(item().delete_started_at).toBeNull();
        expect(result.canStop).toBe(true);
    });
    it('an active lease cannot be resumed by a second worker or stopped', async () => {
        const created = await start();
        job().lease_until = new Date(date.getTime() + 60_000);
        job().runner_token = 'another';
        expect((await resumeRetirementJob(created.id, admin)).canResume).toBe(false);
        expect(remote.revoke).not.toHaveBeenCalled();
        await expect(stopRetirementJob(created.id, admin)).rejects.toMatchObject({ code: 'worker_active' });
    });
    it('safe stop releases a no-write blocked task without claiming a rollback', async () => {
        const created = await start();
        remote.revoke.mockRejectedValueOnce(new TokenRevocationError('group_mismatch', 'inspect', false));
        expect((await resumeRetirementJob(created.id, admin)).canStop).toBe(true);
        const stopped = await stopRetirementJob(created.id, admin);
        expect(stopped.status).toBe('cancelled');
        expect(stopped.canResume).toBe(false);
        expect(stopped.canStop).toBe(false);
        expect(key().status).toBe('active');
        expect(state.channelGroup).toHaveLength(2);
    });
    it('safe stop after confirmed partial revocation retains the revocation and all group mappings', async () => {
        const created = await start();
        await resumeRetirementJob(created.id, admin);
        const stopped = await stopRetirementJob(created.id, admin);
        expect(stopped.status).toBe('cancelled');
        expect(stopped.summary.revoked).toBe(1);
        expect(key().status).toBe('disabled');
        expect(state.channelGroup).toHaveLength(2);
        expect(state.catalogModel[1].enabled).toBe(true);
    });
    it('does not remove group/models if finalization sees catalogue changes', async () => {
        const created = await start();
        await resumeRetirementJob(created.id, admin);
        state.catalogModel[0].updated_at = new Date(date.getTime() + 1);
        await expect(resumeRetirementJob(created.id, admin)).rejects.toMatchObject({ code: 'catalog_changed' });
        expect(state.channelGroup).toHaveLength(2);
        expect(key().status).toBe('disabled');
        expect((await stopRetirementJob(created.id, admin)).status).toBe('cancelled');
    });
    it('chooses and applies a valid replacement default after every key is confirmed', async () => {
        state.channelGroup[0].is_default = true;
        state.channelGroup[1].is_default = false;
        const created = await start();
        await resumeRetirementJob(created.id, admin);
        await resumeRetirementJob(created.id, admin);
        expect(state.channelGroup).toHaveLength(1);
        expect(state.channelGroup[0].is_default).toBe(true);
    });
    it('replays the same apply idempotently without duplicating tasks or DELETE calls', async () => {
        const preview = await previewRetirementJob(selection, admin);
        const first = await startRetirementJob(selection, admin, preview.preview_token);
        const second = await startRetirementJob(selection, admin, preview.preview_token);
        expect(second.id).toBe(first.id);
        expect(state.channelGroupRetirementJob).toHaveLength(1);
        expect(remote.revoke).not.toHaveBeenCalled();
    });
    it.each(['time', 'token', 'actor', 'key', 'catalogue'])(
        'rejects stale or substituted preview: %s',
        async (kind) => {
            const preview = await previewRetirementJob(selection, admin);
            if (kind === 'time') vi.setSystemTime(new Date(date.getTime() + 600_000));
            if (kind === 'key') key().newapi_token_value = 'changed';
            if (kind === 'catalogue') state.catalogModel[0].updated_at = new Date(date.getTime() + 1);
            await expect(
                startRetirementJob(
                    selection,
                    kind === 'actor' ? { ...admin, viaBreakGlass: false } : admin,
                    preview.preview_token + (kind === 'token' ? 'X' : ''),
                ),
            ).rejects.toMatchObject({
                code:
                    kind === 'time'
                        ? 'preview_expired'
                        : ['token', 'actor'].includes(kind)
                          ? 'preview_invalid'
                          : 'preview_stale',
            });
            expect(state.channelGroupRetirementJob).toHaveLength(0);
        },
    );
    it('holds the pricing/catalogue mutex before creating or resuming writes', async () => {
        const preview = await previewRetirementJob(selection, admin);
        remote.guard.mockRejectedValue(new PricingPublishError('pricing_publish_busy', 'busy'));
        await expect(startRetirementJob(selection, admin, preview.preview_token)).rejects.toMatchObject({
            code: 'pricing_publish_busy',
        });
        expect(state.channelGroupRetirementJob).toHaveLength(0);
        expect(remote.mutex).toHaveBeenCalled();
    });
    it('rejects a cross-tenant selection before network or key inspection', async () => {
        await expect(
            previewRetirementJob(selection, { ...admin, role: 'admin', tenant_id: 'tenant-b' }),
        ).rejects.toMatchObject({ code: 'group_not_found' });
        expect(remote.source).not.toHaveBeenCalled();
    });
    it('scopes task lookup to the acting tenant', async () => {
        const created = await start();
        await expect(
            getRetirementJob(created.id, { ...admin, role: 'admin', tenant_id: 'tenant-b' }),
        ).rejects.toMatchObject({ code: 'job_not_found' });
    });
    it('lists disabled legacy orphans but excludes only previously verified immutable key bindings', async () => {
        state.channelGroup = state.channelGroup.filter((row) => row.id !== 'old');
        key().status = 'disabled';
        expect(
            (await listRetirementJobs(admin)).orphan_groups.find((entry) => entry.tenant_id === tenant)?.key_count,
        ).toBe(1);
        const orphan = { ...selection, groupId: null };
        remote.inspect.mockResolvedValue({ state: 'missing', scope: 'authenticated_owner' });
        const preview = await previewRetirementJob(orphan, admin);
        const created = await startRetirementJob(orphan, admin, preview.preview_token);
        await resumeRetirementJob(created.id, admin);
        await resumeRetirementJob(created.id, admin);
        expect((await listRetirementJobs(admin)).orphan_groups.some((entry) => entry.tenant_id === tenant)).toBe(false);
        key().newapi_token_value = 'sk-CHANGED';
        expect((await listRetirementJobs(admin)).orphan_groups.some((entry) => entry.tenant_id === tenant)).toBe(true);
    });
    it.each([false, true])(
        'cannot use an orphan or disabled tier to delete keys from another active group (orphan=%s)',
        async (orphan) => {
            if (orphan) state.channelGroup = state.channelGroup.filter((row) => row.id !== 'old');
            else state.channelGroup[0].enabled = false;
            await expect(
                previewRetirementJob(
                    { ...selection, groupId: orphan ? null : 'old', newapiGroup: 'Keep group' },
                    admin,
                ),
            ).rejects.toMatchObject({ code: 'group_claimed_by_other_tier' });
            expect(remote.inspect).not.toHaveBeenCalled();
        },
    );
});

describe('automatic orphan discovery and archive-only jobs', () => {
    const orphanTarget = { tenantId: tenant, tierKey: 'old-tier' };
    const orphanSelection = { ...selection, groupId: null };
    const archiveSelection = { ...orphanSelection, newapiGroup: '', archiveOnly: true };
    function removeGroup() {
        state.channelGroup = state.channelGroup.filter((row) => row.id !== 'old');
    }
    function addSameTenantKey() {
        const second: Row = {
            ...structuredClone(key()),
            id: 'second',
            newapi_token_id: 73,
            newapi_token_value: 'sk-SECOND',
        };
        state.newApiToken.push(second);
        return second;
    }
    function allMissing() {
        remote.discover.mockResolvedValue({ state: 'missing', scope: 'authenticated_owner' });
    }
    async function archiveStart() {
        removeGroup();
        allMissing();
        const preview = await previewOrphanRetirementJob(orphanTarget, admin);
        return startRetirementJob(archiveSelection, admin, preview.preview_token);
    }

    it('automatically shows the one current group without calling it a historic group', async () => {
        removeGroup();
        const preview = await previewOrphanRetirementJob(orphanTarget, admin);
        expect(preview.group.newapi_group).toBe('Old group');
        expect(preview.group_resolution?.source).toBe('current_keys');
        expect(preview.group_resolution?.message).toContain('不证明历史分组');
        expect(preview.canApply).toBe(true);
        expect(remote.discover).toHaveBeenCalledTimes(1);
        expect(remote.revoke).not.toHaveBeenCalled();
        expect(transactions).toBe(0);
        expect(JSON.stringify(preview)).not.toMatch(/PRIVATE|sk-/);
    });

    it('stops if any current group differs rather than choosing the first group', async () => {
        removeGroup();
        addSameTenantKey();
        remote.discover.mockImplementation(async (_auth, target) => ({
            state: 'present',
            token: { ...metadata, id: target.tokenId, group: target.tokenId === 71 ? 'Old group' : 'Moved B' },
        }));
        await expect(previewOrphanRetirementJob(orphanTarget, admin)).rejects.toMatchObject({
            code: 'orphan_groups_conflict',
        });
        expect(remote.inspect).not.toHaveBeenCalled();
        expect(remote.revoke).not.toHaveBeenCalled();
    });

    it.each(['network', 'owner', 'blank', 'untrimmed', 'missing-auth'])(
        'does not guess a group when discovery has %s uncertainty',
        async (kind) => {
            removeGroup();
            if (kind === 'network') remote.discover.mockRejectedValue(new Error('PRIVATE-UPSTREAM'));
            if (kind === 'owner')
                remote.discover.mockRejectedValue(new TokenRevocationError('owner_mismatch', 'inspect', false));
            if (kind === 'blank' || kind === 'untrimmed')
                remote.discover.mockResolvedValue({
                    state: 'present',
                    token: { ...metadata, group: kind === 'blank' ? '' : ' Old group ' },
                });
            if (kind === 'missing-auth') asRow(key().user).newapi_access_token = null;
            const error = await previewOrphanRetirementJob(orphanTarget, admin).catch((error: unknown) => error);
            expect(error).toMatchObject({ code: 'orphan_identity_unverified' });
            expect(JSON.stringify(error)).not.toContain('PRIVATE');
            expect(remote.revoke).not.toHaveBeenCalled();
        },
    );

    it('blocks a uniquely identified group already owned by another enabled Portal tier', async () => {
        removeGroup();
        remote.discover.mockResolvedValue({ state: 'present', token: { ...metadata, group: 'Keep group' } });
        await expect(previewOrphanRetirementJob(orphanTarget, admin)).rejects.toMatchObject({
            code: 'group_claimed_by_other_tier',
        });
        expect(remote.inspect).not.toHaveBeenCalled();
        expect(remote.revoke).not.toHaveBeenCalled();
    });

    it('uses exact key-bound original task history for the explanation and persists it on apply', async () => {
        const original = await start();
        await stopRetirementJob(original.id, admin);
        removeGroup();
        const preview = await previewOrphanRetirementJob(orphanTarget, admin);
        expect(preview.group_resolution?.source).toBe('history');
        const created = await startRetirementJob(orphanSelection, admin, preview.preview_token);
        const plan = asRow(state.channelGroupRetirementJob.find((row) => row.id === created.id)?.plan);
        expect(asRow(plan.initial_preview).group_resolution).toEqual(preview.group_resolution);
        expect(remote.revoke).not.toHaveBeenCalled();
    });

    it('blocks current membership that conflicts with key-bound original group history', async () => {
        const original = await start();
        await stopRetirementJob(original.id, admin);
        removeGroup();
        remote.discover.mockResolvedValue({ state: 'present', token: { ...metadata, group: 'Unregistered B' } });
        await expect(previewOrphanRetirementJob(orphanTarget, admin)).rejects.toMatchObject({
            code: 'orphan_history_conflict',
        });
        expect(remote.revoke).not.toHaveBeenCalled();
    });

    it('does not claim unrelated task keys or another tenant as historical evidence', async () => {
        const original = await start();
        await stopRetirementJob(original.id, admin);
        const foreignHistory = { ...structuredClone(job()), id: 'foreign-history', tenant_id: 'tenant-b' };
        state.channelGroupRetirementJob.push(foreignHistory);
        const plan = asRow(job().plan);
        const saved = (plan.keys as Row[])[0];
        saved.credential_hash = 'not-this-key';
        removeGroup();
        const preview = await previewOrphanRetirementJob(orphanTarget, admin);
        expect(preview.group_resolution?.source).toBe('current_keys');
    });

    it('detects new conflicting history again on apply without trusting the preview label', async () => {
        const original = await start();
        await stopRetirementJob(original.id, admin);
        removeGroup();
        const preview = await previewOrphanRetirementJob(orphanTarget, admin);
        job().newapi_group = 'Conflicting historical group';
        asRow(asRow(job().plan).selection).newapiGroup = 'Conflicting historical group';
        await expect(startRetirementJob(orphanSelection, admin, preview.preview_token)).rejects.toMatchObject({
            code: 'orphan_history_conflict',
        });
        expect(state.channelGroupRetirementJob).toHaveLength(1);
    });

    it('includes legacy null platform keys but never expands into another tenant during discovery', async () => {
        removeGroup();
        asRow(key().user).tenant_id = PLATFORM;
        const legacy = addSameTenantKey();
        asRow(legacy.user).tenant_id = null;
        remote.inspect.mockImplementation(async (_auth, target) => ({
            state: 'present',
            token: { ...metadata, id: target.tokenId, user_id: target.ownerId, group: target.group },
        }));
        const preview = await previewOrphanRetirementJob(
            { ...orphanTarget, tenantId: PLATFORM },
            { ...admin, role: 'admin', tenant_id: PLATFORM },
        );
        expect(preview.revocation?.keys.map((entry) => entry.id)).toEqual(['key-old', 'second']);
        expect(remote.discover.mock.calls.map(([, target]) => target.tokenId)).toEqual([71, 73]);
        await expect(
            previewOrphanRetirementJob(orphanTarget, { ...admin, role: 'admin', tenant_id: PLATFORM }),
        ).rejects.toMatchObject({ code: 'group_not_found' });
    });

    it('rejects a canonical platform registration when the request uses historical null', async () => {
        state.channelGroup[0].tenant_id = PLATFORM;
        asRow(key().user).tenant_id = null;
        await expect(previewOrphanRetirementJob({ ...orphanTarget, tenantId: null }, admin)).rejects.toMatchObject({
            code: 'group_exists',
        });
        expect(remote.discover).not.toHaveBeenCalled();
    });

    it('archives all genuinely missing keys without needing or sending a group or any DELETE', async () => {
        removeGroup();
        allMissing();
        const initialModels = structuredClone(state.catalogModel);
        const preview = await previewOrphanRetirementJob(orphanTarget, admin);
        expect(preview.group.newapi_group).toBeNull();
        expect(preview.revocation).toMatchObject({ archive_only: true, expected_group: null });
        expect(preview.group_resolution?.source).toBe('already_absent');
        const created = await startRetirementJob(archiveSelection, admin, preview.preview_token);
        expect(created).toMatchObject({ archive_only: true, newapi_group: null });
        expect(job().newapi_group).toBe('');
        expect(item()).toMatchObject({ expected_group: '', delete_started_at: null });
        expect(item().verified_remote ?? null).toBeNull();
        const archived = await resumeRetirementJob(created.id, admin);
        expect(archived.summary).toMatchObject({ revoked: 0, already_absent: 1 });
        const finished = await resumeRetirementJob(created.id, admin);
        expect(finished.status).toBe('succeeded');
        expect(finished.result).toMatchObject({
            archive_only: true,
            revoked_keys: 0,
            already_absent_keys: 1,
            updated_models: 0,
            disabled_models: 0,
        });
        expect(key().status).toBe('disabled');
        expect(state.newApiToken.find((row) => row.id === 'key-other')?.status).toBe('active');
        expect(state.catalogModel).toEqual(initialModels);
        expect(remote.source).not.toHaveBeenCalled();
        expect(remote.inspect).not.toHaveBeenCalled();
        expect(remote.absent).not.toHaveBeenCalled();
        expect(remote.revoke).not.toHaveBeenCalled();
        expect(remote.absentStored).toHaveBeenCalledTimes(3);
        expect(remote.absentStored).toHaveBeenLastCalledWith(
            expect.anything(),
            { tokenId: 71, ownerId: 11 },
            expect.objectContaining({ kind: 'portal_stored_link' }),
        );
        expect(JSON.stringify(finished)).not.toMatch(/PRIVATE|sk-/);
    });

    it('blocks archive-only preview if any missing record still has an accepted credential', async () => {
        removeGroup();
        allMissing();
        remote.absentStored.mockRejectedValue(new TokenRevocationError('credential_still_accepted', 'verify', true));
        const preview = await previewOrphanRetirementJob(orphanTarget, admin);
        expect(preview.canApply).toBe(false);
        await expect(startRetirementJob(archiveSelection, admin, preview.preview_token)).rejects.toMatchObject({
            code: 'retirement_blocked',
        });
        expect(remote.revoke).not.toHaveBeenCalled();
    });

    it('rechecks absence on apply and refuses a record that appeared after preview', async () => {
        removeGroup();
        allMissing();
        const preview = await previewOrphanRetirementJob(orphanTarget, admin);
        remote.absentStored.mockRejectedValue(new TokenRevocationError('token_still_present', 'verify', false));
        await expect(startRetirementJob(archiveSelection, admin, preview.preview_token)).rejects.toMatchObject({
            code: 'preview_stale',
        });
        expect(state.channelGroupRetirementJob).toHaveLength(0);
        expect(remote.revoke).not.toHaveBeenCalled();
    });

    it('rechecks absence on resume and never converts a reappeared group B record to DELETE', async () => {
        const created = await archiveStart();
        remote.absentStored.mockRejectedValue(new TokenRevocationError('token_still_present', 'verify', false));
        const result = await resumeRetirementJob(created.id, admin);
        expect(result).toMatchObject({ status: 'needs_attention', canStop: true });
        expect(result.summary).toMatchObject({ revoked: 0, already_absent: 0, failed: 1 });
        expect(key().status).toBe('active');
        expect(item().delete_started_at).toBeNull();
        expect(remote.revoke).not.toHaveBeenCalled();
        expect((await stopRetirementJob(created.id, admin)).status).toBe('cancelled');
    });

    it('binds archive-only mode in the signed preview and in idempotent task replay', async () => {
        removeGroup();
        allMissing();
        remote.inspect.mockResolvedValue({ state: 'missing', scope: 'authenticated_owner' });
        const archivePreview = await previewOrphanRetirementJob(orphanTarget, admin);
        await expect(startRetirementJob(orphanSelection, admin, archivePreview.preview_token)).rejects.toMatchObject({
            code: 'preview_stale',
        });
        const groupedPreview = await previewRetirementJob(orphanSelection, admin);
        await expect(startRetirementJob(archiveSelection, admin, groupedPreview.preview_token)).rejects.toMatchObject({
            code: 'preview_stale',
        });
        const created = await startRetirementJob(archiveSelection, admin, archivePreview.preview_token);
        expect((await startRetirementJob(archiveSelection, admin, archivePreview.preview_token)).id).toBe(created.id);
        await expect(startRetirementJob(orphanSelection, admin, archivePreview.preview_token)).rejects.toMatchObject({
            code: 'preview_invalid',
        });
        expect(remote.revoke).not.toHaveBeenCalled();
    });

    it('refuses archive-only mode for a live group or a nonempty guessed group', async () => {
        await expect(previewRetirementJob({ ...archiveSelection, groupId: 'old' }, admin)).rejects.toMatchObject({
            code: 'invalid_input',
        });
        await expect(
            previewRetirementJob({ ...archiveSelection, newapiGroup: 'Old group' }, admin),
        ).rejects.toMatchObject({ code: 'invalid_input' });
        expect(remote.absentStored).not.toHaveBeenCalled();
    });

    it.each(['snapshot-mode', 'snapshot-ready', 'remote-evidence', 'delete-intent'])(
        'rejects inconsistent archive-only %s evidence without remote writes',
        async (kind) => {
            const created = await archiveStart();
            if (kind === 'snapshot-mode') asRow(asRow(job().plan).selection).archiveOnly = 'true';
            if (kind === 'snapshot-ready') {
                const initial = asRow(asRow(job().plan).initial_preview);
                (asRow(initial.revocation).keys as Row[])[0].status = 'ready';
            }
            if (kind === 'remote-evidence') {
                item().ownership_evidence = 'remote_verified';
                item().verified_remote = metadata;
            }
            if (kind === 'delete-intent') item().delete_started_at = date;
            if (kind.startsWith('snapshot'))
                await expect(resumeRetirementJob(created.id, admin)).rejects.toMatchObject({
                    code: 'retirement_job_unavailable',
                });
            else expect((await resumeRetirementJob(created.id, admin)).status).toBe('needs_attention');
            expect(key().status).toBe('active');
            expect(remote.revoke).not.toHaveBeenCalled();
        },
    );
});
