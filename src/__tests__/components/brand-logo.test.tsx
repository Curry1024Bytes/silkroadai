/**
 * BrandLogo fallback priority:
 *   1. logo_url              → custom <img>
 *   2. platform, no logo     → default LLmRoute <Logo> (platform unchanged)
 *   3. non-platform, no logo → brand_name text wordmark (P6b-2 §3.1)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const mockGetCurrentTenant = vi.fn();
vi.mock('@/lib/tenant/resolve', () => ({ getCurrentTenant: (...a: unknown[]) => mockGetCurrentTenant(...a) }));

import { BrandLogo } from '@/components/brand/BrandLogo';
import { Logo } from '@/components/brand/Logo';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = any;

beforeEach(() => vi.clearAllMocks());

describe('BrandLogo', () => {
    it('platform tenant, no logo_url → default <Logo>, props passed through (regression)', async () => {
        mockGetCurrentTenant.mockResolvedValue({
            id: PLATFORM_TENANT_ID,
            logo_url: null,
            brand_name: 'LLmRoute',
            primary_color: '#17201e',
        });
        const el: El = await BrandLogo({ variant: 'primary-flat', size: 28 });
        expect(el.type).toBe(Logo);
        expect(el.props.size).toBe(28);
        expect(el.props.variant).toBe('primary-flat');
    });

    it('non-platform tenant, no logo_url, linkHome=false → bare brand_name wordmark <span> in primary color', async () => {
        mockGetCurrentTenant.mockResolvedValue({
            id: 'tenant-acme',
            logo_url: null,
            brand_name: 'Acme AI',
            primary_color: '#ff0000',
        });
        const el: El = await BrandLogo({ size: 28, linkHome: false });
        expect(el.type).toBe('span');
        expect(el.props.children).toBe('Acme AI');
        expect(el.props.style.color).toBe('#ff0000');
    });

    it('non-platform tenant, no logo_url, linkHome=true → home link wrapping the wordmark <span>', async () => {
        mockGetCurrentTenant.mockResolvedValue({
            id: 'tenant-acme',
            logo_url: null,
            brand_name: 'Acme AI',
            primary_color: null,
        });
        const el: El = await BrandLogo({ size: 28 });
        const span: El = el.props.children; // Link > span
        expect(span.type).toBe('span');
        expect(span.props.children).toBe('Acme AI');
        expect(span.props.style.color).toBe('#1D1D1F'); // neutral wordmark default
    });

    it('logo_url set → custom <img> wrapped in a home link, alt = brand_name', async () => {
        mockGetCurrentTenant.mockResolvedValue({
            id: 'tenant-acme',
            logo_url: 'https://cdn/acme.png',
            brand_name: 'Acme',
        });
        const el: El = await BrandLogo({ size: 28 });
        const img: El = el.props.children; // Link > img
        expect(img.type).toBe('img');
        expect(img.props.src).toBe('https://cdn/acme.png');
        expect(img.props.alt).toBe('Acme');
        expect(img.props.height).toBe(28);
    });

    it('logo_url + linkHome=false → bare <img>, no link wrapper', async () => {
        mockGetCurrentTenant.mockResolvedValue({
            id: 'tenant-acme',
            logo_url: 'https://cdn/acme.png',
            brand_name: 'Acme',
        });
        const el: El = await BrandLogo({ size: 28, linkHome: false });
        expect(el.type).toBe('img');
    });
});
