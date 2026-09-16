import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedirect = vi.fn((url: string) => {
    throw Object.assign(new Error('REDIRECT'), { _redirectUrl: url });
});

vi.mock('next/navigation', () => ({
    redirect: (url: string) => mockRedirect(url),
}));

import PricingCalculatorPage from '@/app/admin/(console)/pricing-calculator/page';

beforeEach(() => vi.clearAllMocks());

describe('legacy pricing calculator redirect', () => {
    it('sends an old calculator bookmark to the pricing workbench', async () => {
        await expect(PricingCalculatorPage({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({
            _redirectUrl: '/admin/pricing',
        });
    });

    it.each([
        { lang: 'en', theme: 'dark', ui_mode: 'embedded' },
        { lang: 'zh', theme: 'light', ui_mode: 'standalone' },
    ])('preserves supported presentation preferences: %j', async (preferences) => {
        await expect(PricingCalculatorPage({ searchParams: Promise.resolve(preferences) })).rejects.toMatchObject({
            _redirectUrl: `/admin/pricing?${new URLSearchParams(preferences).toString()}`,
        });
    });

    it('drops legacy credentials, arbitrary query values, and invalid preferences', async () => {
        await expect(
            PricingCalculatorPage({
                searchParams: Promise.resolve({
                    token: 'legacy-test-token',
                    next: 'https://example.invalid',
                    model: 'untrusted-model',
                    lang: 'unsupported',
                    theme: ['light', 'dark'],
                    ui_mode: 'https://example.invalid',
                }),
            }),
        ).rejects.toMatchObject({ _redirectUrl: '/admin/pricing' });
    });
});
