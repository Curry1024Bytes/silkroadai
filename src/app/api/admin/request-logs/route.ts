import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { extractClientIP } from '@/lib/auth/extract-ip';
import { writeAccessAudit } from '@/lib/reqlog/access-audit';

export const runtime = 'nodejs';

/**
 * GET /api/admin/request-logs — 数据存储第③步:RequestLog 元数据列表(分页 + 筛选)。
 *
 * **superadmin only**(全量客户内容,最高敏感;layout 是 admin+ 粗门,这里细门)。
 * 每次查询写一条 `list` 访问审计(含筛选摘要)—— best-effort(只看元数据不含原文,
 * 审计失败只 warn,不挡可用性,brief §6.1)。
 *
 * 筛选:user_id / model(模糊)/ status_code / success / streamed / 日期范围(from,to)。
 */
export async function GET(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const sp = request.nextUrl.searchParams;
    const page = Math.max(1, Number(sp.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, Number(sp.get('page_size') || '20')));
    const userId = sp.get('user_id')?.trim() || undefined;
    const model = sp.get('model')?.trim() || undefined;
    const statusCode = sp.get('status_code')?.trim() || undefined;
    const success = sp.get('success')?.trim() || undefined; // 'true' | 'false'
    const streamed = sp.get('streamed')?.trim() || undefined;
    const from = sp.get('from')?.trim() || undefined; // ISO
    const to = sp.get('to')?.trim() || undefined;

    const where: Prisma.RequestLogWhereInput = {};
    if (userId) where.user_id = userId;
    if (model) where.model = { contains: model, mode: 'insensitive' };
    if (statusCode) {
        const n = Number(statusCode);
        if (Number.isInteger(n)) where.status_code = n;
    }
    if (success === 'true') where.success = true;
    else if (success === 'false') where.success = false;
    if (streamed === 'true') where.streamed = true;
    else if (streamed === 'false') where.streamed = false;
    const createdAt: Prisma.DateTimeFilter = {};
    if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) createdAt.gte = d;
    }
    if (to) {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) createdAt.lte = d;
    }
    if (createdAt.gte || createdAt.lte) where.created_at = createdAt;

    // 审计:list（best-effort，元数据不含客户原文）。fire-and-forget 不阻塞查询。
    const summary = JSON.stringify({ page, pageSize, userId, model, statusCode, success, streamed, from, to });
    void writeAccessAudit({
        principal: admin,
        action: 'list',
        query: summary,
        ip: extractClientIP(request),
    }).catch((e) => console.warn('[reqlog-access] list audit failed (best-effort)', e));

    const [logs, total] = await Promise.all([
        prisma.requestLog.findMany({
            where,
            orderBy: { created_at: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
            select: {
                id: true,
                created_at: true,
                user_id: true,
                tenant_id: true,
                model: true,
                path: true,
                method: true,
                status_code: true,
                success: true,
                streamed: true,
                incomplete: true,
                input_tokens: true,
                output_tokens: true,
                input_bytes: true,
                output_bytes: true,
                duration_ms: true,
                input_r2_key: true,
                output_r2_key: true,
            },
        }),
        prisma.requestLog.count({ where }),
    ]);

    return NextResponse.json({
        logs,
        total,
        page,
        page_size: pageSize,
        total_pages: Math.max(1, Math.ceil(total / pageSize)),
    });
}
