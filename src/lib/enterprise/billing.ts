/**
 * 独立门户视频计费(P1)—— 纯 portal ¥账本,镜像 cn-billing 的幂等结构但砍掉 newapi 分支:
 * 企业客户没有 new-api 账户(newapi_user_id=null),没有 syncNewapiGate(余额门就在提交时,
 * 见 enterprise/proxy),扣费只有一条路:applyLedgerEntry(charge, ref=taskId) 二级幂等。
 *
 * 费率:默认 = cn-billing 挂牌(决策 Q4);大客户议价走 enterprise_rate_overrides
 * per-(user, resolution, has_video) 覆盖(元/1M token)。
 */
import 'server-only';
import { prisma } from '@/lib/db';
import { applyLedgerEntry } from '@/lib/billing/ledger';
import { officialCostCny, estimateTokens, type ChargeResult, type Resolution } from '@/lib/seedance/cn-billing';
import {
    isVolcModel,
    MODEL_MAP,
    variantForModel,
    type SeedanceVariant,
    type SeedanceRegion,
} from '@/lib/seedance/cn-adapter';

export type EnterprisePricingSnapshot = {
    costCny: number;
    discount: number;
    source: 'model' | 'global' | 'customer';
    rule: Record<string, unknown> & {
        identity: PricingIdentity;
        basis: { currency: 'CNY'; unit: 'token'; unitQuantity: 1_000_000; rate: number };
        evaluatedAt: string;
    };
    timezone: string;
    evaluatedAt: string;
};

type CalendarWindow = {
    start: string;
    end: string;
    discount: number;
    priority?: number;
    enabled?: boolean;
    weekdays?: number[];
    starts_on?: string;
    ends_on?: string;
    note?: string;
};

type PricingIdentity = {
    family: 'seedance';
    region: SeedanceRegion;
    variant: SeedanceVariant;
    resolution: Resolution;
    hasVideo: boolean;
};

const VALID_REGIONS: readonly SeedanceRegion[] = ['cn', 'global', 'promax', 'volc'];
const VALID_VARIANTS: readonly SeedanceVariant[] = [
    'pro',
    'fast',
    'mini',
    '2.5',
    'promax',
    'promax-fast',
    'promax-mini',
    'promax-2.5',
];
const VALID_RESOLUTIONS: readonly Resolution[] = ['480p', '720p', '1080p', '4k'];
const SUPPORTED_RESOLUTIONS: Record<SeedanceVariant, readonly Resolution[]> = {
    pro: ['480p', '720p', '1080p', '4k'],
    fast: ['480p', '720p', '1080p'],
    mini: ['480p', '720p', '1080p'],
    '2.5': ['480p', '720p', '1080p'],
    promax: ['720p', '1080p', '4k'],
    'promax-fast': ['720p'],
    'promax-mini': ['720p'],
    'promax-2.5': ['480p', '720p', '1080p'],
};

function assertPricingIdentity(variant: SeedanceVariant, region: SeedanceRegion, resolution?: Resolution): void {
    if (!VALID_VARIANTS.includes(variant)) throw new Error(`Invalid pricing variant: ${String(variant)}`);
    if (!VALID_REGIONS.includes(region)) throw new Error(`Invalid pricing region: ${String(region)}`);
    if (resolution && !VALID_RESOLUTIONS.includes(resolution)) {
        throw new Error(`Invalid pricing resolution: ${String(resolution)}`);
    }
    if (resolution && !SUPPORTED_RESOLUTIONS[variant].includes(resolution)) {
        throw new Error(`Unsupported pricing identity: ${variant}/${resolution}`);
    }
}

