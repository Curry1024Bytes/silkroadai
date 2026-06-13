import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { unauthorizedResponse } from '@/lib/admin-auth';
import { resolveAdmin } from '@/lib/admin/auth';
import { extractClientIP } from '@/lib/auth/extract-ip';
import { getLogObject, isLogStoreConfigured } from '@/lib/r2/log-store';
import { BODY_MAX_BYTES, writeAccessAudit } from '@/lib/reqlog/access-audit';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/request-logs/[id]/body?which=in|out[&full=1] — 从私有 R2 log
 * bucket 读回客户【请求/响应原文】。**superadmin only,最高敏感。**
 *
 * 治理铁律(brief §6.1,fail-closed):看客户原文前**必须先写审计成功**
 * (`view_input`/`view_output`)才返回 body —— 审计写失败 → 503 拒绝展示。
 *
 * 超过 BODY_MAX_BYTES(默认 256KB,env 可调)→ 截断 + `truncated:true` + `total_bytes`;
 * `?full=1` 拉完整(仍走同一审计)。
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const admin = await resolveAdmin(request, 'superadmin');
    if (!admin) return unauthorizedResponse(request);

    const { id } = await ctx.params;
    const which = request.nextUrl.searchParams.get('which');
    const full = request.nextUrl.searchParams.get('full') === '1';
    if (which !== 'in' && which !== 'out') {
        return NextResponse.json({ error: 'which must be "in" or "out"' }, { status: 400 });
    }
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const row = await prisma.requestLog.findUnique({
        where: { id },
        select: { input_r2_key: true, output_r2_key: true },
    });
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const key = which === 'in' ? row.input_r2_key : row.output_r2_key;
    if (!key) return NextResponse.json({ error: 'no body stored for this request' }, { status: 404 });

    // ── fail-closed:先写审计成功,再返回原文 ──
    const action = which === 'in' ? 'view_input' : 'view_output';
    try {
        await writeAccessAudit({ principal: admin, action, requestLogId: id, ip: extractClientIP(request) });
    } catch (e) {
        console.error('[reqlog-access] body audit write failed — refusing body (fail-closed)', e);
        return NextResponse.json({ error: 'access audit unavailable, body access denied' }, { status: 503 });
    }

    // ── 从私有 bucket 读回(无公开 URL,server 端 getLogObject)──
    if (!isLogStoreConfigured()) {
        return NextResponse.json({ error: 'log store not configured' }, { status: 503 });
    }
    let buf: Buffer;
    try {
        buf = await getLogObject(key);
    } catch (e) {
        // 对象不存在 / R2 故障 → 友好 404,不 500(brief §13.5)
        console.warn('[reqlog-access] getLogObject failed', e);
        return NextResponse.json({ error: 'body object not found in store' }, { status: 404 });
    }

    const truncated = !full && buf.byteLength > BODY_MAX_BYTES;
    const out = truncated ? buf.subarray(0, BODY_MAX_BYTES) : buf;
    return NextResponse.json({
        which,
        key,
        total_bytes: buf.byteLength,
        truncated,
        body: out.toString('utf8'),
    });
}
