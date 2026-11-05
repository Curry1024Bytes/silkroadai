import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
    TENANT: '00000000-0000-0000-0000-000000000001',
    USER: '0f8fad5b-d9cb-469f-a165-70867728950e',
    INTERNAL: 'portal-user-0f8fad5bd9cb469fa16570867728950e',
    options: {} as Record<string, string>,
    puts: [] as Array<[string, string]>,
    failPut: null as string | null,
    readCount: 0,
    onRead: null as null | ((count: number) => void),
    users: {} as Record<number, Row>,
    tokens: {} as Record<number, Array<{ id: number; group: string }>>,
    groupUserRatios: {} as Record<string, Array<{ user_id: number; ratio: number }>>,
    channels: [] as Row[],
    lockError: null as Error | null,
    snapshots: 0,
    db: {
        groups: [] as Row[],
        rules: [] as Row[],
        catalog: [] as Row[],
        costRules: [] as Row[],
        multipliers: [] as Row[],
        publications: [] as Row[],
        portalUsers: [] as Row[],
        channelGroups: [] as Row[],
        audits: [] as Row[],
    },
}));

vi.mock('@/lib/newapi/client', () => ({
    getSaleRuleOptions: vi.fn(async () => {
        fake.readCount += 1;
        fake.onRead?.(fake.readCount);
        return { ...fake.options };
    }),
    putSaleRuleOption: vi.fn(async (key: string, value: string) => {
        if (fake.failPut === key) throw new Error(`put ${key} failed`);
        fake.puts.push([key, value]);
        fake.options[key] = value;
    }),
    getPricingPublishOptions: vi.fn(async () => ({ ...fake.options })),
    listChannelsForCatalogSync: vi.fn(async () => fake.channels),
    listGroupUserRatios: vi.fn(async (group: string) => fake.groupUserRatios[group] ?? []),
    getUser: vi.fn(async (id: number) => {
        const user = fake.users[id];
        if (!user) throw new Error('record not found');
        return { ...user };
    }),
    updateUser: vi.fn(async (user: Row) => {
        fake.users[user.id as number] = { ...fake.users[user.id as number], group: user.group };
    }),
    listTokensForCustomer: vi.fn(async (auth: { userId: number }) => {
        const items = fake.tokens[auth.userId] ?? [];
        return { items, total: items.length };
    }),
}));

vi.mock('@/lib/admin/pricing-publish-lock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin/pricing-publish-lock')>()),
    assertPricingCatalogWritable: vi.fn(async () => {
        if (fake.lockError) throw fake.lockError;
    }),
}));

vi.mock('@/lib/admin/pricing-simple', () => ({
    snapshotCatalog: vi.fn(async () => {
        fake.snapshots += 1;
        return 1;
    }),
}));
vi.mock('@/lib/db', () => {
    const matches = (row: Row, where: Row = {}) =>
        Object.entries(where).every(([key, value]) => {
            if (value && typeof value === 'object' && 'in' in value) return (value.in as unknown[]).includes(row[key]);
            return row[key] === value;
        });
    const db = {
        pricingBillingGroup: { findMany: vi.fn(async () => fake.db.groups) },
        pricingSaleRule: { findMany: vi.fn(async () => fake.db.rules.filter((rule) => rule.enabled)) },
        catalogModel: { findMany: vi.fn(async () => fake.db.catalog) },
        pricingCostRule: { findMany: vi.fn(async () => fake.db.costRules) },
        userTierMultiplier: {
            findMany: vi.fn(async () => fake.db.multipliers),
            findUnique: vi.fn(async (args: { where: { user_id_tier_key: Row } }) => {
                const key = args.where.user_id_tier_key;
                return fake.db.multipliers.find((row) => row.user_id === key.user_id && row.tier_key === key.tier_key);
            }),
            update: vi.fn(async (args: { where: { id: string }; data: Row }) => {
                const row = fake.db.multipliers.find((item) => item.id === args.where.id)!;
                Object.assign(row, args.data, { updated_at: new Date() });
                return row;
            }),
            create: vi.fn(async (args: { data: Row }) => {
                const row = { id: `utm-${fake.db.multipliers.length + 1}`, updated_at: new Date(), ...args.data };
                fake.db.multipliers.push(row);
                return row;
            }),
            updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
                const rows = fake.db.multipliers.filter((row) => matches(row, args.where));
                for (const row of rows) Object.assign(row, args.data);
                return { count: rows.length };
            }),
        },
        pricingRulePublication: {
            findMany: vi.fn(async () => [...fake.db.publications].reverse()),
            create: vi.fn(async (args: { data: Row }) => {
                const row = { id: `pub-${fake.db.publications.length + 1}`, created_at: new Date(), ...args.data };
                fake.db.publications.push(row);
                return row;
            }),
            update: vi.fn(async (args: { where: { id: string }; data: Row }) => {
                const row = fake.db.publications.find((item) => item.id === args.where.id)!;
                return Object.assign(row, args.data);
            }),
            updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
                const rows = fake.db.publications.filter((row) => matches(row, args.where));
                for (const row of rows) Object.assign(row, args.data);
                return { count: rows.length };
            }),
        },
        user: {
            findMany: vi.fn(async (args: { where: Row }) => fake.db.portalUsers.filter((u) => matches(u, args.where))),
        },
        channelGroup: {
            findMany: vi.fn(async (args: { where: Row }) =>
                fake.db.channelGroups.filter((g) => matches(g, args.where)),
            ),
        },
        adminAuditLog: {
            create: vi.fn(async (args: { data: Row }) => {
                fake.db.audits.push(args.data);
                return args.data;
            }),
        },
    };
    return { prisma: { ...db, $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)) } };
});
import { PricingPublishError } from '@/lib/admin/pricing-publish-lock';
import {
    evaluateSaleRulePlan,
    loadPlanInputs,
    previewSaleRules,
    publishSaleRules,
    runSaleRuleSchedulerTick,
    type PublishActor,
} from '@/lib/pricing-rules/publish';
import { writeSteps } from '@/lib/pricing-rules/plan';
import { prisma } from '@/lib/db';

