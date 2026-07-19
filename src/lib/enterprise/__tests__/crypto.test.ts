/**
 * 独立门户上游 key AES-256-GCM 加解密单测(钱敏感周边:密文完整性 + env 守门)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptUpstreamKey, decryptUpstreamKey } from '../crypto';

const KEY = 'a'.repeat(64);

describe('enterprise crypto', () => {
    beforeEach(() => {
        process.env.ENTERPRISE_UPSTREAM_ENC_KEY = KEY;
    });
    afterEach(() => {
        delete process.env.ENTERPRISE_UPSTREAM_ENC_KEY;
    });

    it('roundtrip:encrypt → decrypt 还原明文', () => {
        const ct = encryptUpstreamKey('sk-upstream-secret-123');
        expect(ct).not.toContain('sk-upstream');
        expect(decryptUpstreamKey(ct)).toBe('sk-upstream-secret-123');
    });

    it('每次加密 iv 随机 → 同明文密文不同,都可解', () => {
        const a = encryptUpstreamKey('same');
        const b = encryptUpstreamKey('same');
        expect(a).not.toBe(b);
        expect(decryptUpstreamKey(a)).toBe('same');
        expect(decryptUpstreamKey(b)).toBe('same');
    });

    it('密文被篡改 → GCM 校验 throw', () => {
        const ct = encryptUpstreamKey('secret');
        const raw = Buffer.from(ct, 'base64');
        raw[raw.length - 1] ^= 0xff;
        expect(() => decryptUpstreamKey(raw.toString('base64'))).toThrow();
    });

    it('env 未配 / 非 64 hex → 明确报错', () => {
        delete process.env.ENTERPRISE_UPSTREAM_ENC_KEY;
        expect(() => encryptUpstreamKey('x')).toThrow(/ENTERPRISE_UPSTREAM_ENC_KEY/);
        process.env.ENTERPRISE_UPSTREAM_ENC_KEY = 'short';
        expect(() => encryptUpstreamKey('x')).toThrow(/64 hex/);
    });
});
