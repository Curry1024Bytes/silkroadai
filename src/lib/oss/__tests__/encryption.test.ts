/**
 * W9 D3 PR-C — AES-256-GCM encryption helper 单测(brief test 13)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../encryption';

const VALID_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes

describe('oss/encryption', () => {
    const original = process.env.PORTAL_OSS_ENC_KEY;
    beforeEach(() => {
        process.env.PORTAL_OSS_ENC_KEY = VALID_KEY;
    });
    afterEach(() => {
        process.env.PORTAL_OSS_ENC_KEY = original;
    });

    it('encrypt → decrypt roundtrip (test 13)', () => {
        const secret = 'AKIAIOSFODNN7EXAMPLE-secret-访问密钥';
        const ct = encryptSecret(secret);
        expect(ct).not.toContain(secret);
        expect(decryptSecret(ct)).toBe(secret);
    });

    it('every encryption uses a fresh IV (same plaintext → different ciphertext)', () => {
        expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
    });

    it('tampered ciphertext fails GCM auth (throws, not garbage)', () => {
        const ct = encryptSecret('secret');
        const raw = Buffer.from(ct, 'base64');
        raw[raw.length - 1] ^= 0xff; // flip last ciphertext byte
        expect(() => decryptSecret(raw.toString('base64'))).toThrow();
    });

    it('throws a clear error when PORTAL_OSS_ENC_KEY is missing', () => {
        delete process.env.PORTAL_OSS_ENC_KEY;
        expect(() => encryptSecret('x')).toThrow(/PORTAL_OSS_ENC_KEY/);
    });

    it('throws a clear error when key is wrong length / not hex', () => {
        process.env.PORTAL_OSS_ENC_KEY = 'deadbeef';
        expect(() => encryptSecret('x')).toThrow(/64 hex/);
        process.env.PORTAL_OSS_ENC_KEY = 'z'.repeat(64);
        expect(() => encryptSecret('x')).toThrow(/64 hex/);
    });

    it('rejects too-short ciphertext', () => {
        expect(() => decryptSecret(Buffer.from('short').toString('base64'))).toThrow(/corrupted/);
    });
});
