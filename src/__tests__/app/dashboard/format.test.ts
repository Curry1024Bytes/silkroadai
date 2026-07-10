/**
 * 客户控制台三合一 — pure formatting helpers for the per-call detail table.
 * (brief §5: use_time→友好时长; token=0→"—"; type→成功/失败)
 */
import { describe, expect, it } from 'vitest';
import {
    formatDuration,
    formatTokens,
    isImageModel,
    callResult,
    collapseRetriedFailures,
    sanitizeLogContent,
} from '@/app/(authenticated)/dashboard/format';

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

    it('生图 56 秒(page toCallRow ×1000 后)→ "56s"(回归:不能再显示 "56ms")', () => {
        // new-api use_time=56(秒)→ page ×1000 → 56000ms
        expect(formatDuration(56 * 1000)).toBe('56s');
        expect(formatDuration(11 * 1000)).toBe('11s');
    });
});

describe('isImageModel', () => {
    it('生图模型名命中', () => {
        for (const m of [
            'gpt-image-2',
            'gemini-2.5-flash-image',
            'gemini-3-pro-image-preview',
            'gemini-3-pro-image-preview-2k',
            'dall-e-3',
            'imagen-3',
        ])
            expect(isImageModel(m), m).toBe(true);
    });
    it('非生图模型不命中(含视频/空)', () => {
        for (const m of ['gpt-5.4', 'claude-opus-4-8', 'deepseek-v4', 'seedance-2.0', ''])
            expect(isImageModel(m), m).toBe(false);
    });
});

describe('formatTokens', () => {
    it('生图模型 → 一律 "—"(token 无意义,不管上游报什么数)', () => {
        expect(formatTokens(1, 0, 'gpt-image-2')).toBe('—');
        expect(formatTokens(9, 124, 'gpt-image-2')).toBe('—');
        expect(formatTokens(1212, 1105, 'gpt-image-2')).toBe('—');
        expect(formatTokens(31, 765, 'gemini-3-pro-image-preview')).toBe('—');
        expect(formatTokens(50, 0, 'dall-e-3')).toBe('—');
    });

    it('非生图模型两端都 0 → "—"(不显示误导的 "0 / 0")', () => {
        expect(formatTokens(0, 0)).toBe('—');
        expect(formatTokens(0, 0, 'gpt-5.4')).toBe('—');
    });

    it('非生图模型正常显示 输入 / 输出(千分位)', () => {
        expect(formatTokens(100, 200, 'gpt-5.4')).toBe('100 / 200');
        expect(formatTokens(1234, 5678, 'claude-opus-4-8')).toBe('1,234 / 5,678');
    });

    it('非生图模型仅一端非 0 仍显示', () => {
        expect(formatTokens(100, 0, 'gpt-5.4')).toBe('100 / 0');
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

describe('collapseRetriedFailures', () => {
    const mk = (request_id: string, created_at: number, content = '') => ({ request_id, created_at, content });

    it('failover:失败行与成功共用同一 request_id → 藏掉失败行', () => {
        const consume = [mk('rid-A', 100)];
        const errors = [mk('rid-A', 90, 'status_code=429, 当前分组上游负载已饱和')];
        expect(collapseRetriedFailures(consume, errors)).toHaveLength(0);
    });

    it('真失败:独立 request_id、无对应成功 → 保留', () => {
        const consume = [mk('rid-A', 100)];
        const errors = [mk('rid-B', 95, 'adobe content rejected image_unsafe')];
        expect(collapseRetriedFailures(consume, errors)).toHaveLength(1);
    });

    it('proxy 尺寸重试:size must use + 180s 内有成功 → 藏', () => {
        const consume = [mk('rid-ok', 200)];
        const errors = [mk('rid-err', 120, 'status_code=400, size must use <width>x<height>')];
        expect(collapseRetriedFailures(consume, errors)).toHaveLength(0);
    });

    it('size must use 但无邻近成功 → 保留(真失败)', () => {
        const consume = [mk('rid-ok', 1000)]; // 远在 180s 外
        const errors = [mk('rid-err', 120, 'size must use <width>x<height>')];
        expect(collapseRetriedFailures(consume, errors)).toHaveLength(1);
    });

    it('内容拒绝不因邻近成功被藏(只有 size must use 才按时间藏)', () => {
        const consume = [mk('rid-ok', 130)];
        const errors = [mk('rid-err', 120, 'adobe content rejected image_unsafe')];
        expect(collapseRetriedFailures(consume, errors)).toHaveLength(1);
    });
});

describe('sanitizeLogContent', () => {
    it('adobe 内容拒绝 → 友好安全文案,不泄露 adobe / image_unsafe', () => {
        const out = sanitizeLogContent(
            'status_code=400, adobe content rejected: status 451 {"error_code":"image_unsafe"}',
        );
        expect(out.toLowerCase()).not.toContain('adobe');
        expect(out).not.toContain('image_unsafe');
        expect(out).toContain('安全系统');
    });

    it('Azure safety system → 同样友好文案', () => {
        expect(sanitizeLogContent('Your request was rejected by the safety system.')).toContain('安全');
    });

    it('size must use → 尺寸友好文案', () => {
        expect(sanitizeLogContent('status_code=400, size must use <width>x<height> format')).toContain('尺寸');
    });

    it('上游饱和 / 429 → 服务繁忙', () => {
        expect(sanitizeLogContent('status_code=429, 当前分组上游负载已饱和')).toContain('繁忙');
    });

    it('兜底:抹掉残留上游品牌名', () => {
        expect(sanitizeLogContent('failed via zhiyunai gateway').toLowerCase()).not.toContain('zhiyunai');
    });

    it('普通 / 空内容不误伤', () => {
        expect(sanitizeLogContent('')).toBe('');
        expect(sanitizeLogContent('model not found: gpt-99')).toBe('model not found: gpt-99');
    });
});
