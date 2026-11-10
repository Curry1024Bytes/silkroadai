import { describe, expect, it } from 'vitest';
import {
    isTimeOfDayExpression,
    parseTimeTokenExpression,
    TimeTokenExpressionError,
} from '@/lib/admin/pricing-time-token-expression';

/** Verbatim from prod new-api `billing_setting.billing_expr`, 2026-11-10 (channel 14, aipg). */
const V4_FLASH =
    'let holidayNow = now(); (!(holidayNow >= date("2026-10-01T00:00:00+08:00") && holidayNow < date("2026-10-08T00:00:00+08:00")) && ((weekday("Asia/Shanghai") >= 1 && weekday("Asia/Shanghai") <= 5 && ((hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12) || (hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18))))) ? tier("peak", p * 3 + cr * 0.1 + c * 9) : tier("off_peak", p * 1.5 + cr * 0.05 + c * 4.5)';
const V41_FLASH = `let holidayNow = now(); (!(holidayNow >= date("2026-10-01T00:00:00+08:00") && holidayNow < date("2026-10-08T00:00:00+08:00")) && ((
  weekday("Asia/Shanghai") >= 1 &&
  weekday("Asia/Shanghai") <= 5 &&
  (
    (hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12) ||
    (hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18)
  )
))) ? tier("peak", p * 2 + cr * 0.04 + c * 8)
: tier("off_peak", p * 1 + cr * 0.02 + c * 4)`;

const WORKDAYS = [1, 2, 3, 4, 5];
const DEEPSEEK_SCHEDULE = [
    { weekdays: WORKDAYS, start_hour: 9, end_hour: 12 },
    { weekdays: WORKDAYS, start_hour: 14, end_hour: 18 },
];

