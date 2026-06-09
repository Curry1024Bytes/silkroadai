/**
 * 客户控制台三合一 — pure formatting helpers for the per-call detail table.
 * (brief §5: use_time→友好时长; token=0→"—"; type→成功/失败)
 */
import { describe, expect, it } from 'vitest';
import { formatDuration, formatTokens, callResult } from '@/app/(authenticated)/dashboard/format';

describe('formatDuration', () => {
    it('0 / negative / non-finite → "—"', () => {
        expect(formatDuration(0)).toBe('—');
        expect(formatDuration(-5)).toBe('—');
        expect(formatDuration(NaN)).toBe('—');
    });

    it('sub-second → "Nms"', () => {
        expect(formatDuration(1)).toBe('1ms');
        expect(formatDuration(820)).toBe('820ms');
        expect(formatDuration(999)).toBe('999ms');
    });

    it('seconds → one decimal, trailing ".0" dropped', () => {
        expect(formatDuration(1000)).toBe('1s');
        expect(formatDuration(1200)).toBe('1.2s');
        expect(formatDuration(12340)).toBe('12.3s');
        expect(formatDuration(59000)).toBe('59s');
    });

    it('minutes', () => {
        expect(formatDuration(60000)).toBe('1m');
        expect(formatDuration(65000)).toBe('1m 5s');
        expect(formatDuration(125000)).toBe('2m 5s');
    });
});

describe('formatTokens', () => {
    it('both zero (image gen) → "—" (生图友好, not "0 / 0")', () => {
        expect(formatTokens(0, 0)).toBe('—');
    });

    it('formats 输入 / 输出 with thousands separators', () => {
        expect(formatTokens(100, 200)).toBe('100 / 200');
        expect(formatTokens(1234, 5678)).toBe('1,234 / 5,678');
    });

    it('shows the row when only one side is non-zero', () => {
        expect(formatTokens(100, 0)).toBe('100 / 0');
        expect(formatTokens(0, 50)).toBe('0 / 50');
    });
});

describe('callResult', () => {
    it('type 5 → error, everything else → success', () => {
        expect(callResult(5)).toBe('error');
        expect(callResult(2)).toBe('success');
        expect(callResult(1)).toBe('success');
    });
});