/** Task rows retain the submitted model name. Resolve only registered names and canonical short aliases. */
function identityForTaskModel(model: string, resolution: Resolution, hasVideo: boolean): PricingIdentity {
    const short = model.toLowerCase();
    let variant: SeedanceVariant;
    let region: SeedanceRegion;
    if (MODEL_MAP[model]) {
        variant = MODEL_MAP[model].variant;
        region = MODEL_MAP[model].region ?? 'cn';
    } else if (isVolcModel(short)) {
        variant = variantForModel(short);
        region = 'volc';
    } else {
        const match = /^seedance-(2-0|2-5)(?:-(global|promax))?(?:-(fast|mini))?$/.exec(short);
        if (!match) throw new Error(`Unknown enterprise pricing model: ${model}`);
        const [, generation, regionAlias, tier] = match;
        region = regionAlias === 'global' ? 'global' : regionAlias === 'promax' ? 'promax' : 'cn';
        if (generation === '2-5') variant = regionAlias === 'global' || regionAlias === 'promax' ? 'promax-2.5' : '2.5';
        else if (regionAlias === 'promax')
            variant = tier === 'fast' ? 'promax-fast' : tier === 'mini' ? 'promax-mini' : 'promax';
        else variant = tier === 'fast' ? 'fast' : tier === 'mini' ? 'mini' : 'pro';
    }
    assertPricingIdentity(variant, region, resolution);
    return { family: 'seedance', region, variant, resolution, hasVideo };
}

function assertSnapshotMatchesTask(
    task: { model: string; resolution: string; has_video: boolean },
    pricingDiscount: unknown,
    pricingSource: unknown,
    pricingRule: unknown,
    pricingTimezone: unknown,
): { rate: number; discount: number } {
    const identity = identityForTaskModel(task.model, task.resolution as Resolution, task.has_video);
    const discount = Number(pricingDiscount);
    if (!Number.isFinite(discount) || discount < 0.05 || discount > 2)
        throw new Error('Invalid pricing snapshot discount');
    if (!['model', 'global', 'customer'].includes(String(pricingSource)))
        throw new Error('Invalid pricing snapshot source');
    if (typeof pricingTimezone !== 'string' || !pricingTimezone) throw new Error('Invalid pricing snapshot timezone');
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: pricingTimezone });
    } catch {
        throw new Error('Invalid pricing snapshot timezone');
    }
    if (!pricingRule || typeof pricingRule !== 'object' || Array.isArray(pricingRule)) {
        throw new Error('Invalid pricing snapshot rule');
    }
    const rule = pricingRule as Record<string, unknown>;
    if (!rule.identity || typeof rule.identity !== 'object' || Array.isArray(rule.identity)) {
        throw new Error('Invalid pricing snapshot identity');
    }
    const savedIdentity = rule.identity as Record<string, unknown>;
    if (
        savedIdentity.family !== identity.family ||
        savedIdentity.region !== identity.region ||
        savedIdentity.variant !== identity.variant ||
        savedIdentity.resolution !== identity.resolution ||
        savedIdentity.hasVideo !== identity.hasVideo
    ) {
        throw new Error('Pricing snapshot identity does not match task');
    }
    if (rule.source !== pricingSource || rule.timezone !== pricingTimezone) {
        throw new Error('Pricing snapshot source or timezone does not match task');
    }
    const expectedRuleTypes: Record<string, string[]> = {
        model: ['model'],
        global: ['static', 'calendar'],
        customer: ['customer'],
    };
    if (!expectedRuleTypes[String(pricingSource)]?.includes(String(rule.type))) {
        throw new Error('Invalid pricing snapshot rule source');
    }
    if (
        typeof rule.evaluatedAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(rule.evaluatedAt) ||
        !Number.isFinite(Date.parse(rule.evaluatedAt))
    ) {
        throw new Error('Invalid pricing snapshot evaluatedAt');
    }
    if (!rule.basis || typeof rule.basis !== 'object' || Array.isArray(rule.basis)) {
        throw new Error('Invalid pricing snapshot basis');
    }
    const basis = rule.basis as Record<string, unknown>;
    const rate = Number(basis.rate);
    if (
        basis.currency !== 'CNY' ||
        basis.unit !== 'token' ||
        Number(basis.unitQuantity) !== 1_000_000 ||
        !Number.isFinite(rate) ||
        rate <= 0
    ) {
        throw new Error('Invalid pricing snapshot basis');
    }
    return { rate, discount };
}

export type GlobalDiscountRuleStatus = {
    active: boolean;
    status: 'active' | 'pending' | 'expired' | 'inactive';
    discount: number | null;
    timezone: string;
    window: CalendarWindow | null;
    next_transition_at: string | null;
    next_transition_kind: 'start' | 'end' | null;
};

