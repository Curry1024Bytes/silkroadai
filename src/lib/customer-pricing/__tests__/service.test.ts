import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewApiToken, NewApiUser } from '@/lib/newapi/client';
import type { OfficialContext } from '../context';
import type { NativeModelPrice } from '../types';
import type { NativeJournal, NativePublishArgs, NativeRestoreArgs, NativeSnapshot, SafeTokenSnapshot } from '../native';

const m = vi.hoisted(() => ({
    transaction: vi.fn(),
    lock: vi.fn(),
    readLock: vi.fn(),
    context: vi.fn(),
    compile: vi.fn(),
    saleGuard: vi.fn(),
    prepare: vi.fn(),
    publish: vi.fn(),
    restore: vi.fn(),
    rollback: vi.fn(),
    systemCache: vi.fn(),
    ratioCache: vi.fn(),
    global: {
        change: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
        registry: { upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
        binding: { upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    },
    tx: {
        query: vi.fn(),
        keys: vi.fn(),
        unfinished: vi.fn(),
        bindingUpdate: vi.fn(),
        bindingDelete: vi.fn(),
        ruleUpsert: vi.fn(),
        ruleDelete: vi.fn(),
        audit: vi.fn(),
        changeUpdate: vi.fn(),
        marker: vi.fn(),
    },
    api: {
        listTokensForCustomer: vi.fn(),
        setChannelStatusStrict: vi.fn(),
        copyChannelStrict: vi.fn(),
        getChannelStrict: vi.fn(),
        getOption: vi.fn(),
        getTokenForCustomer: vi.fn(),
        getUser: vi.fn(),
        putOption: vi.fn(),
        updateChannelStrict: vi.fn(),
        updateTokenForCustomer: vi.fn(),
        updateUser: vi.fn(),
    },
    realRollback: null as null | typeof import('../native').rollbackNativeSnapshot,
    realRestore: null as null | typeof import('../native').restoreNativeCustomerPricing,
}));
vi.mock('@/lib/db', () => ({
    prisma: {
        $transaction: m.transaction,
        customerPricingChange: m.global.change,
        customerModelBillingGroup: m.global.registry,
        customerPricingBinding: m.global.binding,
    },
}));
vi.mock('@/lib/admin/pricing-publish-lock', () => ({
    assertPricingCatalogWritable: m.lock,
    lockPricingPublisherReadOnly: m.readLock,
}));
vi.mock('@/lib/newapi/client', () => m.api);
vi.mock('@/lib/newapi/system-token', () => ({ invalidateSystemTokenCache: m.systemCache }));
vi.mock('@/lib/newapi/effective-group-ratios', () => ({ invalidateEffectiveRatioCache: m.ratioCache }));
vi.mock('@/lib/newapi/user-tier-multiplier', () => ({
    internalNewApiUserGroup: (id: string) => `portal-user-${id.replaceAll('-', '')}`,
}));
vi.mock('../context', () => ({ loadOfficialContext: m.context }));
vi.mock('../guards', () => ({ assertTierOutsideSaleRules: m.saleGuard }));
vi.mock('../preview', () => ({ compileCustomerPreview: m.compile }));
vi.mock('../native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../native')>();
    m.realRollback = actual.rollbackNativeSnapshot;
    m.realRestore = actual.restoreNativeCustomerPricing;
    return {
        ...actual,
        prepareNativeModelGroups: m.prepare,
        publishNativeCustomerPricing: m.publish,
        restoreNativeCustomerPricing: m.restore,
        rollbackNativeSnapshot: m.rollback,
    };
});

import { CustomerPricingError } from '../math';
import { saveCustomerOfficialPricing, type SaveOfficialPricingArgs } from '../service';

const USER = '12345678-1234-4234-8234-123456789abc';
const INTERNAL = `portal-user-${USER.replaceAll('-', '')}`;
const GA = `portal-price-${'a'.repeat(32)}`;
const GB = `portal-price-${'b'.repeat(32)}`;
const GC = `portal-price-${'c'.repeat(32)}`;
const SPECIAL = 'group_ratio_setting.group_special_usable_group';
const AUTO_BEFORE = { auto: { present: false }, '+:auto': { present: false }, '-:auto': { present: false } };
const tx = {
    $queryRaw: m.tx.query,
    newApiToken: { findMany: m.tx.keys },
    customerPricingChange: { findFirst: m.tx.unfinished, update: m.tx.changeUpdate, findUnique: m.tx.marker },
    customerPricingBinding: { update: m.tx.bindingUpdate, delete: m.tx.bindingDelete },
    customerModelBillingGroup: { updateMany: m.global.registry.updateMany },
    customerOfficialPriceRule: { upsert: m.tx.ruleUpsert, deleteMany: m.tx.ruleDelete },
    adminAuditLog: { create: m.tx.audit },
};

