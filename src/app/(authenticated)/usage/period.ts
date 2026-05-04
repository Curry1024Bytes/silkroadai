/** Period filter for /usage. Server + client both import this. */

export type UsagePeriod = '7d' | '30d' | 'all';

export const PERIOD_VALUES: ReadonlySet<UsagePeriod> = new Set(['7d', '30d', 'all']);

/** Parse a raw `?period=` querystring value, defaulting to '30d' on invalid
 *  / missing input. Defending against arbitrary user-supplied strings. */
export function parsePeriod(raw: string | string[] | undefined): UsagePeriod {
    const v = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
    if (v && PERIOD_VALUES.has(v as UsagePeriod)) return v as UsagePeriod;
    return '30d';
}

/** Compute the inclusive (start, end) unix-seconds window for a period. End
 *  is "now" in all cases. `'all'` returns start=0 to scan all-time. */
export function periodToRange(period: UsagePeriod): { start: number; end: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    if (period === 'all') return { start: 0, end: nowSec };
    const days = period === '7d' ? 7 : 30;
    return { start: nowSec - days * 86_400, end: nowSec };
}