function localCalendarParts(date: Date, timezone: string): { weekday: number; minutes: number; date: string } | null {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date);
        const weekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[
            parts.find((p) => p.type === 'weekday')?.value ?? ''
        ];
        const hour = Number(parts.find((p) => p.type === 'hour')?.value);
        const minute = Number(parts.find((p) => p.type === 'minute')?.value);
        const year = parts.find((p) => p.type === 'year')?.value;
        const month = parts.find((p) => p.type === 'month')?.value;
        const day = parts.find((p) => p.type === 'day')?.value;
        if (!weekday || !Number.isInteger(hour) || !Number.isInteger(minute) || !year || !month || !day) return null;
        return { weekday, minutes: hour * 60 + minute, date: `${year}-${month}-${day}` };
    } catch {
        return null;
    }
}

function parseMinutes(value: unknown): number | null {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    const [h, m] = value.split(':').map(Number);
    return h * 60 + m;
}

function isLocalDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addLocalDays(date: string, days: number): string {
    const [year, month, day] = date.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return `${next.getUTCFullYear().toString().padStart(4, '0')}-${(next.getUTCMonth() + 1)
        .toString()
        .padStart(2, '0')}-${next.getUTCDate().toString().padStart(2, '0')}`;
}

function weekdayForLocalDate(date: string): number {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

function localDateTimeToInstant(date: string, minutes: number, timezone: string): Date | null {
    const [year, month, day] = date.split('-').map(Number);
    const wallTime = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
    let instant = wallTime;
    for (let i = 0; i < 4; i += 1) {
        const parts = localCalendarParts(new Date(instant), timezone);
        if (!parts) return null;
        const [localYear, localMonth, localDay] = parts.date.split('-').map(Number);
        const localWallTime = Date.UTC(
            localYear,
            localMonth - 1,
            localDay,
            Math.floor(parts.minutes / 60),
            parts.minutes % 60,
        );
        instant += wallTime - localWallTime;
    }
    const result = new Date(instant);
    const parts = localCalendarParts(result, timezone);
    return parts?.date === date && parts.minutes === minutes ? result : null;
}

function calendarWindowSignature(window: CalendarWindow | null): string | null {
    if (!window) return null;
    return JSON.stringify({
        start: window.start,
        end: window.end,
        discount: window.discount,
        priority: window.priority,
        weekdays: window.weekdays,
        starts_on: window.starts_on,
        ends_on: window.ends_on,
        note: window.note,
    });
}

function nextCalendarTransition(
    row: { schedule_timezone?: string | null; schedule_weekdays?: unknown; schedule_windows?: unknown },
    at: Date,
): { at: string; kind: 'start' | 'end' } | null {
    if (!Array.isArray(row.schedule_windows) || row.schedule_windows.length === 0) return null;
    const timezone = row.schedule_timezone ?? 'Asia/Shanghai';
    const localDate = localCalendarParts(at, timezone)?.date;
    if (!localDate) throw new Error('Unable to evaluate calendar timezone');
    const baseDate = addLocalDays(localDate, -1);
    const candidates = new Set<number>();

    for (const raw of row.schedule_windows) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const value = raw as Record<string, unknown>;
        if (value.enabled === false) continue;
        const start = typeof value.start === 'string' ? parseMinutes(value.start) : null;
        const end = typeof value.end === 'string' ? parseMinutes(value.end) : null;
        if (start == null || end == null || start === end) continue;
        const weekdays = Array.isArray(value.weekdays)
            ? (value.weekdays as number[])
            : Array.isArray(row.schedule_weekdays)
              ? (row.schedule_weekdays as number[])
              : [];
        if (weekdays.length === 0) continue;
        const firstDate =
            typeof value.starts_on === 'string' && value.starts_on > baseDate ? value.starts_on : baseDate;

        for (let offset = 0; offset <= 14; offset += 1) {
            const occurrenceDate = addLocalDays(firstDate, offset);
            if (typeof value.ends_on === 'string' && occurrenceDate > value.ends_on) break;
            if (!weekdays.includes(weekdayForLocalDate(occurrenceDate))) continue;
            const startAt = localDateTimeToInstant(occurrenceDate, start, timezone);
            const endDate = addLocalDays(occurrenceDate, end <= start ? 1 : 0);
            const endAt = localDateTimeToInstant(endDate, end, timezone);
            if (startAt && startAt.getTime() > at.getTime()) candidates.add(startAt.getTime());
            if (endAt && endAt.getTime() > at.getTime()) candidates.add(endAt.getTime());
        }
    }

    for (const timestamp of [...candidates].sort((a, b) => a - b)) {
        const before = activeCalendarWindow(row, new Date(timestamp - 60_000))?.window ?? null;
        const after = activeCalendarWindow(row, new Date(timestamp))?.window ?? null;
        if (calendarWindowSignature(before) === calendarWindowSignature(after)) continue;
        return { at: new Date(timestamp).toISOString(), kind: after ? 'start' : 'end' };
    }
    return null;
}

