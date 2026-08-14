/**
 * Seedance 成片落客户自定义 OSS 单测(2026-08-14)。
 * 覆盖:未配置/非 active → null(回退);已配置 → 下载+上传客户桶返客户 URL;
 * 幂等(HEAD 命中不重传);上游 fetch 失败 / 超大 / 空 → null;config 查询异常 → null。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOssConfig, objectExistsInOss, ossPublicUrl, uploadToCustomerOss } = vi.hoisted(() => ({
    getOssConfig: vi.fn(),
    objectExistsInOss: vi.fn(),
    ossPublicUrl: vi.fn((cfg: { public_url_prefix: string }, key: string) => `${cfg.public_url_prefix}/${key}`),
    uploadToCustomerOss: vi.fn(
        async (cfg: { public_url_prefix: string }, _b: Buffer, key: string) => `${cfg.public_url_prefix}/${key}`,
    ),
}));
vi.mock('@/lib/oss/store', () => ({ getOssConfig }));
vi.mock('@/lib/oss/client', () => ({ objectExistsInOss, ossPublicUrl, uploadToCustomerOss }));

import { maybeStoreVideoToCustomerOss, customerVideoKey } from '../customer-oss-video';

const CONFIG = {
    id: 'o1',
    user_id: 'u1',
    provider: 'r2',
    endpoint: 'https://acc.r2.cloudflarestorage.com',
    bucket: 'cust-bucket',
    region: null,
    access_key_id: 'AK',
    secret_access_key_encrypted: 'enc',
    public_url_prefix: 'https://cdn.customer.com',
    cdn_enabled: false,
    status: 'active',
    last_test_at: null,
    last_test_message: null,
    created_at: new Date(),
    updated_at: new Date(),
};
const UP = 'https://ark-signed.volces.com/out.mp4?sig=xyz';
const mockFetch = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    ossPublicUrl.mockImplementation(
        (cfg: { public_url_prefix: string }, key: string) => `${cfg.public_url_prefix}/${key}`,
    );
    uploadToCustomerOss.mockImplementation(
        async (cfg: { public_url_prefix: string }, _b: Buffer, key: string) => `${cfg.public_url_prefix}/${key}`,
    );
    mockFetch.mockResolvedValue(
        new Response(Buffer.from([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'video/mp4' } }),
    );
    global.fetch = mockFetch as typeof fetch;
});

describe('maybeStoreVideoToCustomerOss', () => {
    it('未配置 OSS → null(回退上游),不下载不上传', async () => {
        getOssConfig.mockResolvedValue(null);
        const r = await maybeStoreVideoToCustomerOss({ userId: 'u1', taskId: 'cgt-1', upstreamUrl: UP });
        expect(r).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
        expect(uploadToCustomerOss).not.toHaveBeenCalled();
    });

    it('status≠active → null', async () => {
        getOssConfig.mockResolvedValue({ ...CONFIG, status: 'disabled' });
        const r = await maybeStoreVideoToCustomerOss({ userId: 'u1', taskId: 'cgt-1', upstreamUrl: UP });
        expect(r).toBeNull();
    });

    it('已配置 + 桶内无此对象 → 下载上游成片 + 上传客户桶 + 返客户 URL', async () => {
        getOssConfig.mockResolvedValue(CONFIG);
        objectExistsInOss.mockResolvedValue(false);
        const r = await maybeStoreVideoToCustomerOss({ userId: 'u1', taskId: 'cgt-9', upstreamUrl: UP });
        expect(mockFetch).toHaveBeenCalledWith(UP, expect.objectContaining({ signal: expect.anything() }));
        expect(uploadToCustomerOss).toHaveBeenCalledWith(CONFIG, expect.any(Buffer), 'seedance/cgt-9.mp4', 'video/mp4');
        expect(r).toBe('https://cdn.customer.com/seedance/cgt-9.mp4');
    });

    it('幂等:桶内已存在同 key → 直接拼 URL,不重复下载/上传', async () => {
        getOssConfig.mockResolvedValue(CONFIG);
        objectExistsInOss.mockResolvedValue(true);
        const r = await maybeStoreVideoToCustomerOss({ userId: 'u1', taskId: 'cgt-9', upstreamUrl: UP });
        expect(r).toBe('https://cdn.customer.com/seedance/cgt-9.mp4');
        expect(mockFetch).not.toHaveBeenCalled();
        expect(uploadToCustomerOss).not.toHaveBeenCalled();
    });

    it('上游 fetch 非 2xx → null(回退)', async () => {
        getOssConfig.mockResolvedValue(CONFIG);
        objectExistsInOss.mockResolvedValue(false);
        mockFetch.mockResolvedValue(new Response('nope', { status: 403 }));
        const r = await maybeStoreVideoToCustomerOss({ userId: 'u1', taskId: 'cgt-9', upstreamUrl: UP });
        expect(r).toBeNull();
        expect(uploadToCustomerOss).not.toHaveBeenCalled();
    });

    it('上游成片超 300MB → null(不转存)', async () => {
        getOssConfig.mockResolvedValue(CONFIG);
        objectExistsInOss.mockResolvedValue(false);
        mockFetch.mockResolvedValue(
            new Response(Buffer.from([1]), {
                status: 200,
                headers: { 'content-type': 'video/mp4', 'content-length': String(301 * 1024 * 1024) },
            }),
        );
        const r = await maybeStoreVideoToCustomerOss({ userId: 'u1', taskId: 'cgt-9', upstreamUrl: UP });
        expect(r).toBeNull();
        expect(uploadToCustomerOss).not.toHaveBeenCalled();
    });

    it('config 查询抛异常 → null(不断流)', async () => {
        getOssConfig.mockRejectedValue(new Error('db down'));
        const r = await maybeStoreVideoToCustomerOss({ userId: 'u1', taskId: 'cgt-9', upstreamUrl: UP });
        expect(r).toBeNull();
    });

    it('空 upstreamUrl → null', async () => {
        const r = await maybeStoreVideoToCustomerOss({ userId: 'u1', taskId: 'cgt-9', upstreamUrl: '' });
        expect(r).toBeNull();
        expect(getOssConfig).not.toHaveBeenCalled();
    });

    it('customerVideoKey:seedance/{taskId}.mp4', () => {
        expect(customerVideoKey('cgt-abc')).toBe('seedance/cgt-abc.mp4');
    });
});