const { TENANT, USER, INTERNAL } = fake;
const MINUTE = 60_000;
const ACTOR: PublishActor = {
    userId: null,
    email: 'ops@example.com',
    viaBreakGlass: true,
    level: 'break_glass',
    ip: '127.0.0.1',
    userAgent: 'vitest',
    path: '/api/admin/pricing/sale-rules/publish',
};
const decimal = (value: string) => new Prisma.Decimal(value);
const parsed = (key: string) => JSON.parse(fake.options[key] ?? '{}') as Record<string, unknown>;

let ruleSeq = 0;
function rule(overrides: Row = {}): Row {
    ruleSeq += 1;
    return {
        id: `rule-${ruleSeq}`,
        tenant_id: TENANT,
        kind: 'global_tier',
        user_id: null,
        tier_key: 'pool',
        model_id: null,
        discount: decimal('0.5'),
        effective_from: null,
        effective_to: null,
        enabled: true,
        ...overrides,
    };
}

function seed() {
    fake.options = {
        GroupRatio: '{"default":1,"pool-gpt":1.2}',
        GroupGroupRatio: '{}',
        UserUsableGroups: '{"default":"默认","pool-gpt":"GPT 池"}',
        'group_ratio_setting.group_special_usable_group': '{}',
        'billing_setting.scheduled_discount': '{}',
    };
    fake.puts = [];
    fake.failPut = null;
    fake.readCount = 0;
    fake.onRead = null;
    fake.users = { 501: { id: 501, username: 'c-1', display_name: 'c-1', role: 1, status: 1, group: 'default' } };
    fake.tokens = { 501: [{ id: 9, group: 'pool-gpt' }] };
    fake.groupUserRatios = {};
    fake.channels = [{ id: 1, group: 'pool-gpt', models: 'gpt-a,gpt-b' }];
    fake.lockError = null;
    fake.snapshots = 0;
    fake.db = {
        groups: [{ tenant_id: TENANT, tier_key: 'pool', newapi_group: 'pool-gpt', unified_sale_ratio: decimal('1.2') }],
        rules: [],
        catalog: [],
        costRules: [],
        multipliers: [],
        publications: [],
        portalUsers: [{ id: USER, tenant_id: TENANT, newapi_user_id: 501, newapi_access_token: 'pat-501' }],
        channelGroups: [{ tenant_id: TENANT, key: 'pool', newapi_group: 'pool-gpt' }],
        audits: [],
    };
}

