/**
 * W9 D3 PR-C — /settings/storage page SSR smoke(brief test 19)。
 * 镜像 portal-balance/balance-page.test.tsx 的模式。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';

const mockHeadersGet = vi.fn<(name: string) => string | null>();
vi.mock('next/headers', () => ({
    headers: vi.fn(async () => ({ get: mockHeadersGet })),
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
}));

const mockGetOssConfig = vi.fn();
vi.mock('@/lib/oss/store', () => ({
    getOssConfig: (...args: unknown[]) => mockGetOssConfig(...args),
}));

import StorageSettingsPage from '@/app/(authenticated)/settings/storage/page';

const USER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'oss@test.io' };

beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockReturnValue('silkroad_session=fake-jwt');
    mockGetCurrentUser.mockResolvedValue(USER);
});

describe('/settings/storage SSR', () => {
    it('renders without config (default mode)', async () => {
        mockGetOssConfig.mockResolvedValue(null);
        const html = renderToString(await StorageSettingsPage());
        expect(html).toContain('存储设置');
        expect(html).toContain('默认存储');
        expect(html).toContain('自定义对象存储');
    });

    it('renders saved-config summary with masked AK, never the secret', async () => {
        mockGetOssConfig.mockResolvedValue({
            provider: 'aliyun-oss',
            endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
            bucket: 'cust-bucket',
            region: null,
            access_key_id: 'LTAI1234567890ABCD',
            secret_access_key_encrypted: 'ENCRYPTED-BLOB',
            public_url_prefix: 'https://img.cust.com',
            cdn_enabled: false,
            status: 'active',
            last_test_at: new Date('2026-06-05T10:00:00Z'),
            last_test_message: null,
        });
        const html = renderToString(await StorageSettingsPage());
        expect(html).toContain('阿里云 OSS');
        expect(html).toContain('cust-bucket');
        expect(html).toContain('LTAI****ABCD');
        expect(html).not.toContain('ENCRYPTED-BLOB');
    });

    it('renders null (layout redirects) when no session', async () => {
        mockGetCurrentUser.mockResolvedValue(null);
        const result = await StorageSettingsPage();
        expect(result).toBeNull();
    });

    it('survives a store read failure — renders as unconfigured', async () => {
        mockGetOssConfig.mockRejectedValue(new Error('db down'));
        const html = renderToString(await StorageSettingsPage());
        expect(html).toContain('存储设置');
    });
});
