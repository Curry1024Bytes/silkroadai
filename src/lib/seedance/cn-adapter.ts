/**
 * Seedance 国内企业级端口 适配器(火山方舟 doubao-seedance / token.xinhankr.com)。
 *
 * 上游网关「与 OpenAI 官方视频规范完全对齐」:提交 POST /v1/video/generations、
 * 轮询 GET /v1/video/generations/{task_id}、完成响应 { status, data:[{url}], usage }。
 * 因此本适配器比海外档(service-inference.ai 自定义 API)简单得多 —— 近乎透传,
 * 只做两件事:①档位模型名 → 上游单模型 artsdance-2-0-pro-260801 + resolution + 参考模式门控;
 * ②入参图/视频/音频 data URL 先转存我们 R2(上游 images[]/videos[]/audios[] 只吃 http(s) 直链)。
 * 成片【不转存】,直接返回火山 volcvideo.com 原始直链(operator 要「真实感」:客户看到火山官方
 * VOD 域名,已隐藏 token.xinhankr 上游、只露 Volcengine=火山方舟)。⚠️ 火山直链是【签名 URL ~24h 过期】,
 * 客户须及时下载/转存(不像 R2 永久)。见 /docs 说明。
 *
 * 计费:【按 token 量】—— 上游按 token 计价(usage.completion_tokens 权威),我们对客 = 实际 token ×
 * 零售单价(官方价 × 0.85;上游给我们 0.75)。分辨率(480p/720p/1080p/4k,-ref 后缀 = 带参考输入)
 * 决定每-token 费率档;pollVideo 回传 usage 供 new-api ModelRatio 或适配器自扣计费(见按 token 计费方案)。
 * ⚠️ 参考视频档(输入视频也计 token)成本高于无视频,不能按无视频档收 —— 待接入含视频费率档(off-peak)。
 * 适配器强制档位与实际输入一致(无参考档带图 → 400;参考档不带图/视频 → 400),防止客户挑便宜档串用。
 *
 * ⚠️ 上游账户余额 < ¥5 会对【所有】请求回 403「账户余额不足5元」—— 保持上游充值。
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { uploadImage } from '@/lib/r2/client';
import { classifyUpstreamError } from './upstream-error';

const XHK_BASE = process.env.SEEDANCE_XHK_BASE_URL || 'https://token.xinhankr.com';
/** 上游 pro 模型名(SEEDANCE_XHK_MODEL 仅覆盖 pro;fast/mini 上游 id 固定)。 */
// 上游 2026-08-11 升级到 260801 版(连字符命名,同 2.5;480p/720p/1080p/4k 分辨率支持与旧 260701 一致,实测)。
const UPSTREAM_MODEL = process.env.SEEDANCE_XHK_MODEL || 'artsdance-2-0-pro-260801';
const UPSTREAM_FAST = 'artsdance-2-0-fast-260801';
const UPSTREAM_MINI = 'artsdance-2-0-mini-260801';
// 海外版(2026-07-23,同上游厂商的国际端口 BytePlus 出片;协议与国内完全一致,实测见
// seedance-enterprise-intl-design.md):仅 base/key/模型名不同。key 按客户存
// enterprise_upstream_keys(region='global') 行。
const INTL_BASE = process.env.SEEDANCE_INTL_BASE_URL || 'https://ai.artsmcp.com';
const UPSTREAM_INTL_PRO = 'artsdance2-0-pro-intl-260701';
const UPSTREAM_INTL_FAST = 'artsdance2-0-fast-intl-260701';
const UPSTREAM_INTL_MINI = 'artsdance2-0-mini-intl-260701';
// 海外版proMax(2026-07-23):同 intl base/key,dreamina 系上游模型(挂牌更高,零售=挂牌×0.85)。
// pro 有 480p/720p/1080p/4k,fast/mini 上游仅 480p/720p。mini 实测 token 基数
// 与现有渠道一致(720p 5s = 108,900);计费按 usage 实报,基数差异不影响正确性。
// proMax 三档 2026-08-08 全部由 dreamina 系迁到 artsdance intl 系(= global 同一上游名,生产已验证)。
// artsdance intl 不支持 480p → proMax 全档去 480p:pro 保留 720p/1080p/4k,fast/mini 仅 720p。价格不变。
const UPSTREAM_PROMAX_PRO = 'artsdance2-0-pro-intl-260701';
const UPSTREAM_PROMAX_FAST = 'artsdance2-0-fast-intl-260701';
const UPSTREAM_PROMAX_MINI = 'artsdance2-0-mini-intl-260701';
// 海外版 proMax seedance 2.5(2026-08-08):intl 新代模型,仅 720p/1080p,费率独立(按原价挂牌)。
const UPSTREAM_PROMAX_25 = process.env.SEEDANCE_PROMAX_MODEL_25 || 'artsdance2-5-intl-260628';
// 国内版 seedance 2.5(2026-08-07):国内版渠道(token.xinhankr)上游新代模型。
// 上游名 2026-08-08 由 doubao-seedance-2-5-260628 换成 artsdance-2-5-pro-260801
// (实测:新名支持 720p/1080p、【不支持 480p】;旧名支持 480p/720p)。费率独立(含视/无视两档)。
const UPSTREAM_XHK_25 = process.env.SEEDANCE_XHK_MODEL_25 || 'artsdance-2-5-pro-260801';

