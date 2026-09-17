import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const wire = vi.hoisted(() => ({ query: vi.fn(), dispose: vi.fn() }));

// Keep the real generated Prisma client and query compiler. Only replace the
// network adapter, so this catches missing generated assets/runtime mismatches
// and proves the actual SQL compiled by Prisma remains a narrow SELECT.
vi.mock('@prisma/adapter-mariadb', () => ({
    PrismaMariaDb: class {
        provider = 'mysql' as const;
        adapterName = 'readonly-pricing-test';
        async connect() {
            return {
                provider: 'mysql' as const,
                adapterName: 'readonly-pricing-test',
                queryRaw: wire.query,
                executeRaw: () => {
                    throw new Error('Writes are forbidden');
                },
                executeScript: () => {
                    throw new Error('Scripts are forbidden');
                },
                startTransaction: () => {
                    throw new Error('Transactions are forbidden');
                },
                getConnectionInfo: () => ({ schemaName: 'newapi_fixture', supportsRelationJoins: false }),
                dispose: wire.dispose,
            };
        }
    },
}));

import { readPersistedPricingOptions, readPersistedTieredPricingOptions } from '@/lib/newapi/persisted-pricing';

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

it('the real generated MySQL client compiles only a parameterized four-option SELECT', async () => {
    vi.stubEnv('NEWAPI_PRICING_DATABASE_URL', 'mysql://readonly:fixture@localhost/newapi_fixture');
    wire.dispose.mockResolvedValue(undefined);
    wire.query.mockResolvedValue({
        columnNames: ['key', 'value'],
        columnTypes: [7, 7],
        rows: [
            ['ModelRatio', '{}'],
            ['CompletionRatio', '{}'],
            ['ModelPrice', '{}'],
            ['GroupRatio', '{}'],
        ],
    });
    expect(await readPersistedPricingOptions()).toEqual({
        ModelRatio: '{}',
        CompletionRatio: '{}',
        ModelPrice: '{}',
        GroupRatio: '{}',
    });
    expect(wire.query).toHaveBeenCalledOnce();
    const query = wire.query.mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(query.sql).toMatch(/^SELECT /);
    expect(query.sql).toContain('`options`.`key`');
    expect(query.sql).toContain('`options`.`value`');
    expect(query.sql).toContain(' IN (?,?,?,?)');
    expect(query.sql).not.toMatch(/INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|\*/);
    expect(query.args.slice(0, 4)).toEqual(['ModelRatio', 'CompletionRatio', 'ModelPrice', 'GroupRatio']);
    expect(wire.dispose).toHaveBeenCalledOnce();
});

it('the real client compiles a seven-option SELECT for tiered publication without requiring absent overrides', async () => {
    vi.stubEnv('NEWAPI_PRICING_DATABASE_URL', 'mysql://readonly:fixture@localhost/newapi_fixture');
    wire.dispose.mockResolvedValue(undefined);
    const stored = {
        ModelRatio: '{}',
        CompletionRatio: '{}',
        ModelPrice: '{}',
        GroupRatio: '{"enterprise":0.16}',
        'billing_setting.billing_mode': '{"gpt-5.5":"tiered_expr"}',
        'billing_setting.billing_expr': JSON.stringify({ 'gpt-5.5': 'tier("base", p * 5 + c * 30 + cr * 0.5)' }),
    };
    wire.query.mockResolvedValue({ columnNames: ['key', 'value'], columnTypes: [7, 7], rows: Object.entries(stored) });
    expect(await readPersistedTieredPricingOptions()).toEqual({ ...stored, GroupGroupRatio: '{}' });
    expect(wire.query).toHaveBeenCalledOnce();
    const query = wire.query.mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(query.sql).toMatch(/^SELECT /);
    expect(query.sql).toContain('`options`.`key`');
    expect(query.sql).toContain('`options`.`value`');
    expect(query.sql).toContain(' IN (?,?,?,?,?,?,?)');
    expect(query.sql).not.toMatch(/INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|\*/);
    expect(query.args.slice(0, 7)).toEqual([...Object.keys(stored), 'GroupGroupRatio']);
    expect(wire.dispose).toHaveBeenCalledOnce();
});
