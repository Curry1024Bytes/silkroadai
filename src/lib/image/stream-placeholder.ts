/**
 * 伪流式 partial_image 的「生成中」占位图(operator 方案,2026-10-20)。
 *
 * 背景:客户用官方 Images streaming 写法(`stream:true` + `partial_images:N`)时,我们的上游不产渐进图。
 * 此前(第 5 批)partial 用最终图缩放预览合成,但只能在拿到最终图后一次性发出 —— 客户在整个生成期(慢上游
 * 1–3 分钟)什么帧都收不到。现改为:SSE 一开就按 partial_images 数量吐 N 帧**同一张**固定占位图(平色底 +
 * 加载环),completed 帧再给真图。占位图按请求的 (尺寸, 格式, 透明) 生成,否则客户端拿占位帧去布局会错位。
 *
 * 2026-10-20 第二版:占位帧做成**动图**(静态图客户会以为卡死,反而起 partial_image 的反作用)——
 *   png  → APNG(自写最小编码器 ./apng):首帧整幅画布(普通解码器看到的静态图),后续帧只覆盖转圈
 *          那一小块子矩形 → 4K 画布也只有几十 KB;
 *   webp → 动态 WebP(sharp 多页 raw 输入;整页帧,只对 ≤ 2.5MP 画布做,更大的退回静态);
 *   jpeg → 无动画,静态首帧。
 * 两层缓存:常用尺寸模块加载时后台预热;长尾尺寸首次现做后进 LRU。sharp 不可用 → 返 null,调用方跳过
 * partial 帧(只发 completed)。
 */
import { encodeApng, type ApngFrame } from './apng';
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

/** 动画参数:12 帧 × 80ms ≈ 1 秒转一圈。 */
export const PLACEHOLDER_FRAMES = 12;
export const PLACEHOLDER_FRAME_MS = 80;
/** 动态 WebP 要整页帧(sharp 不暴露子矩形),只对 ≤ 2.5MP 画布做;再大退回静态 webp。 */
const WEBP_ANIMATED_MAX_PIXELS = 2_500_000;

interface Geometry {
    r: number;
    sw: number;
    cx: number;
    cy: number;
    dotR: number;
    dotY: number;
    gap: number;
    /** 动画只更新的子矩形(整数、落在画布内)。 */
    region: { left: number; top: number; width: number; height: number };
}

function geometry(w: number, h: number): Geometry {
    const r = Math.max(8, Math.round(Math.min(w, h) * 0.06));
    const sw = Math.max(2, Math.round(r * 0.22));
    const cx = w / 2;
    const cy = h / 2 - r * 0.6;
    const dotR = Math.max(2, Math.round(r * 0.14));
    const dotY = cy + r * 1.9;
    const gap = r * 0.6;
    const pad = sw + 2;
    const left = Math.max(0, Math.floor(cx - r - pad));
    const top = Math.max(0, Math.floor(cy - r - pad));
    const right = Math.min(w, Math.ceil(cx + r + pad));
    const bottom = Math.min(h, Math.ceil(dotY + dotR + pad));
    return { r, sw, cx, cy, dotR, dotY, gap, region: { left, top, width: right - left, height: bottom - top } };
}

/** 第 i 帧的 SVG:加载环 + 三点,纯形状不依赖字体(Alpine 镜像里 librsvg 未必有字体,文字会渲染成空)。
 *  环的高亮弧按帧旋转,三点按相位渐隐。 */
function placeholderSvg(s: PlaceholderSpec, frame: number): string {
    const { w, h } = s;
    const g = geometry(w, h);
    const bg = s.transparent ? '' : `<rect width="${w}" height="${h}" fill="#1c1f26"/>`;
    const angle = (frame * 360) / PLACEHOLDER_FRAMES;
    const arc = `M ${g.cx} ${g.cy - g.r} A ${g.r} ${g.r} 0 1 1 ${g.cx - g.r} ${g.cy}`;
    const dot = (k: number): string => {
        const phase = (frame / PLACEHOLDER_FRAMES) * 2 * Math.PI - (k * 2 * Math.PI) / 3;
        const op = (0.3 + 0.6 * ((Math.sin(phase) + 1) / 2)).toFixed(2);
        return `<circle cx="${g.cx + (k - 1) * g.gap}" cy="${g.dotY}" r="${g.dotR}" fill="#9fb3ff" fill-opacity="${op}"/>`;
    };
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg}` +
        `<circle cx="${g.cx}" cy="${g.cy}" r="${g.r}" fill="none" stroke="#5a6070" stroke-opacity="0.45" stroke-width="${g.sw}"/>` +
        `<g transform="rotate(${angle} ${g.cx} ${g.cy})"><path d="${arc}" fill="none" stroke="#9fb3ff" stroke-width="${g.sw}" stroke-linecap="round"/></g>` +
        dot(0) +
        dot(1) +
        dot(2) +
        `</svg>`
    );
}

/** 测试 / 排障用:动画只更新的子矩形。 */
export function placeholderRegion(w: number, h: number): { left: number; top: number; width: number; height: number } {
    return geometry(w, h).region;
}

const LRU_MAX = 64;
const cache = new Map<string, Promise<string | null>>();

async function render(s: PlaceholderSpec): Promise<string | null> {
    const sharp = await loadSharp();
    if (!sharp) return null;
    try {
        const base = (frame: number) => {
            let pipe = sharp(Buffer.from(placeholderSvg(s, frame)));
            if (!s.transparent) pipe = pipe.flatten({ background: '#1c1f26' });
            return pipe.ensureAlpha();
        };
        if (s.format === 'jpeg') {
            return (await base(0).jpeg({ quality: 80 }).toBuffer()).toString('base64');
        }
        if (s.format === 'webp') {
            if (s.w * s.h > WEBP_ANIMATED_MAX_PIXELS)
                return (await base(0).webp({ quality: 80, alphaQuality: 100 }).toBuffer()).toString('base64');
            // 动态 WebP:N 页整幅 RGBA raw 竖向拼接,pageHeight 告诉 sharp 这是多页
            const pages: Buffer[] = [];
            for (let i = 0; i < PLACEHOLDER_FRAMES; i++) pages.push(await base(i).raw().toBuffer());
            const buf = await sharp(Buffer.concat(pages), {
                raw: { width: s.w, height: s.h * PLACEHOLDER_FRAMES, channels: 4, pageHeight: s.h },
            })
                .webp({ quality: 80, alphaQuality: 100, loop: 0, delay: PLACEHOLDER_FRAME_MS })
                .toBuffer();
            return buf.toString('base64');
        }
        // APNG:首帧整幅,后续帧只编码转圈子矩形;所有帧 8-bit RGBA 非调色板,保证 IHDR 一致
        const png = { compressionLevel: 9, palette: false } as const;
        const region = geometry(s.w, s.h).region;
        const frames: ApngFrame[] = [
            { png: await base(0).png(png).toBuffer(), x: 0, y: 0, delayMs: PLACEHOLDER_FRAME_MS },
        ];
        for (let i = 1; i < PLACEHOLDER_FRAMES; i++) {
            frames.push({
                png: await base(i).extract(region).png(png).toBuffer(),
                x: region.left,
                y: region.top,
                delayMs: PLACEHOLDER_FRAME_MS,
            });
        }
        return encodeApng(frames).toString('base64');
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