function assertNoAmbiguousCalendarWindows(windows: CalendarWindow[]): void {
    const enabled = windows.filter((window) => window.enabled);
    const dayNumber = (value: string): number => {
        const [year, month, day] = value.split('-').map(Number);
        return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
    };
    const formatDate = (value: number): string => new Date(value * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < enabled.length; i += 1) {
        const a = enabled[i];
        const aStart = parseMinutes(a.start)!;
        const aEnd = parseMinutes(a.end)!;
        const aDays = a.weekdays ?? [];
        for (let j = i + 1; j < enabled.length; j += 1) {
            const b = enabled[j];
            if ((a.priority ?? 0) !== (b.priority ?? 0)) continue;
            const bStart = parseMinutes(b.start)!;
            const bEnd = parseMinutes(b.end)!;
            const bDays = b.weekdays ?? [];
            const explicitDates = [a.starts_on, a.ends_on, b.starts_on, b.ends_on].filter((date): date is string =>
                Boolean(date),
            );
            const anchor = dayNumber('2026-01-05');
            const explicitDays = explicitDates.map(dayNumber);
            const lowerBound = explicitDays.length ? Math.min(...explicitDays) - 14 : anchor;
            const upperBound = explicitDays.length ? Math.max(...explicitDays) + 14 : anchor + 21;
            for (let day = lowerBound; day <= upperBound; day += 1) {
                const dateA = formatDate(day);
                if (!aDays.includes(new Date(day * 86_400_000).getUTCDay() || 7)) continue;
                if (a.starts_on && dateA < a.starts_on) continue;
                if (a.ends_on && dateA > a.ends_on) continue;
                const absoluteAStart = day * 1440 + aStart;
                const absoluteAEnd = day * 1440 + (aEnd <= aStart ? aEnd + 1440 : aEnd);
                for (let otherDay = day - 1; otherDay <= day + 1; otherDay += 1) {
                    const dateB = formatDate(otherDay);
                    if (!bDays.includes(new Date(otherDay * 86_400_000).getUTCDay() || 7)) continue;
                    if (b.starts_on && dateB < b.starts_on) continue;
                    if (b.ends_on && dateB > b.ends_on) continue;
                    const absoluteBStart = otherDay * 1440 + bStart;
                    const absoluteBEnd = otherDay * 1440 + (bEnd <= bStart ? bEnd + 1440 : bEnd);
                    if (absoluteAStart < absoluteBEnd && absoluteBStart < absoluteAEnd)
                        throw new Error('Ambiguous overlapping calendar windows at equal priority');
                }
            }
        }
    }
}

