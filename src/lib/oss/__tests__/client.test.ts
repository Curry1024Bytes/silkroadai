/**
 * W9 D3 PR-C — 客户 OSS S3 client 单测(brief tests 14-15 + URL 组装)。
 * Mock @aws-sdk/client-s3(镜像 src/lib/r2/__tests__/client.test.ts 的模式)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();

interface CapturedCommand {
    type: string;
    input: Record<string, unknown>;
}
let captured: CapturedCommand[] = [];
let lastClientConfig: Record<string, unknown> | null = null;

vi.mock('@aws-sdk/client-s3', () => {
    class S3Client {
        send = mockSend;
        constructor(config: Record<string, unknown>) {
            lastClientConfig = config;
        }
    }
    class PutObjectCommand {
        constructor(public input: Record<string, unknown>) {
            captured.push({ type: 'PutObject', input });
        }
    }
    class DeleteObjectCommand {
        constructor(public input: Record<string, unknown>) {
            captured.push({ type: 'DeleteObject', input });
        }
    }
    class DeleteObjectsCommand {
        constructor(public input: Record<string, unknown>) {
            captured.push({ type: 'DeleteObjects', input });
        }
    }
    return { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand };
});

import { encryptSecret } from '../encryption';
import { testOssConnection, uploadToCustomerOss, type OssConfigLike } from '../client';

const VALID_KEY = 'b'.repeat(64);

function makeConfig(overrides: Partial<OssConfigLike> = {}): OssConfigLike {
    return {
        provider: 'r2',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        bucket: 'customer-bucket',
        region: null,
        access_key_id: 'AKID',
        secret_access_key_encrypted: encryptSecret('SECRET'),
        public_url_prefix: 'https://images.example.com/',
        ...overrides,
    };
}

describe('oss/client', () => {
    beforeEach(() => {
        process.env.PORTAL_OSS_ENC_KEY = VALID_KEY;
        vi.clearAllMocks();
        captured = [];
        lastClientConfig = null;
    });

    it('uploadToCustomerOss puts to customer bucket and returns prefix URL (trailing slash normalized)', async () => {
        mockSend.mockResolvedValue({});
        const url = await uploadToCustomerOss(makeConfig(), Buffer.from('img'), 'gen/u1.png', 'image/png');
        expect(url).toBe('https://images.example.com/gen/u1.png'); // 无双斜杠
        const put = captured.find((c) => c.type === 'PutObject');
        expect(put?.input.Bucket).toBe('customer-bucket');
        expect(put?.input.Key).toBe('gen/u1.png');
        expect(put?.input.ContentType).toBe('image/png');
        // 凭证已解密注入 S3Client
        const creds = lastClientConfig?.credentials as { accessKeyId: string; secretAccessKey: string };
        expect(creds.accessKeyId).toBe('AKID');
        expect(creds.secretAccessKey).toBe('SECRET');
    });

    it('s3-custom uses forcePathStyle', async () => {
        mockSend.mockResolvedValue({});
        await uploadToCustomerOss(
            makeConfig({ provider: 's3-custom', endpoint: 'https://minio.example.com' }),
            Buffer.from('x'),
            'k.png',
            'image/png',
        );
        expect(lastClientConfig?.forcePathStyle).toBe(true);
    });

    it('testOssConnection success: put + delete temp object, returns ok (test 14)', async () => {
        mockSend.mockResolvedValue({});
        const result = await testOssConnection(makeConfig());
        expect(result).toEqual({ ok: true });
        expect(captured.map((c) => c.type)).toEqual(['PutObject', 'DeleteObject']);
        expect(String(captured[0].input.Key)).toMatch(/^__silkroadai_test_\d+\.txt$/);
    });

    it('testOssConnection failure: returns ok:false + message, does NOT throw (test 15)', async () => {
        mockSend.mockRejectedValue(new Error('AccessDenied: invalid credentials'));
        const result = await testOssConnection(makeConfig());
        expect(result.ok).toBe(false);
        expect(result.message).toContain('AccessDenied');
    });

    it('testOssConnection with bad encryption key returns ok:false (decrypt throws inside)', async () => {
        const config = makeConfig();
        process.env.PORTAL_OSS_ENC_KEY = 'c'.repeat(64); // 换 key → decrypt 失败
        const result = await testOssConnection(config);
        expect(result.ok).toBe(false);
    });
});
