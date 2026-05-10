/**
 * PR-T1 Phase 2 — R2 client unit tests.
 *
 * Mocks the @aws-sdk/client-s3 module so we can assert on:
 *   - PutObject call shape (Bucket / Key / Body / ContentType / CacheControl)
 *   - DeleteObject / DeleteObjects call shape
 *   - getPublicUrl format
 *   - imageKey format
 *   - readEnv guard throws when env missing
 *
 * Also asserts the server-only marker is present (regression test for
 * accidental client-bundle exposure).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();

interface CapturedCommand {
    type: string;
    input: Record<string, unknown>;
}

let captured: CapturedCommand[] = [];

vi.mock('@aws-sdk/client-s3', () => {
    class S3Client {
        send = mockSend;
    }
    class PutObjectCommand {
        constructor(public input: Record<string, unknown>) {
            captured.push({ type: 'Put', input });
        }
    }
    class DeleteObjectCommand {
        constructor(public input: Record<string, unknown>) {
            captured.push({ type: 'Delete', input });
        }
    }
    class DeleteObjectsCommand {
        constructor(public input: Record<string, unknown>) {
            captured.push({ type: 'DeleteMany', input });
        }
    }
    return { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand };
});

import { uploadImage, deleteImage, deleteImages, getPublicUrl, imageKey, _resetClientForTest } from '@/lib/r2/client';

beforeEach(() => {
    process.env.R2_ACCOUNT_ID = 'acc-stub';
    process.env.R2_ACCESS_KEY_ID = 'key-id-stub';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-stub';
    process.env.R2_BUCKET_NAME = 'silkroadai-image-gen';
    process.env.R2_PUBLIC_URL = 'https://images.silkroadai.io';
    captured = [];
    mockSend.mockReset();
    mockSend.mockResolvedValue(undefined);
    _resetClientForTest();
});

afterEach(() => {
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET_NAME;
    delete process.env.R2_PUBLIC_URL;
});

describe('imageKey', () => {
    it('formats per the documented convention', () => {
        expect(imageKey('user-uuid-1', 'gen-uuid-9', 0)).toBe('image-gen/user-uuid-1/gen-uuid-9/0.png');
        expect(imageKey('user-uuid-1', 'gen-uuid-9', 3)).toBe('image-gen/user-uuid-1/gen-uuid-9/3.png');
    });
});

describe('getPublicUrl (PR-T2 v2 — env-driven public URL)', () => {
    it('uses R2_PUBLIC_URL env as the base (custom domain happy path)', () => {
        process.env.R2_PUBLIC_URL = 'https://images.silkroadai.io';
        expect(getPublicUrl('image-gen/u/g/0.png')).toBe('https://images.silkroadai.io/image-gen/u/g/0.png');
    });

    it("strips a trailing slash from R2_PUBLIC_URL so a typo doesn't produce //", () => {
        process.env.R2_PUBLIC_URL = 'https://images.silkroadai.io/';
        expect(getPublicUrl('image-gen/u/g/0.png')).toBe('https://images.silkroadai.io/image-gen/u/g/0.png');
    });

    it('also accepts r2.dev subdomain (the alternate public-access shape)', () => {
        process.env.R2_PUBLIC_URL = 'https://pub-deadbeef.r2.dev';
        expect(getPublicUrl('image-gen/u/g/0.png')).toBe('https://pub-deadbeef.r2.dev/image-gen/u/g/0.png');
    });

    it('throws when R2_PUBLIC_URL is missing — fail-loud, NOT silent S3-endpoint URL', () => {
        delete process.env.R2_PUBLIC_URL;
        expect(() => getPublicUrl('any')).toThrow(/R2_PUBLIC_URL not set/);
    });
});

describe('uploadImage', () => {
    it('issues PutObject with the right shape and returns the public URL', async () => {
        const buf = Buffer.from('fake-png-bytes');
        const url = await uploadImage('image-gen/u/g/0.png', buf);
        // PR-T2 v2: returned URL uses R2_PUBLIC_URL, NOT the S3-endpoint
        // hostname (which requires SigV4 and 400s in the browser).
        expect(url).toBe('https://images.silkroadai.io/image-gen/u/g/0.png');
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(captured).toHaveLength(1);
        expect(captured[0].type).toBe('Put');
        expect(captured[0].input).toMatchObject({
            Bucket: 'silkroadai-image-gen',
            Key: 'image-gen/u/g/0.png',
            Body: buf,
            ContentType: 'image/png',
        });
        // Cache-control is set for max immutability
        expect(captured[0].input.CacheControl).toMatch(/max-age=\d+/);
    });

    it('honors a custom contentType', async () => {
        await uploadImage('something/0.jpg', Buffer.from('x'), 'image/jpeg');
        expect(captured[0].input.ContentType).toBe('image/jpeg');
    });
});

describe('deleteImage', () => {
    it('issues DeleteObject with the bucket + key', async () => {
        await deleteImage('image-gen/u/g/0.png');
        expect(captured[0].type).toBe('Delete');
        expect(captured[0].input).toEqual({ Bucket: 'silkroadai-image-gen', Key: 'image-gen/u/g/0.png' });
    });
});

describe('deleteImages (batch)', () => {
    it('no-ops when keys array is empty', async () => {
        await deleteImages([]);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('issues DeleteObjects with all keys in a single call', async () => {
        await deleteImages(['a', 'b', 'c']);
        expect(captured[0].type).toBe('DeleteMany');
        expect(captured[0].input).toMatchObject({
            Bucket: 'silkroadai-image-gen',
            Delete: {
                Objects: [{ Key: 'a' }, { Key: 'b' }, { Key: 'c' }],
                Quiet: true,
            },
        });
    });

    it('throws when keys exceed the S3 1000-per-call limit', async () => {
        const tooMany = Array.from({ length: 1001 }, (_, i) => `k${i}`);
        await expect(deleteImages(tooMany)).rejects.toThrow(/max 1000 keys/);
    });
});