/** 版本 → 上游 base URL(global 与 promax 同为 intl 端口,仅模型名/费率不同)。
 *  volc(火山渠道)走独立上游 + 火山方舟原生协议,不经此函数(见 kuaizi-adapter)。 */
export type SeedanceRegion = 'cn' | 'global' | 'promax' | 'volc';
export function baseForRegion(region: SeedanceRegion): string {
    return region === 'global' || region === 'promax' ? INTL_BASE : XHK_BASE;
}

/** 「火山」渠道对客模型名(火山方舟点分形)。2026-08-17 换上游(筷子开放平台)后由单模型
 *  扩到四档;上游 Model ID 与档位映射见 kuaizi-adapter 的 VOLC_MODELS。
 *  ⚠️ 必须是点分形 —— 连字符形(doubao-seedance-2-0-260128 等)被 ark-format 归一到国内版
 *  短名 seedance-2-0 系(cn 渠道),两套命名不能相撞。 */
export const VOLC_MODEL = 'doubao-seedance-2.0';
const VOLC_MODEL_NAMES = new Set([
    VOLC_MODEL,
    'doubao-seedance-2.0-fast',
    'doubao-seedance-2.0-mini',
    'doubao-seedance-2.5',
]);
/** 是否「火山」渠道对客模型名(点分形四档)。 */
export function isVolcModel(model: string): boolean {
    return VOLC_MODEL_NAMES.has(String(model || '').toLowerCase());
}

// 默认单次输入上限(旧档 pro/fast/mini/promax…):9 图 / 3 视频 / 音频不限数(仅需配图)。
const MAX_REF_IMAGES = 9;
const MAX_REF_VIDEOS = 3;

/** seedance 变体(2026-07-19 加 fast/mini;2026-07-23 加 promax 系,费率独立;
 *  2026-08-07 加 '2.5' = 国内版新代模型,费率独立):费率按 variant × resolution × 含视频 分档。 */
export type SeedanceVariant = 'pro' | 'fast' | 'mini' | '2.5' | 'promax' | 'promax-fast' | 'promax-mini' | 'promax-2.5';

/** 单次输入素材上限(按变体)。seedance 2.5(2026-08-07 上游放宽):30 图 + 10 视频 + 10 音频;
 *  其余档沿用默认 9 图 / 3 视频 / 音频不限数(Infinity —— 保留旧行为,只需「音频需配图」约束)。
 *  上限比上游宽或等 —— 超限我们先 400 给清晰文案,不白打上游。 */
const REF_LIMITS: Partial<Record<SeedanceVariant, { images: number; videos: number; audios: number }>> = {
    '2.5': { images: 30, videos: 10, audios: 10 },
};
function refLimitsFor(variant: SeedanceVariant): { images: number; videos: number; audios: number } {
    return REF_LIMITS[variant] ?? { images: MAX_REF_IMAGES, videos: MAX_REF_VIDEOS, audios: Infinity };
}

export interface SeedanceModelSpec {
    resolution: '480p' | '720p' | '1080p' | '4k';
    ref: boolean;
    variant: SeedanceVariant;
    /** 该档实际发给上游的模型 id(分辨率/参考模式由请求体承载)。 */
    upstream: string;
    /** 版本:缺省 'cn';'global' 走海外 base(INTL_BASE)。 */
    region?: SeedanceRegion;
}

/** 客户/new-api 档位模型名 → 档位规格(每档 × {无参考,-ref} 两名)。2k 已下线(2026-07-15)。
 *  2026-08-03 全线加 480p:上游(artsdance 国内/intl + dreamina)挂牌本就含 480p,
 *  与 720p 统一价(token ∝ 像素,整条约半价)。 */
