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
    schedulerEnabled: true,
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
vi.mock('@/lib/scheduler/sale-rules', () => ({ saleRuleSchedulerEnabled: () => fake.schedulerEnabled }));

vi.mock('@/lib/db', () => {
    const matches = (row: Row, where: Row = {}): boolean =>
        Object.entries(where).every(([key, value]) => {
            if (key === 'NOT') return !matches(row, value as Row);
            if (key === 'OR') return (value as Row[]).some((item) => matches(row, item));
            if (value && typeof value === 'object' && !(value instanceof Date)) {
                if ('in' in value) return (value.in as unknown[]).includes(row[key]);
                if ('not' in value) return row[key] !== value.not;
            }
            return row[key] === value;
        });
    const table = (rows: () => Row[], prefix: string) => ({
        findMany: vi.fn(async (args: { where?: Row } = {}) => rows().filter((row) => matches(row, args.where))),
        findFirst: vi.fn(async (args: { where?: Row } = {}) => rows().find((row) => matches(row, args.where)) ?? null),
        findUnique: vi.fn(async (args: { where: Row }) => {
            const where = (args.where.user_id_tier_key as Row | undefined) ?? args.where;
            return rows().find((row) => matches(row, where)) ?? null;
        }),
        count: vi.fn(async (args: { where?: Row } = {}) => rows().filter((row) => matches(row, args.where)).length),
        create: vi.fn(async (args: { data: Row }) => {
            const row = {
                id: `${prefix}-${rows().length + 1}`,
                created_at: new Date(),
                updated_at: new Date(),
                ...args.data,
            };
            rows().push(row);
            return row;
        }),
        update: vi.fn(async (args: { where: Row; data: Row }) => {
            const row = rows().find((item) => matches(item, args.where))!;
            return Object.assign(row, args.data, { updated_at: new Date() });
        }),
        updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
            const found = rows().filter((row) => matches(row, args.where));
            for (const row of found) Object.assign(row, args.data);
            return { count: found.length };
        }),
        delete: vi.fn(async (args: { where: Row }) => {
            const index = rows().findIndex((row) => matches(row, args.where));
            return rows().splice(index, 1)[0];
        }),
        upsert: vi.fn(async (args: { where: Row; create: Row; update: Row }) => {
            const row = rows().find((item) => matches(item, args.where));
            if (row) return Object.assign(row, args.update);
            const created = { id: `${prefix}-${rows().length + 1}`, ...args.create };
            rows().push(created);
            return created;
        }),
    });
    const db = {
        pricingBillingGroup: table(() => fake.db.groups, 'bg'),
        pricingSaleRule: table(() => fake.db.rules, 'rule'),
        catalogModel: table(() => fake.db.catalog, 'model'),
        pricingCostRule: table(() => fake.db.costRules, 'cost'),
        userTierMultiplier: table(() => fake.db.multipliers, 'utm'),
        pricingRulePublication: table(() => fake.db.publications, 'pub'),
        user: table(() => fake.db.portalUsers, 'user'),
        channelGroup: table(() => fake.db.channelGroups, 'cg'),
        adminAuditLog: table(() => fake.db.audits, 'audit'),
    };
    return { prisma: { ...db, $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)) } };
});
import type { AdminPrincipal } from '@/lib/admin/auth';
import {
    adoptBillingGroup,
    saveSaleRule,
    saveUnifiedSaleRatio,
    type Confirmation,
    type SaleRuleContext,
    type SaleRuleDraft,
} from '@/lib/pricing-rules/service';

const { TENANT, USER, INTERNAL } = fake;
const OTHER = '6f1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b';
const OTHER_INTERNAL = `portal-user-${OTHER.replaceAll('-', '')}`;
const decimal = (value: string) => new Prisma.Decimal(value);
const parsed = (key: string) => JSON.parse(fake.options[key] ?? '{}') as Record<string, unknown>;

function context(role: AdminPrincipal['role'] = 'superadmin', tenantId: string | null = null): SaleRuleContext {
    const admin = {
        role,
        tenant_id: tenantId,
        user: { id: 'a0000000-0000-4000-8000-000000000001', email: 'ops@example.com' },
        viaBreakGlass: false,
    } as unknown as AdminPrincipal;
    return { admin, ip: '127.0.0.1', userAgent: 'vitest', path: '/api/admin/pricing/sale-rules' };
}