function activeCalendarWindow(
    row: {
        schedule_timezone?: string | null;
        schedule_weekdays?: unknown;
        schedule_windows?: unknown;
    },
    at: Date,
): { window: CalendarWindow; timezone: string } | null {
    const timezone = row.schedule_timezone ?? 'Asia/Shanghai';
    if (typeof timezone !== 'string' || !timezone.trim()) throw new Error('Invalid calendar timezone');
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
        throw new Error('Invalid calendar timezone');
    }
    const parts = localCalendarParts(at, timezone);
    if (!parts) throw new Error('Unable to evaluate calendar timezone');
    if (!Array.isArray(row.schedule_windows) || row.schedule_windows.length === 0)
        throw new Error('Invalid calendar windows');
    const rawWeekdays = row.schedule_weekdays;
    if (
        !Array.isArray(rawWeekdays) ||
        rawWeekdays.length === 0 ||
        rawWeekdays.some((x) => !Number.isInteger(x) || Number(x) < 1 || Number(x) > 7) ||
        new Set(rawWeekdays).size !== rawWeekdays.length
    ) {
        throw new Error('Invalid calendar weekdays');
    }
    const weekdays = rawWeekdays as number[];
    const windows = row.schedule_windows.map((raw): CalendarWindow => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid calendar window');
        const r = raw as Record<string, unknown>;
        const start = typeof r.start === 'string' ? r.start : '';
        const end = typeof r.end === 'string' ? r.end : '';
        const discount = Number(r.discount);
        if (parseMinutes(start) == null || parseMinutes(end) == null || parseMinutes(start) === parseMinutes(end))
            throw new Error('Invalid calendar window time');
        if (!Number.isFinite(discount) || discount < 0.05 || discount > 2)
            throw new Error('Invalid calendar window discount');
        if (r.priority != null && (!Number.isInteger(r.priority) || !Number.isFinite(Number(r.priority)))) {
            throw new Error('Invalid calendar window priority');
        }
        if (r.enabled != null && typeof r.enabled !== 'boolean')
            throw new Error('Invalid calendar window enabled flag');
        if (r.weekdays != null) {
            if (
                !Array.isArray(r.weekdays) ||
                r.weekdays.length === 0 ||
                r.weekdays.some((x) => !Number.isInteger(x) || Number(x) < 1 || Number(x) > 7) ||
                new Set(r.weekdays).size !== r.weekdays.length
            ) {
                throw new Error('Invalid calendar window weekdays');
            }
        }
        if (r.starts_on != null && !isLocalDate(r.starts_on)) throw new Error('Invalid calendar window start date');
        if (r.ends_on != null && !isLocalDate(r.ends_on)) throw new Error('Invalid calendar window end date');
        if (isLocalDate(r.starts_on) && isLocalDate(r.ends_on) && r.starts_on > r.ends_on) {
            throw new Error('Invalid calendar window date range');
        }
        if (r.note != null && (typeof r.note !== 'string' || r.note.length > 200)) {
            throw new Error('Invalid calendar window note');
        }
        return {
            start,
            end,
            discount,
            priority: r.priority == null ? 0 : Number(r.priority),
            enabled: r.enabled == null ? true : r.enabled,
            weekdays: r.weekdays == null ? weekdays : (r.weekdays as number[]),
            starts_on: r.starts_on == null ? undefined : (r.starts_on as string),
            ends_on: r.ends_on == null ? undefined : (r.ends_on as string),
            note: r.note == null ? undefined : (r.note as string),
        };
    });
    assertNoAmbiguousCalendarWindows(windows);
    const matches = windows.filter((window) => {
        if (!window.enabled) return false;
        const start = parseMinutes(window.start)!;
        const end = parseMinutes(window.end)!;
        const activeWeekdays = window.weekdays ?? weekdays;
        const afterMidnight = start > end && parts.minutes < end;
        const occurrenceDate = afterMidnight
            ? (() => {
                  const [year, month, day] = parts.date.split('-').map(Number);
                  const previous = new Date(Date.UTC(year, month - 1, day - 1));
                  return `${previous.getUTCFullYear().toString().padStart(4, '0')}-${(previous.getUTCMonth() + 1)
                      .toString()
                      .padStart(2, '0')}-${previous.getUTCDate().toString().padStart(2, '0')}`;
              })()
            : parts.date;
        if (window.starts_on && occurrenceDate < window.starts_on) return false;
        if (window.ends_on && occurrenceDate > window.ends_on) return false;
        if (start < end) {
            return activeWeekdays.includes(parts.weekday) && parts.minutes >= start && parts.minutes < end;
        }
        const previousWeekday = parts.weekday === 1 ? 7 : parts.weekday - 1;
        return (
            (activeWeekdays.includes(parts.weekday) && parts.minutes >= start) ||
            (activeWeekdays.includes(previousWeekday) && parts.minutes < end)
        );
    });
    if (matches.length === 0) return null;
    const highestPriority = Math.max(...matches.map((window) => window.priority ?? 0));
    const highestMatches = matches.filter((window) => (window.priority ?? 0) === highestPriority);
    if (highestMatches.length > 1) throw new Error('Ambiguous overlapping calendar windows at equal priority');
    const window = highestMatches[0];
    return { window, timezone };
}