export const MODEL_MAP: Record<string, SeedanceModelSpec> = {
    // ── 国内(cn):pro 4 档,fast/mini 480p/720p/1080p ──
    ...Object.fromEntries(
        (
            [
                ['pro', UPSTREAM_MODEL, ['480p', '720p', '1080p', '4k']],
                ['fast', UPSTREAM_FAST, ['480p', '720p', '1080p']],
                ['mini', UPSTREAM_MINI, ['480p', '720p', '1080p']],
            ] as Array<[SeedanceVariant, string, Array<'480p' | '720p' | '1080p' | '4k'>]>
        ).flatMap(([variant, upstream, resolutions]) =>
            resolutions.flatMap((resolution) =>
                [false, true].map((ref) => [
                    `seedance2.0-${variant}-${resolution}${ref ? '-ref' : ''}`,
                    { resolution, ref, variant, upstream },
                ]),
            ),
        ),
    ),
    // ── 国内 seedance 2.5(cn):新代单模型,仅 720p/1080p(上游 artsdance-2-5-pro 不支持 480p),费率独立 ──
    ...Object.fromEntries(
        (['720p', '1080p'] as const).flatMap((resolution) =>
            [false, true].map((ref) => [
                `seedance2.5-${resolution}${ref ? '-ref' : ''}`,
                { resolution, ref, variant: '2.5' as const, upstream: UPSTREAM_XHK_25 },
            ]),
        ),
    ),
    // ── 海外版 proMax seedance 2.5(2026-08-08):intl 新代模型,仅 720p/1080p,费率独立(按原价挂牌)──
    ...Object.fromEntries(
        (['720p', '1080p'] as const).flatMap((resolution) =>
            [false, true].map((ref) => [
                `seedance2.5-promax-${resolution}${ref ? '-ref' : ''}`,
                {
                    resolution,
                    ref,
                    variant: 'promax-2.5' as const,
                    upstream: UPSTREAM_PROMAX_25,
                    region: 'promax' as const,
                },
            ]),
        ),
    ),
    // ── 海外版proMax(promax,2026-07-23):dreamina 系,费率独立;pro 4 档,fast/mini 480p/720p ──
    ...Object.fromEntries(
        (
            [
                ['promax', UPSTREAM_PROMAX_PRO, ['720p', '1080p', '4k']], // artsdance intl:无 480p
                ['promax-fast', UPSTREAM_PROMAX_FAST, ['720p']], // artsdance intl:仅 720p
                ['promax-mini', UPSTREAM_PROMAX_MINI, ['720p']], // artsdance intl:仅 720p
            ] as Array<[SeedanceVariant, string, Array<'480p' | '720p' | '1080p' | '4k'>]>
        ).flatMap(([variant, upstream, resolutions]) =>
            resolutions.flatMap((resolution) =>
                [false, true].map((ref) => [
                    `seedance2.0-${variant}-${resolution}${ref ? '-ref' : ''}`,
                    { resolution, ref, variant, upstream, region: 'promax' as const },
                ]),
            ),
        ),
    ),
    // ── 海外版(global,2026-07-23):档位与国内一致(operator 拍板同 4k/15s/定价),仅上游不同。
    //    ⚠️ 无 480p:intl 上游三变体实测均拒「当前分辨率 480p 不支持」(2026-08-06),
    //    proxy 对 global+480p 返带指引的 400。 ──
    ...Object.fromEntries(
        (
            [
                ['pro', UPSTREAM_INTL_PRO, ['720p', '1080p', '4k']],
                ['fast', UPSTREAM_INTL_FAST, ['720p', '1080p']],
                ['mini', UPSTREAM_INTL_MINI, ['720p', '1080p']],
            ] as Array<[SeedanceVariant, string, Array<'480p' | '720p' | '1080p' | '4k'>]>
        ).flatMap(([variant, upstream, resolutions]) =>
            resolutions.flatMap((resolution) =>
                [false, true].map((ref) => [
                    `seedance2.0-global-${variant}-${resolution}${ref ? '-ref' : ''}`,
                    { resolution, ref, variant, upstream, region: 'global' as const },
                ]),
            ),
        ),
    ),
};

/** model 名 → 版本(计费折扣/上游 base 用):MODEL_MAP 优先,短名按 '-global' 识别,缺省 cn。 */
export function regionForModel(model: string): SeedanceRegion {
    const hit = MODEL_MAP[model]?.region;
    if (hit) return hit;
    const m = String(model || '').toLowerCase();
    if (isVolcModel(m)) return 'volc';
    if (m.includes('-promax')) return 'promax';
    if (m.includes('-global')) return 'global';
    return 'cn';
}

/** 任务行只存 model 名 → 变体(计费用)。长名走 MODEL_MAP;企业门户短名
 *  (seedance-2-0[-fast|-mini],2026-07-20 归一)按后缀识别;未知名回落 pro(宁多收不少收)。 */
export function variantForModel(model: string): SeedanceVariant {
    const hit = MODEL_MAP[model]?.variant;
    if (hit) return hit;
    const m = model.toLowerCase();
    if (m === VOLC_MODEL) return 'pro'; // 火山渠道 2.0 主档 = pro(国内版同价)
    // 火山渠道其余三档(doubao-seedance-2.0-fast / -mini / doubao-seedance-2.5)由下面的
    // 通用后缀识别命中 fast / mini / '2.5',与国内版同费率表。
    // 2.5 系:费率独立。promax-2.5 含 '2-5' 且 '-promax',必须【先于】纯 2.5 与 promax 判,
    // 否则会落到 cn '2.5' 或 'promax' 档按错价计费。
    const is25 = m.includes('2-5') || m.includes('2.5');
    if (is25 && m.includes('-promax')) return 'promax-2.5';
    if (is25) return '2.5';
    if (m.includes('-promax')) {
        // promax 系费率独立,必须先于 -fast/-mini 判(seedance-2-0-promax-fast 含 '-fast')
        if (m.includes('-fast')) return 'promax-fast';
        if (m.includes('-mini')) return 'promax-mini';
        return 'promax';
    }
    if (m.includes('-fast')) return 'fast';
    if (m.includes('-mini')) return 'mini';
    return 'pro';
}

