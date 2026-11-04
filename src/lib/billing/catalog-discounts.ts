export type CatalogDiscountSource = 'customer_model' | 'global' | 'customer' | 'model';

export type CatalogDiscountTarget = {
    modelId: string | null;
    tier: string | null;
};

export type CatalogDiscountWindow = {
    start: string;
    end: string;
    discount: number;
    priority?: number;
    enabled?: boolean;
    weekdays?: number[];
    startsOn?: string | null;
    endsOn?: string | null;
};

export type CatalogDiscountRule = {
    id: string;
    kind: Exclude<CatalogDiscountSource, 'model'>;
    enabled: boolean;
    tenantId: string | null;
    userId: string | null;
    targets: CatalogDiscountTarget[];
    discount: number;
    priority: number;
    createdAt: string | Date;
    effectiveFrom: string | Date | null;
    expiresAt: string | Date | null;
    timezone: string;
    weekdays: number[] | null;
    windows: CatalogDiscountWindow[] | null;
};

export type CatalogDiscountIdentity = {
    userId: string;
    modelId: string;
    tier: string;
    tenantId?: string | null;
};

export type CatalogDiscountSelection = {
    source: CatalogDiscountSource;
    ruleId: string | null;
    discount: number;
    evaluatedAt: string;
    timezone: string;
};

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function instant(value: string | Date | null): number | null {
    if (value == null) return null;
    const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(milliseconds)) throw new Error('Invalid catalog discount date');
    return milliseconds;
}

function validDiscount(value: number): boolean {
    return Number.isFinite(value) && value >= 0.05 && value <= 2;
}

function timeParts(at: Date, timezone: string) {
    let parts: Intl.DateTimeFormatPart[];
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            weekday: 'short',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(at);
    } catch {
        throw new Error('Invalid catalog discount timezone');
    }
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const weekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[
        values.weekday
    ];
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    if (!weekday || !Number.isInteger(hour) || !Number.isInteger(minute)) {
        throw new Error('Invalid catalog discount calendar');
    }
    return {
        weekday,
        minutes: hour * 60 + minute,
        date: `${values.year}-${values.month}-${values.day}`,
    };
}

function addLocalDays(date: string, days: number): string {
    const [year, month, day] = date.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + days));
    return `${next.getUTCFullYear().toString().padStart(4, '0')}-${(next.getUTCMonth() + 1)
        .toString()
        .padStart(2, '0')}-${next.getUTCDate().toString().padStart(2, '0')}`;
}

function parseTime(value: string): number {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Invalid catalog discount window time');
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
}

function validLocalDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateWindow(window: CatalogDiscountWindow): void {
    if (window.enabled !== undefined && typeof window.enabled !== 'boolean') {
        throw new Error('Invalid catalog discount window state');
    }
    const start = parseTime(window.start);
    const end = parseTime(window.end);
    if (start === end) throw new Error('Invalid catalog discount window');
    if (!validDiscount(window.discount)) throw new Error('Invalid catalog discount');
    if (window.priority !== undefined && (!Number.isInteger(window.priority) || !Number.isFinite(window.priority))) {
        throw new Error('Invalid catalog discount priority');
    }
    if (
        window.weekdays &&
        (window.weekdays.length === 0 || window.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7))
    ) {
        throw new Error('Invalid catalog discount weekdays');
    }
    if (window.startsOn && !validLocalDate(window.startsOn)) throw new Error('Invalid catalog discount start date');
    if (window.endsOn && !validLocalDate(window.endsOn)) throw new Error('Invalid catalog discount end date');
    if (window.startsOn && window.endsOn && window.startsOn > window.endsOn) {
        throw new Error('Invalid catalog discount date range');
    }
}

function windowMatches(
    window: CatalogDiscountWindow,
    rule: CatalogDiscountRule,
    local: ReturnType<typeof timeParts>,
): boolean {
    if (window.enabled === false) return false;
    const minute = local.minutes;
    const start = parseTime(window.start);
    const end = parseTime(window.end);
    const weekdays = window.weekdays ?? rule.weekdays ?? [1, 2, 3, 4, 5, 6, 7];
    const matchesStartDay = (date: string, weekday: number, startOffset: 0 | -1): boolean => {
        const effectiveStartDate = startOffset === 0 ? date : addLocalDays(date, -1);
        const effectiveStartDay = startOffset === 0 ? weekday : weekday === 1 ? 7 : weekday - 1;
        if (!weekdays.includes(effectiveStartDay)) return false;
        if (window.startsOn && effectiveStartDate < window.startsOn) return false;
        if (window.endsOn && effectiveStartDate > window.endsOn) return false;
        return true;
    };
    if (end > start) {
        return minute >= start && minute < end && matchesStartDay(local.date, local.weekday, 0);
    }
    if (minute >= start) return matchesStartDay(local.date, local.weekday, 0);
    if (minute < end) return matchesStartDay(local.date, local.weekday, -1);
    return false;
}

