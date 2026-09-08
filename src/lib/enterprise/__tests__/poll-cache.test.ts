/**
 * 轮询缓存单测:TTL 命中 / 过期 / 并发合流 / 完成态长 TTL / 关闭开关 / 失效。
 * 这是「降上游 QPS」的核心件 —— 2026-08-18 客户 29 任务在途把上游打到 429。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPollCache, invalidatePollCache, pollWithCache } from '../poll-cache';

const QUEUED = { status: 200, text: '{"id":"t1","status":"queued"}' };
const DONE = { status: 200, text: '{"id":"t1","status":"completed","video_url":"https://x/v.mp4"}' };

beforeEach(() => {
    __resetPollCache();
    vi.useFakeTimers();
    delete process.env.ENTERPRISE_POLL_CACHE_MS;
});
afterEach(() => {
    vi.useRealTimers();
    delete process.env.ENTERPRISE_POLL_CACHE_MS;
});

describe('pollWithCache', () => {
    it('TTL 内重复轮询只打一次上游', async () => {
        const f = vi.fn().mockResolvedValue(QUEUED);
        const a = await pollWithCache('t1', f);
        expect(a.cached).toBe(false);
        for (let i = 0; i < 5; i++) {
            const r = await pollWithCache('t1', f);
            expect(r.cached).toBe(true);
            expect(r.result).toEqual(QUEUED);
        }
        expect(f).toHaveBeenCalledTimes(1); // 6 次轮询 → 1 次上游
    });

    it('TTL 过期后重新打上游', async () => {
        const f = vi.fn().mockResolvedValue(QUEUED);
        await pollWithCache('t1', f);
        vi.advanceTimersByTime(8_001);
        const r = await pollWithCache('t1', f);
        expect(r.cached).toBe(false);
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('并发合流:同任务 10 个并发轮询只打一次上游', async () => {
        let resolveIt: (v: typeof QUEUED) => void = () => {};
        const f = vi.fn().mockImplementation(() => new Promise((r) => (resolveIt = r)));
        const all = Promise.all(Array.from({ length: 10 }, () => pollWithCache('t1', f)));
        await vi.advanceTimersByTimeAsync(0);
        resolveIt(QUEUED);
        const rs = await all;
        expect(f).toHaveBeenCalledTimes(1);
        expect(rs.every((r) => r.result === QUEUED)).toBe(true);
    });

    it('不同任务各自独立,不会串结果', async () => {
        const f1 = vi.fn().mockResolvedValue(QUEUED);
        const f2 = vi.fn().mockResolvedValue(DONE);
        expect((await pollWithCache('t1', f1)).result).toEqual(QUEUED);
        expect((await pollWithCache('t2', f2)).result).toEqual(DONE);
        expect((await pollWithCache('t1', f1)).result).toEqual(QUEUED);
    });

    it('已完成 → 长 TTL(60s),短 TTL 过期后仍命中', async () => {
        const f = vi.fn().mockResolvedValue(DONE);
        await pollWithCache('t1', f);
        vi.advanceTimersByTime(30_000); // 早过 8s 短 TTL
        expect((await pollWithCache('t1', f)).cached).toBe(true);
        expect(f).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(31_000); // 过 60s
        expect((await pollWithCache('t1', f)).cached).toBe(false);
    });

    it('上游报错也缓存(短 TTL)—— 限流时别继续猛打', async () => {
        const f = vi.fn().mockResolvedValue({ status: 429, text: 'Too Many Requests' });
        await pollWithCache('t1', f);
        expect((await pollWithCache('t1', f)).cached).toBe(true);
        expect(f).toHaveBeenCalledTimes(1);
    });

    it('ENTERPRISE_POLL_CACHE_MS=0 → 整体关闭(逃生阀)', async () => {
        process.env.ENTERPRISE_POLL_CACHE_MS = '0';
        const f = vi.fn().mockResolvedValue(QUEUED);
        await pollWithCache('t1', f);
        await pollWithCache('t1', f);
        await pollWithCache('t1', f);
        expect(f).toHaveBeenCalledTimes(3);
    });

    it('ENTERPRISE_POLL_CACHE_MS 可调大', async () => {
        process.env.ENTERPRISE_POLL_CACHE_MS = '30000';
        const f = vi.fn().mockResolvedValue(QUEUED);
        await pollWithCache('t1', f);
        vi.advanceTimersByTime(20_000);
        expect((await pollWithCache('t1', f)).cached).toBe(true);
        expect(f).toHaveBeenCalledTimes(1);
    });

    it('invalidatePollCache 立即失效(终态化后不返旧的排队态)', async () => {
        const f = vi.fn().mockResolvedValue(QUEUED);
        await pollWithCache('t1', f);
        invalidatePollCache('t1');
        expect((await pollWithCache('t1', f)).cached).toBe(false);
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('上游抛错不落缓存,下次照常重试', async () => {
        const f = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(QUEUED);
        await expect(pollWithCache('t1', f)).rejects.toThrow('boom');
        const r = await pollWithCache('t1', f);
        expect(r.cached).toBe(false);
        expect(r.result).toEqual(QUEUED);
    });
});
