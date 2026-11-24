'use client';

import { useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { intlLocale } from '@/lib/i18n';
import { useLocale, useMessages } from '@/lib/i18n/client';
import { logsMessages } from '@/lib/i18n/messages/logs';

export interface DateRange {
    start: string;
    end: string;
}

const MINUTE = 60_000;
const pad = (n: number) => String(n).padStart(2, '0');

function formatDateTime(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function getLogDatePresets(now: Date) {
    const year = now.getFullYear();
    const month = now.getMonth();
    const day = now.getDate();
    const today = new Date(year, month, day);
    const tomorrow = new Date(year, month, day + 1);
    const end = formatDateTime(now);
    const endingBefore = (date: Date) => `${formatDateTime(new Date(date.getTime() - 1000))}:59`;
    const recent = (minutes: number): DateRange => ({
        start: formatDateTime(new Date(now.getTime() - minutes * MINUTE)),
        end,
    });
    return {
        last15m: recent(15),
        last30m: recent(30),
        last1h: recent(60),
        last3h: recent(180),
        last6h: recent(360),
        last12h: recent(720),
        last24h: recent(1440),
        today: { start: formatDateTime(today), end },
        allToday: { start: formatDateTime(today), end: endingBefore(tomorrow) },
        yesterday: { start: formatDateTime(new Date(year, month, day - 1)), end: endingBefore(today) },
        last3d: recent(3 * 1440),
        last7d: recent(7 * 1440),
        last30d: recent(30 * 1440),
        month: { start: formatDateTime(new Date(year, month, 1)), end },
    };
}

function Calendar({ value, onChange }: { value: string; onChange: (date: string) => void }) {
    const copy = useMessages(logsMessages).dates;
    const locale = intlLocale(useLocale());
    const parsed = new Date(value);
    const current = Number.isFinite(parsed.getTime()) ? parsed : new Date();
    const [month, setMonth] = useState(() => new Date(current.getFullYear(), current.getMonth(), 1));
    const year = month.getFullYear();
    const index = month.getMonth();
    const firstDay = month.getDay();
    const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month);
    const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'full' });

    return (
        <div>
            <div className="flex items-center justify-between gap-2 py-2">
                <button
                    type="button"
                    aria-label={copy.previousMonth}
                    onClick={() => setMonth(new Date(year, index - 1, 1))}
                    className="grid size-9 place-items-center rounded-md hover:bg-portal-soft"
                >
                    <ChevronLeft size={17} aria-hidden="true" />
                </button>
                <span aria-live="polite" className="text-sm font-semibold">
                    {monthLabel}
                </span>
                <button
                    type="button"
                    aria-label={copy.nextMonth}
                    onClick={() => setMonth(new Date(year, index + 1, 1))}
                    className="grid size-9 place-items-center rounded-md hover:bg-portal-soft"
                >
                    <ChevronRight size={17} aria-hidden="true" />
                </button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-xs">
                {copy.weekdays.map((label) => (
                    <span key={label} className="py-2 text-portal-muted">
                        {label}
                    </span>
                ))}
                {Array.from({ length: 42 }, (_, cell) => {
                    const date = new Date(year, index, 1 + cell - firstDay, current.getHours(), current.getMinutes());
                    const dateTime = formatDateTime(date);
                    const selected = value.startsWith(dateTime.slice(0, 10));
                    return (
                        <button
                            key={dateTime}
                            type="button"
                            aria-label={dateFormatter.format(date)}
                            aria-pressed={selected}
                            onClick={() => {
                                setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
                                onChange(dateTime);
                            }}
                            className={`h-9 rounded-md tabular-nums ${selected ? 'bg-navy text-white' : 'hover:bg-portal-soft'} ${date.getMonth() !== index && !selected ? 'text-portal-muted' : ''}`}
                        >
                            {date.getDate()}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (range: DateRange) => void }) {
    const copy = useMessages(logsMessages);
    const [openField, setOpenField] = useState<keyof DateRange | null>(null);
    return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(['start', 'end'] as const).map((field) => (
                <div key={field} className="min-w-0">
                    <div className="mb-1.5 text-xs font-medium text-portal-muted">{copy.filters[field]}</div>
                    <Popover.Root
                        open={openField === field}
                        onOpenChange={(open) =>
                            setOpenField((current) => (open ? field : current === field ? null : current))
                        }
                    >
                        <Popover.Trigger
                            className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-portal-line bg-portal-panel px-3 text-left text-sm text-portal-ink hover:border-navy focus-visible:outline-2 focus-visible:outline-navy"
                            aria-label={copy.filters[field]}
                        >
                            <span className="truncate" suppressHydrationWarning>
                                {value[field].replace('T', ' ') || copy.dates.unset}
                            </span>
                            <CalendarDays size={16} className="shrink-0" aria-hidden="true" />
                        </Popover.Trigger>
                        <Popover.Portal>
                            <Popover.Positioner sideOffset={8} collisionPadding={12} className="z-50">
                                <Popover.Popup className="max-h-[var(--available-height)] w-[min(22rem,calc(100vw-1.5rem))] overflow-auto rounded-lg border border-portal-line bg-portal-panel p-3 text-portal-ink shadow-lg">
                                    <Popover.Title className="sr-only">{copy.filters[field]}</Popover.Title>
                                    <div className="flex flex-wrap gap-1.5">
                                        {(
                                            Object.keys(copy.dates.presets) as Array<
                                                keyof ReturnType<typeof getLogDatePresets>
                                            >
                                        ).map((preset) => (
                                            <button
                                                key={preset}
                                                type="button"
                                                className="min-h-8 rounded-md border border-portal-line px-2 text-xs hover:bg-portal-soft"
                                                onClick={() => {
                                                    onChange(getLogDatePresets(new Date())[preset]);
                                                    setOpenField(null);
                                                }}
                                            >
                                                {copy.dates.presets[preset]}
                                            </button>
                                        ))}
                                    </div>
                                    <Calendar
                                        value={value[field]}
                                        onChange={(date) => onChange({ ...value, [field]: date })}
                                    />
                                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-portal-line pt-3">
                                        <input
                                            type="datetime-local"
                                            step={1}
                                            aria-label={copy.filters[field]}
                                            value={value[field]}
                                            onChange={(event) => onChange({ ...value, [field]: event.target.value })}
                                            className="h-9 min-w-0 flex-1 rounded-md border border-portal-line bg-portal-panel px-2 text-sm"
                                        />
                                        <button
                                            type="button"
                                            className="h-9 rounded-md bg-navy px-3 text-sm text-white"
                                            onClick={() => setOpenField(null)}
                                        >
                                            {copy.dates.done}
                                        </button>
                                    </div>
                                </Popover.Popup>
                            </Popover.Positioner>
                        </Popover.Portal>
                    </Popover.Root>
                </div>
            ))}
        </div>
    );
}
