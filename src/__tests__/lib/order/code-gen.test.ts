import { describe, it, expect } from 'vitest';
import { generateRechargeCode } from '@/lib/order/code-gen';

describe('generateRechargeCode', () => {
    it('should generate code with s2p_ prefix and random suffix', () => {
        const code = generateRechargeCode('cm1234567890');
        expect(code.startsWith('s2p_')).toBe(true);
        expect(code.length).toBeLessThanOrEqual(32);
        // 包含 orderId 部分和 8 字符随机后缀
        expect(code.length).toBeGreaterThan(12);
    });

    it('should truncate long order IDs to fit 32 chars', () => {
        const longId = 'a'.repeat(50);
        const code = generateRechargeCode(longId);
        expect(code.length).toBeLessThanOrEqual(32);
        expect(code.startsWith('s2p_')).toBe(true);
    });

    it('should generate different codes for same orderId (randomness)', () => {
        const code1 = generateRechargeCode('order-001');
        const code2 = generateRechargeCode('order-001');
        expect(code1).not.toBe(code2);
    });

    it('should handle empty string', () => {
        const code = generateRechargeCode('');
        expect(code.startsWith('s2p_')).toBe(true);
        expect(code.length).toBeLessThanOrEqual(32);
    });
});
