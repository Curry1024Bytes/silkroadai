import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireEnterpriseUser } from '@/lib/enterprise/session';
import { AssetError, assetLimits, storeAsset, type AssetType } from '@/lib/enterprise/assets';

export const runtime = 'nodejs';

/**
 * P3 dashboard 素材端点(cookie 会话;与火山形 Action API 共享 lib/enterprise/assets 核心)。
 * GET  → 素材 + 素材组列表(素材库页数据源)。
 * POST → multipart 文件上传(浏览器直传 → R2 → 落库)。⚠️ 本路径在 middleware matcher
 *        排除清单里(视频可 >10MB,避开 body 缓冲截断),鉴权全在本文件。
 */
export async function GET(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const [assets, groups] = await Promise.all([
        prisma.enterpriseAsset.findMany({
            where: { user_id: user.id },
            orderBy: { created_at: 'desc' },
            take: 500,
        }),
        prisma.enterpriseAssetGroup.findMany({ where: { user_id: user.id }, orderBy: { created_at: 'asc' } }),
    ]);
    return NextResponse.json({
        assets: assets.map((a) => ({
            id: a.id,
            name: a.name,
            asset_type: a.asset_type,
            group_id: a.group_id,
            url: a.public_url,
            bytes: a.bytes,
            created_at: a.created_at.toISOString(),
        })),
        groups: groups.map((g) => ({ id: g.id, name: g.name })),
    });
}

function assetTypeFromMime(mime: string): AssetType | null {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return null;
}

export async function POST(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return NextResponse.json({ error: 'invalid_input', detail: '需要 multipart/form-data' }, { status: 400 });
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
        return NextResponse.json({ error: 'invalid_input', detail: 'file 字段必填' }, { status: 400 });
    }
    if (file.size > assetLimits().maxFileBytes) {
        return NextResponse.json({ error: 'file_too_large' }, { status: 400 });
    }
    const mime = file.type || 'application/octet-stream';
    const assetType = assetTypeFromMime(mime);
    if (!assetType) {
        return NextResponse.json({ error: 'unsupported_type', detail: '仅支持图片/视频/音频' }, { status: 400 });
    }
    const nameRaw = form.get('name');
    const groupRaw = form.get('group_id');
    const name = (typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : file.name || 'asset').slice(0, 100);
    const groupId = typeof groupRaw === 'string' && groupRaw.trim() ? groupRaw.trim() : null;

    try {
        const row = await storeAsset({
            userId: user.id,
            assetType,
            name,
            groupId,
            bytes: Buffer.from(await file.arrayBuffer()),
            mime,
        });
        return NextResponse.json({
            id: row.id,
            name: row.name,
            asset_type: row.asset_type,
            group_id: row.group_id,
            url: row.public_url,
            bytes: row.bytes,
            created_at: row.created_at.toISOString(),
        });
    } catch (e) {
        if (e instanceof AssetError) {
            return NextResponse.json({ error: e.code, detail: e.message }, { status: e.status });
        }
        console.error('[enterprise-assets] upload failed', e);
        return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    }
}