/** 与实际计费共用的规则状态判断，供管理 API 展示当前命中状态。 */
export function evaluateGlobalDiscountRule(
    row: {
        discount: unknown;
        expires_at?: Date | null;
        effective_from?: Date | null;
        schedule_timezone?: string | null;
        schedule_weekdays?: unknown;
        schedule_windows?: unknown;
    },
    at = new Date(),
): GlobalDiscountRuleStatus {
    const timezone = row.schedule_timezone ?? 'Asia/Shanghai';
    if (typeof timezone !== 'string' || !timezone.trim()) throw new Error('Invalid pricing calendar timezone');
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
        throw new Error('Invalid pricing calendar timezone');
    }
    if (row.effective_from && row.effective_from.getTime() > at.getTime()) {
        return {
            active: false,
            status: 'pending',
            discount: null,
            timezone,
            window: null,
            next_transition_at: null,
            next_transition_kind: null,
        };
    }
    if (row.expires_at && row.expires_at.getTime() <= at.getTime()) {
        return {
            active: false,
            status: 'expired',
            discount: null,
            timezone,
            window: null,
            next_transition_at: null,
            next_transition_kind: null,
        };
    }
    const staticDiscount = Number(row.discount);
    if (!Number.isFinite(staticDiscount) || staticDiscount < 0.05 || staticDiscount > 2) {
        throw new Error('Invalid global pricing discount');
    }
    if (Array.isArray(row.schedule_windows)) {
        if (row.schedule_windows.length === 0) {
            return {
                active: false,
                status: 'inactive',
                discount: null,
                timezone,
                window: null,
                next_transition_at: null,
                next_transition_kind: null,
            };
        }
        const scheduled = activeCalendarWindow(row, at);
        const nextTransition = nextCalendarTransition(row, at);
        return scheduled
            ? {
                  active: true,
                  status: 'active',
                  discount: scheduled.window.discount,
                  timezone: scheduled.timezone,
                  window: scheduled.window,
                  next_transition_at: nextTransition?.at ?? null,
                  next_transition_kind: nextTransition?.kind ?? null,
              }
            : {
                  active: false,
                  status: 'inactive',
                  discount: null,
                  timezone,
                  window: null,
                  next_transition_at: nextTransition?.at ?? null,
                  next_transition_kind: nextTransition?.kind ?? null,
              };
    }
    if (row.schedule_windows != null || row.schedule_weekdays != null) {
        throw new Error('Invalid pricing calendar configuration');
    }
    return {
        active: true,
        status: 'active',
        discount: staticDiscount,
        timezone,
        window: null,
        next_transition_at: null,
        next_transition_kind: null,
    };
}

/** 企业门户任务在 seedance_video_tasks.tier 里的标记(区分 seedance-cn 渠道任务)。 */
export const ENTERPRISE_TIER = 'enterprise-portal';

/** 客户 per-模型议价折扣(enterprise_model_discounts,按 客户×渠道×模型档)。【优先级最高】。
 *  返回折扣率;无行 → null。已存行若倍率非法则拒绝报价，禁止静默回落到更低价规则。 */
async function modelDiscountFor(
    userId: string,
    variant: SeedanceVariant,
    region: SeedanceRegion,
): Promise<number | null> {
    const row = await prisma.enterpriseModelDiscount.findUnique({
        where: { user_id_region_variant: { user_id: userId, region, variant } },
        select: { discount: true },
    });
    if (!row) return null;
    const d = Number(row.discount);
    if (!Number.isFinite(d) || d < 0.05 || d > 2) throw new Error('Invalid customer model discount');
    return d;
}

/** 客户级折扣率(enterprise_upstream_keys.discount,每版本一行 → 国内/海外独立)。
 *  【口径 2026-08-07 重锚】相对【官方挂牌价】:0.85 = 标准零售(默认),0.9 = 官方价九折,
 *  1 = 按官方原价。没有配置行时使用官方价；已存行但倍率非法时拒绝报价。 */
