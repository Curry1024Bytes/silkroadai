/**
 * gpt-image-2.6 SVG 两步生成,给上游不支持原生 SVG 的分组用(ch326 / ch327 等适配器线)。
 *
 * 官方做法(官方文档 + 2026-11-07 官 key 实测):图像模型先画一张参考图,再由 `svg.model` 指定的文字模型
 * 照着参考图写 SVG 代码。响应里 `usage` 是参考图的 token,`svg_usage` 是作者模型的 token。
 * 代理层复刻同一流程:两步都用客户自己的 key,所以都按客户所在分组的倍率计费(operator 在 2.6 分组里挂 GPT 文本渠道)。
 *
 * 本文件只放纯逻辑(请求体、抽取、安全检查、背景判定、用量换算),网络调用在 /v1 代理里。
 */
import { loadSharp } from './transcode';

export type SvgBackground = 'transparent' | 'opaque' | 'auto';

export interface SvgAuthorParams {
    model: string;
    /** 官方 svg.reasoning.effort;null = 不传,用作者模型默认值。 */
    effort: string | null;
}

/** 官方 svg.reasoning.effort 枚举(images 参考页)。 */
export const SVG_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 复杂场景实测输出 7.5k–9.2k token(2026-11-08 原型),留足余量防截断。 */
export const SVG_AUTHOR_MAX_COMPLETION_TOKENS = 32_000;

const MAX_SVG_BYTES = 4 * 1024 * 1024;

const BACKGROUND_RULES: Record<SvgBackground, string> = {
    auto: 'Draw a background only if the reference image has one.',
    transparent: 'Leave the background transparent: do not paint a full-canvas background.',
    opaque: 'Paint a full-canvas background first.',
};

export function normalizeSvgBackground(raw: string): SvgBackground {
    const v = raw.trim().toLowerCase();
    return v === 'transparent' || v === 'opaque' ? v : 'auto';
}

/** 读 svg 对象(JSON 的 svg,或 multipart 折回的 svg[model])+ 推理强度。model 已由代理层校验非空。 */
export function readSvgAuthorParams(svg: unknown, formEffort?: unknown): SvgAuthorParams {
    const o = svg && typeof svg === 'object' && !Array.isArray(svg) ? (svg as Record<string, unknown>) : {};
    const model = typeof o.model === 'string' ? o.model.trim() : '';
    const reasoning =
        o.reasoning && typeof o.reasoning === 'object' ? (o.reasoning as Record<string, unknown>) : undefined;
    const raw = reasoning?.effort ?? formEffort;
    const effort = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
    return { model, effort };
}

/** 推理强度不在官方枚举 → 官方文案的 400;放在出参考图之前,免得先扣参考图的钱。 */
export function svgEffortError(effort: string | null): string | null {
    if (effort === null || (SVG_REASONING_EFFORTS as readonly string[]).includes(effort)) return null;
    const list = SVG_REASONING_EFFORTS.map((e) => `'${e}'`);
    return `Invalid value: '${effort}'. Supported values are: ${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}.`;
}

/** 适配器线对原生 SVG 的立即拒绝(gif.ts gpt26ParamError)。命中才走两步流程,其余错误原样返回。 */
export function isNativeSvgUnsupported(errorText: string): boolean {
    return /Invalid value: 'svg'/.test(errorText);
}

export function buildSvgAuthorBody(p: {
    params: SvgAuthorParams;
    prompt: string;
    w: number;
    h: number;
    background: SvgBackground;
    referenceB64: string;
    referenceMime: string;
}): Record<string, unknown> {
    const system = [
        'You turn a reference image into a standalone SVG file.',
        'Output only the SVG markup: start with <svg and end with </svg>. No code fences, no commentary.',
        'Rules:',
        `- Root element: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.w} ${p.h}" width="${p.w}" height="${p.h}">.`,
        '- First child is a <title> naming the subject in a few words.',
        "- Reproduce the reference image's composition, shapes, colors, lighting and any visible text as clean vector art. Keep proportions and placement.",
        '- Use paths, basic shapes, gradients, groups, clip paths and <text>. Reuse shapes with <defs> and <use> where it helps.',
        '- Static content only: no <script>, <image>, <foreignObject>, animation, event attributes, CSS @import or external references.',
        `- ${BACKGROUND_RULES[p.background]}`,
    ].join('\n');
    const body: Record<string, unknown> = {
        model: p.params.model,
        messages: [
            { role: 'system', content: system },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `The reference image was created for this request: ${p.prompt}` },
                    { type: 'image_url', image_url: { url: `data:${p.referenceMime};base64,${p.referenceB64}` } },
                ],
            },
        ],
        max_completion_tokens: SVG_AUTHOR_MAX_COMPLETION_TOKENS,
    };
    if (p.params.effort) body.reasoning_effort = p.params.effort;
    return body;
}

