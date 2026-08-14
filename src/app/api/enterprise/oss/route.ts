/**
 * /api/enterprise/oss(2026-08-14)— 企业客户自定义 OSS 配置 CRUD。
 *
 * = /api/portal/oss 的企业版:逻辑一致(共用 user_oss_configs 表 + src/lib/oss/* 基建),
 * 唯一区别是鉴权走 requireEnterpriseUser(企业客户判定)+ 路径前缀 /api/enterprise/*
 * (企业裸 IP 门户 Caddy 只放行 /api/enterprise/*,不放行 /api/portal/*)。
 *
 * GET    — 读当前配置(secret 不返;access_key_id 返 mask)
 * PUT    — zod 校验 → 真连接测试 → 通过才加密落库(status='active');测试失败 422
 * DELETE — 清除配置,回平台默认存储(幂等)
 *
 * 所有操作 WHERE user_id = 当前企业客户,body 不收 id → 无 IDOR 面。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireEnterpriseUser } from '@/lib/enterprise/session';
import { encryptSecret } from '@/lib/oss/encryption';
import { testOssConnection } from '@/lib/oss/client';
import { OssConfigSchema } from '@/lib/oss/schema';
import { deleteOssConfig, getOssConfig, upsertOssConfig } from '@/lib/oss/store';

export const runtime = 'nodejs';

function maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export async function GET(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });

    const config = await getOssConfig(user.id);
    if (!config) return NextResponse.json({ config: null });

    return NextResponse.json({
        config: {
            provider: config.provider,
            endpoint: config.endpoint,
            bucket: config.bucket,
            region: config.region,
            access_key_id_masked: maskKey(config.access_key_id),
            public_url_prefix: config.public_url_prefix,
            cdn_enabled: config.cdn_enabled,
            status: config.status,
            last_test_at: config.last_test_at,
            last_test_message: config.last_test_message,
        },
    });
}

export async function PUT(req: NextRequest) {
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

    const test = await testOssConnection({
        provider: c.provider,
        endpoint: c.endpoint ?? null,
        bucket: c.bucket,
        region: c.region ?? null,
        access_key_id: c.access_key_id,
        secret_access_key_encrypted: encrypted,
        public_url_prefix: c.public_url_prefix,
    });
    if (!test.ok) {
        return NextResponse.json(
            { error: 'connection_test_failed', message: test.message ?? 'unknown' },
            { status: 422 },
        );
    }

    const saved = await upsertOssConfig(user.id, {
        provider: c.provider,
        endpoint: c.endpoint ?? null,
        bucket: c.bucket,
        region: c.region ?? null,
        access_key_id: c.access_key_id,
        secret_access_key_encrypted: encrypted,
        public_url_prefix: c.public_url_prefix,
        cdn_enabled: c.cdn_enabled,
        status: 'active',
        last_test_at: new Date(),
        last_test_message: null,
    });

    return NextResponse.json({ ok: true, status: saved.status });
}

export async function DELETE(req: NextRequest) {
    const user = await requireEnterpriseUser(req);
    if (!user) return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });

    await deleteOssConfig(user.id);
    return NextResponse.json({ ok: true });
}