type CommitMode = 'normal' | 'aborted' | 'ack_lost' | 'unknown';
type Patch = { where: Record<string, unknown>; data: Record<string, unknown> };
let commitMode: CommitMode;
let txCalls: number;
let markerStatus: string;
let stagedMarker: string | null;
let journals: NativeJournal[];
let options: Record<string, string>;
let tokens: Map<number, NewApiToken>;
let user: NewApiUser;
let context: OfficialContext;
let plan: ReturnType<typeof import('../preview').compileCustomerPreview>;

function token(id: number, group = 'SD官转', name = `key-${id}`): NewApiToken {
    return {
        id,
        user_id: 7,
        key: `KEY_SECRET_${id}`,
        name,
        status: 1,
        created_time: 1,
        accessed_time: 2,
        expired_time: 1900000000,
        remain_quota: 123456,
        unlimited_quota: false,
        model_limits_enabled: true,
        model_limits: 'model-a,model-b',
        used_quota: 42,
        allow_ips: '127.0.0.1',
        group,
        auto_groups: null,
        cross_group_retry: false,
    };
}
function safe(value: NewApiToken): SafeTokenSnapshot {
    const { key, ...rest } = structuredClone(value);
    void key;
    return rest;
}
function journal(operation: NativeSnapshot['operation']): NativeJournal {
    return {
        version: 1,
        operation,
        phase: operation === 'prepare' ? 'prepared' : 'published',
        options: [],
        tokens: [],
        user: null,
        created_channels: [],
        pending_copy: null,
    };
}
function models(): NativeModelPrice[] {
    return [
        {
            model_id: 'model-a',
            model_name: 'model-a',
            group: GA,
            public_ratio: 1,
            customer_ratio: 0.666666666667,
            source_channel_ids: [13],
            replica_channel_ids: [],
        },
        {
            model_id: 'model-b',
            model_name: 'model-b',
            group: GB,
            public_ratio: 1,
            customer_ratio: 0.5,
            source_channel_ids: [13],
            replica_channel_ids: [],
        },
    ];
}
function binding(tier = 'sd', groups = [GA, GB]): OfficialContext['bindings'][number] {
    return {
        id: `binding-${tier}`,
        user_id: USER,
        tier_key: tier,
        public_group: tier === 'sd' ? 'SD官转' : 'Kiro',
        model_groups: groups,
        token_snapshots: JSON.parse(JSON.stringify([safe(token(11))])),
        original_user_group: 'default',
        original_auto_permissions: AUTO_BEFORE,
        status: 'active',
        revision: 2,
        created_at: new Date('2026-11-19T03:00:00Z'),
        updated_at: new Date('2026-11-19T03:00:00Z'),
    };
}
const args = (patch: Partial<SaveOfficialPricingArgs> = {}): SaveOfficialPricingArgs => ({
    userId: USER,
    actorId: 'admin-a',
    draft: { tier_key: 'sd', model_id: null, official_multiplier: 0.2 },
    expectedVersion: 'v1',
    previewHash: 'preview-v1',
    confirmBelowCost: false,
    confirmIncreases: false,
    ...patch,
});

