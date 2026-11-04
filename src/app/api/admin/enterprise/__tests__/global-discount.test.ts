/**
 * 全局折扣路由单测:守门 / 校验 / 设置(upsert)/ 清除(discount=null)/ 列表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

const { db, resolveAdmin, auditAdminAction } = vi.hoisted(() => ({
    db: {
        enterpriseGlobalDiscount: {
            findMany: vi.fn(),
            findUnique: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
            deleteMany: vi.fn(),
        },
    },
    resolveAdmin: vi.fn(),
    auditAdminAction: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: db }));
// 2026-09-04 起路由守门换到 enterprise/admin-auth(两级管理员);测试沿用 resolveAdmin 变量名
vi.mock('@/lib/enterprise/admin-auth', () => ({
    resolveEnterpriseAdmin: resolveAdmin,
    auditAdminAction,
}));
vi.mock('@/lib/admin-auth', () => ({ unauthorizedResponse: () => new Response(null, { status: 401 }) }));

import { GET, POST } from '../global-discount/route';

function req(body?: unknown, method = 'POST'): NextRequest {
    return new NextRequest('http://internal/api/admin/enterprise/global-discount', {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    resolveAdmin.mockResolvedValue({ user: { id: 'admin-1' } });
    db.enterpriseGlobalDiscount.findUnique.mockResolvedValue(null);
    db.enterpriseGlobalDiscount.create.mockResolvedValue({
        id: 'rule-1',
        version: 1,
        region: 'cn',
        variant: 'fast',
        discount: '0.6',
        expires_at: null,
        effective_from: null,
        schedule_timezone: 'Asia/Shanghai',
        schedule_weekdays: null,
        schedule_windows: null,
        note: null,
    });
    db.enterpriseGlobalDiscount.updateMany.mockResolvedValue({ count: 1 });
    db.enterpriseGlobalDiscount.deleteMany.mockResolvedValue({ count: 1 });
    db.enterpriseGlobalDiscount.findMany.mockResolvedValue([]);
});

describe('POST /api/admin/enterprise/global-discount', () => {
    it('非 superadmin → 401', async () => {
        resolveAdmin.mockResolvedValue(null);
        expect((await POST(req({ region: 'cn', variant: 'fast', discount: 0.6 }))).status).toBe(401);
    });

    it('非法 region/variant/discount → 400', async () => {
        expect((await POST(req({ region: 'xx', variant: 'fast', discount: 0.6 }))).status).toBe(400);
        expect((await POST(req({ region: 'cn', variant: 'nope', discount: 0.6 }))).status).toBe(400);
        expect((await POST(req({ region: 'cn', variant: 'fast', discount: 3 }))).status).toBe(400);
        expect(
            (await POST(req({ region: 'cn', variant: 'fast', discount: 0.6, schedule_timezone: 'Not/AZone' }))).status,
        ).toBe(400);
        expect(
            (
                await POST(
                    req({
                        region: 'cn',
                        variant: 'fast',
                        discount: 0.6,
                        schedule_weekdays: [5, 5],
                        schedule_windows: [{ start: '23:00', end: '02:00', discount: 0.5, weekdays: [5, 5] }],
                    }),
                )
            ).status,
        ).toBe(400);
        expect(
            (
                await POST(
                    req({
                        region: 'cn',
                        variant: 'fast',
                        discount: 0.6,
                        schedule_weekdays: [],
                        schedule_windows: [{ start: '23:00', end: '02:00', discount: 0.5 }],
                    }),
                )
            ).status,
        ).toBe(400);
    });

    it('设置:创建 (region, variant) 规则并带 expires_at', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'rule-1',
            version: 1,
            region: 'cn',
            variant: 'fast',
            discount: '0.6',
            expires_at: new Date('2026-09-08T00:00:00.000Z'),
            effective_from: null,
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: null,
            schedule_windows: null,
            note: null,
            created_at: new Date(),
        });
        const res = await POST(
            req({
                region: 'cn',
                variant: 'fast',
                discount: 0.6,
                expires_at: '2026-09-08T00:00:00.000Z',
                expected_version: 0,
            }),
        );
        expect(res.status).toBe(200);
        expect(db.enterpriseGlobalDiscount.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ region: 'cn', variant: 'fast', version: 1 }) }),
        );
    });

    it('创建日历窗口时省略顶层星期默认保存周一至周日', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'rule-1',
            version: 1,
            region: 'cn',
            variant: 'fast',
            discount: '0.6',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: [1, 2, 3, 4, 5, 6, 7],
            schedule_windows: [{ start: '09:00', end: '10:00', discount: 0.5 }],
            note: null,
            created_at: new Date(),
        });
        const res = await POST(
            req({
                region: 'cn',
                variant: 'fast',
                discount: 0.6,
                expected_version: 0,
                schedule_windows: [{ start: '09:00', end: '10:00', discount: 0.5 }],
            }),
        );
        expect(res.status).toBe(200);
        expect(db.enterpriseGlobalDiscount.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ schedule_weekdays: [1, 2, 3, 4, 5, 6, 7] }),
            }),
        );
    });

    it('更新已有窗口时省略顶层星期保留已有星期', async () => {
        const existing = {
            id: 'rule-1',
            version: 4,
            region: 'cn',
            variant: 'fast',
            discount: '0.6',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: [2, 4],
            schedule_windows: [{ start: '09:00', end: '10:00', discount: 0.5 }],
            note: null,
        };
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue(existing);
        const res = await POST(
            req({
                region: 'cn',
                variant: 'fast',
                discount: 0.7,
                expected_version: 4,
                schedule_windows: [{ start: '11:00', end: '12:00', discount: 0.4 }],
            }),
        );
        expect(res.status).toBe(200);
        expect(db.enterpriseGlobalDiscount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    schedule_weekdays: [2, 4],
                    schedule_windows: [{ start: '11:00', end: '12:00', discount: 0.4 }],
                }),
            }),
        );
    });

    it('显式清空顶层星期但保留窗口时拒绝保存', async () => {
        const res = await POST(
            req({
                region: 'cn',
                variant: 'fast',
                discount: 0.7,
                expected_version: 0,
                schedule_weekdays: [],
                schedule_windows: [{ start: '09:00', end: '10:00', discount: 0.4, weekdays: [1] }],
            }),
        );
        expect(res.status).toBe(400);
        expect(db.enterpriseGlobalDiscount.create).not.toHaveBeenCalled();
    });

    it('更新时省略日历字段保留已有规则', async () => {
        const existing = {
            id: 'rule-1',
            version: 4,
            region: 'cn',
            variant: 'fast',
            discount: '0.6',
            expires_at: null,
            effective_from: null,
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: [1, 2],
            schedule_windows: [{ start: '23:00', end: '02:00', discount: 0.5, enabled: true, weekdays: [1] }],
            note: 'night sale',
        };
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue(existing);
        const res = await POST(req({ region: 'cn', variant: 'fast', discount: 0.8, expected_version: 4 }));
        expect(res.status).toBe(200);
        expect(db.enterpriseGlobalDiscount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'rule-1', version: 4 },
                data: expect.objectContaining({
                    schedule_weekdays: [1, 2],
                    schedule_windows: existing.schedule_windows,
                    schedule_timezone: 'Asia/Shanghai',
                    note: 'night sale',
                    version: { increment: 1 },
                }),
            }),
        );
    });

    it('更新时显式空日历值清除旧窗口', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'rule-1',
            version: 2,
            schedule_weekdays: [1],
            schedule_windows: [{ start: '00:00', end: '08:00', discount: 0.5 }],
        });
        await POST(
            req({
                region: 'cn',
                variant: 'fast',
                discount: 0.8,
                expected_version: 2,
                schedule_weekdays: [],
                schedule_windows: [],
            }),
        );
        expect(db.enterpriseGlobalDiscount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ schedule_weekdays: Prisma.DbNull, schedule_windows: Prisma.DbNull }),
            }),
        );
    });

    it('版本过期或缺失时拒绝覆盖', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({ id: 'rule-1', version: 7 });
        const stale = await POST(req({ region: 'cn', variant: 'fast', discount: 0.8, expected_version: 6 }));
        expect(stale.status).toBe(409);
        const missing = await POST(req({ region: 'cn', variant: 'fast', discount: 0.8 }));
        expect(missing.status).toBe(409);
        expect(db.enterpriseGlobalDiscount.updateMany).not.toHaveBeenCalled();
    });

    it('成功更新时审计完整前后值与版本', async () => {
        db.enterpriseGlobalDiscount.findUnique
            .mockResolvedValueOnce({
                id: 'rule-1',
                version: 3,
                region: 'cn',
                variant: 'fast',
                discount: '0.6',
                schedule_windows: null,
            })
            .mockResolvedValueOnce({
                id: 'rule-1',
                version: 4,
                region: 'cn',
                variant: 'fast',
                discount: '0.8',
                schedule_windows: null,
            });
        await POST(req({ region: 'cn', variant: 'fast', discount: 0.8, expected_version: 3 }));
        expect(auditAdminAction).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'global_discount',
            expect.objectContaining({
                target: 'cn/fast',
                params: expect.objectContaining({
                    before: expect.objectContaining({ discount: '0.6' }),
                    after: expect.objectContaining({ discount: '0.8' }),
                    expected_version: 3,
                    version: 4,
                }),
            }),
        );
    });

    it('同优先级重叠窗口被拒绝', async () => {
        const res = await POST(
            req({
                region: 'cn',
                variant: 'fast',
                discount: 0.8,
                expected_version: 0,
                schedule_weekdays: [1, 2, 3],
                schedule_windows: [
                    { start: '22:00', end: '02:00', discount: 0.5, weekdays: [1], priority: 1 },
                    { start: '01:00', end: '03:00', discount: 0.6, weekdays: [2], priority: 1 },
                ],
            }),
        );
        expect(res.status).toBe(400);
        expect(db.enterpriseGlobalDiscount.create).not.toHaveBeenCalled();
    });

    it('日期边界上的跨午夜重叠窗口被拒绝', async () => {
        const res = await POST(
            req({
                region: 'cn',
                variant: 'fast',
                discount: 0.8,
                expected_version: 0,
                schedule_weekdays: [1, 2],
                schedule_windows: [
                    {
                        start: '22:00',
                        end: '02:00',
                        discount: 0.5,
                        weekdays: [1],
                        starts_on: '2026-11-02',
                        ends_on: '2026-11-02',
                    },
                    {
                        start: '01:00',
                        end: '03:00',
                        discount: 0.6,
                        weekdays: [2],
                        starts_on: '2026-11-03',
                        ends_on: '2026-11-03',
                    },
                ],
            }),
        );
        expect(res.status).toBe(400);
        expect(db.enterpriseGlobalDiscount.create).not.toHaveBeenCalled();
    });

    it('窗口保存启停、日期、星期覆盖和备注', async () => {
        await POST(
            req({
                region: 'cn',
                variant: 'fast',
                discount: 0.8,
                expected_version: 0,
                schedule_weekdays: [1, 2, 3, 4, 5, 6, 7],
                schedule_windows: [
                    {
                        start: '23:00',
                        end: '02:00',
                        discount: 0.5,
                        enabled: false,
                        weekdays: [1, 3],
                        starts_on: '2026-11-04',
                        ends_on: '2026-11-30',
                        note: 'weekday promo',
                    },
                ],
            }),
        );
        expect(db.enterpriseGlobalDiscount.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    schedule_windows: [
                        {
                            start: '23:00',
                            end: '02:00',
                            discount: 0.5,
                            enabled: false,
                            weekdays: [1, 3],
                            starts_on: '2026-11-04',
                            ends_on: '2026-11-30',
                            note: 'weekday promo',
                        },
                    ],
                }),
            }),
        );
    });

    it('discount=null 清除时要求匹配版本并审计前后值', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({
            id: 'rule-1',
            version: 5,
            region: 'cn',
            variant: 'mini',
            discount: '0.7',
        });
        const res = await POST(req({ region: 'cn', variant: 'mini', discount: null, expected_version: 5 }));
        expect(res.status).toBe(200);
        expect(db.enterpriseGlobalDiscount.deleteMany).toHaveBeenCalledWith({ where: { id: 'rule-1', version: 5 } });
        expect(auditAdminAction).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'global_discount',
            expect.objectContaining({
                params: expect.objectContaining({
                    before: expect.objectContaining({ discount: '0.7' }),
                    after: null,
                    expected_version: 5,
                }),
            }),
        );
    });

    it('缺少版本时不能删除已有规则', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValue({ id: 'rule-1', version: 1 });
        const res = await POST(req({ region: 'cn', variant: 'mini', discount: null }));
        expect(res.status).toBe(409);
        expect(db.enterpriseGlobalDiscount.deleteMany).not.toHaveBeenCalled();
    });

    it('保留创建接口覆盖并发插入冲突', async () => {
        db.enterpriseGlobalDiscount.create.mockRejectedValue({ code: 'P2002' });
        const res = await POST(req({ region: 'cn', variant: 'fast', discount: 0.6, expected_version: 0 }));
        expect(res.status).toBe(409);
    });

    it('设置日历规则:保存时区/星期/窗口/生效时间', async () => {
        db.enterpriseGlobalDiscount.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'rule-1',
            version: 1,
            region: 'cn',
            variant: 'fast',
            discount: '0.6',
            expires_at: null,
            effective_from: new Date('2026-11-03T00:00:00.000Z'),
            schedule_timezone: 'Asia/Shanghai',
            schedule_weekdays: [5, 6],
            schedule_windows: [
                {
                    start: '23:00',
                    end: '02:00',
                    discount: 0.5,
                    priority: 1,
                    enabled: true,
                    weekdays: [5, 6],
                    starts_on: null,
                    ends_on: null,
                    note: null,
                },
            ],
            note: null,
            created_at: new Date(),
        });
        const res = await POST(
            req({
                region: 'cn',
                variant: 'fast',
                discount: 0.6,
                effective_from: '2026-11-03T00:00:00.000Z',
                schedule_timezone: 'Asia/Shanghai',
                schedule_weekdays: [5, 6],
                expected_version: 0,
                schedule_windows: [
                    {
                        start: '23:00',
                        end: '02:00',
                        discount: 0.5,
                        priority: 1,
                        enabled: true,
                        weekdays: [5, 6],
                        starts_on: null,
                        ends_on: null,
                        note: null,
                    },
                ],
            }),
        );
        expect(res.status).toBe(200);
        expect(db.enterpriseGlobalDiscount.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    schedule_timezone: 'Asia/Shanghai',
                    schedule_weekdays: [5, 6],
                    schedule_windows: [
                        {
                            start: '23:00',
                            end: '02:00',
                            discount: 0.5,
                            priority: 1,
                            enabled: true,
                            weekdays: [5, 6],
                            starts_on: null,
                            ends_on: null,
                            note: null,
                        },
                    ],
                }),
            }),
        );
    });

    it('生效时间必须早于失效时间', async () => {
        expect(
            (
                await POST(
                    req({
                        region: 'cn',
                        variant: 'fast',
                        discount: 0.6,
                        effective_from: '2026-11-04T00:00:00.000Z',
                        expires_at: '2026-11-03T00:00:00.000Z',
                    }),
                )
            ).status,
        ).toBe(400);
    });

    it('discount=null → 已不存在的规则可幂等清除', async () => {
        const res = await POST(req({ region: 'cn', variant: 'mini', discount: null, expected_version: 0 }));
        expect(res.status).toBe(200);
        expect((await res.json()).cleared).toBe(true);
        expect(db.enterpriseGlobalDiscount.deleteMany).not.toHaveBeenCalled();
        expect(db.enterpriseGlobalDiscount.create).not.toHaveBeenCalled();
    });
});

describe('GET /api/admin/enterprise/global-discount', () => {
    it('列出并标记 expired', async () => {
        db.enterpriseGlobalDiscount.findMany.mockResolvedValue([
            {
                region: 'cn',
                variant: 'fast',
                discount: '0.6',
                version: 2,
                expires_at: new Date(Date.now() - 1000),
                note: null,
                created_at: new Date(),
            },
            { region: 'cn', variant: 'mini', discount: '0.7', expires_at: null, note: 'x', created_at: new Date() },
        ]);
        const j = (await (await GET(req(undefined, 'GET'))).json()) as {
            discounts: Array<{ variant: string; expired: boolean; version: number }>;
        };
        expect(j.discounts.find((d) => d.variant === 'fast')?.expired).toBe(true);
        expect(j.discounts.find((d) => d.variant === 'mini')?.expired).toBe(false);
        expect(j.discounts.find((d) => d.variant === 'fast')?.version).toBe(2);
    });
});
