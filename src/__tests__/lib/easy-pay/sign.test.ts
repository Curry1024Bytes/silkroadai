import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { generateSign, verifySign } from '@/lib/easy-pay/sign';

const TEST_PKEY = 'test-merchant-secret-key';

describe('EasyPay MD5 Sign', () => {
    const testParams: Record<string, string> = {
        pid: '1001',
        type: 'alipay',
        out_trade_no: 'order-001',
        notify_url: 'https://pay.example.com/api/easy-pay/notify',
        return_url: 'https://pay.example.com/pay/result',
        name: 'Test Product',
        money: '10.00',
        clientip: '127.0.0.1',
    };

    describe('generateSign', () => {
        it('should generate a valid MD5 hex string', () => {
            const sign = generateSign(testParams, TEST_PKEY);
            expect(sign).toBeTruthy();
            expect(sign).toMatch(/^[0-9a-f]{32}$/);
        });

        it('should produce consistent signatures for same input', () => {
            const sign1 = generateSign(testParams, TEST_PKEY);
            const sign2 = generateSign(testParams, TEST_PKEY);
            expect(sign1).toBe(sign2);
        });

        it('should sort parameters alphabetically', () => {
            const reversed: Record<string, string> = {};
            const keys = Object.keys(testParams).reverse();
            for (const key of keys) {
                reversed[key] = testParams[key];
            }
            const sign1 = generateSign(testParams, TEST_PKEY);
            const sign2 = generateSign(reversed, TEST_PKEY);
            expect(sign1).toBe(sign2);
        });

        it('should filter out empty values', () => {
            const paramsWithEmpty = { ...testParams, empty_field: '' };
            const sign1 = generateSign(testParams, TEST_PKEY);
            const sign2 = generateSign(paramsWithEmpty, TEST_PKEY);
            expect(sign1).toBe(sign2);
        });

        it('should exclude sign field from signing', () => {
            const paramsWithSign = { ...testParams, sign: 'old_sign' };
            const sign1 = generateSign(testParams, TEST_PKEY);
            const sign2 = generateSign(paramsWithSign, TEST_PKEY);
            expect(sign1).toBe(sign2);
        });

        it('should exclude sign_type field from signing', () => {
            const paramsWithSignType = { ...testParams, sign_type: 'MD5' };
            const sign1 = generateSign(testParams, TEST_PKEY);
            const sign2 = generateSign(paramsWithSignType, TEST_PKEY);
            expect(sign1).toBe(sign2);
        });

        it('should produce correct MD5 hash for known input', () => {
            // Manually compute expected: sorted keys → query string → append pkey → MD5
            const sorted = Object.entries(testParams)
                .filter(([, v]) => v !== '')
                .sort(([a], [b]) => a.localeCompare(b));
            const queryString = sorted.map(([k, v]) => `${k}=${v}`).join('&');
            const expected = crypto
                .createHash('md5')
                .update(queryString + TEST_PKEY)
                .digest('hex');

            const sign = generateSign(testParams, TEST_PKEY);
            expect(sign).toBe(expected);
        });

        it('should produce different signatures for different pkeys', () => {
            const sign1 = generateSign(testParams, TEST_PKEY);
            const sign2 = generateSign(testParams, 'different-key');
            expect(sign1).not.toBe(sign2);
        });

        it('should produce different signatures for different params', () => {
            const sign1 = generateSign(testParams, TEST_PKEY);
            const modified = { ...testParams, money: '99.99' };
            const sign2 = generateSign(modified, TEST_PKEY);
            expect(sign1).not.toBe(sign2);
        });
    });

    describe('verifySign', () => {
        it('should return true for a valid signature', () => {
            const sign = generateSign(testParams, TEST_PKEY);
            const valid = verifySign(testParams, TEST_PKEY, sign);
            expect(valid).toBe(true);
        });

        it('should return false for an invalid signature', () => {
            const valid = verifySign(testParams, TEST_PKEY, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            expect(valid).toBe(false);
        });

        it('should return false for tampered params', () => {
            const sign = generateSign(testParams, TEST_PKEY);
            const tampered = { ...testParams, money: '999.99' };
            const valid = verifySign(tampered, TEST_PKEY, sign);
            expect(valid).toBe(false);
        });

        it('should return false for wrong pkey', () => {
            const sign = generateSign(testParams, TEST_PKEY);
            const valid = verifySign(testParams, 'wrong-key', sign);
            expect(valid).toBe(false);
        });

        it('should return false when sign length differs (timing-safe guard)', () => {
            const valid = verifySign(testParams, TEST_PKEY, 'short');
            expect(valid).toBe(false);
        });

        it('should use timing-safe comparison (same length, different content)', () => {
            const sign = generateSign(testParams, TEST_PKEY);
            // Flip the first character to create a same-length but different sign
            const flipped = (sign[0] === 'a' ? 'b' : 'a') + sign.slice(1);
            const valid = verifySign(testParams, TEST_PKEY, flipped);
            expect(valid).toBe(false);
        });
    });
});