/** 从作者回复里取出 <svg>…</svg>(容忍代码围栏和前后说明);取不到 → null。 */
export function extractSvg(content: string): string | null {
    const start = content.search(/<svg[\s>]/i);
    const end = content.toLowerCase().lastIndexOf('</svg>');
    if (start < 0 || end < start) return null;
    let svg = content.slice(start, end + '</svg>'.length);
    if (!/^<svg[^>]*\sxmlns\s*=/i.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    return svg;
}

const FORBIDDEN: Array<[RegExp, string]> = [
    [/<\s*script\b/i, 'script'],
    [/<\s*foreignObject\b/i, 'foreignObject'],
    [/<\s*image\b/i, 'embedded image'],
    [/<\s*(?:iframe|object|embed|audio|video|canvas)\b/i, 'embedded content'],
    [/<\s*(?:animate|animateMotion|animateTransform|set)\b/i, 'animation'],
    [/<!DOCTYPE|<!ENTITY/i, 'doctype'],
    [/\son[a-z]+\s*=/i, 'event attribute'],
    [/javascript:/i, 'javascript url'],
    [/@import/i, 'css import'],
    [/(?:xlink:)?href\s*=\s*["'](?!#)/i, 'external reference'],
    [/url\(\s*(?!["']?#)/i, 'external url'],
];

/** 官方 SVG 是静态矢量内容(无脚本、外部资源、内嵌位图)。不达标返回原因,由调用方重写一次。 */
export function svgSafetyError(svg: string): string | null {
    if (Buffer.byteLength(svg) > MAX_SVG_BYTES) return 'too large';
    for (const [re, why] of FORBIDDEN) if (re.test(svg)) return why;
    return null;
}

/** 用 librsvg 解析一遍:XML 坏了或渲染不了 → false。 */
export async function svgRenders(svg: string): Promise<boolean> {
    try {
        const sharp = await loadSharp();
        if (!sharp) return true; // 没有 sharp 无从校验,安全检查已过,放行
        const meta = await sharp(Buffer.from(svg)).metadata();
        return (meta.width ?? 0) > 0 && (meta.height ?? 0) > 0;
    } catch {
        return false;
    }
}

function fullLength(v: string | undefined, total: number): boolean {
    if (v === undefined) return false;
    const s = v.trim();
    if (s === '100%') return true;
    const n = Number(s.replace(/px$/, ''));
    return Number.isFinite(n) && n >= total;
}

function atOrigin(v: string | undefined): boolean {
    return v === undefined || Number(v.trim().replace(/px$/, '')) <= 0;
}

/** 回显 background:第一个绘制元素是铺满画布的 rect → opaque,否则 transparent(官方缺省两种都回过)。 */
export function svgPaintsCanvas(svg: string, w: number, h: number): boolean {
    const body = svg
        .replace(/^<svg[^>]*>/i, '')
        .replace(/<(defs|title|desc|metadata|style)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
    const first = /<(?!\/)(?!g[\s>])([a-zA-Z]+)\b([^>]*)>/.exec(body);
    if (!first || first[1].toLowerCase() !== 'rect') return false;
    const attrs: Record<string, string> = {};
    for (const m of first[2].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) attrs[m[1]] = m[2];
    if (attrs.fill === 'none' || attrs.fill === 'transparent') return false;
    return fullLength(attrs.width, w) && fullLength(attrs.height, h) && atOrigin(attrs.x) && atOrigin(attrs.y);
}

/** 作者回复 usage → 官方 svg_usage 形。 */
export function toSvgUsage(chat: Record<string, unknown>, fallbackModel: string): Record<string, unknown> {
    const u = (chat.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const details = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
    const input = num(u.prompt_tokens);
    const output = num(u.completion_tokens);
    return {
        input_tokens: input,
        model: typeof chat.model === 'string' && chat.model ? chat.model : fallbackModel,
        output_tokens: output,
        reasoning_tokens: num(details.reasoning_tokens),
        total_tokens: num(u.total_tokens) || input + output,
    };
}
