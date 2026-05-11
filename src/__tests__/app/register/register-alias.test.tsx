/**
 * fix/invite-landing — /register top-level alias redirects to /portal/register.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockRedirect = vi.fn((url: string) => {
    throw Object.assign(new Error('REDIRECT'), { _redirectUrl: url });
});
vi.mock('next/navigation', () => ({
    redirect: (url: string) => mockRedirect(url),
}));

import RegisterAliasPage from '@/app/register/page';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('/register alias', () => {
    it('no invite → redirects to /portal/register (clean)', async () => {
        await expect(RegisterAliasPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT');
        expect(mockRedirect).toHaveBeenCalledWith('/portal/register');
    });

    it('?invite=SMOKE001 → redirects to /portal/register?invite=SMOKE001', async () => {
        await expect(RegisterAliasPage({ searchParams: Promise.resolve({ invite: 'SMOKE001' }) })).rejects.toThrow(
            'REDIRECT',
        );
        expect(mockRedirect).toHaveBeenCalledWith('/portal/register?invite=SMOKE001');
    });

    it('encodes special characters in invite code', async () => {
        await expect(RegisterAliasPage({ searchParams: Promise.resolve({ invite: 'A&B+C' }) })).rejects.toThrow(
            'REDIRECT',
        );
        // encodeURIComponent: & → %26, + → %2B
        expect(mockRedirect).toHaveBeenCalledWith('/portal/register?invite=A%26B%2BC');
    });
});
