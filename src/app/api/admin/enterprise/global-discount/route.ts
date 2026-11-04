import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveEnterpriseAdmin, auditAdminAction } from '@/lib/enterprise/admin-auth';
import { evaluateGlobalDiscountRule } from '@/lib/enterprise/billing';

export const runtime = 'nodejs';

/**
 * 全局折扣(按 渠道×模型 的临时促销,如上游 fast/mini 降价一个月我们跟降)。守门:superadmin。
 * 计价优先级:客户议价(绝对单价 override)> 全局折扣 > 客户折扣率。全局折扣【覆盖客户折扣率】,
 * 按 (region, variant) 隔离(只影响目标模型),expires_at 到期读时自动失效。
 *   GET  → 列出全部(带 active/expired 标记)
 *   POST → 设/改一条;discount=null 清除该 (region, variant)
 */
const schema = z.object({
    region: z.enum(['cn', 'global', 'promax', 'volc']),
    variant: z.enum(['pro', 'fast', 'mini', '2.5', 'promax', 'promax-fast', 'promax-mini', 'promax-2.5']),
    // 0.05~2(>1 = 上浮);null = 清除该档全局折扣(回落客户折扣率)
    discount: z.number().min(0.05).max(2).nullable(),
    expected_version: z.number().int().min(0).max(2_147_483_646).optional(),
    // 到期时间(ISO 字符串;null / 省略 = 手动撤销前长期有效)
    expires_at: z.string().datetime().nullable().optional(),
    effective_from: z.string().datetime().nullable().optional(),
    schedule_timezone: z.literal('Asia/Shanghai').optional(),
    schedule_weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    schedule_windows: z
        .array(
            z.object({
                start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
                end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
                discount: z.number().min(0.05).max(2),
                priority: z.number().int().optional(),
                enabled: z.boolean().optional(),
                weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
                starts_on: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .nullable()
                    .optional(),
                ends_on: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .nullable()
                    .optional(),
                note: z.string().trim().max(200).nullable().optional(),
            }),
        )
        .max(24)
        .optional(),
    note: z.string().trim().max(200).nullable().optional(),
});

type Window = NonNullable<z.infer<typeof schema>['schedule_windows']>[number];

