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
    /** true = 跳过盈利档/形状守门,放行【所有】可解析尺寸(仍要求 size 可解析)。
     *  用于"官方账单"上游(we-token 系):azure 直连对几乎所有非标准尺寸超收 5~229%,客户对不上
     *  官方计算器 → 全量走适配器合成官方 usage。默认(缺省)= 走 isProfitable/isElongated 守门。 */
    openAllTiers?: boolean;
}

export const IMAGE_PROVIDERS: Record<string, ImageProvider> = {
    // ominiapi:1k/2k/4k 统一 ¥0.1/张 → 只值得接 4K 全档 + 2K-high(守门在 adapter.ts)
    // 2026-08-14:上游端点 www. → api.(api. 连接更快;www 仍活,非强制迁移)。
    ominiapi: { baseUrl: 'https://api.ominiapi.com', brand: /\bomini(?:api)?\b/gi },
    // codexvip:同源 Adobe Firefly 转售(usage_source=adobe2api,出图带 Firefly C2PA →
    // stripAdobeImageMetadataB64 自动剥),¥0.06/张(比 ominiapi 便宜)。与 ch154 同 prio 分流承压。
    codexvip: { baseUrl: 'https://subdirect.aicodexvip.top', brand: /\b(?:aicodexvip|aicodex|codexvip|adobe2api)\b/gi },
    // wetoken(us-la.we-token.cc)= ch153 那条 US 线上游;wetokenasia(asian-acc.we-token.cc)= ch83 上游。
    // 两条都是 adobe Firefly 转售,直连按【面积刻度】超收(非标准尺寸 +5~229%,客户对不上官方计算器)。
    // 2026-08-15 operator 拍板 ch83+ch153 全量走适配器 → openAllTiers 放行所有尺寸、合成官方 usage → 官方
    // 标准账单可对账。key 由各自 new-api 渠道透传(代码不存)。C2PA 由 proxy 剥。
    wetoken: {
        baseUrl: 'https://us-la.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
    },
    wetokenasia: {
        baseUrl: 'https://asian-acc.we-token.cc',
        brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi,
        openAllTiers: true,
    },
    // wetokengated:同 us-la.we-token.cc 上游,但【不带 openAllTiers】→ 走盈利档+狭长守门(= ch154/ominiapi
    // 那套)。给 ch175 用:让它只接狭长/盈利档,方图低档/auto 拒 → 走 ch176/ch177。2026-08-15 operator 指定。
    wetokengated: { baseUrl: 'https://us-la.we-token.cc', brand: /\bwe-?token\b|\badobe\b|\bfirefly\b/gi },
    // ---- 2026-08-21 operator 新接两家【全量】上游,给 ch176/ch177 那条全量线扩容 ----
    // ominiapifull:ominiapi 平台【另一个账号的 key】(与上面 gated 的 `ominiapi` 是两条独立渠道,别混),
    // 端点用 operator 给的 www.(api. 同样 200,留 www 以免与另一账号的线路混淆)。同为 Firefly 转售:
    // 直连 b64_json 生效,出图带 adobe/firefly C2PA(proxy 回程剥)。openAllTiers = 全量接、合成官方 usage。
    ominiapifull: { baseUrl: 'https://www.ominiapi.com', brand: /\bomini(?:api)?\b/gi, openAllTiers: true },
    // frimodel:new-api 型网关,**API host 是 api.frimodel.com**(operator 给的 platform. 是控制台,
    // nginx 对 /v1/* 恒 403)。同为 Adobe Firefly 转售。契约差异:generations【无视 response_format】恒返
    // 预签名 S3 url(适配器 url→b64 兜底拉回,绝不外泄),edits 才直接给 b64;size/quality 均如实生效。
    frimodel: {
        baseUrl: 'https://api.frimodel.com',
        brand: /\bfri-?model\b|\bfirefly\b|\bs3-accelerate\.amazonaws\.com\b/gi,
        openAllTiers: true,
    },
};