beforeEach(() => {
    ruleSeq = 0;
    seed();
    vi.clearAllMocks();
});
describe('sale rule publisher', () => {
    it('publishes a global tier sale to GroupRatio only', async () => {
        fake.db.rules = [rule()];
        const result = await publishSaleRules({ trigger: 'scheduler', actor: null });
        expect(result.outcome).toBe('applied');
        expect(fake.puts.map(([key]) => key)).toEqual(['GroupRatio']);
        expect(parsed('GroupRatio')).toEqual({ default: 1, 'pool-gpt': 0.6 });
        expect(fake.snapshots).toBe(1);
        expect(fake.db.publications).toMatchObject([{ status: 'applied', trigger: 'scheduler' }]);
        expect(fake.db.publications[0].before).toEqual({ 'pool-gpt': { ratio: 1.2, customers: {} } });
        expect(fake.db.publications[0].after).toEqual({ 'pool-gpt': { ratio: 0.6, customers: {} } });
    });

    it('does nothing when new-api already matches', async () => {
        const result = await runSaleRuleSchedulerTick();
        expect(result.outcome).toBe('noop');
        expect(fake.puts).toEqual([]);
        expect(fake.db.publications).toEqual([]);
    });

    it('moves a discounted customer into its internal group after its row is in place', async () => {
        fake.db.rules = [rule({ kind: 'customer_tier', user_id: USER, discount: decimal('0.8') })];
        const result = await publishSaleRules({ trigger: 'scheduler', actor: null });
        expect(
            result.plan.steps.map((step) => (step.kind === 'move' ? `move:${step.move.direction}` : step.label)),
        ).toEqual(['stage_rows', 'move:in']);
        expect(parsed('GroupGroupRatio')).toEqual({ [INTERNAL]: { 'pool-gpt': 0.96 } });
        expect(fake.users[501].group).toBe(INTERNAL);
        expect(fake.db.multipliers).toMatchObject([
            {
                user_id: USER,
                tier_key: 'pool',
                newapi_billing_group: 'pool-gpt',
                newapi_user_group: INTERNAL,
                original_newapi_user_group: 'default',
                multiplier: 0.96,
                enabled: true,
                managed_by_rules: true,
            },
        ]);
        expect(fake.db.publications[0].moves).toEqual([
            { userId: USER, newapiUserId: 501, from: 'default', to: INTERNAL, direction: 'in' },
        ]);
    });

    it('returns the customer to its original group when its discount is gone', async () => {
        fake.options.GroupGroupRatio = JSON.stringify({ [INTERNAL]: { 'pool-gpt': 0.96 } });
        fake.users[501].group = INTERNAL;
        fake.db.multipliers = [
            {
                id: 'utm-1',
                user_id: USER,
                tier_key: 'pool',
                newapi_billing_group: 'pool-gpt',
                newapi_user_group: INTERNAL,
                original_newapi_user_group: 'default',
                multiplier: decimal('0.96'),
                enabled: true,
                managed_by_rules: true,
                updated_at: new Date(),
            },
        ];
        const result = await publishSaleRules({ trigger: 'scheduler', actor: null });
        expect(result.outcome).toBe('applied');
        expect(parsed('GroupGroupRatio')).toEqual({});
        expect(fake.users[501].group).toBe('default');
        expect(fake.db.multipliers[0]).toMatchObject({ enabled: false, managed_by_rules: true });
    });
    it('holds a customer whose keys would follow the user group after the move', async () => {
        fake.db.rules = [rule({ kind: 'customer_tier', user_id: USER, discount: decimal('0.8') })];
        fake.tokens[501] = [
            { id: 9, group: 'pool-gpt' },
            { id: 10, group: '' },
        ];
        const result = await publishSaleRules({ trigger: 'scheduler', actor: null });
        expect(result.outcome).toBe('noop');
        expect(result.plan.held).toEqual([USER]);
        expect(result.plan.diagnostics.find((item) => item.code === 'move_in_blocked')?.message).toContain(
            '1 个 Key 未固定分组',
        );
        expect(fake.puts).toEqual([]);
        expect(fake.users[501].group).toBe('default');
    });

    it('holds a customer with a new-api per-user ratio in the billing group', async () => {
        fake.db.rules = [rule({ kind: 'customer_tier', user_id: USER, discount: decimal('0.8') })];
        fake.groupUserRatios['pool-gpt'] = [
            { user_id: 501, ratio: 0.7 },
            { user_id: 777, ratio: 0.5 },
        ];
        const plan = await previewSaleRules();
        expect(plan.held).toEqual([USER]);
        expect(plan.diagnostics.map((item) => item.code)).toEqual(
            expect.arrayContaining(['group_user_ratio_override', 'group_user_ratio_present']),
        );
        expect(plan.steps).toEqual([]);
    });

    it('holds a customer whose new-api group changed outside Portal', async () => {
        fake.db.rules = [rule({ kind: 'customer_tier', user_id: USER, discount: decimal('0.8') })];
        fake.users[501].group = 'vip';
        fake.db.multipliers = [
            {
                id: 'utm-1',
                user_id: USER,
                tier_key: 'pool',
                newapi_billing_group: 'pool-gpt',
                newapi_user_group: INTERNAL,
                original_newapi_user_group: 'default',
                multiplier: decimal('0.96'),
                enabled: true,
                managed_by_rules: true,
                updated_at: new Date(),
            },
        ];
        const plan = await previewSaleRules();
        expect(plan.held).toEqual([USER]);
        expect(plan.diagnostics.map((item) => item.code)).toContain('user_group_drift');
    });

    it('never compiles a customer that still has a hand-made multiplier', async () => {
        fake.db.rules = [rule()];
        fake.options.GroupGroupRatio = JSON.stringify({ [INTERNAL]: { 'pool-gpt': 0.9 } });
        fake.users[501].group = INTERNAL;
        fake.db.multipliers = [
            {
                id: 'utm-1',
                user_id: USER,
                tier_key: 'pool',
                newapi_billing_group: 'pool-gpt',
                newapi_user_group: INTERNAL,
                original_newapi_user_group: 'default',
                multiplier: decimal('0.9'),
                enabled: true,
                managed_by_rules: false,
                updated_at: new Date(),
            },
        ];
        const result = await publishSaleRules({ trigger: 'scheduler', actor: null });
        expect(fake.puts.map(([key]) => key)).toEqual(['GroupRatio']);
        expect(parsed('GroupGroupRatio')).toEqual({ [INTERNAL]: { 'pool-gpt': 0.9 } });
        expect(fake.users[501].group).toBe(INTERNAL);
        expect(result.plan.diagnostics.map((item) => item.code)).toContain('legacy_multiplier');
    });
    it('keeps a removed customer row until the group ratio has changed', () => {
        const steps = writeSteps({
            liveGroupRatio: { 'pool-gpt': 0.6 },
            nextGroupRatio: { 'pool-gpt': 1.2 },
            liveRows: { [INTERNAL]: { 'pool-gpt': 0.6 } },
            nextRows: {},
            owned: { 'pool-gpt': [USER] },
            moves: [{ userId: USER, newapiUserId: 501, from: INTERNAL, to: 'default', direction: 'out' }],
        });
        expect(steps.map((step) => (step.kind === 'move' ? `move:${step.move.direction}` : step.label))).toEqual([
            'group_ratio',
            'move:out',
            'final_rows',
        ]);
    });

    it('lands a new customer row and moves the customer before the group ratio changes', () => {
        const steps = writeSteps({
            liveGroupRatio: { 'pool-gpt': 1.2 },
            nextGroupRatio: { 'pool-gpt': 0.6 },
            liveRows: {},
            nextRows: { [INTERNAL]: { 'pool-gpt': 0.96 } },
            owned: { 'pool-gpt': [USER] },
            moves: [{ userId: USER, newapiUserId: 501, from: 'default', to: INTERNAL, direction: 'in' }],
        });
        expect(steps.map((step) => (step.kind === 'move' ? `move:${step.move.direction}` : step.label))).toEqual([
            'stage_rows',
            'move:in',
            'group_ratio',
        ]);
    });

    it('rejects a manual publish whose preview is stale and accepts a current one', async () => {
        fake.db.rules = [rule()];
        const preview = await previewSaleRules();
        fake.options.GroupRatio = '{"default":1,"pool-gpt":1.1}';
        await expect(
            publishSaleRules({ trigger: 'manual', actor: ACTOR, expectedHash: preview.hash }),
        ).rejects.toMatchObject({ code: 'sale_rules_stale' });
        expect(fake.puts).toEqual([]);
        const current = await previewSaleRules();
        const result = await publishSaleRules({ trigger: 'manual', actor: ACTOR, expectedHash: current.hash });
        expect(result.outcome).toBe('applied');
        expect(fake.db.audits).toMatchObject([{ action: 'pricing_sale_rules_publish', level: 'break_glass' }]);
    });

    it('writes the dotted copy with the same full value when its row exists', async () => {
        fake.db.rules = [rule()];
        fake.options['group_ratio_setting.group_ratio'] = fake.options.GroupRatio;
        await publishSaleRules({ trigger: 'scheduler', actor: null });
        expect(fake.puts.map(([key]) => key)).toEqual(['GroupRatio', 'group_ratio_setting.group_ratio']);
        expect(parsed('group_ratio_setting.group_ratio')).toEqual(parsed('GroupRatio'));
    });

    it('puts the classic copy back when the dotted copy cannot be written', async () => {
        fake.db.rules = [rule()];
        fake.options['group_ratio_setting.group_ratio'] = fake.options.GroupRatio;
        fake.failPut = 'group_ratio_setting.group_ratio';
        await expect(publishSaleRules({ trigger: 'scheduler', actor: null })).rejects.toThrow('failed');
        expect(parsed('GroupRatio')).toEqual({ default: 1, 'pool-gpt': 1.2 });
        expect(fake.db.publications).toMatchObject([{ status: 'failed' }]);
    });

    it('refuses to publish while the two copies disagree', async () => {
        fake.db.rules = [rule()];
        fake.options['group_ratio_setting.group_ratio'] = '{"default":1,"pool-gpt":1.5}';
        await expect(publishSaleRules({ trigger: 'manual', actor: ACTOR })).rejects.toMatchObject({
            code: 'sale_rules_blocked',
        });
        expect((await runSaleRuleSchedulerTick()).outcome).toBe('noop');
        expect(fake.puts).toEqual([]);
    });
    it('lists a customer whose own discount is overridden by a new global sale as an increase', async () => {
        fake.options.GroupGroupRatio = JSON.stringify({ [INTERNAL]: { 'pool-gpt': 0.96 } });
        fake.users[501].group = INTERNAL;
        fake.db.multipliers = [
            {
                id: 'utm-1',
                user_id: USER,
                tier_key: 'pool',
                newapi_billing_group: 'pool-gpt',
                newapi_user_group: INTERNAL,
                original_newapi_user_group: 'default',
                multiplier: decimal('0.96'),
                enabled: true,
                managed_by_rules: true,
                updated_at: new Date(),
            },
        ];
        fake.db.rules = [
            rule({ discount: decimal('0.9') }),
            rule({ kind: 'customer_tier', user_id: USER, discount: decimal('0.8') }),
        ];
        const plan = await previewSaleRules();
        expect(plan.changes).toEqual([
            { newapiGroup: 'pool-gpt', userId: null, before: 1.2, after: 1.08, increase: false },
            { newapiGroup: 'pool-gpt', userId: USER, before: 0.96, after: 1.08, increase: true },
        ]);
        expect(plan.steps.map((step) => (step.kind === 'move' ? `move:${step.move.direction}` : step.label))).toEqual([
            'group_ratio',
            'move:out',
            'final_rows',
        ]);
    });

    it('refuses to overwrite an option changed during the publication', async () => {
        fake.db.rules = [rule()];
        fake.onRead = (count) => {
            if (count === 3) fake.options.GroupRatio = '{"default":1,"pool-gpt":1.1}';
        };
        await expect(publishSaleRules({ trigger: 'scheduler', actor: null })).rejects.toMatchObject({
            code: 'sale_rules_remote_changed',
        });
        expect(fake.puts).toEqual([]);
        expect(fake.db.publications).toMatchObject([{ status: 'failed' }]);
    });

    it('skips a scheduler pass while another pricing change holds the lock', async () => {
        fake.db.rules = [rule()];
        fake.lockError = new PricingPublishError('pricing_publish_busy', 'busy');
        expect(await runSaleRuleSchedulerTick()).toEqual({ outcome: 'busy', publicationId: null });
        expect(fake.puts).toEqual([]);
        expect(fake.db.publications).toEqual([]);
    });

    it('never creates a billing group that new-api does not have', async () => {
        fake.db.rules = [rule()];
        fake.options.GroupRatio = '{"default":1}';
        const plan = await previewSaleRules();
        expect(plan.diagnostics.map((item) => item.code)).toContain('group_missing');
        expect(plan.steps).toEqual([]);
        expect(plan.nextGroupRatio).toEqual({ default: 1 });
    });

    it('refuses to compile against an empty channel list', async () => {
        fake.channels = [];
        await expect(previewSaleRules()).rejects.toMatchObject({ code: 'sale_rules_channels_empty' });
    });

    it('evaluates without remote customer checks in never mode', async () => {
        fake.db.rules = [rule({ kind: 'customer_tier', user_id: USER, discount: decimal('0.8') })];
        const plan = await evaluateSaleRulePlan(prisma, await loadPlanInputs(prisma), new Date(), 'never');
        expect(plan.resolved).toBe(false);
        expect(plan.nextRows).toEqual({ [INTERNAL]: { 'pool-gpt': 0.96 } });
        expect(plan.steps).toEqual([]);
        await expect(publishSaleRules({ trigger: 'scheduler', actor: null })).resolves.toMatchObject({
            outcome: 'applied',
        });
    });

    it('does not apply a rule that ends inside the publish window', async () => {
        fake.db.rules = [rule({ effective_to: new Date(Date.now() + MINUTE) })];
        expect((await runSaleRuleSchedulerTick()).outcome).toBe('noop');
    });
});
