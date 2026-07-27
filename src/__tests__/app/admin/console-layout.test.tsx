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
    // Safety net in case the real AdminShell isn't intercepted by the mock below.
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => '/admin',
}));

const mockGetAdminUser = vi.fn();
vi.mock('@/lib/admin/auth', () => ({
    getAdminUser: (...a: unknown[]) => mockGetAdminUser(...a),
}));

// Stub the client shell so the layout's returned tree renders without the
// full nav chrome (and without needing the real next/navigation hooks).
vi.mock('@/app/admin/(console)/admin-shell', () => ({
    AdminShell: ({ adminEmail, children }: { adminEmail: string; children: React.ReactNode }) => (
        <div data-testid="admin-shell" data-email={adminEmail}>
            {children}
        </div>
    ),
}));

import AdminConsoleLayout from '@/app/admin/(console)/layout';

beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockReturnValue('silkroad_session=fake-jwt');
});
afterEach(() => vi.restoreAllMocks());

describe('AdminConsoleLayout (server-side auth gate)', () => {
    it('redirects to /admin/login when there is no staff+ admin session', async () => {
        mockGetAdminUser.mockResolvedValue(null);
        await expect(AdminConsoleLayout({ children: <div /> })).rejects.toMatchObject({ message: 'REDIRECT' });
        expect(mockRedirect).toHaveBeenCalledWith('/admin/login');
    });

    it('renders the shell (with admin email) for a staff+ admin, no redirect', async () => {
        mockGetAdminUser.mockResolvedValue({ email: 'ops@llmroute.club', role: 'superadmin' });
        const tree = await AdminConsoleLayout({ children: <div>CHILD_OK</div> });
        const html = renderToString(tree);
        expect(html).toContain('ops@llmroute.club');
        expect(html).toContain('CHILD_OK');
        expect(mockRedirect).not.toHaveBeenCalled();
    });
});