function targetSpecificity(target: CatalogDiscountTarget): number {
    return Number(target.modelId !== null) + Number(target.tier !== null);
}

function matchingSpecificity(rule: CatalogDiscountRule, identity: CatalogDiscountIdentity): number | null {
    const matching = rule.targets.filter(
        (candidate) =>
            (candidate.modelId === null || candidate.modelId === identity.modelId) &&
            (candidate.tier === null || candidate.tier === identity.tier),
    );
    return matching.length > 0 ? Math.max(...matching.map(targetSpecificity)) : null;
}

type EligibleCatalogDiscount = {
    specificity: number;
    discount: number;
};

function eligible(
    rule: CatalogDiscountRule,
    identity: CatalogDiscountIdentity,
    at: Date,
): EligibleCatalogDiscount | null {
    if (!rule.enabled || rule.tenantId !== (identity.tenantId ?? null)) return null;
    if (rule.kind === 'global' ? rule.userId !== null : rule.userId !== identity.userId) return null;
    const specificity = matchingSpecificity(rule, identity);
    if (specificity === null) return null;

    const from = instant(rule.effectiveFrom);
    const until = instant(rule.expiresAt);
    if (from !== null && until !== null && from >= until) throw new Error('Invalid catalog discount date range');
    if (from !== null && at.getTime() < from) return null;
    if (until !== null && at.getTime() >= until) return null;
    if (!validDiscount(rule.discount)) throw new Error('Invalid catalog discount');

    if (rule.kind !== 'global' || rule.windows === null) return { specificity, discount: rule.discount };
    if (rule.windows.length === 0) throw new Error('Invalid catalog discount calendar');
    const local = timeParts(at, rule.timezone || DEFAULT_TIMEZONE);
    for (const window of rule.windows) validateWindow(window);
    const matching = rule.windows.filter((window) => windowMatches(window, rule, local));
    if (matching.length === 0) return null;
    const maxPriority = Math.max(...matching.map((window) => window.priority ?? rule.priority));
    const top = matching.filter((window) => (window.priority ?? rule.priority) === maxPriority);
    if (top.length > 1) throw new Error('Ambiguous catalog discount calendar');
    return { specificity, discount: top[0].discount };
}

function creationTime(rule: CatalogDiscountRule): number {
    const value = instant(rule.createdAt);
    if (value === null) throw new Error('Invalid catalog discount creation date');
    return value;
}

export function selectCatalogDiscount(
    rules: CatalogDiscountRule[],
    identity: CatalogDiscountIdentity,
    at: Date,
): CatalogDiscountSelection {
    if (!Number.isFinite(at.getTime())) throw new Error('Invalid catalog discount evaluation time');
    const candidates = rules
        .map((rule) => ({ rule, result: eligible(rule, identity, at) }))
        .filter(
            (candidate): candidate is { rule: CatalogDiscountRule; result: EligibleCatalogDiscount } =>
                candidate.result !== null,
        );
    const precedence: CatalogDiscountSource[] = ['customer_model', 'global', 'customer'];

    for (const source of precedence) {
        const matches = candidates.filter(({ rule }) => rule.kind === source);
        if (matches.length === 0) continue;
        if (source === 'customer_model' && matches.length > 1) {
            throw new Error('Ambiguous customer model discount');
        }
        matches.sort((a, b) => {
            if (source === 'global') {
                return (
                    b.result.specificity - a.result.specificity ||
                    b.rule.priority - a.rule.priority ||
                    creationTime(a.rule) - creationTime(b.rule) ||
                    a.rule.id.localeCompare(b.rule.id)
                );
            }
            return creationTime(a.rule) - creationTime(b.rule) || a.rule.id.localeCompare(b.rule.id);
        });
        if (source === 'customer' && matches.length > 1) throw new Error('Ambiguous customer discount');
        const selected = matches[0].rule;
        return {
            source,
            ruleId: selected.id,
            discount: matches[0].result.discount,
            evaluatedAt: at.toISOString(),
            timezone: selected.timezone || DEFAULT_TIMEZONE,
        };
    }

    return {
        source: 'model',
        ruleId: null,
        discount: 1,
        evaluatedAt: at.toISOString(),
        timezone: DEFAULT_TIMEZONE,
    };
}
