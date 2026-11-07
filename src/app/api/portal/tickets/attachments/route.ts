/**
 * POST /api/portal/tickets/attachments — multipart `file`(图片 ≤ 5MB)→ R2 `tickets/<uid>/<uuid>.<ext>`。
 * 返回 { key, url, name, size, type },客户端随消息提交 key。文件头嗅探决定类型(浏览器 type 不可信)。
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { uploadImage } from '@/lib/r2/client';
import { attachmentKey, MAX_ATTACHMENT_BYTES, sniffImageMime } from '@/lib/tickets/attachments';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
    const user = await getCurrentUser(req);
    if (!user) return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 });
    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return NextResponse.json({ error: 'invalid_multipart' }, { status: 400 });
    }
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'file_required' }, { status: 400 });
    if (file.size > MAX_ATTACHMENT_BYTES) return NextResponse.json({ error: 'file_too_large' }, { status: 413 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffImageMime(bytes);
    if (!mime) return NextResponse.json({ error: 'unsupported_type' }, { status: 415 });
    const key = attachmentKey(user.id, randomUUID(), mime);
    try {
        const url = await uploadImage(key, Buffer.from(bytes), mime);
        return NextResponse.json(
            { key, url, name: file.name.slice(0, 120) || 'image', size: file.size, type: mime },
            { status: 201 },
        );
    } catch (e) {
        console.error('[tickets/attachments] upload failed:', e);
        return NextResponse.json({ error: 'upload_failed' }, { status: 502 });
    }
}
