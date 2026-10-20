/**
 * 伪流式 partial_image 的「生成中」占位图(operator 方案,2026-10-20)。
 *
 * 背景:客户用官方 Images streaming 写法(`stream:true` + `partial_images:N`)时,我们的上游不产渐进图。
 * 此前(第 5 批)partial 用最终图缩放预览合成,但只能在拿到最终图后一次性发出 —— 客户在整个生成期(慢上游
 * 1–3 分钟)什么帧都收不到。现改为:SSE 一开就按 partial_images 数量吐 N 帧**同一张**固定占位图(平色底 +
 * 加载环),completed 帧再给真图。占位图按请求的 (尺寸, 格式, 透明) 生成,否则客户端拿占位帧去布局会错位。
 *
 * 两层缓存:常用尺寸模块加载时后台预热;长尾尺寸首次现做后进 LRU。平色底 PNG 即使 4K 也只有几十 KB,
 * sharp 编码几十毫秒,现做也不是瓶颈。sharp 不可用 → 返 null,调用方跳过 partial 帧(只发 completed)。
 */
import { loadSharp, type ImageFormat } from './transcode';

export interface PlaceholderSpec {
    w: number;
    h: number;
    format: ImageFormat;
    transparent: boolean;
}

/** 官方 gpt-image 尺寸硬约束:16 的倍数、最长边 ≤ 3840。占位图只需「像素相等」,这里只做钳位不做校验。 */
const MIN_SIDE = 16;
const MAX_SIDE = 3840;
export const PLACEHOLDER_DEFAULT_SIZE = { w: 1024, h: 1024 } as const;

/** 从客户请求字段推占位图规格。size 非 `WxH`(含 auto / 空)→ 1024²(auto 的真实画幅要上游返回才知道,
 *  占位帧按缺省方图发,文档已注明);jpeg 无 alpha → transparent 只对 png / webp 生效。 */
export function placeholderSpecFromRequest(
    size: string | null | undefined,
    outputFormat: string | null | undefined,
    background: string | null | undefined,
): PlaceholderSpec {
    let { w, h } = PLACEHOLDER_DEFAULT_SIZE as { w: number; h: number };
    const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(size ?? '');
    if (m) {
        w = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Number(m[1])));
        h = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Number(m[2])));
    }
    const f = (outputFormat ?? '').trim().toLowerCase();
    const format: ImageFormat = f === 'jpeg' || f === 'jpg' ? 'jpeg' : f === 'webp' ? 'webp' : 'png';
    const transparent = format !== 'jpeg' && (background ?? '').trim().toLowerCase() === 'transparent';
    return { w, h, format, transparent };
}

export function placeholderKey(s: PlaceholderSpec): string {
    return `${s.w}x${s.h}:${s.format}:${s.transparent ? 'a' : 'o'}`;
}

/** 加载环 + 三点的 SVG(纯形状,不依赖字体 —— Alpine 镜像里 librsvg 未必有字体,文字会渲染成空)。 */
function placeholderSvg(s: PlaceholderSpec): string {
    const { w, h } = s;
    const r = Math.max(8, Math.round(Math.min(w, h) * 0.06));
    const sw = Math.max(2, Math.round(r * 0.22));
    const cx = w / 2;
    const cy = h / 2 - r * 0.6;
    const dotR = Math.max(2, Math.round(r * 0.14));
    const dotY = cy + r * 1.9;
    const gap = r * 0.6;
    const bg = s.transparent ? '' : `<rect width="${w}" height="${h}" fill="#1c1f26"/>`;
    // 环:浅灰底环 + 3/4 弧高亮,读起来像 spinner;三点递减透明度。
    const arc = `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - r} ${cy}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg}<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#5a6070" stroke-opacity="0.45" stroke-width="${sw}"/><path d="${arc}" fill="none" stroke="#9fb3ff" stroke-width="${sw}" stroke-linecap="round"/><circle cx="${cx - gap}" cy="${dotY}" r="${dotR}" fill="#9fb3ff" fill-opacity="0.9"/><circle cx="${cx}" cy="${dotY}" r="${dotR}" fill="#9fb3ff" fill-opacity="0.6"/><circle cx="${cx + gap}" cy="${dotY}" r="${dotR}" fill="#9fb3ff" fill-opacity="0.3"/></svg>`;
}

const LRU_MAX = 64;
const cache = new Map<string, Promise<string | null>>();

async function render(s: PlaceholderSpec): Promise<string | null> {
    const sharp = await loadSharp();
    if (!sharp) return null;
    try {
        let pipe = sharp(Buffer.from(placeholderSvg(s)));
        if (!s.transparent) pipe = pipe.flatten({ background: '#1c1f26' });
        pipe =
            s.format === 'jpeg'
                ? pipe.jpeg({ quality: 80 })
                : s.format === 'webp'
                  ? pipe.webp({ quality: 80, alphaQuality: 100 })
                  : pipe.png({ compressionLevel: 9, palette: !s.transparent });
        return (await pipe.toBuffer()).toString('base64');
    } catch (e) {
        console.warn('[stream-placeholder] render failed:', placeholderKey(s), e instanceof Error ? e.message : e);
        return null;
    }
}

/** 取占位图 base64(命中缓存直接返;未命中现做并入缓存;失败结果不缓存以便下次重试)。 */
export function getStreamPlaceholderB64(s: PlaceholderSpec): Promise<string | null> {
    const key = placeholderKey(s);
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit); // LRU touch
        return hit;
    }
    const p = render(s).then((b64) => {
        if (b64 === null) cache.delete(key);
        return b64;
    });
    cache.set(key, p);
    while (cache.size > LRU_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return p;
}

/** 常用尺寸(官方三标准尺寸 + 2K / 2880 / 4K)× png 预热;透明 1024² 也预热。后台跑,失败只 warn。 */
export const WARM_SIZES: ReadonlyArray<readonly [number, number]> = [
    [1024, 1024],
    [1536, 1024],
    [1024, 1536],
    [2048, 2048],
    [2880, 2880],
    [3840, 2160],
];
let warmed = false;
export function warmStreamPlaceholders(): void {
    if (warmed) return;
    warmed = true;
    for (const [w, h] of WARM_SIZES) void getStreamPlaceholderB64({ w, h, format: 'png', transparent: false });
    void getStreamPlaceholderB64({ ...PLACEHOLDER_DEFAULT_SIZE, format: 'png', transparent: true });
}

/** 测试用:缓存大小 / 清空。 */
export function _placeholderCacheSize(): number {
    return cache.size;
}
export function _resetPlaceholderCache(): void {
    cache.clear();
    warmed = false;
}
