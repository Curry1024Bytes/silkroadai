export type GlobalDiscountFormRule = {
    region: string;
    variant: string;
    version: number;
    discount: number;
    effective_from: string | null;
    expires_at: string | null;
    schedule_timezone: string;
    schedule_weekdays: number[] | null;
    schedule_windows: Array<{
        start: string;
        end: string;
        discount: number;
        priority?: number;
        enabled?: boolean;
        weekdays?: number[];
        starts_on?: string | null;
        ends_on?: string | null;
        note?: string | null;
    }> | null;
    note: string | null;
};

export type GlobalDiscountWindowValues = {
    start: string;
    end: string;
    discountPercent: string;
    priority: string;
    enabled: boolean;
    weekdays: number[];
    startsOn: string;
    endsOn: string;
    note: string;
};

export type GlobalDiscountFormValues = {
    region: string;
    variant: string;
    expectedVersion: number;
    discountPercent: string;
    effectiveLocal: string;
    expiresLocal: string;
    scheduleTimezone: string;
    scheduleWeekdays: number[];
    scheduleWindows: GlobalDiscountWindowValues[];
    note: string;
};

export type GlobalDiscountPayloadInput = Omit<GlobalDiscountFormValues, 'expectedVersion'> & {
    expectedVersion: number;
};

export function toGlobalDiscountPayload(values: GlobalDiscountPayloadInput) {
    return {
        region: values.region,
        variant: values.variant,
        expected_version: values.expectedVersion,
        discount: Number(values.discountPercent) / 100,
        effective_from: values.effectiveLocal
            ? datetimeLocalToIso(values.effectiveLocal, values.scheduleTimezone)
            : null,
        expires_at: values.expiresLocal ? datetimeLocalToIso(values.expiresLocal, values.scheduleTimezone) : null,
        schedule_timezone: values.scheduleTimezone,
        schedule_weekdays: values.scheduleWeekdays,
        schedule_windows: values.scheduleWindows.map((window) => ({
            start: window.start.trim(),
            end: window.end.trim(),
            discount: Number(window.discountPercent) / 100,
            ...(window.priority.trim() ? { priority: Number(window.priority) } : {}),
            enabled: window.enabled,
            weekdays: window.weekdays,
            starts_on: window.startsOn || null,
            ends_on: window.endsOn || null,
            note: window.note.trim(),
        })),
        note: values.note.trim(),
    };
}

const formatter = (timezone: string) =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    });

function dateParts(date: Date, timezone: string) {
    const parts = Object.fromEntries(
        formatter(timezone)
            .formatToParts(date)
            .map(({ type, value }) => [type, value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function isoToDatetimeLocal(iso: string, timezone: string): string {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) throw new Error('无效日期');
    return dateParts(date, timezone);
}

export function datetimeLocalToIso(value: string, timezone: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match) throw new Error('日期时间格式无效');
    const [, year, month, day, hour, minute] = match.map(Number);
    const wallTime = Date.UTC(year, month - 1, day, hour, minute);
    if (dateParts(new Date(wallTime), 'UTC') !== value) throw new Error('日期时间无效');

    let instant = wallTime;
    for (let i = 0; i < 4; i += 1) {
        const shown = dateParts(new Date(instant), timezone);
        const shownMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(shown)!;
        const shownWallTime = Date.UTC(
            Number(shownMatch[1]),
            Number(shownMatch[2]) - 1,
            Number(shownMatch[3]),
            Number(shownMatch[4]),
            Number(shownMatch[5]),
        );
        const difference = wallTime - shownWallTime;
        if (difference === 0) return new Date(instant).toISOString();
        instant += difference;
    }
    throw new Error('所选时区中该本地时间不存在');
}

function percent(value: number): string {
    return String(Number((value * 100).toFixed(6)));
}

export function globalDiscountFormValues(rule: GlobalDiscountFormRule): GlobalDiscountFormValues {
    const timezone = rule.schedule_timezone || 'Asia/Shanghai';
    return {
        region: rule.region,
        variant: rule.variant,
        expectedVersion: rule.version,
        discountPercent: percent(rule.discount),
        effectiveLocal: rule.effective_from ? isoToDatetimeLocal(rule.effective_from, timezone) : '',
        expiresLocal: rule.expires_at ? isoToDatetimeLocal(rule.expires_at, timezone) : '',
        scheduleTimezone: timezone,
        scheduleWeekdays: rule.schedule_weekdays ?? [1, 2, 3, 4, 5, 6, 7],
        scheduleWindows: (rule.schedule_windows ?? []).map((window) => ({
            start: window.start,
            end: window.end,
            discountPercent: percent(window.discount),
            priority: window.priority == null ? '' : String(window.priority),
            enabled: window.enabled ?? true,
            weekdays: window.weekdays ?? rule.schedule_weekdays ?? [1, 2, 3, 4, 5, 6, 7],
            startsOn: window.starts_on ?? '',
            endsOn: window.ends_on ?? '',
            note: window.note ?? '',
        })),
        note: rule.note ?? '',
    };
}
