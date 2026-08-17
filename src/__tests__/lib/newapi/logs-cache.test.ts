/**
 * dashboard 明细日志 30s 进程内缓存单测。
 *
 * 重点覆盖:命中/过期、key 区分度(改任一维度就是另一条)、
 * 错误不入缓存(故障不黏住 30s),以及【容量有上界】—— 最后这条是硬要求,
 * 2026-08-15 刚修完 reqlog 无界持有导致的 OOM,这里不能再种一个。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQueryLogs = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    queryLogs: (...a: unknown[]) => mockQueryLogs(...a),
}));

import { queryLogsCached, __resetLogsCacheForTest } from '@/lib/newapi/logs-cache';

// `type` 在 queryLogs 里是字面量联合(0|1|2|…)不是 number,所以 fixture 直接
// 按被测函数的形参类型标注 —— 既过 tsc,又允许用例改成 type=5 这类别的成员。
type LogsArgs = Parameters<typeof queryLogsCached>[0];
const baseArgs: LogsArgs = {
    username: 'c-abc123',
    type: 2,
    start_timestamp: 1000,
    end_timestamp: 2000,
    page: 1,
    page_size: 200,
};
type Patch = Partial<LogsArgs>;
const result = (n: number) => ({ items: [{ id: n }], total: n });

beforeEach(() => {
    __resetLogsCacheForTest();
    mockQueryLogs.mockReset();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('queryLogsCached', () => {
    it('第二次调用命中缓存,不再打上游', async () => {
        mockQueryLogs.mockResolvedValue(result(1));
        const a = await queryLogsCached(baseArgs);
        const b = await queryLogsCached(baseArgs);
        expect(a).toBe(b); // 同一个对象引用 = 真的没重新取
        expect(mockQueryLogs).toHaveBeenCalledTimes(1);
    });

    it('超过 30s TTL 后重新取', async () => {
        mockQueryLogs.mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(2));
        await queryLogsCached(baseArgs);
        vi.advanceTimersByTime(30_001);
        const second = await queryLogsCached(baseArgs);
        expect(mockQueryLogs).toHaveBeenCalledTimes(2);
        expect(second.total).toBe(2);
    });

    it('TTL 边界内不重取', async () => {
        mockQueryLogs.mockResolvedValue(result(1));
        await queryLogsCached(baseArgs);
        vi.advanceTimersByTime(29_999);
        await queryLogsCached(baseArgs);
        expect(mockQueryLogs).toHaveBeenCalledTimes(1);
    });

    it.each<[string, Patch]>([
        ['username', { username: 'c-other' }],
        ['type', { type: 5 }],
        ['start_timestamp', { start_timestamp: 999 }],
        ['end_timestamp', { end_timestamp: 9999 }],
        ['page', { page: 2 }],
        ['page_size', { page_size: 50 }],
    ])('改 %s 就是另一条缓存', async (_label, patch) => {
        mockQueryLogs.mockResolvedValue(result(1));
        await queryLogsCached(baseArgs);
        await queryLogsCached({ ...baseArgs, ...patch });
        expect(mockQueryLogs).toHaveBeenCalledTimes(2);
    });

    it('上游抛错不写缓存 —— 故障不黏住 30s', async () => {
        mockQueryLogs.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(result(7));
        await expect(queryLogsCached(baseArgs)).rejects.toThrow('boom');
        const ok = await queryLogsCached(baseArgs); // 立刻重试应真的打上游
        expect(ok.total).toBe(7);
        expect(mockQueryLogs).toHaveBeenCalledTimes(2);
    });

    it('条目数有上界(不会无限增长)', async () => {
        mockQueryLogs.mockResolvedValue(result(1));
        // 写入远超上限的不同 key
        for (let i = 0; i < 700; i++) {
            await queryLogsCached({ ...baseArgs, username: `c-${i}` });
        }
        expect(mockQueryLogs).toHaveBeenCalledTimes(700);
        // 最早写入的那批已被驱逐 → 再查会重新打上游
        mockQueryLogs.mockClear();
        await queryLogsCached({ ...baseArgs, username: 'c-0' });
        expect(mockQueryLogs).toHaveBeenCalledTimes(1);
        // 而最近写入的仍在缓存里 → 不打上游
        mockQueryLogs.mockClear();
        await queryLogsCached({ ...baseArgs, username: 'c-699' });
        expect(mockQueryLogs).not.toHaveBeenCalled();
    });
});
