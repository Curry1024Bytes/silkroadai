import { describe, expect, it } from 'vitest';
import {
    datetimeLocalToIso,
    globalDiscountFormValues,
    isoToDatetimeLocal,
    toGlobalDiscountPayload,
} from '../global-discount-form';

describe('global discount form values', () => {
    it('loads an existing calendar rule without losing its timezone, windows, weekdays, or dates', () => {
        expect(
            globalDiscountFormValues({
                region: 'cn',
                variant: 'fast',
                version: 4,
                discount: 0.8,
                effective_from: '2026-11-03T04:00:00.000Z',
                expires_at: '2026-11-08T04:00:00.000Z',
                schedule_timezone: 'Asia/Shanghai',
                schedule_weekdays: [1, 3, 5],
                schedule_windows: [
                    {
                        start: '22:00',
                        end: '02:00',
                        discount: 0.6,
                        priority: 2,
                        enabled: false,
                        weekdays: [1, 3],
                        starts_on: '2026-11-01',
                        ends_on: '2026-11-30',
                        note: 'night sale',
                    },
                ],
                note: 'weeknight promotion',
            }),
        ).toEqual({
            region: 'cn',
            variant: 'fast',
            expectedVersion: 4,
            discountPercent: '80',
            effectiveLocal: '2026-11-03T12:00',
            expiresLocal: '2026-11-08T12:00',
            scheduleTimezone: 'Asia/Shanghai',
            scheduleWeekdays: [1, 3, 5],
            scheduleWindows: [
                {
                    start: '22:00',
                    end: '02:00',
                    discountPercent: '60',
                    priority: '2',
                    enabled: false,
                    weekdays: [1, 3],
                    startsOn: '2026-11-01',
                    endsOn: '2026-11-30',
                    note: 'night sale',
                },
            ],
            note: 'weeknight promotion',
        });
    });

    it('converts datetime-local in the chosen business timezone, independent of host timezone', () => {
        expect(datetimeLocalToIso('2026-11-04T12:30', 'Asia/Shanghai')).toBe('2026-11-04T04:30:00.000Z');
        expect(isoToDatetimeLocal('2026-11-04T04:30:00.000Z', 'Asia/Shanghai')).toBe('2026-11-04T12:30');
    });

    it('resolves daylight-saving transitions using the selected IANA timezone', () => {
        expect(datetimeLocalToIso('2026-11-01T01:30', 'America/Los_Angeles')).toBe('2026-11-01T08:30:00.000Z');
        expect(isoToDatetimeLocal('2026-11-01T08:30:00.000Z', 'America/Los_Angeles')).toBe('2026-11-01T01:30');
    });

    it('serializes versioned window settings and sends empty arrays to clear the schedule', () => {
        expect(
            toGlobalDiscountPayload({
                region: 'cn',
                variant: 'fast',
                expectedVersion: 7,
                discountPercent: '80',
                effectiveLocal: '2026-11-04T12:30',
                expiresLocal: '',
                scheduleTimezone: 'Asia/Shanghai',
                scheduleWeekdays: [1, 3],
                scheduleWindows: [
                    {
                        start: '22:00',
                        end: '02:00',
                        discountPercent: '60',
                        priority: '2',
                        enabled: false,
                        weekdays: [1, 3],
                        startsOn: '2026-11-04',
                        endsOn: '2026-11-30',
                        note: 'night sale',
                    },
                ],
                note: 'campaign',
            }),
        ).toEqual({
            region: 'cn',
            variant: 'fast',
            expected_version: 7,
            discount: 0.8,
            effective_from: '2026-11-04T04:30:00.000Z',
            expires_at: null,
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: [1, 3],
            schedule_windows: [
                {
                    start: '22:00',
                    end: '02:00',
                    discount: 0.6,
                    priority: 2,
                    enabled: false,
                    weekdays: [1, 3],
                    starts_on: '2026-11-04',
                    ends_on: '2026-11-30',
                    note: 'night sale',
                },
            ],
            note: 'campaign',
        });
        expect(
            toGlobalDiscountPayload({
                region: 'cn',
                variant: 'fast',
                expectedVersion: 0,
                discountPercent: '80',
                effectiveLocal: '',
                expiresLocal: '',
                scheduleTimezone: 'Asia/Shanghai',
                scheduleWeekdays: [],
                scheduleWindows: [],
                note: '',
            }),
        ).toMatchObject({ expected_version: 0, schedule_weekdays: [], schedule_windows: [] });
    });
});