beforeEach(() => {
    vi.clearAllMocks();
    commitMode = 'normal';
    txCalls = 0;
    markerStatus = 'missing';
    stagedMarker = null;
    journals = [];
    options = {
        GroupGroupRatio: JSON.stringify({ other_customer: { Kiro: 0.4 }, [INTERNAL]: { SD官转: 0.8 } }),
        [SPECIAL]: '{}',
    };
    user = {
        id: 7,
        username: 'fixture',
        display_name: 'Fixture',
        role: 1,
        status: 1,
        email: '',
        group: 'default',
        quota: 1000000,
        used_quota: 0,
        request_count: 0,
        aff_code: '',
        inviter_id: 0,
        access_token: 'USER_SECRET',
        created_at: 1,
    };
    tokens = new Map([
        [11, token(11)],
        [12, token(12, 'Kiro', 'Kiro Key')],
        [13, token(13, 'SD官转', 'portal-internal-SD官转')],
        [14, token(14, 'Kiro', 'portal-internal-Kiro')],
        [15, token(15, 'SD官转', 'portal-internal')],
    ]);
    context = {
        version: 'v1',
        // 平台客户（tenant_id 为空即平台主体）；代理客户由代理定价，另有用例。
        user: { id: USER, tenant_id: null, newapi_user_id: 7, newapi_access_token: 'CUSTOMER_PAT_SECRET' },
        tiers: [
            {
                key: 'sd',
                display_name: 'SD官转',
                public_group: 'SD官转',
                public_ratio: 1,
                legacy_multiplier: 0.8,
                models: [],
                binding_status: null,
            },
        ],
        rules: [],
        options: {},
        channels: [],
        bindings: [],
        registry: [],
        model_states: {},
    };
    plan = {
        preview: {
            version: 'v1',
            hash: 'preview-v1',
            draft: args().draft,
            cells: [],
            below_cost: false,
            has_increases: false,
            blocked: [],
            warnings: [],
            affected_keys: 1,
        },
        models: models(),
        rules: [{ id: 'rule-a', tier_key: 'sd', model_id: null, official_multiplier: 0.2, revision: 1 }],
        tier: context.tiers[0],
        restoring: false,
    };
    m.context.mockImplementation(async () => context);
    m.compile.mockImplementation(() => plan);
    m.lock.mockResolvedValue(undefined);
    m.readLock.mockResolvedValue(undefined);
    m.saleGuard.mockResolvedValue(undefined);
    m.tx.keys.mockResolvedValue([{ newapi_token_id: 11 }]);
    m.tx.unfinished.mockResolvedValue(null);
    m.tx.query.mockResolvedValue([1]);
    m.tx.bindingUpdate.mockResolvedValue({});
    m.tx.bindingDelete.mockResolvedValue({});
    m.tx.ruleUpsert.mockResolvedValue({});
    m.tx.ruleDelete.mockResolvedValue({ count: 1 });
    m.tx.audit.mockResolvedValue({});
    m.tx.changeUpdate.mockImplementation(async ({ data }: Patch) => {
        stagedMarker = String(data.status);
        return { status: stagedMarker };
    });
    m.tx.marker.mockImplementation(async () => {
        if (commitMode === 'unknown') throw new Error('DB temporarily unavailable');
        return { status: markerStatus };
    });
    m.transaction.mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => {
        txCalls += 1;
        if (txCalls > 1) return work(tx);
        const result = await work(tx);
        if (commitMode === 'aborted') throw new Error('COMMIT rejected');
        if (stagedMarker) markerStatus = stagedMarker;
        if (commitMode === 'ack_lost' || commitMode === 'unknown') throw new Error('COMMIT acknowledgement lost');
        return result;
    });
    m.global.change.create.mockImplementation(async () => {
        markerStatus = 'preparing';
        return { id: 'change-a' };
    });
    m.global.change.update.mockImplementation(async ({ data }: Patch) => {
        if (data.status) markerStatus = String(data.status);
        if (data.progress) journals.push(structuredClone(data.progress as NativeJournal));
        return { id: 'change-a', status: markerStatus };
    });
    m.global.change.findUnique.mockImplementation(async () => ({ status: markerStatus }));
    m.global.registry.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
        id: `registry-${create.model_id}`,
        ...create,
    }));
    m.global.registry.update.mockResolvedValue({});
    m.global.registry.updateMany.mockResolvedValue({ count: 1 });
    m.global.registry.findMany.mockResolvedValue([{ replica_channel_ids: [101, 102] }]);
    m.global.binding.upsert.mockResolvedValue({});
    m.global.binding.update.mockResolvedValue({});
    m.global.binding.deleteMany.mockResolvedValue({ count: 1 });
    m.global.binding.updateMany.mockResolvedValue({ count: 1 });

    m.api.listTokensForCustomer.mockImplementation(async () => ({
        items: [...tokens.values()].map((t) => structuredClone(t)),
        total: tokens.size,
    }));
    m.api.getOption.mockImplementation(async (key: string) => options[key] ?? null);
    m.api.putOption.mockImplementation(async (key: string, value: string) => {
        options[key] = value;
    });
    m.api.getUser.mockImplementation(async () => structuredClone(user));
    m.api.updateUser.mockImplementation(async (next: NewApiUser) => {
        user = { ...user, ...structuredClone(next) };
    });
    m.api.getTokenForCustomer.mockImplementation(async (_auth: unknown, id: number) =>
        structuredClone(tokens.get(id)!),
    );
    m.api.updateTokenForCustomer.mockImplementation(async (_auth: unknown, value: NewApiToken) => {
        tokens.set(value.id, structuredClone(value));
    });
    m.api.setChannelStatusStrict.mockResolvedValue(undefined);

    m.prepare.mockImplementation(async (input: NativeModelPrice[], progress: (j: NativeJournal) => Promise<void>) => {
        const prepared = input.map((value, index) => ({
            ...value,
            replica_channel_ids: [101 + index],
            source_fingerprint: 'verified-source',
        }));
        const j = journal('prepare');
        j.created_channels = prepared.map((value) => ({
            id: value.replica_channel_ids[0],
            source_id: 13,
            group: value.group,
            model: value.model_name,
            configured: true,
        }));
        await progress(j);
        return prepared;
    });
    m.publish.mockImplementation(async (input: NativePublishArgs, progress: (j: NativeJournal) => Promise<void>) => {
        const j = journal('publish');
        const before = options.GroupGroupRatio;
        const matrix = JSON.parse(before);
        matrix[INTERNAL] = {
            ...matrix[INTERNAL],
            ...Object.fromEntries(input.models.map((model) => [model.group, model.customer_ratio])),
        };
        const after = JSON.stringify(matrix);
        j.options.push({ key: 'GroupGroupRatio', before, after, attempted: true, verified: true });
        options.GroupGroupRatio = after;
        j.user = {
            id: 7,
            before_group: user.group,
            after_group: INTERNAL,
            attempted: user.group !== INTERNAL,
            verified: true,
        };
        user.group = INTERNAL;
        const snapshots = input.portalTokenIds.map((id) => safe(tokens.get(id)!));
        for (const snapshot of snapshots) {
            const next = {
                group: 'auto',
                auto_groups: input.models.map((model) => model.group),
                cross_group_retry: false,
            };
            j.tokens.push({ before: snapshot, after: next, attempted: true, verified: true });
            tokens.set(snapshot.id, { ...tokens.get(snapshot.id)!, ...next });
        }
        await progress(j);
        return {
            model_groups: input.models.map((model) => model.group),
            token_snapshots: snapshots,
            original_user_group:
                input.previousBinding?.original_user_group ?? input.originalUserGroup ?? j.user.before_group,
            original_auto_permissions: input.previousBinding?.original_auto_permissions ?? AUTO_BEFORE,
            before: j,
        };
    });
    m.restore.mockImplementation((input: NativeRestoreArgs, progress: (j: NativeJournal) => Promise<void>) =>
        m.realRestore!(input, progress),
    );
    m.rollback.mockImplementation(
        (
            snapshot: NativeSnapshot,
            auth: { userId: number; accessToken: string },
            progress: (j: NativeJournal) => Promise<void>,
        ) => m.realRollback!(snapshot, auth, progress),
    );
});