const preview: Confirmation = { dry_run: true, confirm_increases: false };
const apply = (hash: string, extra: Partial<Confirmation> = {}): Confirmation => ({
    dry_run: false,
    impact_hash: hash,
    confirm_increases: false,
    ...extra,
});

function draft(overrides: Partial<SaleRuleDraft> = {}): SaleRuleDraft {
    return {
        kind: 'global_tier',
        tier_key: 'pool',
        user_id: null,
        model_id: null,
        discount: '0.5',
        effective_from: null,
        effective_to: null,
        enabled: true,
        note: null,
        ...overrides,
    };
}

function managedRow(ratio: string) {
    return {
        id: 'utm-1',
        user_id: USER,
        tier_key: 'pool',
        newapi_billing_group: 'pool-gpt',
        newapi_user_group: INTERNAL,
        original_newapi_user_group: 'default',
        multiplier: decimal(ratio),
        enabled: true,
        managed_by_rules: true,
        updated_at: new Date(),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    fake.options = {
        GroupRatio: '{"default":1,"pool-gpt":1.2}',
        GroupGroupRatio: '{}',
        UserUsableGroups: '{"default":"默认","pool-gpt":"GPT 池"}',
        'group_ratio_setting.group_special_usable_group': '{}',
        'billing_setting.scheduled_discount': '{}',
    };
    Object.assign(fake, { puts: [], failPut: null, readCount: 0, onRead: null, lockError: null, snapshots: 0 });
    fake.schedulerEnabled = true;
    fake.users = { 501: { id: 501, username: 'c-1', display_name: 'c-1', role: 1, status: 1, group: 'default' } };
    fake.tokens = { 501: [{ id: 9, group: 'pool-gpt' }] };
    fake.groupUserRatios = {};
    fake.channels = [{ id: 1, group: 'pool-gpt', models: 'gpt-a,gpt-b' }];
    fake.db = {
        groups: [{ tenant_id: TENANT, tier_key: 'pool', newapi_group: 'pool-gpt', unified_sale_ratio: decimal('1.2') }],
        rules: [],
        catalog: [],
        costRules: [],
        multipliers: [],
        publications: [],
        portalUsers: [{ id: USER, tenant_id: TENANT, newapi_user_id: 501, newapi_access_token: 'pat-501' }],
        channelGroups: [{ tenant_id: TENANT, key: 'pool', newapi_group: 'pool-gpt', enabled: true }],
        audits: [],
    };
});
describe('sale rule service', () => {
    it('previews a global sale, refuses an unconfirmed apply and publishes the confirmed one', async () => {
        const dry = await saveSaleRule(context(), { op: 'create', draft: draft() }, preview);
        expect(dry.applied).toBe(false);
        expect(dry.impact.changes).toEqual([
            { at: null, newapiGroup: 'pool-gpt', userId: null, before: 1.2, after: 0.6, increase: false },
        ]);
        expect(fake.db.rules).toEqual([]);
        await expect(
            saveSaleRule(context(), { op: 'create', draft: draft() }, apply('0'.repeat(64))),
        ).rejects.toMatchObject({ code: 'sale_rules_stale' });
        const saved = await saveSaleRule(context(), { op: 'create', draft: draft() }, apply(dry.impact.hash));
        expect(saved.applied).toBe(true);
        expect(fake.db.rules).toMatchObject([{ kind: 'global_tier', tier_key: 'pool', tenant_id: TENANT }]);
        expect(fake.db.audits.map((row) => row.action)).toEqual(
            expect.arrayContaining(['pricing_sale_rule_create', 'pricing_sale_rules_publish']),
        );
        expect(saved.publish).toMatchObject({ outcome: 'applied' });
        expect(parsed('GroupRatio')).toEqual({ default: 1, 'pool-gpt': 0.6 });
    });

    it('requires confirmation for a customer surcharge and then moves the customer', async () => {
        const change = {
            op: 'create' as const,
            draft: draft({ kind: 'customer_tier', user_id: USER, discount: '1.25' }),
        };
        const dry = await saveSaleRule(context(), change, preview);
        expect(dry.impact.increases).toEqual([
            { at: null, newapiGroup: 'pool-gpt', userId: USER, before: 1.2, after: 1.5, increase: true },
        ]);
        await expect(saveSaleRule(context(), change, apply(dry.impact.hash))).rejects.toMatchObject({
            code: 'sale_rules_increase_unconfirmed',
        });
        await saveSaleRule(context(), change, apply(dry.impact.hash, { confirm_increases: true }));
        expect(parsed('GroupGroupRatio')).toEqual({ [INTERNAL]: { 'pool-gpt': 1.5 } });
        expect(fake.users[501].group).toBe(INTERNAL);
    });

    it('lists the price going back up when a customer discount is deleted', async () => {
        fake.db.rules = [
            {
                id: 'r-1',
                tenant_id: TENANT,
                kind: 'customer_tier',
                user_id: USER,
                tier_key: 'pool',
                model_id: null,
                discount: decimal('0.8'),
                effective_from: null,
                effective_to: null,
                enabled: true,
                updated_at: new Date('2026-11-05T00:00:00.000Z'),
            },
        ];
        fake.db.multipliers = [managedRow('0.96')];
        fake.options.GroupGroupRatio = JSON.stringify({ [INTERNAL]: { 'pool-gpt': 0.96 } });
        fake.users[501].group = INTERNAL;
        const change = { op: 'delete' as const, id: 'r-1', expected_updated_at: '2026-11-05T00:00:00.000Z' };
        const dry = await saveSaleRule(context(), change, preview);
        expect(dry.impact.increases).toEqual([
            { at: null, newapiGroup: 'pool-gpt', userId: USER, before: 0.96, after: 1.2, increase: true },
        ]);
        await saveSaleRule(context(), change, apply(dry.impact.hash, { confirm_increases: true }));
        expect(fake.db.rules).toEqual([]);
        expect(parsed('GroupGroupRatio')).toEqual({});
        expect(fake.users[501].group).toBe('default');
        expect(fake.db.multipliers[0]).toMatchObject({ enabled: false });
    });

    it('refuses a rule for a customer that cannot be moved, and timed rules without the scheduler', async () => {
        fake.tokens[501] = [{ id: 9, group: '' }];
        const customer = draft({ kind: 'customer_tier', user_id: USER, discount: '0.8' });
        const dry = await saveSaleRule(context(), { op: 'create', draft: customer }, preview);
        expect(dry.impact.holds.map((item) => item.code)).toEqual(['move_in_blocked']);
        await expect(
            saveSaleRule(context(), { op: 'create', draft: customer }, apply(dry.impact.hash)),
        ).rejects.toMatchObject({ code: 'sale_rules_customer_held' });
        fake.schedulerEnabled = false;
        await expect(
            saveSaleRule(
                context(),
                { op: 'create', draft: draft({ effective_to: new Date(Date.now() + 86_400_000).toISOString() }) },
                preview,
            ),
        ).rejects.toMatchObject({ code: 'sale_rules_invalid' });
    });

    it('keeps global rules to superadmins and customers to their own tenant', async () => {
        await expect(
            saveSaleRule(context('admin', TENANT), { op: 'create', draft: draft() }, preview),
        ).rejects.toMatchObject({ code: 'sale_rules_forbidden' });
        const elsewhere = '7a1c2b8e-3d4a-4e5f-9a0b-1c2d3e4f5a6b';
        await expect(
            saveSaleRule(
                context('admin', elsewhere),
                { op: 'create', draft: draft({ kind: 'customer_tier', user_id: USER, discount: '0.8' }) },
                preview,
            ),
        ).rejects.toMatchObject({ code: 'sale_rules_customer_missing' });
        await expect(
            saveSaleRule(context(), { op: 'create', draft: draft({ tier_key: 'unknown' }) }, preview),
        ).rejects.toMatchObject({ code: 'sale_rules_invalid' });
    });
    it('adopts a group, converts an exact hand-made multiplier and keeps an out-of-range one', async () => {
        fake.db.groups = [];
        fake.db.portalUsers.push({ id: OTHER, tenant_id: TENANT, newapi_user_id: 502, newapi_access_token: 'pat-502' });
        fake.users[501].group = INTERNAL;
        fake.users[502] = { id: 502, username: 'c-2', display_name: 'c-2', role: 1, status: 1, group: OTHER_INTERNAL };
        fake.options.GroupGroupRatio = JSON.stringify({
            [INTERNAL]: { 'pool-gpt': 0.96 },
            [OTHER_INTERNAL]: { 'pool-gpt': 0.03 },
        });
        fake.db.multipliers = [
            { ...managedRow('0.96'), managed_by_rules: false },
            {
                ...managedRow('0.03'),
                id: 'utm-2',
                user_id: OTHER,
                newapi_user_group: OTHER_INTERNAL,
                managed_by_rules: false,
            },
        ];
        const dry = await adoptBillingGroup(context(), { tier_key: 'pool' }, preview);
        expect(dry.unifiedSaleRatio).toBe('1.2');
        expect(dry.conversion.converted).toEqual([{ rowId: 'utm-1', userId: USER, discount: '0.8', ratio: 0.96 }]);
        expect(dry.conversion.kept).toEqual([{ userId: OTHER, ratio: 0.03, reason: '换算折扣 0.025 超出 0.05 至 2' }]);
        expect(dry.impact.changes).toEqual([]);
        const done = await adoptBillingGroup(context(), { tier_key: 'pool' }, apply(dry.impact.hash));
        expect(done.applied).toBe(true);
        expect(fake.db.groups).toMatchObject([{ newapi_group: 'pool-gpt', tier_key: 'pool' }]);
        expect(String(fake.db.groups[0].unified_sale_ratio)).toBe('1.2');
        expect(fake.db.rules).toMatchObject([{ kind: 'customer_tier', user_id: USER, tier_key: 'pool' }]);
        expect(String(fake.db.rules[0].discount)).toBe('0.8');
        expect(fake.db.multipliers.map((row) => row.managed_by_rules)).toEqual([true, false]);
        expect(parsed('GroupGroupRatio')).toEqual({
            [INTERNAL]: { 'pool-gpt': 0.96 },
            [OTHER_INTERNAL]: { 'pool-gpt': 0.03 },
        });
        expect(fake.puts).toEqual([]);
    });

    it('refuses to adopt a group that another tier also bills through', async () => {
        fake.db.groups = [];
        fake.db.channelGroups.push({ tenant_id: TENANT, key: 'pool-b', newapi_group: 'pool-gpt', enabled: true });
        await expect(adoptBillingGroup(context(), { tier_key: 'pool' }, preview)).rejects.toMatchObject({
            code: 'sale_rules_invalid',
        });
    });

    it('moves discounted customers in proportion when the unified sale ratio changes', async () => {
        fake.db.rules = [
            {
                id: 'r-1',
                tenant_id: TENANT,
                kind: 'customer_tier',
                user_id: USER,
                tier_key: 'pool',
                model_id: null,
                discount: decimal('0.8'),
                effective_from: null,
                effective_to: null,
                enabled: true,
                updated_at: new Date(),
            },
        ];
        fake.db.multipliers = [managedRow('0.96')];
        fake.options.GroupGroupRatio = JSON.stringify({ [INTERNAL]: { 'pool-gpt': 0.96 } });
        fake.users[501].group = INTERNAL;
        const input = { tier_key: 'pool', unified_sale_ratio: '1.5' };
        const dry = await saveUnifiedSaleRatio(context(), input, preview);
        expect(dry.impact.changes).toEqual([
            { at: null, newapiGroup: 'pool-gpt', userId: null, before: 1.2, after: 1.5, increase: true },
            { at: null, newapiGroup: 'pool-gpt', userId: USER, before: 0.96, after: 1.2, increase: true },
        ]);
        await saveUnifiedSaleRatio(context(), input, apply(dry.impact.hash, { confirm_increases: true }));
        expect(String(fake.db.groups[0].unified_sale_ratio)).toBe('1.5');
        expect(parsed('GroupRatio')).toEqual({ default: 1, 'pool-gpt': 1.5 });
        expect(parsed('GroupGroupRatio')).toEqual({ [INTERNAL]: { 'pool-gpt': 1.2 } });
    });
});
