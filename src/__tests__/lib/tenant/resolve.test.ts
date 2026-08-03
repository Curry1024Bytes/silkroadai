import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindUnique = vi.fn();
const mockFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        tenant: {
            findUnique: (...a: unknown[]) => mockFindUnique(...a),
            findFirst: (...a: unknown[]) => mockFindFirst(...a),
        },
    },
}));
vi.mock('next/headers', () => ({ headers: vi.fn(async () => ({ get: () => null })) }));

import { resolveTenantByHost, normalizeHost } from '@/lib/tenant/resolve';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

function tenant(over: Record<string, unknown> = {}) {
    return {
        id: PLATFORM_TENANT_ID,
        slug: 'silkroadai',
        brand_name: 'LLmRoute',
        primary_domain: 'llmroute.club',
        status: 'active',
        prepaid_balance_cny: '0',
        logo_url: null,
        primary_color: '#17201e',
        support_email: 'support@llmroute.club',
        support_wechat: 'LLmRoute',
        domains: ['llmroute.club', 'www.llmroute.club', 'api.llmroute.club'],
        signup_enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
        ...over,
    };
}
const partner = tenant({
    id: 'tenant-7',
    slug: 'acme',
    brand_name: 'Acme',
    primary_domain: 'acme.com',
    domains: ['acme.com', 'www.acme.com'],
    logo_url: 'https://x/l.png',
    primary_color: '#FF0000',
});

beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue(tenant()); // getPlatformTenant
});

describe('normalizeHost', () => {
    it.each([
        ['Acme.COM:443', 'acme.com'],
        ['partner.example.com', 'partner.example.com'],
        ['Example.com.', 'example.com'],
        ['a.com, b.com', 'a.com'],
        ['', ''],
        [null, ''],
    ])('%s → %s', (input, out) => {
        expect(normalizeHost(input as string | null)).toBe(out);
    });
});

describe('resolveTenantByHost', () => {
    it('matches a partner domain (domains[] has)', async () => {
        mockFindFirst.mockResolvedValue(partner);
        const t = await resolveTenantByHost('acme.com');
        expect(t.id).toBe('tenant-7');
        expect(t.brand_name).toBe('Acme');
    });

    it('strips port + lowercases before matching', async () => {
        mockFindFirst.mockResolvedValue(partner);
        await resolveTenantByHost('WWW.Acme.com:443');
        expect(mockFindFirst.mock.calls[0][0].where.OR).toEqual([
            { domains: { has: 'www.acme.com' } },
            { primary_domain: 'www.acme.com' },
        ]);
    });

    it('no domain match → platform fallback', async () => {
        mockFindFirst.mockResolvedValue(null);
        const t = await resolveTenantByHost('unknown-host.example');
        expect(t.id).toBe(PLATFORM_TENANT_ID);
    });

    it('null host → platform, no DB domain query', async () => {
        const t = await resolveTenantByHost(null);
        expect(t.id).toBe(PLATFORM_TENANT_ID);
        expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it('DB domain query throws → platform fallback (never throws)', async () => {
        mockFindFirst.mockRejectedValue(new Error('db down'));
        const t = await resolveTenantByHost('flaky-host.example');
        expect(t.id).toBe(PLATFORM_TENANT_ID);
    });

    it('even platform read down → in-memory platform fallback (never throws)', async () => {
        mockFindFirst.mockRejectedValue(new Error('db down'));
        mockFindUnique.mockRejectedValue(new Error('db down'));
        const t = await resolveTenantByHost('totally-dead.example');
        expect(t.id).toBe(PLATFORM_TENANT_ID);
        expect(t.brand_name).toBe('LLmRoute');
        expect(t.support_email).toBe('support@llmroute.club');
    });
});