async function customerDiscount(userId: string, region: SeedanceRegion): Promise<number> {
    const row = await prisma.enterpriseUpstreamKey.findUnique({
        where: { user_id_region: { user_id: userId, region } },
        select: { discount: true },
    });
    if (!row) return 1;
    const d = Number(row.discount);
    if (!Number.isFinite(d) || d < 0.05 || d > 2) throw new Error('Invalid customer discount');
    return d;
}

/** 全局折扣(enterprise_global_discounts,按 渠道×模型 的临时促销)。
 *  返回有效折扣率;无行 / 已过期(读时判定)/ 非法值 → null(回落客户折扣)。 */
async function globalPricingRuleFor(
    region: SeedanceRegion,
    variant: SeedanceVariant,
    at: Date,
): Promise<{ discount: number; rule: Record<string, unknown>; timezone: string } | null> {
    const row = await prisma.enterpriseGlobalDiscount.findUnique({
        where: { region_variant: { region, variant } },
        select: {
            id: true,
            discount: true,
            expires_at: true,
            effective_from: true,
            schedule_timezone: true,
            schedule_weekdays: true,
            schedule_windows: true,
        },
    });
    if (!row) return null;
    const status = evaluateGlobalDiscountRule(row, at);
    if (!status.active || status.discount == null) return null;
    return {
        discount: status.discount,
        timezone: status.timezone,
        rule: status.window
            ? { id: row.id, type: 'calendar', window: status.window, weekdays: row.schedule_weekdays ?? null }
            : { id: row.id, type: 'static' },
    };
}

/** 对客 ¥ 计价优先级(2026-08-11 起,全折扣制三层,取第一个命中):
 *   1. per-模型议价折扣(enterprise_model_discounts 按 客户×渠道×模型)—— 【最高】,客户协议价;
 *   2. 全局折扣(enterprise_global_discounts 按 渠道×模型)—— 促销,覆盖客户整体折扣,按模型隔离;
 *   3. 客户整体折扣(enterprise_upstream_keys.discount)—— 缺省。
 *  实付 = 官方挂牌价 × 生效折扣。三层都按 (渠道×模型) 隔离,不影响其它模型。海外挂牌价 = 国内(operator 拍板)。 */
export async function computeEnterpriseCostCny(
    userId: string,
    tokens: number | bigint,
    resolution: Resolution,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
    region: SeedanceRegion = 'cn',
): Promise<number> {
    return (await getEnterprisePricingSnapshot(userId, tokens, resolution, hasVideo, variant, region)).costCny;
}

export async function getEnterprisePricingSnapshot(
    userId: string,
    tokens: number | bigint,
    resolution: Resolution,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
    region: SeedanceRegion = 'cn',
    at = new Date(),
): Promise<EnterprisePricingSnapshot> {
    assertPricingIdentity(variant, region, resolution);
    // Validate the highest-priority rule before reading lower-priority rules. A corrupt
    // stored model discount must fail closed and must never silently fall back to a cheaper quote.
    const modelDisc = await modelDiscountFor(userId, variant, region);
    const [globalRule, customerDisc] = await Promise.all([
        globalPricingRuleFor(region, variant, at),
        customerDiscount(userId, region),
    ]);
    const t = typeof tokens === 'bigint' ? Number(tokens) : tokens;
    const source = modelDisc != null ? 'model' : globalRule != null ? 'global' : 'customer';
    const discount = modelDisc ?? globalRule?.discount ?? customerDisc;
    const timezone = globalRule?.timezone ?? 'Asia/Shanghai';
    const base = officialCostCny(t, resolution, hasVideo, variant);
    const identity: PricingIdentity = { family: 'seedance', region, variant, resolution, hasVideo };
    const rate = officialCostCny(1_000_000, resolution, hasVideo, variant);
    const evaluatedAt = at.toISOString();
    const pricingRule = modelDisc != null ? { type: 'model' } : (globalRule?.rule ?? { type: 'customer' });
    return {
        costCny: +(base * discount).toFixed(6),
        discount,
        source,
        timezone,
        evaluatedAt,
        rule: {
            ...pricingRule,
            source,
            timezone,
            identity,
            basis: { currency: 'CNY', unit: 'token', unitQuantity: 1_000_000, rate },
            evaluatedAt,
        },
    };
}

