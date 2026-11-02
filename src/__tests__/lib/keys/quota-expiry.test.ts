import { describe, expect, it } from 'vitest';
import {
    buildQuotaExpiryPayload,
    EXPIRY_PRESET_LABELS,
    expiryPresetLabels,
    formatExpiry,
    isExpired,
    MAX_QUOTA_CNY,
    parseQuotaCny,
    presetToExpiresAt,
    toDatetimeLocalValue,
} from '@/lib/keys/quota-expiry';

const NOW = new Date('2026-10-22T08:00:00.000Z');

describe('presetToExpiresAt', () => {
    it('never → null; 1h / 1d / 1m are relative to now', () => {
        expect(presetToExpiresAt('never', '', NOW)).toBeNull();
        expect(presetToExpiresAt('1h', '', NOW)).toBe('2026-10-22T09:00:00.000Z');
        expect(presetToExpiresAt('1d', '', NOW)).toBe('2026-10-23T08:00:00.000Z');
        expect(presetToExpiresAt('1m', '', NOW)).toBe('2026-11-22T08:00:00.000Z');
    });
    it('custom parses a datetime-local string; garbage → null', () => {
        const iso = presetToExpiresAt('custom', '2026-12-01T10:30', NOW);
        expect(iso).not.toBeNull();
        expect(new Date(iso!).getMinutes()).toBe(30);
        expect(presetToExpiresAt('custom', 'not-a-date', NOW)).toBeNull();
    });
});

describe('parseQuotaCny', () => {
    it.each([
        ['100', 100],
        ['99.5', 99.5],
        ['0.01', 0.01],
        [' 12.34 ', 12.34],
    ])('accepts %s', (raw, expected) => {
        expect(parseQuotaCny(raw)).toBe(expected);
    });
    it.each([['0'], ['-1'], ['abc'], ['1.234'], [''], [String(MAX_QUOTA_CNY + 1)], ['1e3']])('rejects %s', (raw) => {
        expect(parseQuotaCny(raw)).toBeNull();
    });
});

describe('buildQuotaExpiryPayload', () => {
    it('unlimited + never → both null', () => {
        expect(
            buildQuotaExpiryPayload(
                { quotaUnlimited: true, quotaCny: '', expiryPreset: 'never', expiryCustom: '' },
                NOW,
            ),
        ).toEqual({ ok: true, quotaCny: null, expiresAt: null });
    });
    it('capped + 1d → numeric quota and ISO expiry', () => {
        expect(
            buildQuotaExpiryPayload(
                { quotaUnlimited: false, quotaCny: '50', expiryPreset: '1d', expiryCustom: '' },
                NOW,
            ),
        ).toEqual({ ok: true, quotaCny: 50, expiresAt: '2026-10-23T08:00:00.000Z' });
    });
    it('invalid quota → error, never reaches expiry', () => {
        const r = buildQuotaExpiryPayload(
            { quotaUnlimited: false, quotaCny: '0', expiryPreset: 'never', expiryCustom: '' },
            NOW,
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('额度上限');
    });
    it('custom expiry in the past / empty / garbage → error', () => {
        for (const custom of ['2020-01-01T00:00', '', 'zzz']) {
            const r = buildQuotaExpiryPayload(
                { quotaUnlimited: true, quotaCny: '', expiryPreset: 'custom', expiryCustom: custom },
                NOW,
            );
            expect(r.ok, custom).toBe(false);
        }
    });
});

describe('isExpired / formatExpiry / toDatetimeLocalValue', () => {
    it('isExpired is false for null and future, true for past', () => {
        expect(isExpired(null, NOW)).toBe(false);
        expect(isExpired('2026-10-22T09:00:00.000Z', NOW)).toBe(false);
        expect(isExpired('2026-10-22T07:59:59.000Z', NOW)).toBe(true);
    });
    it('formatExpiry renders 永不过期 or Beijing time (gotcha #20)', () => {
        expect(formatExpiry(null)).toBe('永不过期');
        expect(formatExpiry('2026-01-01T04:00:00.000Z')).toBe('2026/1/1 12:00:00');
    });
    it('toDatetimeLocalValue yields yyyy-MM-ddTHH:mm', () => {
        expect(toDatetimeLocalValue('2026-06-05T01:02:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        expect(toDatetimeLocalValue(null, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });
});

describe('English locale', () => {
    it('formatExpiry → "Never expires" / en-US Beijing time', () => {
        expect(formatExpiry(null, 'en')).toBe('Never expires');
        expect(formatExpiry('2026-01-01T04:00:00.000Z', 'en')).toBe('1/1/2026, 12:00:00');
    });
    it('buildQuotaExpiryPayload errors are English', () => {
        const bad = buildQuotaExpiryPayload(
            { quotaUnlimited: false, quotaCny: '0', expiryPreset: 'never', expiryCustom: '' },
            NOW,
            'en',
        );
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.error).toContain('spending cap');
        const past = buildQuotaExpiryPayload(
            { quotaUnlimited: true, quotaCny: '', expiryPreset: 'custom', expiryCustom: '2020-01-01T00:00' },
            NOW,
            'en',
        );
        if (!past.ok) expect(past.error).toBe('Expiry time must be in the future');
    });
    it('expiryPresetLabels: zh alias unchanged, en labels', () => {
        expect(expiryPresetLabels()).toEqual(EXPIRY_PRESET_LABELS);
        expect(EXPIRY_PRESET_LABELS.never).toBe('永不');
        expect(expiryPresetLabels('en')).toEqual({
            never: 'Never',
            '1h': '1 hour',
            '1d': '1 day',
            '1m': '1 month',
            custom: 'Custom',
        });
    });
});
