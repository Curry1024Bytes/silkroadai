import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindMany = vi.fn();
const mockAggregate = vi.fn();
const mockFindUnique = vi.fn();

vi.mock('@/lib/db', () => ({
    prisma: {
        paymentProviderInstance: {
            findMany: (...args: unknown[]) => mockFindMany(...args),
            findUnique: (...args: unknown[]) => mockFindUnique(...args),
        },
        order: {
            aggregate: (...args: unknown[]) => mockAggregate(...args),
        },
    },
}));

vi.mock('@/lib/crypto', () => ({
    decrypt: (text: string) => text.replace(/^enc:/, ''),
}));

vi.mock('@/lib/time/biz-day', () => ({
    getBizDayStartUTC: () => new Date('2026-04-01T00:00:00Z'),
}));

function makeInstance(id: string, sortOrder: number, supportedTypes: string | null = null) {
    return {
        id,
        providerKey: 'easypay',
        name: `Instance ${id}`,
        config: `enc:${JSON.stringify({ pid: id, pkey: `key-${id}` })}`,
        enabled: true,
        sortOrder,
        supportedTypes,
    };
}

describe('load-balancer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset module to clear round-robin counters
        vi.resetModules();
    });

    describe('selectInstance - round-robin', () => {
        it('returns null when no enabled instances', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            mockFindMany.mockResolvedValue([]);

            const result = await selectInstance('easypay');
            expect(result).toBeNull();
        });

        it('selects single instance', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            mockFindMany.mockResolvedValue([makeInstance('a', 0)]);

            const result = await selectInstance('easypay');
            expect(result).not.toBeNull();
            expect(result!.instanceId).toBe('a');
            expect(result!.config.pid).toBe('a');
        });

        it('cycles through instances in round-robin order', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            const instances = [makeInstance('a', 0), makeInstance('b', 1), makeInstance('c', 2)];
            mockFindMany.mockResolvedValue(instances);

            const r1 = await selectInstance('easypay');
            const r2 = await selectInstance('easypay');
            const r3 = await selectInstance('easypay');
            const r4 = await selectInstance('easypay'); // wraps around

            expect(r1!.instanceId).toBe('a');
            expect(r2!.instanceId).toBe('b');
            expect(r3!.instanceId).toBe('c');
            expect(r4!.instanceId).toBe('a');
        });
    });

    describe('selectInstance - least-amount', () => {
        it('selects instance with smallest daily total', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            const instances = [makeInstance('a', 0), makeInstance('b', 1)];
            mockFindMany.mockResolvedValue(instances);

            // Instance 'a' has 500 today, instance 'b' has 100 today
            mockAggregate
                .mockResolvedValueOnce({ _sum: { payAmount: 500 } })
                .mockResolvedValueOnce({ _sum: { payAmount: 100 } });

            const result = await selectInstance('easypay', 'least-amount');
            expect(result!.instanceId).toBe('b');
        });

        it('treats null payAmount sum as 0', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            mockFindMany.mockResolvedValue([makeInstance('a', 0), makeInstance('b', 1)]);

            mockAggregate
                .mockResolvedValueOnce({ _sum: { payAmount: 200 } })
                .mockResolvedValueOnce({ _sum: { payAmount: null } }); // no orders today

            const result = await selectInstance('easypay', 'least-amount');
            expect(result!.instanceId).toBe('b');
        });
    });

    describe('selectInstance - payment type filtering', () => {
        it('includes instances with matching supportedTypes', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            mockFindMany.mockResolvedValue([makeInstance('a', 0, 'alipay,wxpay'), makeInstance('b', 1, 'stripe')]);

            const result = await selectInstance('easypay', 'round-robin', 'alipay');
            expect(result!.instanceId).toBe('a');
        });

        it('includes instances with null supportedTypes (wildcard)', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            mockFindMany.mockResolvedValue([
                makeInstance('a', 0, 'stripe'),
                makeInstance('b', 1, null), // supports all
            ]);

            const result = await selectInstance('easypay', 'round-robin', 'alipay');
            expect(result!.instanceId).toBe('b');
        });

        it('includes instances with empty supportedTypes (wildcard)', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            mockFindMany.mockResolvedValue([makeInstance('a', 0, '')]);

            const result = await selectInstance('easypay', 'round-robin', 'alipay');
            expect(result!.instanceId).toBe('a');
        });

        it('returns null when no instances match paymentType', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            mockFindMany.mockResolvedValue([makeInstance('a', 0, 'stripe'), makeInstance('b', 1, 'wxpay')]);

            const result = await selectInstance('easypay', 'round-robin', 'alipay');
            expect(result).toBeNull();
        });

        it('returns all instances when paymentType is not specified', async () => {
            const { selectInstance } = await import('@/lib/payment/load-balancer');
            mockFindMany.mockResolvedValue([makeInstance('a', 0, 'stripe'), makeInstance('b', 1, 'wxpay')]);

            const result = await selectInstance('easypay');
            expect(result).not.toBeNull();
        });
    });

    describe('getInstanceConfig', () => {
        it('returns decrypted config for existing instance', async () => {
            const { getInstanceConfig } = await import('@/lib/payment/load-balancer');
            mockFindUnique.mockResolvedValue(makeInstance('a', 0));

            const config = await getInstanceConfig('a');
            expect(config).toEqual({ pid: 'a', pkey: 'key-a' });
        });

        it('returns null for nonexistent instance', async () => {
            const { getInstanceConfig } = await import('@/lib/payment/load-balancer');
            mockFindUnique.mockResolvedValue(null);

            const config = await getInstanceConfig('nonexistent');
            expect(config).toBeNull();
        });
    });
});
