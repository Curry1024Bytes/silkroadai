/**
 * /enterprise/storage —— 企业客户自定义 OSS 配置页(2026-08-14,参照主站 /settings/storage)。
 *
 * Seedance 成片默认存平台对象存储、返回平台域名 URL(火山签名直链 ~24h 过期);客户在这里配自己的
 * S3 兼容存储(R2 / 阿里 OSS / 腾讯 COS / AWS S3 / 自建)后,成片直接转存到客户 bucket、返回客户
 * 自己域名下的永久 URL。配置与主站生图【共用同一张表 user_oss_configs + 同一套加解密】,
 * 保存/清除走同一套 /api/portal/oss(cookie-session,WHERE user_id=当前企业客户,无 IDOR 面)。
 *
 * Auth 由 (dash)/layout.tsx 顶层 getEnterpriseSessionUser 守门;本页再取一次拿当前配置。
 */
import { getEnterpriseSessionUser } from '@/lib/enterprise/session';
import { getOssConfig } from '@/lib/oss/store';
import { StorageSettingsForm, type OssConfigView } from '@/app/(authenticated)/settings/storage/storage-form';

export const dynamic = 'force-dynamic';

function maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export default async function EnterpriseStoragePage() {
    const user = await getEnterpriseSessionUser();
    if (!user) return null;

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
                    ? config.last_test_at.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
                    : null,
            };
        }
    } catch {
        // 读失败按"未配置"渲染 —— 表单仍可用,保存时服务端会再校验
    }

    return (
        <div className="max-w-3xl">
            <h1 className="text-xl font-semibold text-gray-900">自定义存储</h1>
            <p className="mt-2 text-sm text-gray-600">
                默认情况下,Seedance 视频成片返回<strong>上游生成直链</strong>(有效期约 24
                小时,请及时下载或转存)。你可以配置自己的对象存储(Cloudflare R2 / 阿里云 OSS / 腾讯云 COS / AWS S3 / 自建
                S3 兼容),配置生效后成片将直接上传到你的
                bucket、返回你自己域名下的永久链接,数据完全归属你。未配置或任何故障时自动回退上游直链,不影响出片。
            </p>
            <StorageSettingsForm
                initialConfig={initialConfig}
                apiBase="/api/enterprise/oss"
                defaultModeHint="无需配置,成片返回上游生成直链(有效期约 24 小时,请及时下载或转存)"
            />
        </div>
    );
}
