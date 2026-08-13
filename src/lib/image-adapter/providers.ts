/**
 * 按张计费图片上游注册表(W10 image2 适配器)。
 *
 * 每个 provider = 一条 new-api 渠道(OpenAI 型),Base URL 指到
 * `https://portal.silkroadai.io/image-adapter/<provider>`,渠道 Key 填【真实上游的 key】——
 * 适配器把 new-api 带来的 Authorization 原样透传给真实上游,portal 不存上游凭据。
 *
 * 新增零散上游 = 这里加一行(OpenAI-images 兼容上游只需 baseUrl + brand)。
 */

export interface ImageProvider {
    /** 真实上游 base(不含 /v1),适配器拼 `${baseUrl}/v1/images/{generations|edits}`。 */
    baseUrl: string;
    /** 错误脱敏:出现在客户可见错误体里要抹掉的品牌名。 */
    brand: RegExp;
}

export const IMAGE_PROVIDERS: Record<string, ImageProvider> = {
    // ominiapi:1k/2k/4k 统一 ¥0.1/张 → 只值得接 4K 全档 + 2K-high(守门在 adapter.ts)
    ominiapi: { baseUrl: 'https://www.ominiapi.com', brand: /\bomini(?:api)?\b/gi },
    // codexvip:同源 Adobe Firefly 转售(usage_source=adobe2api,出图带 Firefly C2PA →
    // stripAdobeImageMetadataB64 自动剥),¥0.06/张(比 ominiapi 便宜)。与 ch154 同 prio 分流承压。
    codexvip: { baseUrl: 'https://subdirect.aicodexvip.top', brand: /\b(?:aicodexvip|aicodex|codexvip|adobe2api)\b/gi },
};
