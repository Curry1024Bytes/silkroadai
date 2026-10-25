/**
 * Gemini 按量生图上游注册表(gemini-adapter,2026-10-23)。
 *
 * 每个 provider = 一条 new-api 渠道(Gemini 型 type=24),Base URL 指到
 * `http://172.20.0.1:3010/gemini-adapter/<provider>`,渠道 Key 填【真实上游的 key】——
 * 适配器把 new-api 带来的 key(x-goog-api-key / Authorization / ?key=)原样透传给真实上游,
 * portal 不存上游凭据(与 @/lib/image-adapter 同一约定)。
 *
 * 为什么需要这层:new-api 的 `billing-usage-gemini` 直接信上游回包里的 usageMetadata 扣费。
 * ch198 we-token / 真 vertex 回官方常数,但 yobox(ch306)/ frimodel(ch221)这类池子回的
 * 图片 token 是自己编的(2026-10-22 实测 1K 回 560/566/599/615,官方 1120;2K 回 1902/2114,
 * 官方 1680)→ 同一分组同一请求账单随渠道漂。适配器把 usage 重写成官方常数,任何上游进来都
 * 按官方口径扣。
 */

export interface GeminiProvider {
    /** 真实上游 base(不含 /v1beta),适配器拼 `${baseUrl}/v1beta/models/{model}:generateContent`。 */
    baseUrl: string;
    /** 错误脱敏:出现在客户可见错误体里要抹掉的品牌名。 */
    brand: RegExp;
    /** 单次上游调用超时(ms)。缺省 = adapter.ts DEFAULT_UPSTREAM_TIMEOUT_MS(600s,与 Caddy :3010 对齐)。 */
    upstreamTimeoutMs?: number;
}

export const GEMINI_PROVIDERS: Record<string, GeminiProvider> = {
    // yobox:max.yoboxai.com/gemini(原 ch306「香蕉 yobox」直连 base)。真出图(1K→1024²、2K→2048²、
    // 4K→4096²、img2img 跟随输入),但 usageMetadata 的 IMAGE token 非官方常数且每次不同。
    // 流式(:streamGenerateContent)上游回空图 → 适配器对 stream 一律走非流式再包 SSE。
    yobox: {
        baseUrl: 'https://max.yoboxai.com/gemini',
        brand: /\byobox\s?ai\b|\byobox\b|\bjd23kjs\b|provider api error:?\s*|\bone_hub(?:_error)?\b/gi,
    },
};