/** 单次生成时长上限(秒):seedance 2.5 系 = 30s(火山官方 2026-08 提升,4~30);
 *  2.0 全系仍 15s(4~15)。低于 4 或超上限 → 调用方回落缺省 5(cn-adapter/cn-proxy)或 400(proxy)。 */
export function maxDurationForVariant(v: SeedanceVariant): number {
    return v === '2.5' || v === 'promax-2.5' ? 30 : 15;
}

// 火山官方 2.5 支持 adaptive(首尾帧/视频编辑/延长任务【必须】adaptive → 输出跟随输入宽高比)。
const ALLOWED_RATIOS = new Set(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive']);

/** category:机器可读分类。调用方(enterprise proxy / 对账器)据此判定
 *  「任务已废」还是「瞬时抖动」—— 见 upstream-error.isTerminalTaskFailure。 */
function err(status: number, code: string, message: string, category?: string) {
    return NextResponse.json(
        { error: { code, message, type: 'seedance_cn_adapter_error', ...(category ? { category } : {}) } },
        { status },
    );
}

// 上游报错体 → 对客文案的分类/脱敏已抽到 ./upstream-error(2026-08-17 重写,见该文件头部
// 「为什么重写」)。此处 re-export 保持既有 import 路径不变。
export { friendlyUpstreamError, classifyUpstreamError } from './upstream-error';

function isAuthorized(auth: string): boolean {
    const key = auth.replace(/^Bearer\s+/i, '').trim();
    // 渠道 key(= new-api 下发的 channel key)。设了 SEEDANCE_XHK_KEY 就精确校验,防路由被外部直接打;
    // 未设(本地/测试)时放行任何 sk- 前缀。运行时读 env(不缓存),便于改 key 不重启 + 可测。
    const configured = process.env.SEEDANCE_XHK_KEY || '';
    if (configured) return key === configured;
    return /^sk-/.test(key);
}

/** OpenAI/视频两种风格都抽:prompt / content[].text / messages[].content。 */
function extractPrompt(body: Record<string, unknown>): string {
    if (typeof body.prompt === 'string' && body.prompt.trim()) return body.prompt;
    const content = body.content;
    if (Array.isArray(content)) {
        const t = content
            .filter((c): c is { type: string; text: string } => {
                const o = c as { type?: unknown; text?: unknown };
                return o?.type === 'text' && typeof o?.text === 'string';
            })
            .map((c) => c.text)
            .join('\n');
        if (t.trim()) return t;
    }
    const messages = body.messages;
    if (Array.isArray(messages)) {
        const lastUser = [...messages].reverse().find((m) => (m as { role?: string })?.role === 'user') as
            | { content?: unknown }
            | undefined;
        const mc = lastUser?.content;
        if (typeof mc === 'string') return mc;
        if (Array.isArray(mc)) {
            return mc
                .filter((c): c is { text: string } => (c as { type?: string })?.type === 'text')
                .map((c) => c.text)
                .join('\n');
        }
    }
    return '';
}

function pushUrl(list: string[], u: unknown) {
    if (typeof u === 'string' && u) list.push(u);
    else if (u && typeof u === 'object' && typeof (u as { url?: unknown }).url === 'string')
        list.push((u as { url: string }).url);
}

function urlOf(u: unknown): string {
    if (typeof u === 'string') return u;
    if (u && typeof u === 'object' && typeof (u as { url?: unknown }).url === 'string')
        return (u as { url: string }).url;
    return '';
}

/** 从 content 数组抽出图片项 + 其显式 role(火山官方形:first_frame / last_frame / reference_image)。
 *  用于保留客户在 content-item 上显式指定的帧角色;未识别的 role 归一为 reference_image。 */
export function extractImageRolesFromContent(body: Record<string, unknown>): Array<{ url: string; role: string }> {
    const out: Array<{ url: string; role: string }> = [];
    const content = body.content;
    if (!Array.isArray(content)) return out;
    for (const c of content) {
        const o = c as { type?: string; image_url?: unknown; role?: unknown };
        if (o?.type !== 'image_url' && o?.type !== 'input_image') continue;
        const url = urlOf(o.image_url);
        if (!url) continue;
        const r = typeof o.role === 'string' ? o.role : '';
        out.push({ url, role: r === 'first_frame' || r === 'last_frame' ? r : 'reference_image' });
    }
    return out;
}

/** 入参图 URL(顶层 image_url / image / images / reference_image_urls + content[].image_url)。 */
export function extractImageUrls(body: Record<string, unknown>): string[] {
    const urls: string[] = [];
    pushUrl(urls, body.image_url);
    if (typeof body.image === 'string') urls.push(body.image);
    if (Array.isArray(body.images)) for (const i of body.images) pushUrl(urls, i);
    if (Array.isArray(body.image_urls)) for (const i of body.image_urls) pushUrl(urls, i);
    if (Array.isArray(body.reference_image_urls)) for (const i of body.reference_image_urls) pushUrl(urls, i);
    const content = body.content;
    if (Array.isArray(content)) {
        for (const c of content) {
            const o = c as { type?: string; image_url?: unknown };
            if (o?.type === 'image_url' || o?.type === 'input_image') pushUrl(urls, o.image_url);
        }
    }
    return urls;
}

/** 入参视频 URL(reference_video / reference_videos / videos + content[].video_url)。 */
export function extractVideoUrls(body: Record<string, unknown>): string[] {
    const urls: string[] = [];
    pushUrl(urls, body.reference_video);
    if (Array.isArray(body.reference_videos)) for (const v of body.reference_videos) pushUrl(urls, v);
    if (Array.isArray(body.videos)) for (const v of body.videos) pushUrl(urls, v);
    const content = body.content;
    if (Array.isArray(content)) {
        for (const c of content) {
            const o = c as { type?: string; video_url?: unknown };
            if (o?.type === 'video_url' || o?.type === 'input_video') pushUrl(urls, o.video_url);
        }
    }
    return urls;
}

/** 入参音频 URL(audio_url / audio / audios / reference_audios + content[].audio_url)。 */
export function extractAudioUrls(body: Record<string, unknown>): string[] {
    const urls: string[] = [];
    pushUrl(urls, body.audio_url);
    if (typeof body.audio === 'string') urls.push(body.audio);
    if (Array.isArray(body.audios)) for (const a of body.audios) pushUrl(urls, a);
    if (Array.isArray(body.reference_audios)) for (const a of body.reference_audios) pushUrl(urls, a);
    const content = body.content;
    if (Array.isArray(content)) {
        for (const c of content) {
            const o = c as { type?: string; audio_url?: unknown };
            if (o?.type === 'audio_url' || o?.type === 'input_audio') pushUrl(urls, o.audio_url);
        }
    }
    return urls;
}

/** media URL → 上游能抓的 http(s) 直链。data URL 解码上传我们 R2(无扩展名,content-type 权威);
 *  http(s) 原样透传(上游 Volcengine 抓取器直接吃网络直链)。 */
/** 已是我们 R2 公网域名(转存过 / 生图产出)→ 不再重复转存。 */
function isOurR2Url(u: string): boolean {
    const base = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
    return !!base && u.startsWith(base);
}

/** 把 http(s) 输入媒体转存到 Cloudflare R2(全球 CDN,海外上游可达),返回 R2 直链;
 *  任何失败(拉取超时/非 2xx/超限)→ null,调用方回退原 URL(不硬失败)。 */
async function rehostHttpMediaToR2(url: string): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) return null;
        const len = Number(res.headers.get('content-length') || 0);
        if (len > 50 * 1024 * 1024) return null; // >50MB 不转存(参考视频兜底上限)
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 50 * 1024 * 1024) return null;
        let ct = res.headers.get('content-type') || '';
        if (!/^(image|video|audio)\//.test(ct)) {
            ct = /\.(mp4|mov|webm)(\?|$)/i.test(url)
                ? 'video/mp4'
                : /\.(mp3|wav|m4a|aac)(\?|$)/i.test(url)
                  ? 'audio/mpeg'
                  : 'image/jpeg';
        }
        return await uploadImage(`seedance-input/${randomUUID()}`, buf, ct);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function toHttpMediaUrl(url: string, opts?: { rehostHttp?: boolean }): Promise<string> {
    const u = url.trim();
    const m = /^data:((?:image|audio|video)\/[a-z0-9.+-]+);base64,(.+)$/i.exec(u);
    if (m) {
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 20 * 1024 * 1024) throw new Error('media exceeds 20MB');
        return uploadImage(`seedance-cn-ref/${randomUUID()}`, buf, m[1]);
    }
    if (!/^https?:\/\//i.test(u)) throw new Error('media must be an http(s) URL or a base64 data URL');
    // 海外档(global/promax):把 http 输入媒体转存 Cloudflare R2,避免海外上游跨境拉国内 CDN
    // (popreels.cn 等)超时(Gateway Time-out)。已是我们 R2 域名的跳过;转存失败回退原 URL。
    if (opts?.rehostHttp && !isOurR2Url(u)) {
        const rehosted = await rehostHttpMediaToR2(u);
        if (rehosted) return rehosted;
    }
    return u;
}

