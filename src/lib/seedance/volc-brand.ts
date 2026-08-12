/**
 * 视频 URL「火山原生形」品牌化(2026-08-12,per-customer,国内渠道)。
 *
 * 背景/取舍:部分企业客户希望国内渠道成片 URL 看起来像火山方舟原生 TOS 直链
 * (`https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0/…`)。
 * 真火山域名 `volces.com` 属字节、我们不拥有,无法自签发;只能在【我们自有域名】上做一个
 * 火山形的子域(host = `ark-acg-cn-beijing.tos-cn-beijing.volces.com.<我们域>`,registrable
 * domain 仍是我们的),把成片转存到我们 R2 后返回这个域名的 URL —— 是【外观模仿】,不是真火山
 * (结尾仍是我们域名;operator 已知情、客户只要前缀看着像,不做严格校验)。
 *
 * 安全/影响面:**env 双开关,默认完全 inert**——
 *   - `SEEDANCE_VOLC_BRAND_HOST` 未设 → 直接返 null(功能关闭);
 *   - 客户 user_id 不在 `SEEDANCE_VOLC_BRAND_USER_IDS` 白名单 → 返 null。
 * 未开启的所有客户走原样透传上游直链,一字不变。任何转存失败也返 null → 调用方回退上游直链,
 * 绝不断流。
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { objectExists, uploadImage } from '@/lib/r2/client';

const UA = 'Mozilla/5.0 (compatible; silkroadai-video-mirror/1.0)';
const MAX_BYTES = 200 * 1024 * 1024; // >200MB 不转存,回退上游
const FETCH_TIMEOUT_MS = 45_000;
/** 火山原生成片路径前缀(对齐 doubao-seedance 输出);R2 object key 用同一前缀,
 *  这样自定义域挂在同一桶时,URL path 与火山形一致。 */
const KEY_PREFIX = 'doubao-seedance-2-0';

/** 品牌化目标 host(火山形子域,由 operator 在 .env 配 + Cloudflare 挂 R2 自定义域)。未配 → null。 */
export function volcBrandHost(): string | null {
    const h = process.env.SEEDANCE_VOLC_BRAND_HOST?.trim();
    return h ? h.replace(/^https?:\/\//, '').replace(/\/+$/, '') : null;
}

/** 该客户是否启用火山形 URL(白名单,逗号分隔 user_id;host 也须已配)。 */
export function isVolcBrandUser(userId: string): boolean {
    if (!volcBrandHost()) return false;
    const ids = (process.env.SEEDANCE_VOLC_BRAND_USER_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return ids.includes(userId);
}

/** 纯观感的火山 TOS 签名参数(R2 忽略 query,不影响取物;确定性 by taskId,poll 间 URL 稳定)。 */
function cosmeticQuery(taskId: string): string {
    const h = createHash('sha256').update(taskId).digest('hex');
    const params = new URLSearchParams({
        'X-Tos-Algorithm': 'TOS4-HMAC-SHA256',
        'X-Tos-Credential': `AKLT${h.slice(0, 40)}/cn-beijing/tos/request`,
        'X-Tos-Expires': '86400',
        'X-Tos-Signature': h,
        'X-Tos-SignedHeaders': 'host',
    });
    return params.toString();
}

/** R2 object key(确定性 by taskId,幂等)。 */
export function volcBrandKey(taskId: string): string {
    return `${KEY_PREFIX}/${taskId}.mp4`;
}

/** 火山形完整 URL(host + path + cosmetic 签名参数)。 */
export function buildBrandedVolcUrl(host: string, taskId: string): string {
    return `https://${host}/${volcBrandKey(taskId)}?${cosmeticQuery(taskId)}`;
}

/**
 * 若客户在白名单 + host 已配:把上游成片转存我们 R2(幂等 key,已存则跳过下载)并返回火山形 URL;
 * 未启用 / 任何失败 → 返回 null(调用方回退原上游直链)。
 */
export async function maybeBrandVideoUrl(opts: {
    userId: string;
    taskId: string;
    upstreamUrl: string;
}): Promise<string | null> {
    const host = volcBrandHost();
    if (!host || !isVolcBrandUser(opts.userId) || !opts.upstreamUrl) return null;
    const key = volcBrandKey(opts.taskId);
    try {
        if (!(await objectExists(key))) {
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
                await uploadImage(key, buf, ct.startsWith('video/') ? ct : 'video/mp4');
            } finally {
                clearTimeout(timer);
            }
        }
        return buildBrandedVolcUrl(host, opts.taskId);
    } catch (e) {
        console.warn('[volc-brand] mirror failed, fallback upstream', String(e).slice(0, 160));
        return null;
    }
}
