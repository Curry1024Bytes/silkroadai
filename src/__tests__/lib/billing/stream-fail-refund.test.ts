/**
 * 失败流自动退款(根治件②)单测 —— 直接驱动 runStreamFailRefund(绕过调度 setTimeout)。
 *
 * Mock:prisma(token 反查 / RechargeLog 幂等与熔断 / cache bust)+ newapi client
 * (queryLogs / addQuota / getUser)。断言:精确对行才退、有输出不退、幂等不双退、
 * 熔断停手、portal 账本用户只报警、退款链路(add → bust → 流水)完整。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTokenFindUnique = vi.fn();
const mockRechargeFindFirst = vi.fn();
const mockRechargeCount = vi.fn();
const mockRechargeCreate = vi.fn();
const mockUserUpdate = vi.fn();
vi.mock('@/lib/db', () => ({
    prisma: {
        newApiToken: { findUnique: (...a: unknown[]) => mockTokenFindUnique(...a) },
        rechargeLog: {
            findFirst: (...a: unknown[]) => mockRechargeFindFirst(...a),
            count: (...a: unknown[]) => mockRechargeCount(...a),
            create: (...a: unknown[]) => mockRechargeCreate(...a),
        },
        user: { update: (...a: unknown[]) => mockUserUpdate(...a) },
    },
}));

const mockQueryLogs = vi.fn();
const mockAddQuota = vi.fn();
const mockGetUser = vi.fn();
vi.mock('@/lib/newapi/client', () => ({
    queryLogs: (...a: unknown[]) => mockQueryLogs(...a),
    addQuota: (...a: unknown[]) => mockAddQuota(...a),
    getUser: (...a: unknown[]) => mockGetUser(...a),
}));

import { runStreamFailRefund } from '@/lib/billing/stream-fail-refund';
import { quotaToCny } from '@/lib/newapi/quota-units';

const ARGS = {
    upstreamRequestId: 'RID-X',
    rawAuth: 'sk-abc',
    model: 'claude-opus-4-8',
    label: 'test',
};

const newapiUser = {
    user: { id: 'u1', newapi_user_id: 721, newapi_username: 'c-x', billing_mode: 'newapi' },
};

function billedRow(over: Record<string, unknown> = {}) {
    return {
        id: 1,
        user_id: 721,
        request_id: 'RID-X',
        type: 2,
        completion_tokens: 0,
        prompt_tokens: 75450,
        quota: 226350,
        created_at: 1785211546,
        model_name: 'claude-opus-4-8',
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockTokenFindUnique.mockResolvedValue(newapiUser);
    mockRechargeFindFirst.mockResolvedValue(null);
    mockRechargeCount.mockResolvedValue(0);
    mockRechargeCreate.mockResolvedValue({});
    mockUserUpdate.mockResolvedValue({});
    mockGetUser.mockResolvedValue({ quota: 1_000_000 });
    mockAddQuota.mockResolvedValue(undefined);
});

describe('stream-fail-refund — 退款主路径', () => {
    it('input-only 消费行命中 → addQuota + cache bust + RechargeLog(带 request_id 幂等标记)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockQueryLogs.mockResolvedValue({ items: [billedRow()], total: 1 });
        await runStreamFailRefund(ARGS);

        expect(mockQueryLogs).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: 721, username: 'c-x', request_id: 'RID-X', type: 2 }),
        );
        expect(mockAddQuota).toHaveBeenCalledWith({ userId: 721, quotaDelta: 226350, mode: 'add' });
        expect(mockUserUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { newapi_quota_cache: null, newapi_used_quota_cache: null, newapi_cached_at: null },
            }),
        );
        const created = mockRechargeCreate.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(created.data.source).toBe('refund');
        expect(created.data.amount).toBe(quotaToCny(226350));
        expect(String(created.data.note)).toContain('RID-X');
        expect(String(created.data.note)).toContain('[stream-fail]');
        warn.mockRestore();
    });

    it('sk- 前缀与 Bearer 前缀都剥掉再反查 token', async () => {
        mockQueryLogs.mockResolvedValue({ items: [billedRow()], total: 1 });
        await runStreamFailRefund({ ...ARGS, rawAuth: 'Bearer sk-abc' });
        expect(mockTokenFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { newapi_token_value: 'abc' } }),
        );
    });
});

describe('stream-fail-refund — 不该退的都不退', () => {
    it('同 request_id 但有输出(completion>0)→ 不退', async () => {
        mockQueryLogs.mockResolvedValue({ items: [billedRow({ completion_tokens: 55 })], total: 1 });
        await runStreamFailRefund(ARGS);
        expect(mockAddQuota).not.toHaveBeenCalled();
    });

    it('行属于别的 user_id(防越权/串账)→ 不退', async () => {
        mockQueryLogs.mockResolvedValue({ items: [billedRow({ user_id: 999 })], total: 1 });
        await runStreamFailRefund(ARGS);
        expect(mockAddQuota).not.toHaveBeenCalled();
    });

    it('幂等:note 里已有该 request_id 的退款流水 → 不双退', async () => {
        mockQueryLogs.mockResolvedValue({ items: [billedRow()], total: 1 });
        mockRechargeFindFirst.mockResolvedValue({ id: 'existing' });
        await runStreamFailRefund(ARGS);
        expect(mockAddQuota).not.toHaveBeenCalled();
    });

    it('24h 熔断达上限 → 不退 + 报警', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockQueryLogs.mockResolvedValue({ items: [billedRow()], total: 1 });
        mockRechargeCount.mockResolvedValue(50);
        await runStreamFailRefund(ARGS);
        expect(mockAddQuota).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
            '[stream-fail-refund] DAILY CAP HIT — manual review needed',
            expect.anything(),
        );
        warn.mockRestore();
    });

    it('portal ¥账本客户 → 只报警走人工,不动账', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockTokenFindUnique.mockResolvedValue({
            user: { id: 'u2', newapi_user_id: 9, newapi_username: 'c-y', billing_mode: 'portal' },
        });
        await runStreamFailRefund(ARGS);
        expect(mockQueryLogs).not.toHaveBeenCalled();
        expect(mockAddQuota).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
            '[stream-fail-refund] portal-billing user needs MANUAL refund review',
            expect.anything(),
        );
        warn.mockRestore();
    });

    it('未知 key → 静默返回', async () => {
        mockTokenFindUnique.mockResolvedValue(null);
        await runStreamFailRefund(ARGS);
        expect(mockQueryLogs).not.toHaveBeenCalled();
    });

    it('没查到账单行(压根没扣钱)→ 二次确认后放行不动账', async () => {
        vi.useFakeTimers();
        mockQueryLogs.mockResolvedValue({ items: [], total: 0 });
        const p = runStreamFailRefund(ARGS);
        await vi.advanceTimersByTimeAsync(25_000);
        await p;
        expect(mockQueryLogs).toHaveBeenCalledTimes(2); // 首查 + 二次确认
        expect(mockAddQuota).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