function validLocalDate(value: string | null | undefined): boolean {
    if (value == null) return true;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function windowsMayOverlap(a: Window, b: Window, parentWeekdays: number[]): boolean {
    if (a.enabled === false || b.enabled === false) return false;
    const daysA = a.weekdays ?? parentWeekdays;
    const daysB = b.weekdays ?? parentWeekdays;
    const startA = Number(a.start.slice(0, 2)) * 60 + Number(a.start.slice(3));
    const endA = Number(a.end.slice(0, 2)) * 60 + Number(a.end.slice(3));
    const startB = Number(b.start.slice(0, 2)) * 60 + Number(b.start.slice(3));
    const endB = Number(b.end.slice(0, 2)) * 60 + Number(b.end.slice(3));

    const dayNumber = (value: string): number => {
        const [year, month, day] = value.split('-').map(Number);
        return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
    };
    const formatDate = (value: number): string => new Date(value * 86_400_000).toISOString().slice(0, 10);
    const explicitDates = [a.starts_on, a.ends_on, b.starts_on, b.ends_on].filter((value): value is string =>
        Boolean(value),
    );
    const anchor = dayNumber('2026-01-05');
    const explicitDays = explicitDates.map(dayNumber);
    const lowerBound = explicitDays.length ? Math.min(...explicitDays) - 14 : anchor;
    const upperBound = explicitDays.length ? Math.max(...explicitDays) + 14 : anchor + 21;
    const intervalFor = (window: Window, start: number, end: number, date: string): [number, number] | null => {
        if (window.starts_on && date < window.starts_on) return null;
        if (window.ends_on && date > window.ends_on) return null;
        return [dayNumber(date) * 1440 + start, dayNumber(date) * 1440 + (end <= start ? end + 1440 : end)];
    };
    for (let day = lowerBound; day <= upperBound; day += 1) {
        const dateA = formatDate(day);
        if (!daysA.includes(new Date(day * 86_400_000).getUTCDay() || 7)) continue;
        const intervalA = intervalFor(a, startA, endA, dateA);
        if (!intervalA) continue;
        for (let otherDay = day - 1; otherDay <= day + 1; otherDay += 1) {
            const dateB = formatDate(otherDay);
            if (!daysB.includes(new Date(otherDay * 86_400_000).getUTCDay() || 7)) continue;
            const intervalB = intervalFor(b, startB, endB, dateB);
            if (intervalB && intervalA[0] < intervalB[1] && intervalB[0] < intervalA[1]) return true;
        }
    }
    return false;
}

function validWindows(windows: Window[], weekdays: number[]): string | null {
    for (const window of windows) {
        if (window.start === window.end) return '时间窗口起止不能相同';
        if (
            window.weekdays &&
            (window.weekdays.length === 0 || new Set(window.weekdays).size !== window.weekdays.length)
        ) {
            return '窗口生效星期不能为空或重复';
        }
        if (window.starts_on && !validLocalDate(window.starts_on)) return '无效窗口开始日期';
        if (window.ends_on && !validLocalDate(window.ends_on)) return '无效窗口结束日期';
        if (window.starts_on && window.ends_on && window.starts_on > window.ends_on)
            return '窗口开始日期必须早于结束日期';
    }
    for (let i = 0; i < windows.length; i += 1) {
        for (let j = i + 1; j < windows.length; j += 1) {
            if (
                (windows[i].priority ?? 0) === (windows[j].priority ?? 0) &&
                windowsMayOverlap(windows[i], windows[j], weekdays)
            ) {
                return '相同优先级的启用窗口不能重叠，请调整优先级或时间';
            }
        }
    }
    return null;
}

export async function GET(request: NextRequest) {
    const admin = await resolveEnterpriseAdmin(request);
    if (!admin) return unauthorizedResponse(request);
    const rows = await prisma.enterpriseGlobalDiscount.findMany({
        orderBy: [{ region: 'asc' }, { variant: 'asc' }],
    });
    const now = Date.now();
    return NextResponse.json({
        discounts: rows.map((r) => ({
            region: r.region,
            variant: r.variant,
            version: r.version,
            discount: Number(r.discount),
            expires_at: r.expires_at?.toISOString() ?? null,
            effective_from: r.effective_from?.toISOString() ?? null,
            schedule_timezone: r.schedule_timezone,
            schedule_weekdays: r.schedule_weekdays,
            schedule_windows: r.schedule_windows,
            expired: r.expires_at ? r.expires_at.getTime() <= now : false,
            current_status: evaluateGlobalDiscountRule(r),
            note: r.note ?? null,
            created_at: r.created_at.toISOString(),
        })),
    });
}

export async function POST(request: NextRequest) {
    const admin = await resolveEnterpriseAdmin(request);
    if (!admin) return unauthorizedResponse(request);

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json(
            { error: 'invalid_input', issues: parsed.error.flatten().fieldErrors },
            { status: 400 },
        );
    }
    const {
        region,
        variant,
        discount,
        expires_at,
        effective_from,
        schedule_timezone,
        schedule_weekdays,
        schedule_windows,
        note,
        expected_version,
    } = parsed.data;

    if (schedule_weekdays && new Set(schedule_weekdays).size !== schedule_weekdays.length) {
        return NextResponse.json({ error: 'invalid_input', detail: '生效星期不能重复' }, { status: 400 });
    }
    const effectiveWeekdays = schedule_weekdays ?? [1, 2, 3, 4, 5, 6, 7];
    if (
        schedule_windows &&
        schedule_windows.length > 0 &&
        effectiveWeekdays.length === 0 &&
        schedule_windows.some((w) => !w.weekdays)
    ) {
        return NextResponse.json({ error: 'invalid_input', detail: '时间窗口至少需要一个生效星期' }, { status: 400 });
    }
    if (schedule_windows) {
        const windowsError = validWindows(schedule_windows, effectiveWeekdays);
        if (windowsError) return NextResponse.json({ error: 'invalid_input', detail: windowsError }, { status: 400 });
    }

    const expiresAt = expires_at ? new Date(expires_at) : null;
    const effectiveFrom = effective_from ? new Date(effective_from) : null;
    if (discount != null && effectiveFrom && expiresAt && effectiveFrom.getTime() >= expiresAt.getTime()) {
        return NextResponse.json({ error: 'invalid_input', detail: '生效时间必须早于失效时间' }, { status: 400 });
    }
    if (expected_version === undefined) {
        return NextResponse.json(
            { error: 'version_conflict', detail: 'expected_version is required' },
            { status: 409 },
        );
    }

    const existing = await prisma.enterpriseGlobalDiscount.findUnique({
        where: { region_variant: { region, variant } },
    });
    if (discount == null) {
        if (!existing && expected_version === 0) {
            return NextResponse.json({ ok: true, region, variant, discount: null, cleared: true });
        }
        if (!existing || existing.version !== expected_version) {
            return NextResponse.json(
                { error: 'version_conflict', current_version: existing?.version ?? 0 },
                { status: 409 },
            );
        }
        const deleted = await prisma.enterpriseGlobalDiscount.deleteMany({
            where: { id: existing.id, version: expected_version },
        });
        if (deleted.count !== 1) return NextResponse.json({ error: 'version_conflict' }, { status: 409 });
        auditAdminAction(request, admin, 'global_discount', {
            target: `${region}/${variant}`,
            params: { region, variant, before: existing, after: null, expected_version },
        });
        return NextResponse.json({ ok: true, region, variant, discount: null, cleared: true });
    }

    if (existing) {
        if (expected_version !== existing.version) {
            return NextResponse.json({ error: 'version_conflict', current_version: existing.version }, { status: 409 });
        }
        const data: Prisma.EnterpriseGlobalDiscountUpdateManyMutationInput = {
            discount,
            expires_at: expires_at === undefined ? existing.expires_at : expiresAt,
            effective_from: effective_from === undefined ? existing.effective_from : effectiveFrom,
            schedule_timezone: schedule_timezone ?? existing.schedule_timezone,
            schedule_weekdays:
                schedule_weekdays === undefined
                    ? (existing.schedule_weekdays ?? Prisma.DbNull)
                    : schedule_weekdays.length
                      ? schedule_weekdays
                      : Prisma.DbNull,
            schedule_windows:
                schedule_windows === undefined
                    ? (existing.schedule_windows ?? Prisma.DbNull)
                    : schedule_windows.length
                      ? (schedule_windows as Prisma.InputJsonValue)
                      : Prisma.DbNull,
            note: note === undefined ? existing.note : note,
            version: { increment: 1 },
        };
        const updated = await prisma.enterpriseGlobalDiscount.updateMany({
            where: { id: existing.id, version: expected_version },
            data,
        });
        if (updated.count !== 1) return NextResponse.json({ error: 'version_conflict' }, { status: 409 });
    } else {
        if (expected_version !== 0)
            return NextResponse.json({ error: 'version_conflict', current_version: 0 }, { status: 409 });
        try {
            await prisma.enterpriseGlobalDiscount.create({
                data: {
                    region,
                    variant,
                    discount,
                    version: 1,
                    expires_at: expiresAt,
                    effective_from: effectiveFrom,
                    schedule_timezone: schedule_timezone ?? 'Asia/Shanghai',
                    schedule_weekdays: schedule_weekdays?.length ? schedule_weekdays : Prisma.DbNull,
                    schedule_windows: schedule_windows?.length
                        ? (schedule_windows as Prisma.InputJsonValue)
                        : Prisma.DbNull,
                    note,
                    created_by: admin.user?.id ?? null,
                },
            });
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
                return NextResponse.json({ error: 'version_conflict' }, { status: 409 });
            }
            throw error;
        }
    }
    const row = await prisma.enterpriseGlobalDiscount.findUnique({ where: { region_variant: { region, variant } } });
    if (!row) return NextResponse.json({ error: 'write_verification_failed' }, { status: 500 });
    auditAdminAction(request, admin, 'global_discount', {
        target: `${region}/${variant}`,
        params: {
            region,
            variant,
            before: existing,
            after: row,
            expected_version,
            version: row.version,
        },
    });
    return NextResponse.json({
        ok: true,
        region,
        variant,
        version: row.version,
        discount: Number(row.discount),
        expires_at: row.expires_at?.toISOString() ?? null,
        effective_from: row.effective_from?.toISOString() ?? null,
        schedule_timezone: row.schedule_timezone,
        schedule_weekdays: row.schedule_weekdays,
        schedule_windows: row.schedule_windows,
    });
}
