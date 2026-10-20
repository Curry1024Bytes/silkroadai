/**
 * src/instrumentation.ts 测试 —— dispatcher + 调度器合并版(2026-07-28)。
 *
 * 背景:PR #231 曾在仓库根另建 instrumentation.ts,把 src/ 的调度器 bootstrap
 * 静默顶掉停摆 15 天(位置规则实测见 src/instrumentation.ts 文件头)。
 * 合并到 src/ 单文件后这里守两件事:
 *  1. dispatcher(600s undici timeout)照旧
 *  2. 调度器在主站实例跑、在 seedance flavor / PORTAL_SCHEDULERS=off 实例不跑
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const setGlobalDispatcher = vi.fn();
const Agent = vi.fn();
vi.mock('undici', () => ({ setGlobalDispatcher, Agent }));

vi.mock('../../sentry.server.config', () => ({}));

const startTimeoutScheduler = vi.fn();
const startBalanceAlertScheduler = vi.fn();
const startImageCleanupScheduler = vi.fn();
const startResellerCommissionScheduler = vi.fn();
const startShadowMeterScheduler = vi.fn();
const startBatchScheduler = vi.fn();
const startEnterpriseReqlogCleanupScheduler = vi.fn();
vi.mock('@/lib/order/timeout', () => ({ startTimeoutScheduler }));
vi.mock('@/lib/scheduler/balance-alert', () => ({ startBalanceAlertScheduler }));
vi.mock('@/lib/scheduler/image-cleanup', () => ({ startImageCleanupScheduler }));
vi.mock('@/lib/scheduler/reseller-commission', () => ({ startResellerCommissionScheduler }));
vi.mock('@/lib/scheduler/shadow-meter', () => ({ startShadowMeterScheduler }));
vi.mock('@/lib/batch/worker', () => ({ startBatchScheduler }));
// 不 mock 会 import 真调度器 → 初始 sweep 打真 prisma(P1 2026-09-03 的测试盲区,曾致本文件抖动超时)
vi.mock('@/lib/scheduler/enterprise-reqlog-cleanup', () => ({ startEnterpriseReqlogCleanupScheduler }));
// 排空钩子真实现会 patch http.ServerResponse.prototype + 挂 SIGTERM 监听 —— 这里只验证被装上
const installDrainHook = vi.fn();
vi.mock('@/lib/server/drain', () => ({ installDrainHook }));

const ALL_SCHEDULERS = [
    startTimeoutScheduler,
    startBalanceAlertScheduler,
    startImageCleanupScheduler,
    startResellerCommissionScheduler,
    startShadowMeterScheduler,
    startBatchScheduler,
    startEnterpriseReqlogCleanupScheduler,
];

describe('instrumentation register()', () => {
    const orig = process.env.NEXT_RUNTIME;
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.PORTAL_FLAVOR;
        delete process.env.PORTAL_SCHEDULERS;
    });
    afterEach(() => {
        if (orig === undefined) delete process.env.NEXT_RUNTIME;
        else process.env.NEXT_RUNTIME = orig;
        delete process.env.PORTAL_FLAVOR;
        delete process.env.PORTAL_SCHEDULERS;
    });

    it('nodejs runtime → 装 headersTimeout/bodyTimeout=600s 的 dispatcher', async () => {
        process.env.NEXT_RUNTIME = 'nodejs';
        const { register } = await import('../instrumentation');
        await register();
        expect(Agent).toHaveBeenCalledWith({ headersTimeout: 600_000, bodyTimeout: 600_000 });
        expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
        expect(installDrainHook).toHaveBeenCalledTimes(1); // Part 3 排空钩子随 dispatcher 一起装
    });

    it('nodejs runtime(主站,无门)→ 7 个调度器全部启动', async () => {
        process.env.NEXT_RUNTIME = 'nodejs';
        const { register } = await import('../instrumentation');
        await register();
        for (const s of ALL_SCHEDULERS) expect(s).toHaveBeenCalledTimes(1);
    });

    it('非 nodejs runtime(edge)→ 不装 dispatcher、不起调度器', async () => {
        process.env.NEXT_RUNTIME = 'edge';
        const { register } = await import('../instrumentation');
        await register();
        expect(setGlobalDispatcher).not.toHaveBeenCalled();
        expect(Agent).not.toHaveBeenCalled();
        for (const s of ALL_SCHEDULERS) expect(s).not.toHaveBeenCalled();
    });

    it('PORTAL_FLAVOR=seedance-enterprise → dispatcher 装、调度器不跑', async () => {
        process.env.NEXT_RUNTIME = 'nodejs';
        process.env.PORTAL_FLAVOR = 'seedance-enterprise';
        const { register } = await import('../instrumentation');
        await register();
        expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
        for (const s of ALL_SCHEDULERS) expect(s).not.toHaveBeenCalled();
    });

    it('PORTAL_SCHEDULERS=off(API 副本)→ dispatcher 装、调度器不跑', async () => {
        process.env.NEXT_RUNTIME = 'nodejs';
        process.env.PORTAL_SCHEDULERS = 'off';
        const { register } = await import('../instrumentation');
        await register();
        expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
        for (const s of ALL_SCHEDULERS) expect(s).not.toHaveBeenCalled();
    });
});