describe('parseTimeTokenExpression', () => {
    it('reads the live deepseek-v4-flash formula: two tiers, Mon–Fri 9–12 and 14–18, National Day off', () => {
        const parsed = parseTimeTokenExpression(V4_FLASH);
        expect(parsed.timezone).toBe('Asia/Shanghai');
        expect(parsed.window).toEqual({
            name: 'peak',
            rates: { input: 3, output: 9, cache_read: 0.1, cache_write: null, cache_write_1h: null },
        });
        expect(parsed.otherwise).toEqual({
            name: 'off_peak',
            rates: { input: 1.5, output: 4.5, cache_read: 0.05, cache_write: null, cache_write_1h: null },
        });
        expect(parsed.schedule).toEqual(DEEPSEEK_SCHEDULE);
        // Before 10-01 the regular week also applies, so only the holiday differs: billed off-peak all day.
        expect(parsed.exceptions).toEqual([
            { from: '2026-09-30T16:00:00.000Z', until: '2026-10-07T16:00:00.000Z', schedule: [] },
        ]);
    });

    it('reads the multi-line deepseek-v4.1-flash formula identically', () => {
        const parsed = parseTimeTokenExpression(V41_FLASH);
        expect(parsed.window.rates).toMatchObject({ input: 2, output: 8, cache_read: 0.04 });
        expect(parsed.otherwise.rates).toMatchObject({ input: 1, output: 4, cache_read: 0.02 });
        expect(parsed.schedule).toEqual(DEEPSEEK_SCHEDULE);
        expect(parsed.exceptions).toHaveLength(1);
    });

    it('follows new-api weekday numbering (0 = Sunday) and reverses int-first comparisons', () => {
        const parsed = parseTimeTokenExpression(
            '(weekday("Asia/Shanghai") == 0 || 6 == weekday("Asia/Shanghai")) && 20 <= hour("Asia/Shanghai") ? tier("night", p * 1 + c * 2) : tier("day", p * 3 + c * 6)',
        );
        expect(parsed.schedule).toEqual([{ weekdays: [6, 7], start_hour: 20, end_hour: 24 }]);
        expect(parsed.exceptions).toEqual([]);
    });

    it('accepts inline now() and a fully parenthesized ternary', () => {
        const parsed = parseTimeTokenExpression(
            '((now() < date("2026-12-01T00:00:00+08:00") && hour("Asia/Shanghai") < 8) ? tier("promo", p * 1 + c * 1) : (tier("base", p * 2 + c * 2)))',
        );
        // After the promo ends the cheap tier never applies; the promo itself is the exception.
        expect(parsed.schedule).toEqual([]);
        expect(parsed.exceptions).toEqual([
            {
                from: null,
                until: '2026-11-30T16:00:00.000Z',
                schedule: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], start_hour: 0, end_hour: 8 }],
            },
        ]);
    });

    it.each([
        ['minute()', 'minute("Asia/Shanghai") < 30 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)', /minute/],
        ['another zone', 'hour("UTC") < 9 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)', /Asia\/Shanghai/],
        [
            'a length condition',
            'len < 1000 && hour("Asia/Shanghai") < 9 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)',
            /./,
        ],
        [
            'length tiers inside a branch',
            'hour("Asia/Shanghai") < 9 ? (len < 10 ? tier("a", p * 1 + c * 1) : tier("x", p * 3 + c * 3)) : tier("b", p * 2 + c * 2)',
            /./,
        ],
        [
            'a constant condition',
            'hour("Asia/Shanghai") >= 0 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)',
            /恒成立/,
        ],
        [
            'duplicate tier names',
            'hour("Asia/Shanghai") < 9 ? tier("a", p * 1 + c * 1) : tier("a", p * 2 + c * 2)',
            /档位名/,
        ],
        [
            'a date without offset',
            'now() < date("2026-10-01T00:00:00") && hour("Asia/Shanghai") < 9 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)',
            /时区偏移/,
        ],
        [
            'an impossible date',
            'now() < date("2026-02-30T00:00:00+08:00") && hour("Asia/Shanghai") < 9 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)',
            /不存在/,
        ],
        [
            'an unknown function',
            'max(hour("Asia/Shanghai"), 1) < 9 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)',
            /./,
        ],
        [
            'three tiers',
            'hour("Asia/Shanghai") < 9 ? tier("a", p * 1 + c * 1) : hour("Asia/Shanghai") < 18 ? tier("b", p * 2 + c * 2) : tier("c", p * 3 + c * 3)',
            /./,
        ],
        [
            'a non-now let binding',
            'let x = 3; hour("Asia/Shanghai") < 9 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)',
            /./,
        ],
        [
            'hour compared with a date',
            'hour("Asia/Shanghai") < date("2026-10-01T00:00:00+08:00") ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)',
            /./,
        ],
        [
            'a non-linear price',
            'hour("Asia/Shanghai") < 9 ? tier("a", p * p + c * 1) : tier("b", p * 2 + c * 2)',
            /分支单价/,
        ],
        [
            'trailing rules',
            'hour("Asia/Shanghai") < 9 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2) * 2',
            /额外规则/,
        ],
    ])('refuses %s in full', (_, expression, message) => {
        expect(() => parseTimeTokenExpression(expression)).toThrow(TimeTokenExpressionError);
        expect(() => parseTimeTokenExpression(expression)).toThrow(message);
    });
});

describe('isTimeOfDayExpression', () => {
    it('routes only formulas that use new-api time functions', () => {
        expect(isTimeOfDayExpression(V4_FLASH)).toBe(true);
        expect(isTimeOfDayExpression('minute("Asia/Shanghai") < 1 ? tier("a", p) : tier("b", p)')).toBe(true);
        expect(
            isTimeOfDayExpression('len < 272000 ? tier("base", p * 5 + c * 30) : tier("long", p * 10 + c * 45)'),
        ).toBe(false);
        expect(isTimeOfDayExpression('tier("weekday_name", p * 1 + c * 1)')).toBe(false);
        expect(isTimeOfDayExpression(null)).toBe(false);
    });
});
