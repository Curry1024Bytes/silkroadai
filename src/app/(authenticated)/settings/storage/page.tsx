/**
 * /settings/storage(W9 D3 PR-C)— 客户自定义 OSS 配置页(server component)。
 *
 * 生图(/v1 proxy Gemini image)默认存平台 R2;客户可在这里配自己的
 * S3 兼容存储,配置生效后出图 URL 用客户自己的域名。
 * Auth 由 (authenticated)/layout.tsx 顶层守门;本页再读一次 user 拿配置。
 */
import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { getOssConfig } from '@/lib/oss/store';
import { getLocale } from '@/lib/i18n/server';
import { intlLocale, pickMessages } from '@/lib/i18n';
import { storageMessages } from '@/lib/i18n/messages/storage';
import { StorageSettingsForm, type OssConfigView } from './storage-form';

async function getSessionUser() {
    const h = await headers();
    const cookie = h.get('cookie') || '';
    const req = new NextRequest('http://internal/settings/storage', {
        method: 'GET',
        headers: { cookie },
    });
    return getCurrentUser(req);
}

function maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export default async function StorageSettingsPage() {
    const [user, locale] = await Promise.all([getSessionUser(), getLocale()]);
    if (!user) return null;
    const m = pickMessages(storageMessages, locale);

    let initialConfig: OssConfigView | null = null;
    try {
        const config = await getOssConfig(user.id);
        if (config) {
            initialConfig = {
                provider: config.provider,
                endpoint: config.endpoint,
                bucket: config.bucket,
                region: config.region,
                access_key_id_masked: maskKey(config.access_key_id),
                public_url_prefix: config.public_url_prefix,
                status: config.status,
                last_test_at: config.last_test_at
                    ? config.last_test_at.toLocaleString(intlLocale(locale), { timeZone: 'Asia/Shanghai' })
                    : null,
            };
        }
    } catch {
        // 读失败按"未配置"渲染 — 表单仍可用,保存时服务端会再校验
    }

    return (
        <div className="max-w-3xl">
            <h1 className="text-2xl font-semibold text-navy">{m.heading}</h1>
            <p className="mt-2 text-sm text-muted-ink">
                {m.intro1}
                <code className="mx-1 font-mono text-xs">images.silkroadai.io</code>
                {m.intro2}
                <code className="mx-1 font-mono text-xs">response_format: url</code>
                {m.intro3}
            </p>
            <StorageSettingsForm initialConfig={initialConfig} />
        </div>
    );
}