const fetchXhk = (path: string, auth: string, init: RequestInit = {}, base: string = XHK_BASE) =>
    fetch(`${base}${path}`, {
        ...init,
        headers: { Authorization: auth, Accept: 'application/json', ...(init.headers || {}) },
    });

/** POST 提交:OpenAI-video → token.xinhankr.com /v1/video/generations。 */
export async function submitVideo(req: NextRequest): Promise<NextResponse> {
    const auth = req.headers.get('authorization') || '';
    if (!isAuthorized(auth)) return err(401, 'unauthorized', 'invalid credentials for seedance-cn adapter');

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) as Record<string, unknown>;
    } catch {
        return err(400, 'invalid_json', 'request body must be JSON');
    }
    return submitVideoWithKey(body, auth);
}

/** 提交核心(独立门户直调:body + 上游 key 授权头,进程内调用,不走 HTTP/适配器单 key 鉴权)。 */
export async function submitVideoWithKey(body: Record<string, unknown>, auth: string): Promise<NextResponse> {
    const model = String(body.model || '');
    const map = MODEL_MAP[model];
    if (!map) return err(400, 'model_not_found', `unknown seedance-cn model: ${model}`);

    const prompt = extractPrompt(body);
    if (!prompt) return err(400, 'invalid_request', 'prompt (text) is required');

    // 入参图/视频 + 帧角色(first_frame/last_frame 显式优先;reference_mode 次之;否则智能模式)
    const rawImages = extractImageUrls(body);
    const rawVideos = extractVideoUrls(body);
    const refMode = String(
        (body.video_config as { reference_mode?: unknown } | undefined)?.reference_mode || '',
    ).toLowerCase();
    const explicitFirst = typeof body.first_frame === 'string' ? body.first_frame : '';
    const explicitLast = typeof body.last_frame === 'string' ? body.last_frame : '';
    const rawAudios = extractAudioUrls(body);
    const totalImages = rawImages.length + (explicitFirst ? 1 : 0) + (explicitLast ? 1 : 0);

    // 档位与输入一致性门控(防串档薅便宜档)
    const hasInputs = totalImages > 0 || rawVideos.length > 0 || rawAudios.length > 0;
    if (!map.ref && hasInputs)
        return err(400, 'invalid_request', `${model} is text-only; use a "-ref" model for image/video/audio inputs`);
    if (map.ref && !hasInputs)
        return err(
            400,
            'invalid_request',
            `${model} requires a reference (image_url / images / reference_image_urls / first_frame / last_frame / reference_videos)`,
        );
    // 音频需配 ≥1 张图(对齐上游文档)
    if (rawAudios.length > 0 && totalImages === 0)
        return err(400, 'invalid_request', 'audio requires at least one reference image (image / first_frame)');
    // 单次输入上限按变体(seedance 2.5 = 30 图 / 10 视频 / 10 音频;其余 9 图 / 3 视频 / 音频不限数)
    const limits = refLimitsFor(map.variant);
    if (totalImages > limits.images) return err(400, 'invalid_request', `at most ${limits.images} images`);
    if (rawVideos.length > limits.videos) return err(400, 'invalid_request', `at most ${limits.videos} videos`);
    if (rawAudios.length > limits.audios) return err(400, 'invalid_request', `at most ${limits.audios} audios`);

    // duration:2.5 系 4-30s,2.0 系 4-15s(火山官方 2026-08 提升 2.5 至 30s);-1 = 智能时长
    // (上游在有效范围内自选,火山官方全系支持)。范围外/非整数回落 5。
    const durRaw = Number(body.duration ?? body.seconds);
    const maxDur = maxDurationForVariant(map.variant);
    const duration = durRaw === -1 ? -1 : Number.isInteger(durRaw) && durRaw >= 4 && durRaw <= maxDur ? durRaw : 5;
    let ratio = String(body.ratio || body.aspect_ratio || '16:9');
    if (!ALLOWED_RATIOS.has(ratio)) ratio = '16:9';
    const generateAudio = body.generate_audio !== false; // 满血企业档默认出声;传 false 关(音频零额外 token 成本)

    // 上游请求体(images/videos 用带 role 的对象;帧角色显式指定优先)
    const upstreamBody: Record<string, unknown> = {
        model: map.upstream,
        prompt,
        resolution: map.resolution,
        ratio,
        duration,
        generate_audio: generateAudio,
    };
    if (typeof body.camera_fixed === 'boolean') upstreamBody.camera_fixed = body.camera_fixed;
    if (typeof body.seed === 'number') upstreamBody.seed = body.seed;
    // 全模态参考任务类型引导(火山官方 2.5:auto/edit/extend);有则透传,上游做特殊参数校验。
    if (
        typeof body.omni_reference_task_type === 'string' &&
        ['auto', 'edit', 'extend'].includes(body.omni_reference_task_type)
    )
        upstreamBody.omni_reference_task_type = body.omni_reference_task_type;
    // 输出格式(火山官方 2.5 新增 mov;缺省 mp4);有则透传。
    if (typeof body.output_format === 'string' && ['mp4', 'mov'].includes(body.output_format.toLowerCase()))
        upstreamBody.output_format = body.output_format.toLowerCase();

    if (map.ref) {
        try {
            // 海外档(global/promax)上游在境外,拉国内 CDN(popreels.cn 等)输入图会跨境超时 →
            // 先把 http 输入媒体转存 Cloudflare R2(全球 CDN),让海外上游从 images.silkroadai.io 拉。
            // 国内版(cn)上游在境内、能直拉,保持透传。data URL 各档本就转存 R2。
            const rehost = map.region === 'global' || map.region === 'promax';
            const toUrl = (u: string) => toHttpMediaUrl(u, { rehostHttp: rehost });
            // 先只确定每张图的(原始 url, role),不做 IO;再把图/视频/音频【全部并行】转存(保序 + role 不变)。
            // 海外档多图串行转存会累加延迟(13 图 × ~4s ≈ 50s);并行后 ≈ 单张耗时。
            // 客户在 content-item 上显式指定 role(first_frame/last_frame/reference_image)时原样保留
            // (火山官方形);否则回落到顶层 first_frame/last_frame + reference_mode + 智能模式(存量行为)。
            const contentRoled = extractImageRolesFromContent(body);
            const hasContentFrameRole = contentRoled.some((i) => i.role === 'first_frame' || i.role === 'last_frame');
            const imageSpecs: Array<{ url: string; role: string }> = [];
            if (explicitFirst) imageSpecs.push({ url: explicitFirst, role: 'first_frame' });
            if (explicitLast) imageSpecs.push({ url: explicitLast, role: 'last_frame' });
            if (!explicitFirst && !explicitLast && hasContentFrameRole) {
                for (const it of contentRoled) imageSpecs.push({ url: it.url, role: it.role });
            } else if (!explicitFirst && !explicitLast && refMode === 'start_frame' && rawImages.length >= 1) {
                imageSpecs.push({ url: rawImages[0], role: 'first_frame' });
            } else if (!explicitFirst && !explicitLast && refMode === 'start_end' && rawImages.length >= 2) {
                imageSpecs.push({ url: rawImages[0], role: 'first_frame' });
                imageSpecs.push({ url: rawImages[1], role: 'last_frame' });
            } else if (!explicitFirst && !explicitLast) {
                for (const u of rawImages) imageSpecs.push({ url: u, role: 'reference_image' });
            }
            const [imageUrls, videos, audios] = await Promise.all([
                Promise.all(imageSpecs.map((s) => toUrl(s.url))),
                Promise.all(rawVideos.map((u) => toUrl(u))),
                Promise.all(rawAudios.map((u) => toUrl(u))),
            ]);
            if (imageSpecs.length)
                upstreamBody.images = imageSpecs.map((s, i) => ({ url: imageUrls[i], role: s.role }));
            if (videos.length) upstreamBody.videos = videos;
            if (audios.length) upstreamBody.audios = audios;
        } catch (e) {
            return err(400, 'invalid_request', `reference media processing failed: ${String(e).slice(0, 160)}`);
        }
    }

    console.log('[seedance-cn-adapter] submit', {
        model,
        resolution: map.resolution,
        ref: map.ref,
        images: totalImages,
        videos: rawVideos.length,
        audios: rawAudios.length,
        duration,
        ratio,
        genAudio: generateAudio,
    });

    const upstreamBase = baseForRegion(map.region ?? 'cn');
    let upstream: Response;
    try {
        upstream = await fetchXhk(
            '/v1/video/generations',
            auth,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(upstreamBody),
            },
            upstreamBase,
        );
    } catch (e) {
        // 安全:不回显 upstreamBase / 异常文本(含上游域名/IP)给客户 —— 只落日志
        console.warn('[seedance-cn-adapter] submit unreachable', { base: upstreamBase, err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const text = await upstream.text();
    let j: { id?: string; task_id?: string; error?: { message?: string } } | null;
    try {
        j = JSON.parse(text) as { id?: string; task_id?: string };
    } catch {
        j = null;
    }
    const taskId = j?.task_id || j?.id;
    if (!upstream.ok || !taskId) {
        // 上游原始报错体落日志(2000 字):客户投诉 upstream_error 时按时间点反查根因
        const cls = classifyUpstreamError(text, upstream.status);
        console.warn('[seedance-cn-adapter] submit failed', {
            model,
            upstream_model: map.upstream,
            status: upstream.status,
            category: cls.category,
            body: text.slice(0, 2000),
        });
        // 安全:上游原始报错(可能含域名/server 标识)只落日志(见上 console.warn);
        // 客户拿【分类 + 脱敏】后的文案 —— 带主体(提示词/参考图/…)与脱敏后的上游原因。
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', cls.message, cls.category);
    }
    return NextResponse.json(
        {
            id: taskId,
            task_id: taskId,
            object: 'video',
            model,
            status: 'queued',
            progress: 0,
            created_at: Math.floor(Date.now() / 1000),
        },
        { status: 200 },
    );
}

function mapStatus(s: unknown): 'queued' | 'in_progress' | 'completed' | 'failed' {
    const x = String(s || '').toLowerCase();
    if (['completed', 'success', 'succeeded'].includes(x)) return 'completed';
    if (['failed', 'error', 'cancelled', 'canceled'].includes(x)) return 'failed';
    if (x === 'queued' || x === 'pending') return 'queued';
    return 'in_progress';
}

/** 上游完成响应 data 是数组 [{url}];取第一条视频直链。 */
function firstVideoUrl(data: unknown): string | null {
    if (!Array.isArray(data)) return null;
    const first = data[0] as { url?: unknown } | undefined;
    return typeof first?.url === 'string' ? first.url : null;
}

/** GET 轮询:token.xinhankr.com /v1/video/generations/{id} → OpenAI-video 形。 */
export async function pollVideo(req: NextRequest, id: string): Promise<NextResponse> {
    return pollVideoWithKey(id, req.headers.get('authorization') || '');
}

/** DELETE 取消/删除:token.xinhankr.com /v1/video/generations/{id}(火山官方 cancel/delete 语义)。
 *  尽力而为——上游支持则真取消排队任务;不支持/报错由调用方决定不阻断客户,且绝不透传上游 body(#271)。
 *  返回原始 upstream Response(调用方一般只看是否 2xx)。 */
export async function cancelVideoWithKey(id: string, auth: string, region: SeedanceRegion = 'cn'): Promise<Response> {
    return fetchXhk(
        `/v1/video/generations/${encodeURIComponent(id)}`,
        auth,
        { method: 'DELETE' },
        baseForRegion(region),
    );
}

/** 轮询核心(独立门户直调:id + 上游 key 授权头;region 决定打哪个 base,缺省国内)。 */
export async function pollVideoWithKey(id: string, auth: string, region: SeedanceRegion = 'cn'): Promise<NextResponse> {
    let upstream: Response;
    try {
        upstream = await fetchXhk(`/v1/video/generations/${encodeURIComponent(id)}`, auth, {}, baseForRegion(region));
    } catch (e) {
        console.warn('[seedance-cn-adapter] poll unreachable', { id, err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const text = await upstream.text();
    let j: Record<string, unknown> | null;
    try {
        j = JSON.parse(text) as Record<string, unknown>;
    } catch {
        j = null;
    }
    if (!upstream.ok || !j) {
        const cls = classifyUpstreamError(text, upstream.status);
        console.warn('[seedance-cn-adapter] poll failed', {
            id,
            status: upstream.status,
            category: cls.category,
            body: text.slice(0, 2000),
        });
        // 安全:上游原始报错只落日志(见上 console.warn);客户拿【分类 + 脱敏】后的文案。
        // 注:内容审核失败走 HTTP 200 + status:failed + fail_reason(不经此分支),客户仍能看到审核提示。
        return err(upstream.status >= 400 ? upstream.status : 502, 'upstream_error', cls.message, cls.category);
    }
    const status = mapStatus(j.status);
    const videoUrl = firstVideoUrl(j.data);
    const failReason =
        status === 'failed'
            ? String((j.error as { message?: string } | undefined)?.message || j.message || 'generation failed')
            : '';
    if (failReason) console.warn('[seedance-cn-adapter] task failed upstream', { id, fail_reason: failReason });
    // 上游按 token 计费(usage.completion_tokens = 权威 token 数,= 火山公式 (输入+输出时长)×宽×高×帧率/1024;
    // 参考视频档因输入视频时长也计入,token 更多)。回传给下游做【按 token 量计费】—— 见按 token 计费方案。
    // ⚠️ 早期上游报的 token 数偏小一半(2026-07-15 修复),现以 usage 实报为准。
    const usage = (j.usage ?? undefined) as Record<string, unknown> | undefined;
    return NextResponse.json(
        {
            id,
            task_id: id,
            object: 'video',
            status,
            progress: status === 'completed' || status === 'failed' ? 100 : 50,
            video_url: videoUrl ?? undefined,
            url: videoUrl ?? undefined,
            fail_reason: failReason || undefined,
            // 完成时透传上游 usage(供 new-api ModelRatio 或适配器自扣按 token 计费)
            usage: status === 'completed' ? usage : undefined,
        },
        { status: 200 },
    );
}

/** GET 内容代理:new-api result_url 回抓这里 → 拉上游成片流式回(隐藏上游直链)。 */
export async function streamContent(req: NextRequest, id: string): Promise<Response> {
    const auth = req.headers.get('authorization') || '';
    let taskRes: Response;
    try {
        taskRes = await fetchXhk(`/v1/video/generations/${encodeURIComponent(id)}`, auth);
    } catch (e) {
        console.warn('[seedance-cn-adapter] streamContent poll unreachable', { id, err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    const j = (await taskRes.json().catch(() => null)) as { data?: unknown } | null;
    const videoUrl = firstVideoUrl(j?.data);
    if (!videoUrl) return err(409, 'not_ready', 'video not available yet');
    let vid: Response;
    try {
        vid = await fetch(videoUrl, { headers: { Authorization: auth } });
    } catch (e) {
        console.warn('[seedance-cn-adapter] streamContent fetch video failed', { id, err: String(e) });
        return err(502, 'upstream_unreachable', 'upstream temporarily unavailable, please retry');
    }
    if (!vid.ok || !vid.body) return err(502, 'upstream_error', `video fetch ${vid.status}`);
    const headers: Record<string, string> = { 'Content-Type': vid.headers.get('content-type') || 'video/mp4' };
    const len = vid.headers.get('content-length');
    if (len) headers['Content-Length'] = len;
    return new Response(vid.body, { status: 200, headers });
}
