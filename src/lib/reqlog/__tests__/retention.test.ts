import { afterEach, describe, expect, it } from 'vitest';
import { isRequestLogExpired, requestLogExpiresAt, requestLogRetentionDays } from '../retention';

afterEach(() => delete process.env.REQUEST_LOGGING_RETENTION_DAYS);

describe('request log retention', () => {
    it('默认保留 7 天，并可按合法整数配置', () => {
        const createdAt = new Date('2026-10-15T00:00:00Z');
        expect(requestLogRetentionDays()).toBe(7);
        expect(requestLogExpiresAt(createdAt).toISOString()).toBe('2026-10-22T00:00:00.000Z');
        process.env.REQUEST_LOGGING_RETENTION_DAYS = '3';
        expect(requestLogExpiresAt(createdAt).toISOString()).toBe('2026-10-18T00:00:00.000Z');
    });

    it('非法配置退回 7 天，null 历史记录不视为到期', () => {
        for (const value of ['0', '-1', '1.5', 'abc']) {
            process.env.REQUEST_LOGGING_RETENTION_DAYS = value;
            expect(requestLogRetentionDays()).toBe(7);
        }
        expect(isRequestLogExpired(null)).toBe(false);
        expect(isRequestLogExpired(new Date('2026-10-22T00:00:00Z'), new Date('2026-10-22T00:00:00Z'))).toBe(true);
    });
});
