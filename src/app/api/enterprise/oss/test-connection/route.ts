/**
 * /api/enterprise/oss/test-connection(2026-08-14)— 不持久化的连接测试(企业版)。
 *
 * = /api/portal/oss/test-connection 的企业版:鉴权走 requireEnterpriseUser。
 * POST body 同 PUT /api/enterprise/oss 的 schema;put+delete 一个临时对象,返 { ok, message? }。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireEnterpriseUser } from '@/lib/enterprise/session';
import { encryptSecret } from '@/lib/oss/encryption';
import { testOssConnection } from '@/lib/oss/client';
import { OssConfigSchema } from '@/lib/oss/schema';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
    }
    const parsed = OssConfigSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_config', details: parsed.error.flatten() }, { status: 400 });
    }
    const c = parsed.data;

    let encrypted: string;
    try {
        encrypted = encryptSecret(c.secret_access_key);
    } catch (e) {
        console.error('[enterprise-oss] PORTAL_OSS_ENC_KEY missing/invalid', e);
        return NextResponse.json({ error: 'server_encryption_unavailable' }, { status: 503 });
    }

    const result = await testOssConnection({
        provider: c.provider,
        endpoint: c.endpoint ?? null,
        bucket: c.bucket,
        region: c.region ?? null,
        access_key_id: c.access_key_id,
        secret_access_key_encrypted: encrypted,
        public_url_prefix: c.public_url_prefix,
    });

    return NextResponse.json(result, { status: 200 });
}
