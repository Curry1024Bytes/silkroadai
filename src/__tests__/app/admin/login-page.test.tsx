import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

const mockRedirect = vi.fn((url: string) => {
    throw Object.assign(new Error('REDIRECT'), { _redirectUrl: url });
});
vi.mock('next/navigation', () => ({
    redirect: (url: string) => mockRedirect(url),
}));

const mockGetCurrentUser = vi.fn();
const mockGetAdminUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...a: unknown[]) => mockGetCurrentUser(...a),
}));
vi.mock('@/lib/admin/auth', () => ({
    getAdminUser: (...a: unknown[]) => mockGetAdminUser(...a),
}));

import AdminLoginPage from '@/app/admin/login/page';

beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockReturnValue('silkroad_session=fake-jwt');
});
afterEach(() => vi.restoreAllMocks());

describe('AdminLoginPage', () => {
    it('redirects to /admin when the visitor is already a staff+ admin', async () => {
        mockGetCurrentUser.mockResolvedValue({ email: 'ops@x.io', role: 'superadmin' });
        mockGetAdminUser.mockResolvedValue({ email: 'ops@x.io', role: 'superadmin' });
        await expect(AdminLoginPage()).rejects.toMatchObject({ message: 'REDIRECT' });
        expect(mockRedirect).toHaveBeenCalledWith('/admin');
    });

    it('shows a no-permission notice for a logged-in non-admin (customer)', async () => {
        mockGetCurrentUser.mockResolvedValue({ email: 'cust@x.io', role: 'customer' });
        mockGetAdminUser.mockResolvedValue(null);
        const html = renderToString(await AdminLoginPage());
        expect(html).toContain('没有管理后台权限');
        expect(html).toContain('cust@x.io');
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('renders the email/password form when not logged in', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        mockGetAdminUser.mockResolvedValue(null);
        const html = renderToString(await AdminLoginPage());
        expect(html).toContain('管理员登录');
        expect(html).toContain('邮箱');
        expect(html).toContain('密码');
        expect(mockRedirect).not.toHaveBeenCalled();
    });
});