/** 提交前成本预估(余额门)。含视频 1.5× 缓冲,同 cn-billing 语义。 */
export async function estimateEnterpriseCostCny(
    userId: string,
    resolution: Resolution,
    duration: number,
    hasVideo: boolean,
    variant: SeedanceVariant = 'pro',
    region: SeedanceRegion = 'cn',
): Promise<number> {
    const base = await computeEnterpriseCostCny(
        userId,
        estimateTokens(resolution, duration),
        resolution,
        hasVideo,
        variant,
        region,
    );
    return hasVideo ? +(base * 1.5).toFixed(6) : base;
}

/**
 * 轮询完成时扣费 —— 幂等:①CAS 抢占 billed=false→true(并发轮询只有一个能扣);
 * ②applyLedgerEntry(charge, ref=taskId)((kind,ref) unique 二级幂等)。
 * 账本失败时释放本次 claim，允许后续重试；若账本其实已经提交，ref 幂等会阻止重复入账。
 */
export async function chargeEnterpriseVideoTask(taskId: string): Promise<ChargeResult> {
    const task = await prisma.seedanceVideoTask.findUnique({ where: { id: taskId } });
    if (!task) return { outcome: 'skipped' };
    if (task.billed) return { outcome: 'already_billed' };
    if (task.tokens == null || Number(task.tokens) <= 0) return { outcome: 'skipped' };

    const identity = identityForTaskModel(task.model, task.resolution as Resolution, task.has_video);

    let costCny: number;
    if (task.cost_cny != null && task.billed_at != null) {
        // A failed ledger call may have committed before its acknowledgement was lost.
        // Keep the first claimed amount stable so a retry agrees with the ledger ref.
        costCny = Number(task.cost_cny);
        if (!Number.isFinite(costCny) || costCny < 0) throw new Error('Invalid retained billing claim cost');
    } else {
        const snapshotFields = [task.pricing_discount, task.pricing_source, task.pricing_rule, task.pricing_timezone];
        const hasAnySnapshotField = snapshotFields.some((value) => value != null);
        if (hasAnySnapshotField) {
            const { rate, discount } = assertSnapshotMatchesTask(
                task,
                task.pricing_discount,
                task.pricing_source,
                task.pricing_rule,
                task.pricing_timezone,
            );
            costCny = +((Number(task.tokens) / 1_000_000) * rate * discount).toFixed(6);
        } else {
            const snapshot = await getEnterprisePricingSnapshot(
                task.user_id,
                task.tokens,
                task.resolution as Resolution,
                task.has_video,
                identity.variant,
                identity.region,
            );
            costCny = snapshot.costCny;
        }
    }

    const claimedAt = new Date();
    const claim = await prisma.seedanceVideoTask.updateMany({
        where: { id: taskId, billed: false },
        data: { billed: true, cost_cny: costCny, billed_at: claimedAt },
    });
    if (claim.count === 0) return { outcome: 'already_billed' };

    try {
        await applyLedgerEntry(task.user_id, {
            kind: 'charge',
            amount_cny: -costCny,
            ref: taskId,
            note: `${task.model}`,
            tenantId: task.tenant_id,
        });
        return { outcome: 'charged', costCny };
    } catch (e) {
        try {
            const released = await prisma.seedanceVideoTask.updateMany({
                where: { id: taskId, billed: true, billed_at: claimedAt, cost_cny: costCny },
                data: { billed: false },
            });
            if (released.count !== 1) {
                console.error('[enterprise-billing] deduct FAILED and claim release was not confirmed', {
                    taskId,
                    costCny,
                    released: released.count,
                    err: e instanceof Error ? e.message : String(e),
                });
            }
        } catch (releaseError) {
            console.error('[enterprise-billing] deduct FAILED and claim release errored', {
                taskId,
                costCny,
                err: e instanceof Error ? e.message : String(e),
                releaseError: releaseError instanceof Error ? releaseError.message : String(releaseError),
            });
        }
        console.error('[enterprise-billing] deduct FAILED; claim released for retry', {
            taskId,
            costCny,
            err: e instanceof Error ? e.message : String(e),
        });
        return { outcome: 'deduct_failed', costCny };
    }
}
