/**
 * 客户后台大数字的紧凑显示(2026-10-22)。
 *
 * 背景:头部客户的汇总卡已经长到 `1,000,719,906` tokens / `¥290262.82` 余额,
 * 5 列栅格里十位数把卡片撑爆,第一眼读不出量级。规则:**主数字只回答
 * "大概多少",精确值永远保留但退到副行 / title**。
 *
 * 三个 helper 都是纯函数、无 env 依赖,server component 和 client island 都能
 * 直接用(不违反「client island 不许算 ¥」的约束 —— 这里只做格式化,不做换算)。
 *
 * 阈值以下不压缩,小客户看到的和以前几乎一样;阈值以上:
 *   - 金额 ¥:≥ 10 万 → `万`,2 位小数                `¥29.03 万`
 *   - 次数:  ≥ 1 万  → `万`,1 位小数                `218.5 万`
 *   - Tokens:≥ 1 万  → K / M / B,3 位有效数字        `42.6M` / `1.00B`
 * Tokens 用 K/M/B 而不是万/亿:行业定价口径是 `$/M tokens`,与 /pricing 和模型清单一致。
 *
 * i18n(2026-10-27):`formatCny` / `formatCount` 接受可选 `locale`;英文界面没有「万」,
 * 压缩阈值不变,但单位改走 K / M / B(`¥290.26K` / `2.18M`)。省略 locale = 中文,与历史输出一致。
 */
import type { Locale } from '@/lib/i18n';

export interface CompactNumber {
    /** 主显数字本体(不含货币符号和单位),已带千分位。 */
    display: string;
    /** 单位后缀:'' / '万' / 'K' / 'M' / 'B'。空串表示未压缩。 */
    unit: string;
    /** 精确值(含货币符号 / 千分位),给副行与 title。 */
    exact: string;
    /** 是否发生了压缩(调用方据此决定副行要不要放精确值)。 */
    compact: boolean;
}

const CNY_COMPACT_THRESHOLD = 100_000;
const COUNT_COMPACT_THRESHOLD = 10_000;
const TOKENS_COMPACT_THRESHOLD = 10_000;

function safe(n: number): number {
    return Number.isFinite(n) ? n : 0;
}

function thousands(n: number, fractionDigits: number): string {
    return n.toLocaleString('en-US', {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
    });
}

/** 英文压缩:按量级选 K / M / B,固定小数位(金额 2 位、次数 1 位)。 */
function compactEn(n: number, fractionDigits: number): { display: string; unit: string } {
    const a = Math.abs(n);
    const tiers: Array<[number, string]> = [
        [1e9, 'B'],
        [1e6, 'M'],
        [1e3, 'K'],
    ];
    const tier = tiers.find(([div]) => a >= div) ?? tiers[tiers.length - 1];
    return { display: thousands(n / tier[0], fractionDigits), unit: tier[1] };
}

/** 金额(人民币)。`¥` 符号由调用方渲染(便于单独降级字号)。 */
export function formatCny(value: number, locale: Locale = 'zh'): CompactNumber {
    const n = safe(value);
    const exact = `¥${thousands(n, 2)}`;
    if (Math.abs(n) < CNY_COMPACT_THRESHOLD) {
        return { display: thousands(n, 2), unit: '', exact, compact: false };
    }
    if (locale === 'en') return { ...compactEn(n, 2), exact, compact: true };
    return { display: thousands(n / 10_000, 2), unit: '万', exact, compact: true };
}

/** 美元(余额卡副行的换算值)。只做千分位 + 2 位小数,不压缩。 */
export function formatUsd(value: number): string {
    return `$${thousands(safe(value), 2)}`;
}

/** 计数(请求次数等整数)。 */
export function formatCount(value: number, locale: Locale = 'zh'): CompactNumber {
    const n = Math.round(safe(value));
    const exact = thousands(n, 0);
    if (Math.abs(n) < COUNT_COMPACT_THRESHOLD) {
        return { display: exact, unit: '', exact, compact: false };
    }
    if (locale === 'en') return { ...compactEn(n, 1), exact, compact: true };
    return { display: thousands(n / 10_000, 1), unit: '万', exact, compact: true };
}

/** 3 位有效数字:≥100 → 整数;≥10 → 1 位小数;否则 2 位小数。 */
function threeSignificant(v: number): string {
    const a = Math.abs(v);
    if (a >= 100) return thousands(v, 0);
    if (a >= 10) return thousands(v, 1);
    return thousands(v, 2);
}

/** Tokens(输入+输出合计)。 */
export function formatTokens(value: number): CompactNumber {
    const n = Math.round(safe(value));
    const exact = thousands(n, 0);
    const a = Math.abs(n);
    if (a < TOKENS_COMPACT_THRESHOLD) {
        return { display: exact, unit: '', exact, compact: false };
    }
    // 先按量级选单位;若 3 位有效数字四舍五入后翻到 1000(如 999,950 → "1,000K"),
    // 升一级单位,保证主显最多 3 个整数位。
    const tiers: Array<[number, string]> = [
        [1e9, 'B'],
        [1e6, 'M'],
        [1e3, 'K'],
    ];
    let idx = tiers.findIndex(([div]) => a >= div);
    if (idx === -1) idx = tiers.length - 1;
    let display = threeSignificant(n / tiers[idx][0]);
    if (idx > 0 && Math.abs(Number(display.replace(/,/g, ''))) >= 1000) {
        idx -= 1;
        display = threeSignificant(n / tiers[idx][0]);
    }
    return { display, unit: tiers[idx][1], exact, compact: true };
}
