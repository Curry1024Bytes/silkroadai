/**
 * /settings/storage — English locale SSR smoke (i18n). The zh default is pinned
 * by storage-page.test.tsx without any i18n mock; here `getLocale` resolves to
 * 'en' and the client form is wrapped in <LocaleProvider locale="en"> the way
 * the root layout does in production.
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

vi.mock('@/lib/i18n/server', () => ({
    getLocale: async () => 'en',
    getMessages: async (d: { en: unknown }) => d.en,
}));

import StorageSettingsPage from '@/app/(authenticated)/settings/storage/page';
import { StorageSettingsForm } from '@/app/(authenticated)/settings/storage/storage-form';
import { LocaleProvider } from '@/lib/i18n/client';

beforeEach(() => {
    vi.clearAllMocks();
    mockHeadersGet.mockReturnValue('silkroad_session=fake-jwt');
    mockGetCurrentUser.mockResolvedValue({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'oss@test.io' });
});

describe('/settings/storage SSR — English', () => {
    it('server shell renders the English heading / intro', async () => {
        mockGetOssConfig.mockResolvedValue(null);
        const html = renderToString(await StorageSettingsPage());
        expect(html).toContain('>Storage<');
        expect(html).toContain('Silk Road AI object storage');
        expect(html).toContain('images.silkroadai.io');
        expect(html).not.toContain('存储设置');
    });

    it('saved config renders the English provider label + en-US Beijing timestamp', async () => {
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
        const page = await StorageSettingsPage();
        const html = renderToString(<LocaleProvider locale="en">{page}</LocaleProvider>);
        expect(html).toContain('Alibaba Cloud OSS');
        expect(html).not.toContain('阿里云 OSS');
        expect(html).toContain('LTAI****ABCD');
        expect(html).toContain('Clear (back to default)');
        expect(html).toContain('Default storage (recommended)');
        expect(html).toContain('Custom object storage');
    });
});

describe('<StorageSettingsForm /> — English', () => {
    it('custom-mode fields, buttons and security note are English; prop override hint wins', () => {
        const html = renderToString(
            <LocaleProvider locale="en">
                <StorageSettingsForm
                    initialConfig={{
                        provider: 's3',
                        endpoint: null,
                        bucket: 'b',
                        region: 'us-east-1',
                        access_key_id_masked: 'AKIA****WXYZ',
                        public_url_prefix: 'https://cdn.example.com',
                        status: 'active',
                        last_test_at: null,
                    }}
                    defaultModeHint="custom hint from caller"
                />
            </LocaleProvider>,
        );
        expect(html).toContain('custom hint from caller');
        expect(html).toContain('Provider');
        expect(html).toContain('Public URL prefix');
        expect(html).toContain('Test connection');
        expect(html).toContain('Save config');
        expect(html).toContain('Saved (AKIA****WXYZ); re-enter to change');
        expect(html).toContain('Stored encrypted; re-enter to change');
        expect(html).toContain('Leave blank (AWS default; region required)');
        expect(html).toContain('least privilege');
        for (const zh of ['服务商', '测试连接', '保存配置', '公网访问前缀', '已加密存储'])
            expect(html, zh).not.toContain(zh);
    });
});
