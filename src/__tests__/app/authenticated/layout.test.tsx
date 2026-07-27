/**
 * W4-2 D4 — Authenticated route group layout: auth gate + banner gate.
 *
 * The layout is a server async component, but it's still a function that
 * returns either a React tree or throws (via `redirect()` — Next signals
 * redirects by throwing a sentinel error). We mock `next/headers` +
 * `next/navigation` + `@/lib/auth/session` and call the function directly,
 * then assert on the redirect call OR render the returned JSX with
 * react-dom/server to inspect the markup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PLATFORM_TENANT_ID } from '@/lib/admin/tenant-scope';

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

const mockRedirect = vi.fn((url: string) => {
    // Mimic Next's redirect: throws so caller can't proceed
    throw Object.assign(new Error('REDIRECT'), { _redirectUrl: url });
});
vi.mock('next/navigation', () => ({
    redirect: (url: string) => mockRedirect(url),
    usePathname: () => '/dashboard',
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

// PR-U2: layout now calls fetchResellerStatus to decide whether to show
// the 代理后台 sidebar entry. Mock the helper so the layout test stays a
// pure SSR smoke without needing the resellers table on the test DB.
vi.mock('@/lib/reseller/fetch-status', () => ({
    fetchResellerStatus: vi.fn(async () => ({ isReseller: false })),
}));

// 公告 banner: layout 调 getActiveAnnouncements;mock 成空,保持 layout 为纯 SSR
// smoke 而不连 prisma(镜像 fetchResellerStatus 的处理)。
vi.mock('@/lib/announcements/fetch-active', () => ({
    getActiveAnnouncements: vi.fn(async () => []),
}));

// P6a: layout now reads getCurrentTenant (brand color) + renders async <BrandLogo>.
// Mock the tenant (platform values → no-op color) and render BrandLogo as the
// default <Logo> (sync) so renderToString works + the "LLmRoute" alt holds.
vi.mock('@/lib/tenant/resolve', () => ({
    getCurrentTenant: vi.fn(async () => ({
        id: PLATFORM_TENANT_ID,
        primary_color: '#0e1a2a',
        logo_url: null,
        brand_name: 'LLmRoute',
    })),
}));
vi.mock('@/components/brand/BrandLogo', async () => {
    const actual = await vi.importActual<typeof import('@/components/brand/Logo')>('@/components/brand/Logo');
    return { BrandLogo: (props: Record<string, unknown>) => actual.Logo(props) };
});

import AuthenticatedLayout from '@/app/(authenticated)/layout';

const VERIFIED_USER = {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    email: 'happy@llmroute.club',
    nickname: 'Happy',
    email_verified: true,
    status: 'active',
};
const UNVERIFIED_USER = { ...VERIFIED_USER, email_verified: false };

beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockImplementation((name: string) => {
        if (name === 'cookie') return 'silkroad_session=fake-jwt';
        if (name === 'x-invoke-path') return '/keys';
        return null;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('<AuthenticatedLayout />', () => {
    it('redirects to /login?next=<requested path> when no session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);

        await expect(AuthenticatedLayout({ children: <div>child</div> })).rejects.toMatchObject({
            message: 'REDIRECT',
        });

        expect(mockRedirect).toHaveBeenCalledWith('/login?next=%2Fkeys');
    });

    it('redirects to /login?next=/dashboard when path header is missing (fallback)', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        mockHeadersGet.mockImplementation((name) => (name === 'cookie' ? 'silkroad_session=fake-jwt' : null));

        await expect(AuthenticatedLayout({ children: <div /> })).rejects.toMatchObject({ message: 'REDIRECT' });

        expect(mockRedirect).toHaveBeenCalledWith('/login?next=%2Fdashboard');
    });

    it('renders header + sidebar + child for verified user, no banner', async () => {
        mockGetCurrentUser.mockResolvedValue(VERIFIED_USER);

        const tree = await AuthenticatedLayout({
            children: <div data-testid="child-content">CHILD_OK</div>,
        });
        const html = renderToString(tree);

        // Header chrome
        expect(html).toContain('LLmRoute');
        expect(html).toContain('logo-primary-flat');
        expect(html).not.toContain('data-platform-brand');
        expect(html).toContain('happy@llmroute.club');
        expect(html).toContain('退出');
        // Sidebar nav items
        expect(html).toContain('概览');
        expect(html).toContain('API Keys');
        // Child rendered
        expect(html).toContain('CHILD_OK');
        // No unverified banner
        expect(html).not.toContain('邮箱未验证');
        expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('renders + shows unverified banner when email_verified=false', async () => {
        mockGetCurrentUser.mockResolvedValue(UNVERIFIED_USER);

        const tree = await AuthenticatedLayout({
            children: <div>CHILD_OK</div>,
        });
        const html = renderToString(tree);

        // Banner present
        expect(html).toContain('邮箱未验证');
        expect(html).toContain('重发验证邮件');
        expect(html).toMatch(/role="alert"/);
        // Header + sidebar still rendered (soft-block — user can still browse)
        expect(html).toContain('happy@llmroute.club');
        expect(html).toContain('CHILD_OK');
        expect(mockRedirect).not.toHaveBeenCalled();
    });
});
