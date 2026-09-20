/**
 * gpt-image `size=auto`(或缺省)的官方尺寸语义 —— 2026-09-17 官方 key 实测反推:
 *   generations auto → 1122×1402;edits auto 方图输入 → 1254×1254;edits auto 16:9 输入 → 1672×941。
 *   三者面积均 ≈ 1,572,864(= 1536×1024),边长不对齐 16 → 规则 = 1.5MP 面积、按比例开方后四舍五入:
 *   w = round(√(A·r)), h = round(√(A/r)),r = 宽/高。generations 缺省比例 4:5(1122/1402);edits 跟随输入图。
 *   官方 usage 按这些尺寸算:1254² low=229、1672×941 low=129、1122×1402 low=186(与实测逐 token 相同)。
 *
 * 上游只认 16 倍数尺寸(官方约束),所以【发给上游】用最近的 16 对齐尺寸(1122×1402 → 1120×1408),
 * 【计费与回显】用官方尺寸;返回图与对齐尺寸相符(面积 ±6% / 比例 ±4%)即按官方尺寸计,否则(上游降级)按实际。
 * 交付像素与官方相差 ≤8px/边,是有意取舍(不做 jimp 重采样,省 CPU)。
 */
export const OFFICIAL_AUTO_AREA = 1_572_864;
/** generations auto 官方缺省画幅 4:5(1122×1402)。 */
export const OFFICIAL_AUTO_DEFAULT_ASPECT = 4 / 5;
const MAX_ASPECT = 3;

export function isAutoSize(size: string): boolean {
    const t = size.trim().toLowerCase();
    return t === '' || t === 'auto';
}

/** 官方 auto 尺寸:1.5MP 面积按比例分配、四舍五入;比例钳到 [1/3, 3](官方尺寸约束)。 */
export function officialAutoDims(aspect: number): { w: number; h: number } {
    const r = Math.min(MAX_ASPECT, Math.max(1 / MAX_ASPECT, aspect > 0 && Number.isFinite(aspect) ? aspect : 1));
    return { w: Math.round(Math.sqrt(OFFICIAL_AUTO_AREA * r)), h: Math.round(Math.sqrt(OFFICIAL_AUTO_AREA / r)) };
}

/** 最近的 16 倍数(≥16),发给上游用。 */
export function alignTo16(d: { w: number; h: number }): { w: number; h: number } {
    return { w: Math.max(16, Math.round(d.w / 16) * 16), h: Math.max(16, Math.round(d.h / 16) * 16) };
}

/** 返回图是否"就是我们要的那张"(面积 ±6%、比例 ±4%)—— 是则按官方 auto 尺寸计费/回显;否则视为上游降级按实际。 */
export function matchesAutoRequest(actual: { w: number; h: number }, official: { w: number; h: number }): boolean {
    const areaRatio = (actual.w * actual.h) / (official.w * official.h);
    const aspectRatio = actual.w / actual.h / (official.w / official.h);
    return Math.abs(areaRatio - 1) <= 0.06 && Math.abs(aspectRatio - 1) <= 0.04;
}

/** prompt 里的明确画幅字样 → 比例串("16:9")。认半角 / 全角冒号与「比」(`16:9` / `16：9` / `16比9`),
 *  数字前后不能紧挨数字或小数点(排除 1.5:1 / 版本号);两数各 1-32,长短比 ≤ 2.5(涵盖 21:9=2.33,排掉
 *  10:30 这类时间和 3:1 以上的极端值);取第一个命中。只在客户没给 size(auto/缺省)时被用到。
 *  portal 扩展(官方不看 prompt),2026-09-16 #466 后续引入;2026-09-19 从 /v1 route 搬到这里供适配器共用。 */
export function promptAspectRatio(prompt: string): string | null {
    const re = /(?<![\d.])(\d{1,2})\s*[:：比]\s*(\d{1,2})(?![\d.])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt))) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (a < 1 || b < 1 || a > 32 || b > 32) continue;
        if (Math.max(a, b) / Math.min(a, b) > 2.5) continue;
        return `${a}:${b}`;
    }
    return null;
}

/** "16:9" → 16/9。 */
export function aspectFromRatio(ratio: string): number {
    const [a, b] = ratio.split(':').map(Number);
    return a > 0 && b > 0 ? a / b : 1;
}
