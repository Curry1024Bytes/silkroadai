import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { tenantForInsert } from '@/lib/admin/tenant-scope';
import {
    MAX_UPSTREAM_COST_IMPORT_BYTES,
    parseUpstreamCostCsv,
    type ParsedUpstreamCostCsvRow,
} from '@/lib/billing/upstream-cost-ledger';

export const runtime = 'nodejs';

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * POST /api/admin/upstream-costs/import — 导入供应商成本 CSV。
 *
 * 先完整解析/校验文件，再在同一 Portal DB 事务内创建导入批次与全部明细；任何
 * 一行错误都不会留下半批数据。文件 SHA-256 是幂等锚点：重复上传同一文件只返回
 * 原批次。全程不调用 new-api。
 */
export async function POST(request: NextRequest) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return NextResponse.json(
            { error: 'invalid_form', message: '请求必须使用 multipart/form-data' },
            { status: 400 },
        );
    }
    const uploaded = form.get('file');
    if (!uploaded || typeof uploaded === 'string' || typeof uploaded.arrayBuffer !== 'function') {
        return NextResponse.json({ error: 'invalid_file', message: '请上传 CSV 文件' }, { status: 400 });
    }
    if (uploaded.size <= 0 || uploaded.size > MAX_UPSTREAM_COST_IMPORT_BYTES) {
        return NextResponse.json(
            {
                error: 'invalid_file',
                message: `CSV 文件大小必须在 1 字节到 ${MAX_UPSTREAM_COST_IMPORT_BYTES} 字节之间`,
            },
            { status: 400 },
        );
    }

    const bytes = Buffer.from(await uploaded.arrayBuffer());
    const file_sha256 = createHash('sha256').update(bytes).digest('hex');
    const tenant_id = tenantForInsert(admin);
    const existing = await prisma.upstreamCostImport.findUnique({
        where: { tenant_id_file_sha256: { tenant_id, file_sha256 } },
        select: { id: true, filename: true, row_count: true, created_at: true },
    });
    if (existing) return NextResponse.json({ import: existing, imported: 0, duplicate: true });

    let rows: ParsedUpstreamCostCsvRow[];
    try {
        rows = parseUpstreamCostCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
        return NextResponse.json(
            { error: 'invalid_csv', message: error instanceof Error ? error.message : 'CSV 格式无效' },
            { status: 400 },
        );
    }

    // 浏览器 File.name 不可信，但只作为审计显示；长度由 schema 同步约束。
    const filename = (uploaded.name || 'upstream-costs.csv').slice(0, 255);
    try {
        const imported = await prisma.$transaction(async (tx) => {
            const batch = await tx.upstreamCostImport.create({
                data: {
                    tenant_id,
                    filename,
                    file_sha256,
                    row_count: rows.length,
                    created_by: admin.user?.id ?? null,
                },
            });
            await tx.upstreamCostEntry.createMany({
                data: rows.map(({ line, value }) => ({
                    ...value,
                    source: 'csv_import' as const,
                    tenant_id,
                    import_id: batch.id,
                    import_row_number: line,
                    created_by: admin.user?.id ?? null,
                })),
            });
            return batch;
        });
        return NextResponse.json({ import: imported, imported: rows.length, duplicate: false }, { status: 201 });
    } catch (error) {
        // 并发的同文件上传可能在预检查后才撞唯一键；查询既有批次而不是报 500。
        if (isUniqueViolation(error)) {
            const duplicate = await prisma.upstreamCostImport.findUnique({
                where: { tenant_id_file_sha256: { tenant_id, file_sha256 } },
                select: { id: true, filename: true, row_count: true, created_at: true },
            });
            if (duplicate) return NextResponse.json({ import: duplicate, imported: 0, duplicate: true });
        }
        console.error('[upstream-costs/import] transaction failed', {
            tenant_id,
            filename,
            error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
            { error: 'import_failed', message: '导入事务失败，未写入任何成本记录' },
            { status: 500 },
        );
    }
}
