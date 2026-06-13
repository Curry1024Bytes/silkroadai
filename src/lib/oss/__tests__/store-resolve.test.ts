/**
 * resolveUserIdFromAuthHeader 单测(2026-06-12)。
 *
 * 背景:旧版 `catch { return null }` 把瞬时 DB 异常(并发尖峰下连接池竞争)
 * 静默吞掉 → 配了 OSS 的客户生图无声回落平台 R2,零日志零响应头。
 * 新契约:header 不合形 / 查无此 token → null;DB 抛错 → 重试一次,仍失败
 * 则 throw(由 storeGeneratedImage 记日志 + 置 ossFallback 回落)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTokenFindUnique = vi.fn();
const mockUserFindFirst = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        newApiToken: {
            findUnique: (...args: unknown[]) => mockTokenFindUnique(...args),
        },
        user: {
            findFirst: (...args: unknown[]) => mockUserFindFirst(...args),
        },
    },
}));

import { resolveUserIdFromAuthHeader } from '../store';

const RAW = 'Bc4UOPZdTYBS56MMFE1XrOXf5ILtXXXDPsWgqqgecvS5dezb';

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('resolveUserIdFromAuthHeader — header 形状', () => {
    it.each([null, '', 'sk-raw-without-bearer', 'Basic dXNlcjpwYXNz', 'Bearer ', 'Bearer sk-'])(
        '不合形 header %j → null,不触 DB',
        async (h) => {
            await expect(resolveUserIdFromAuthHeader(h as string | null)).resolves.toBeNull();
            expect(mockTokenFindUnique).not.toHaveBeenCalled();
            expect(mockUserFindFirst).not.toHaveBeenCalled();
        },
    );

    it('Bearer sk-<raw> → 去 sk- 前缀按 48 字符值查 NewApiToken', async () => {
        mockTokenFindUnique.mockResolvedValueOnce({ user_id: 'user-1' });
        await expect(resolveUserIdFromAuthHeader(`Bearer sk-${RAW}`)).resolves.toBe('user-1');
        expect(mockTokenFindUnique).toHaveBeenCalledWith({
            where: { newapi_token_value: RAW },
            select: { user_id: true },
        });
    });

    it('token 查不到 → fallback 查 system token;都没有 → null(干净 miss 不 throw)', async () => {
        mockTokenFindUnique.mockResolvedValue(null);
        mockUserFindFirst.mockResolvedValueOnce({ id: 'user-sys' });
        await expect(resolveUserIdFromAuthHeader(`Bearer ${RAW}`)).resolves.toBe('user-sys');

        mockUserFindFirst.mockResolvedValueOnce(null);
        await expect(resolveUserIdFromAuthHeader(`Bearer ${RAW}`)).resolves.toBeNull();
    });
});

describe('resolveUserIdFromAuthHeader — 瞬时 DB 故障重试', () => {
    it('第一次抛错、重试成功 → 返回 user_id 并 warn 一次', async () => {
        mockTokenFindUnique
            .mockRejectedValueOnce(new Error('connection pool timeout'))
            .mockResolvedValueOnce({ user_id: 'user-1' });
        await expect(resolveUserIdFromAuthHeader(`Bearer sk-${RAW}`)).resolves.toBe('user-1');
        expect(mockTokenFindUnique).toHaveBeenCalledTimes(2);
        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('fallback 查询抛错也走同一重试(整块重跑)', async () => {
        mockTokenFindUnique.mockResolvedValue(null);
        mockUserFindFirst.mockRejectedValueOnce(new Error('pool timeout')).mockResolvedValueOnce({ id: 'user-sys' });
        await expect(resolveUserIdFromAuthHeader(`Bearer ${RAW}`)).resolves.toBe('user-sys');
        expect(mockTokenFindUnique).toHaveBeenCalledTimes(2);
    });

    it('连续两次抛错 → throw 给调用方(不再静默吞)', async () => {
        mockTokenFindUnique.mockRejectedValue(new Error('db down'));
        await expect(resolveUserIdFromAuthHeader(`Bearer sk-${RAW}`)).rejects.toThrow('db down');
        expect(mockTokenFindUnique).toHaveBeenCalledTimes(2);
    });
});
