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
    // 2026-08-14:上游端点 www. → api.(api. 连接更快;www 仍活,非强制迁移)。
    ominiapi: { baseUrl: 'https://api.ominiapi.com', brand: /\bomini(?:api)?\b/gi },
    // codexvip:同源 Adobe Firefly 转售(usage_source=adobe2api,出图带 Firefly C2PA →
    // stripAdobeImageMetadataB64 自动剥),¥0.06/张(比 ominiapi 便宜)。与 ch154 同 prio 分流承压。
    codexvip: { baseUrl: 'https://subdirect.aicodexvip.top', brand: /\b(?:aicodexvip|aicodex|codexvip|adobe2api)\b/gi },
    // wetoken(us-la.we-token.cc):同 ch153 那条 US 线的 adobe Firefly 转售,直连按面积刻度计费
    // (4K-high 19,755)。挂适配器后【丢弃上游面积 usage、合成官方 usage】(4K-high 13,342)→ 客户拿
    // 官方标准账单、可对账。健康度好,new-api 渠道 prio 压过 ch154(25)兜住过守门的请求。C2PA 由 proxy 剥。
    wetoken: { baseUrl: 'https://us-la.we-token.cc', brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi },
};
