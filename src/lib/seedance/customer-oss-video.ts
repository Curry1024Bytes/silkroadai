/**
 * Seedance 成片落客户自定义 OSS(2026-08-14,参照主站 /v1 生图自定义 OSS)。
 *
 * 客户在 /enterprise/storage 配了自己的 S3 兼容存储(user_oss_configs —— 与主站生图【同一张表】+
 * 同一套 AES-256-GCM 加解密,一客户一行)后:任务完成时把上游成片(火山签名直链,~24h 过期)
 * 转存到【客户自己的 bucket】,返回客户公网前缀 URL —— 客户拿到自己域名下的永久链接。
 *
 * 幂等:object key 由 taskId 确定,转存前先 HEAD 客户 bucket,已存在则不重复下载+上传
 * (镜像 volc-brand 用 objectExists 做 poll-间幂等的模式)。
 * 未配置 / status≠active / 任何失败 → 返 null,调用方回退上游直链(绝不断流)。
 * 仅落【输出视频】—— 输入图仍走平台 R2(上游要能拉取,客户 bucket 未必公开可读)。
 */
import 'server-only';
import { getOssConfig, type UserOssConfigRow } from '@/lib/oss/store';
import { objectExistsInOss, ossPublicUrl, uploadToCustomerOss } from '@/lib/oss/client';

const UA = 'Mozilla/5.0 (compatible; silkroadai-video-store/1.0)';
const MAX_BYTES = 300 * 1024 * 1024; // >300MB 不转存,回退上游直链
const FETCH_TIMEOUT_MS = 60_000;
const KEY_PREFIX = 'seedance';

/** 客户 bucket 内的成片 object key(确定性 by taskId,幂等)。 */
export function customerVideoKey(taskId: string): string {
    return `${KEY_PREFIX}/${taskId}.mp4`;
}

/**
 * 若客户配了自定义 OSS(status=active):把上游成片转存客户 bucket(幂等 key,已存则跳过下载)
 * 并返回客户公网 URL;未配置 / 任何失败 → 返回 null(调用方回退原上游直链)。
 */
export async function maybeStoreVideoToCustomerOss(opts: {
    userId: string;
    taskId: string;
    upstreamUrl: string;
}): Promise<string | null> {
    if (!opts.upstreamUrl) return null;

    let config: UserOssConfigRow | null;
    try {
        config = await getOssConfig(opts.userId);
    } catch (e) {
        console.warn('[customer-oss-video] config lookup failed', String(e).slice(0, 160));
        return null;
    }
    if (!config || config.status !== 'active') return null;

    const key = customerVideoKey(opts.taskId);
    try {
        if (await objectExistsInOss(config, key)) return ossPublicUrl(config, key);

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const vid = await fetch(opts.upstreamUrl, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
            if (!vid.ok) return null;
            const len = Number(vid.headers.get('content-length') || 0);
            if (len > MAX_BYTES) return null;
            const buf = Buffer.from(await vid.arrayBuffer());
            if (buf.length === 0) return null;
            const ct = vid.headers.get('content-type') || 'video/mp4';
            return await uploadToCustomerOss(config, buf, key, ct.startsWith('video/') ? ct : 'video/mp4');
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        console.warn('[customer-oss-video] store failed, fallback upstream', String(e).slice(0, 160));
        return null;
    }
}
