/**
 * REAL_USD_TO_CNY / quotaToRealUsd — 真实汇率与 quota 换算因子解耦(计价单位迁移前置)。
 *
 * 迁移前(REAL_USD_TO_CNY_RATE 未设)REAL 回落 USD_TO_CNY_RATE → quotaToRealUsd
 * 与 quotaToUsd 完全等价(行为中性);迁移后 prod 设 REAL=7、USD_TO_CNY_RATE=1,
 * quotaToRealUsd 继续给出真美元,quotaToUsd 则变成 ¥ 口径。
 *
 * 常量在 module load 时读 env,所以「迁移后」分支用 vi.resetModules + stubEnv
 * 动态 import 验证。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { REAL_USD_TO_CNY, quotaToRealUsd, quotaToUsd, quotaToCny } from '@/lib/newapi/quota-units';

describe('quota-units real-FX decoupling', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('REAL_USD_TO_CNY_RATE 未设时回落 USD_TO_CNY_RATE(迁移前中性)', async () => {
        vi.resetModules();
        vi.stubEnv('REAL_USD_TO_CNY_RATE', '');
        vi.stubEnv('USD_TO_CNY_RATE', '');
        const mod = await import('@/lib/newapi/quota-units');
        expect(mod.REAL_USD_TO_CNY).toBe(mod.USD_TO_CNY_RATE);
        expect(mod.REAL_USD_TO_CNY).toBe(7.2);
    });

    it('迁移前 quotaToRealUsd ≡ quotaToUsd', () => {
        for (const q of [0, 1, 500_000, 1_000_000, 123_456_789]) {
            expect(quotaToRealUsd(q)).toBeCloseTo(quotaToUsd(q), 10);
        }
    });

    it('quotaToRealUsd = quotaToCny / REAL_USD_TO_CNY(定义即真$口径)', () => {
        expect(quotaToRealUsd(1_000_000)).toBeCloseTo(quotaToCny(1_000_000) / REAL_USD_TO_CNY, 10);
    });

    it('迁移后 env(QPU=500k、FX=1、REAL=7):quotaToCny 是 ¥ 直读,quotaToRealUsd 是真$', async () => {
        vi.resetModules();
        vi.stubEnv('NEWAPI_QUOTA_PER_USD', '500000');
        vi.stubEnv('USD_TO_CNY_RATE', '1');
        vi.stubEnv('REAL_USD_TO_CNY_RATE', '7');
        const mod = await import('@/lib/newapi/quota-units');
        // 500k quota = ¥1(新标尺)
        expect(mod.quotaToCny(500_000)).toBeCloseTo(1, 10);
        // 真$ = ¥ / 7
        expect(mod.quotaToRealUsd(3_500_000)).toBeCloseTo(1, 10);
        // cnyToQuota:¥7 = 3.5M quota(余额 ×3.5 的由来)
        expect(mod.cnyToQuota(7)).toBe(3_500_000);
    });
});
