/**
 * P6a: BrandLogo renders the tenant's logo_url image when set, else falls back
 * to the default Silk Road AI <Logo> (so the platform domain is unchanged).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetCurrentTenant = vi.fn();
vi.mock('@/lib/tenant/resolve', () => ({ getCurrentTenant: (...a: unknown[]) => mockGetCurrentTenant(...a) }));

import { BrandLogo } from '@/components/brand/BrandLogo';
import { Logo } from '@/components/brand/Logo';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = any;

beforeEach(() => vi.clearAllMocks());

describe('BrandLogo', () => {
    it('no logo_url (platform) → default <Logo>, props passed through', async () => {
        mockGetCurrentTenant.mockResolvedValue({ logo_url: null, brand_name: 'Silk Road AI' });
        const el: El = await BrandLogo({ variant: 'primary-flat', size: 28 });
        expect(el.type).toBe(Logo);
        expect(el.props.size).toBe(28);
        expect(el.props.variant).toBe('primary-flat');
    });

    it('logo_url set → custom <img> wrapped in a home link, alt = brand_name', async () => {
        mockGetCurrentTenant.mockResolvedValue({ logo_url: 'https://cdn/acme.png', brand_name: 'Acme' });
        const el: El = await BrandLogo({ size: 28 });
        const img: El = el.props.children; // Link > img
        expect(img.type).toBe('img');
        expect(img.props.src).toBe('https://cdn/acme.png');
        expect(img.props.alt).toBe('Acme');
        expect(img.props.height).toBe(28);
    });

    it('logo_url + linkHome=false → bare <img>, no link wrapper', async () => {
        mockGetCurrentTenant.mockResolvedValue({ logo_url: 'https://cdn/acme.png', brand_name: 'Acme' });
        const el: El = await BrandLogo({ size: 28, linkHome: false });
        expect(el.type).toBe('img');
    });
});
