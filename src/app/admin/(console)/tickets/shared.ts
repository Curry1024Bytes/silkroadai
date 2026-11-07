'use client';

import type { TicketStatus } from '@prisma/client';
import type { Locale } from '@/lib/locale';

export function fmtTime(iso: string | number | null | undefined, locale: Locale): string {
    if (!iso) return '—';
    return new Date(typeof iso === 'number' ? iso * 1000 : iso).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
    });
}

export function hoursSince(iso: string | null): number {
    if (!iso) return 0;
    return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

/** admin 列表用 slate 适配色(跟公告页一致,不用客户面的暖色 token)。 */
export const STATUS_PILL: Record<TicketStatus, string> = {
    open: 'bg-blue-500/15 text-blue-600 dark:text-blue-300',
    waiting_customer: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
    resolved: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    closed: 'bg-slate-500/15 text-slate-500 dark:text-slate-400',
};

export const PRIORITY_PILL: Record<string, string> = {
    low: 'text-slate-400',
    normal: 'text-slate-600 dark:text-slate-300',
    high: 'text-red-600 dark:text-red-400 font-semibold',
};

export function adminQuery(sp: URLSearchParams): string {
    const p = new URLSearchParams();
    for (const k of ['theme', 'ui_mode', 'lang']) {
        const v = sp.get(k);
        if (v) p.set(k, v);
    }
    const s = p.toString();
    return s ? `?${s}` : '';
}