describe('official customer price publication failure contracts', () => {
    it.each([
        ['stale version', { expectedVersion: 'old' }, 'preview_stale'],
        ['stale preview hash', { previewHash: 'old' }, 'preview_stale'],
    ] as const)('rejects %s before creating native state or a publication journal', async (_label, patch, code) => {
        await expect(saveCustomerOfficialPricing(args(patch))).rejects.toMatchObject({ code });
        expect(m.prepare).not.toHaveBeenCalled();
        expect(m.publish).not.toHaveBeenCalled();
        expect(m.global.change.create).not.toHaveBeenCalled();
    });

    it('refuses partner customers before any native mutation', async () => {
        context.user.tenant_id = '11111111-2222-3333-4444-555555555555';
        await expect(saveCustomerOfficialPricing(args())).rejects.toMatchObject({ code: 'partner_customer' });
        expect(m.prepare).not.toHaveBeenCalled();
        expect(m.publish).not.toHaveBeenCalled();
        expect(m.global.change.create).not.toHaveBeenCalled();
    });

    it('refuses unacknowledged below-cost prices and increases before any native mutation', async () => {
        plan.preview.below_cost = true;
        await expect(saveCustomerOfficialPricing(args())).rejects.toMatchObject({ code: 'below_cost_unconfirmed' });
        plan.preview.below_cost = false;
        plan.preview.has_increases = true;
        await expect(saveCustomerOfficialPricing(args())).rejects.toMatchObject({ code: 'increase_unconfirmed' });
        expect(m.prepare).not.toHaveBeenCalled();
        expect(m.publish).not.toHaveBeenCalled();
    });

    it('refuses a blocked preview, an old sale-rule managed tier or an unfinished publication before writes', async () => {
        plan.preview.blocked = ['official reference unavailable'];
        await expect(saveCustomerOfficialPricing(args())).rejects.toMatchObject({ code: 'preview_blocked' });
        plan.preview.blocked = [];
        m.saleGuard.mockRejectedValueOnce(new CustomerPricingError('sale_rules_managed', 'managed'));
        await expect(saveCustomerOfficialPricing(args())).rejects.toMatchObject({ code: 'sale_rules_managed' });
        m.tx.unfinished.mockResolvedValue({ id: 'unfinished-a' });
        await expect(saveCustomerOfficialPricing(args())).rejects.toMatchObject({ code: 'unfinished_change' });
        expect(m.global.change.create).not.toHaveBeenCalled();
        expect(m.prepare).not.toHaveBeenCalled();
    });

    it('migrates only the selected logical tier and its customer-owned service tokens, retaining unrelated keys and legacy pricing', async () => {
        const kiro = structuredClone(tokens.get(12));
        const internalKiro = structuredClone(tokens.get(14));
        const result = await saveCustomerOfficialPricing(args());
        expect(m.tx.keys).toHaveBeenCalledWith({
            where: { user_id: USER, tier: 'sd', status: 'active' },
            select: { newapi_token_id: true },
        });
        expect(m.publish).toHaveBeenCalledWith(
            expect.objectContaining({ publicGroup: 'SD官转', portalTokenIds: [11, 13, 15] }),
            expect.any(Function),
        );
        expect(tokens.get(11)).toMatchObject({
            group: 'auto',
            auto_groups: [GA, GB],
            key: 'KEY_SECRET_11',
            remain_quota: 123456,
            expired_time: 1900000000,
            allow_ips: '127.0.0.1',
        });
        expect(tokens.get(12)).toEqual(kiro);
        expect(tokens.get(14)).toEqual(internalKiro);
        expect(JSON.parse(options.GroupGroupRatio)[INTERNAL].SD官转).toBe(0.8);
        expect(context.tiers[0].legacy_multiplier).toBe(0.8);
        expect(result).toMatchObject({ unchanged: false, affected_keys: 3 });
        expect(markerStatus).toBe('applied');
        expect(m.global.registry.updateMany).toHaveBeenCalledWith({
            where: { internal_group: { in: [GA, GB] } },
            data: { status: 'active' },
        });
        expect(m.systemCache).toHaveBeenCalledWith(USER);
        expect(m.ratioCache).toHaveBeenCalledWith(7);
        expect(JSON.stringify(journals)).not.toContain('CUSTOMER_PAT_SECRET');
        expect(JSON.stringify(journals)).not.toContain('KEY_SECRET_');
    });

    it('keeps native customer pricing when removing the last new-style rule from a legacy-priced tier', async () => {
        plan.restoring = false;
        plan.rules = [];
        await saveCustomerOfficialPricing(
            args({ draft: { tier_key: 'sd', model_id: null, official_multiplier: null } }),
        );

        expect(m.publish).toHaveBeenCalledWith(
            expect.objectContaining({ publicGroup: 'SD官转', portalTokenIds: [11, 13, 15] }),
            expect.any(Function),
        );
        expect(m.restore).not.toHaveBeenCalled();
        expect(m.tx.ruleDelete).toHaveBeenCalledWith({
            where: { user_id: USER, tier_key: 'sd', model_key: '*' },
        });
    });

    it('writes only the confirmed model overrides in a batch publication', async () => {
        const draft = { tier_key: 'sd', model_ids: ['model-a', 'model-c'], official_multiplier: 0.7 };
        await saveCustomerOfficialPricing(args({ draft }));
        expect(m.tx.ruleUpsert.mock.calls.map(([request]) => request.where.user_id_tier_key_model_key)).toEqual([
            { user_id: USER, tier_key: 'sd', model_key: 'model-a' },
            { user_id: USER, tier_key: 'sd', model_key: 'model-c' },
        ]);
        expect(m.tx.ruleDelete).not.toHaveBeenCalled();
        expect(markerStatus).toBe('applied');
    });

    it('does not downgrade shared active model registries while preparing another customer', async () => {
        m.global.registry.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
            id: `registry-${create.internal_group}`,
            ...create,
            status: 'active',
        }));
        await saveCustomerOfficialPricing(args());
        expect(m.global.registry.update).toHaveBeenCalledTimes(2);
        for (const [request] of m.global.registry.update.mock.calls) expect(request.data.status).toBe('active');
    });

    it('does not modify keys when internal-channel preparation fails', async () => {
        const before = structuredClone([...tokens]);
        m.prepare.mockRejectedValue(new Error('cannot prepare replica'));
        await expect(saveCustomerOfficialPricing(args())).rejects.toThrow('cannot prepare replica');
        expect(m.publish).not.toHaveBeenCalled();
        expect(m.restore).not.toHaveBeenCalled();
        expect(m.global.binding.upsert).not.toHaveBeenCalled();
        expect([...tokens]).toEqual(before);
        expect(m.api.updateTokenForCustomer).not.toHaveBeenCalled();
    });

    it('rolls back a partially changed native publication using its persisted before-image', async () => {
        const beforeTokens = structuredClone([...tokens]);
        const beforeOptions = structuredClone(options);
        const publish = m.publish.getMockImplementation()!;
        m.publish.mockImplementation(async (...parameters) => {
            await publish(...parameters);
            throw new Error('native readback failed');
        });
        await expect(saveCustomerOfficialPricing(args())).rejects.toThrow('native readback failed');
        expect(m.rollback).toHaveBeenCalledOnce();
        expect([...tokens]).toEqual(beforeTokens);
        expect(options).toEqual(beforeOptions);
        expect(user.group).toBe('default');
        expect(markerStatus).toBe('compensated');
        expect(m.tx.ruleUpsert).not.toHaveBeenCalled();
    });

    it('restores native pricing when the local transaction fails to persist the customer rule', async () => {
        const beforeOptions = structuredClone(options);
        m.tx.ruleUpsert.mockRejectedValue(new Error('local rule write failed'));
        await expect(saveCustomerOfficialPricing(args())).rejects.toThrow('local rule write failed');
        expect(m.rollback).toHaveBeenCalledOnce();
        expect(tokens.get(11)?.group).toBe('SD官转');
        expect(options).toEqual(beforeOptions);
        expect(m.global.binding.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER, tier_key: 'sd' } });
        expect(markerStatus).toBe('compensated');
    });

    it('does not undo an applied native price after COMMIT succeeds but its acknowledgement is lost', async () => {
        commitMode = 'ack_lost';
        const result = await saveCustomerOfficialPricing(args());
        expect(result).toMatchObject({ unchanged: false, change_id: 'change-a' });
        expect(m.readLock).toHaveBeenCalled();
        expect(m.rollback).not.toHaveBeenCalled();
        expect(m.api.setChannelStatusStrict).not.toHaveBeenCalled();
        expect(markerStatus).toBe('applied');
        expect(tokens.get(11)?.group).toBe('auto');
    });

    it('can compensate after a definite aborted commit whose durable marker is not applied', async () => {
        commitMode = 'aborted';
        await expect(saveCustomerOfficialPricing(args())).rejects.toThrow('COMMIT rejected');
        expect(m.readLock).toHaveBeenCalled();
        expect(m.rollback).toHaveBeenCalledOnce();
        expect(tokens.get(11)?.group).toBe('SD官转');
        expect(markerStatus).toBe('compensated');
    });

    it('does not guess that an unverifiable commit failed: keeps recovery evidence and suspends affected replicas without native rollback', async () => {
        commitMode = 'unknown';
        await expect(saveCustomerOfficialPricing(args())).rejects.toMatchObject({ code: 'publication_uncertain' });
        expect(m.readLock).toHaveBeenCalled();
        expect(m.rollback).not.toHaveBeenCalled();
        expect(tokens.get(11)?.group).toBe('auto');
        expect(m.global.binding.updateMany).toHaveBeenCalledWith({
            where: { user_id: USER, tier_key: 'sd' },
            data: { status: 'failed' },
        });
        expect(m.api.setChannelStatusStrict).toHaveBeenCalledWith(101, 2);
        expect(m.api.setChannelStatusStrict).toHaveBeenCalledWith(102, 2);
        expect(markerStatus).toBe('failed');
    });

    it('does not overwrite another customer’s concurrent matrix change during compensation', async () => {
        m.tx.ruleUpsert.mockImplementation(async () => {
            const matrix = JSON.parse(options.GroupGroupRatio);
            matrix.other_customer.Kiro = 0.9;
            options.GroupGroupRatio = JSON.stringify(matrix);
            throw new Error('local commit failed after another operator change');
        });
        await expect(saveCustomerOfficialPricing(args())).rejects.toBeInstanceOf(Error);
        expect(JSON.parse(options.GroupGroupRatio).other_customer).toEqual({ Kiro: 0.9 });
        expect(m.api.putOption.mock.calls.filter(([key]) => key === 'GroupGroupRatio')).toHaveLength(0);
    });

    it('restores only this tier when its final rule is removed, including a key created after the original binding', async () => {
        const old = binding();
        const other = binding('kiro', [GC]);
        context.bindings = [old, other];
        plan.restoring = true;
        plan.rules = [];
        user.group = INTERNAL;
        for (const id of [11, 13, 15]) tokens.set(id, { ...tokens.get(id)!, group: 'auto', auto_groups: [GA, GB] });
        const later = { ...token(16), group: 'auto', auto_groups: [GA, GB] };
        tokens.set(16, later);
        const otherKey = { ...tokens.get(12)!, group: 'auto', auto_groups: [GC] };
        tokens.set(12, otherKey);
        tokens.set(14, { ...tokens.get(14)!, group: 'auto', auto_groups: [GC] });
        m.tx.keys.mockResolvedValue([{ newapi_token_id: 11 }, { newapi_token_id: 16 }]);
        options.GroupGroupRatio = JSON.stringify({
            [INTERNAL]: { [GA]: 0.6, [GB]: 0.4, [GC]: 0.3, SD官转: 0.8 },
            other_customer: { Kiro: 0.4 },
        });
        options[SPECIAL] = JSON.stringify({ [INTERNAL]: { auto: 'Auto', [GA]: 'A', [GB]: 'B', [GC]: 'C' } });
        await saveCustomerOfficialPricing(
            args({ draft: { tier_key: 'sd', model_id: null, official_multiplier: null } }),
        );
        expect(m.prepare).not.toHaveBeenCalled();
        expect(m.publish).not.toHaveBeenCalled();
        expect(m.restore).toHaveBeenCalledWith(
            expect.objectContaining({ portalTokenIds: [11, 13, 15, 16] }),
            expect.any(Function),
        );
        expect(tokens.get(16)).toMatchObject({
            group: 'SD官转',
            auto_groups: null,
            remain_quota: later.remain_quota,
            key: later.key,
        });
        expect(tokens.get(12)).toEqual(otherKey);
        expect(user.group).toBe(INTERNAL);
        expect(JSON.parse(options.GroupGroupRatio)[INTERNAL]).toEqual({ [GC]: 0.3, SD官转: 0.8 });
        expect(m.tx.bindingDelete).toHaveBeenCalledWith({
            where: { user_id_tier_key: { user_id: USER, tier_key: 'sd' } },
        });
    });

    it('refuses an empty previous AutoGroups binding instead of restoring a globally inherited auto route', async () => {
        context.bindings = [binding('sd', [])];
        plan.restoring = true;
        plan.rules = [];
        await expect(
            saveCustomerOfficialPricing(args({ draft: { tier_key: 'sd', model_id: null, official_multiplier: null } })),
        ).rejects.toMatchObject({ code: 'binding_invalid' });
        expect(m.restore).not.toHaveBeenCalled();
        expect(m.publish).not.toHaveBeenCalled();
        expect(m.api.updateTokenForCustomer).not.toHaveBeenCalled();
    });

    it('does not create channels, change keys or write a journal when deleting a nonexistent rule without a binding', async () => {
        plan.restoring = true;
        plan.rules = [];
        const result = await saveCustomerOfficialPricing(
            args({ draft: { tier_key: 'sd', model_id: null, official_multiplier: null } }),
        );
        expect(result).toEqual({ unchanged: true, affected_keys: 0 });
        expect(m.global.change.create).not.toHaveBeenCalled();
        expect(m.global.binding.upsert).not.toHaveBeenCalled();
        expect(m.prepare).not.toHaveBeenCalled();
        expect(m.publish).not.toHaveBeenCalled();
        expect(m.restore).not.toHaveBeenCalled();
    });
});
