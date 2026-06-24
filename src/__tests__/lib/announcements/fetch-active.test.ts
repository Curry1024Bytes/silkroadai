/**
 * getActiveAnnouncements — where 子句(全局 + 租户)、排序、take、序列化。
 * 每个用例用不同 tenantId,避免 React cache() 在同参数下命中缓存干扰断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindMany = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: { announcement: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}));

import { getActiveAnnouncements } from '@/lib/announcements/fetch-active';

const row = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    title: 't',
    body: 'b',
    level: 'info',
    link_url: null,
    link_label: null,
    created_at: new Date('2026-06-24T00:00:00.000Z'),
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
});

describe('getActiveAnnouncements', () => {
    it('global-only (tenantId=null): is_active + OR[tenant_id:null], desc, take 5', async () => {
        await getActiveAnnouncements(null);
        const arg = mockFindMany.mock.calls[0][0];
        expect(arg.where.is_active).toBe(true);
        expect(arg.where.OR).toEqual([{ tenant_id: null }]);
        expect(arg.orderBy).toEqual({ created_at: 'desc' });
        expect(arg.take).toBe(5);
    });
    it('tenant scoped: OR includes both null and the tenant id', async () => {
        await getActiveAnnouncements('tenant-9');
        const arg = mockFindMany.mock.calls[0][0];
        expect(arg.where.OR).toEqual([{ tenant_id: null }, { tenant_id: 'tenant-9' }]);
    });
    it('serializes created_at Date → ISO string, passes fields through', async () => {
        mockFindMany.mockResolvedValue([row({ id: 'x', title: 'Hi' })]);
        const out = await getActiveAnnouncements('tenant-iso');
        expect(out[0]).toMatchObject({ id: 'x', title: 'Hi', level: 'info' });
        expect(out[0].created_at).toBe('2026-06-24T00:00:00.000Z');
    });
});
